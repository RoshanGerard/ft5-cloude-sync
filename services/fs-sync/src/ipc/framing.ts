// Newline-delimited JSON framing codec. One frame per line. Frames may be
// arbitrarily split across `chunk` events, and a single `chunk` may carry
// multiple frames. Lines that exceed `maxFrameBytes` are rejected with a
// `FrameTooLargeError`. Lines that parse but don't match the expected
// Request/Event shape are the caller's problem — this codec only does
// line-split + JSON.parse.
//
// Spec: IPC transport — Request { id, kind, command, params } | Response
// | Event frames delimited by \n.

import type { Frame } from "@ft5/ipc-contracts/sync-service";

export const DEFAULT_MAX_FRAME_BYTES = 10 * 1024 * 1024;

export class FrameTooLargeError extends Error {
  readonly observedBytes: number;
  readonly limitBytes: number;
  constructor(observedBytes: number, limitBytes: number) {
    super(
      `incoming frame exceeds max size (${observedBytes} > ${limitBytes})`,
    );
    this.name = "FrameTooLargeError";
    this.observedBytes = observedBytes;
    this.limitBytes = limitBytes;
  }
}

export class FrameParseError extends Error {
  readonly raw: string;
  constructor(raw: string, cause: unknown) {
    super(
      `frame parse failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "FrameParseError";
    this.raw = raw;
  }
}

export interface FramingDecoderEvents {
  onFrame(frame: Frame): void;
  onError(err: FrameParseError | FrameTooLargeError): void;
}

export class FramingDecoder {
  private buffer = "";
  private readonly maxFrameBytes: number;
  private readonly events: FramingDecoderEvents;

  constructor(
    events: FramingDecoderEvents,
    options: { readonly maxFrameBytes?: number } = {},
  ) {
    this.events = events;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  /** Feed a chunk (utf8 string or buffer). Emits zero or more frames. */
  push(chunk: string | Buffer): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) {
        // Even with no newline yet, reject if the buffer already exceeds
        // the limit — no point waiting for a newline we'll reject anyway.
        if (this.buffer.length > this.maxFrameBytes) {
          const observed = this.buffer.length;
          this.buffer = "";
          this.events.onError(new FrameTooLargeError(observed, this.maxFrameBytes));
        }
        return;
      }
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);

      if (line.length === 0) continue; // tolerate blank lines

      if (line.length > this.maxFrameBytes) {
        this.events.onError(
          new FrameTooLargeError(line.length, this.maxFrameBytes),
        );
        continue;
      }

      try {
        const frame = JSON.parse(line) as Frame;
        this.events.onFrame(frame);
      } catch (cause) {
        this.events.onError(new FrameParseError(line, cause));
      }
    }
  }

  /** Any unterminated tail after the last newline. Visible for tests. */
  pendingBytes(): number {
    return this.buffer.length;
  }
}

/** Serialize a frame to a single newline-terminated JSON line. */
export function encodeFrame(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`;
}
