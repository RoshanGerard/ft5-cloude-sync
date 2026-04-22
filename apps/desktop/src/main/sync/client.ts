// SyncClient — desktop transport for the fs-sync service.
//
// Owns a connected `net.Socket` (opened by the supervisor), writes
// newline-framed Request frames, and correlates inbound Response frames
// back to their caller by `id`. Scope of this module (tasks.md 3.3–3.4):
//   - typed `request<N>(name, params, { timeoutMs? })` round-trip
//   - per-request timeout (falls back to ctor `defaultTimeoutMs`, else none)
//   - silent drop of responses whose id matches nothing pending
//
// Explicitly NOT in scope yet:
//   - `onEvent` dispatch (pair 4: tasks 3.7 + 3.8)
//   - disconnect / service-disconnected rejection (pair 3: 3.5 + 3.6)
// Event frames reach the decoder and are intentionally ignored here.
// Malformed or oversized frames from the decoder are logged via
// `console.warn` and dropped; a future pair may wire a structured logger.
//
// Correlation-id strategy: defaults to `crypto.randomUUID()`. Tests may
// inject a deterministic generator via the ctor `generateId` seam —
// chosen over `vi.mock("node:crypto")` so this file stays free of
// test-only plumbing.

import type net from "node:net";
import { randomUUID } from "node:crypto";

import type {
  CommandName,
  CommandParams,
  CommandResult,
  ErrorShape,
  Frame,
  RequestFrame,
  ResponseFrame,
} from "@ft5/ipc-contracts/sync-service";

import {
  FrameParseError,
  FrameTooLargeError,
  FramingDecoder,
  encodeFrame,
} from "./framing.js";

export interface SyncClientOptions {
  /** Applied when a per-request `timeoutMs` is not supplied. */
  readonly defaultTimeoutMs?: number;
  /** Test seam. Defaults to `crypto.randomUUID`. */
  readonly generateId?: () => string;
}

export class SyncCommandError<
  N extends CommandName = CommandName,
> extends Error {
  readonly command: N;
  readonly tag: string;
  readonly details?: unknown;

  constructor(command: N, error: ErrorShape) {
    super(`${command} failed: ${error.tag} — ${error.message}`);
    this.name = "SyncCommandError";
    this.command = command;
    this.tag = error.tag;
    this.details = error.details;
  }
}

export class RequestTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;
  readonly tag = "request-timeout" as const;

  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs} ms`);
    this.name = "RequestTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

interface PendingEntry {
  readonly command: CommandName;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer?: NodeJS.Timeout;
}

export class SyncClient {
  private readonly socket: net.Socket;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly defaultTimeoutMs?: number;
  private readonly generateId: () => string;
  private readonly decoder: FramingDecoder;

  constructor(socket: net.Socket, opts: SyncClientOptions = {}) {
    this.socket = socket;
    this.defaultTimeoutMs = opts.defaultTimeoutMs;
    this.generateId = opts.generateId ?? (() => randomUUID());

    this.decoder = new FramingDecoder({
      onFrame: (frame) => this.onFrame(frame),
      onError: (err) => this.onDecoderError(err),
    });
    this.socket.on("data", (chunk) => this.decoder.push(chunk));
    // Attach a no-op error listener now so a mid-request socket error does
    // not crash the main process via Node's default unhandled-error rethrow.
    // Pair 3 (disconnect handling) replaces this with a reject-all handler.
    this.socket.on("error", () => void 0);
  }

  request<N extends CommandName>(
    name: N,
    params: CommandParams<N>,
    opts: { timeoutMs?: number } = {},
  ): Promise<CommandResult<N>> {
    const id = this.generateId();
    const frame: RequestFrame = {
      id,
      kind: "request",
      command: name,
      params,
    };

    return new Promise<CommandResult<N>>((resolve, reject) => {
      const timeoutMs =
        opts.timeoutMs !== undefined ? opts.timeoutMs : this.defaultTimeoutMs;

      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          // Remove pending entry first so a late arrival is dropped silently.
          this.pending.delete(id);
          reject(new RequestTimeoutError(name, timeoutMs));
        }, timeoutMs);
        // Don't keep the event loop alive solely for a pending request timer.
        timer.unref?.();
      }

      this.pending.set(id, {
        command: name,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.socket.write(encodeFrame(frame));
    });
  }

  private onFrame(frame: Frame): void {
    if (frame.kind === "response") {
      const pending = this.pending.get(frame.id);
      if (!pending) {
        // Unknown id — silently drop. Covers late arrivals after timeout
        // and any speculative / duplicate frames from the service.
        return;
      }
      this.pending.delete(frame.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (frame.ok) {
        pending.resolve(frame.result);
      } else {
        pending.reject(new SyncCommandError(pending.command, frame.error));
      }
      return;
    }
    // Event frames: dispatch is wired in pair 4 (tasks 3.7 + 3.8).
    // Ignore silently so the decoder continues processing the stream.
  }

  private onDecoderError(err: FrameParseError | FrameTooLargeError): void {
    // Structured logger wiring is a later pair. For now, surface via
    // console.warn so dev builds don't swallow a wire-level problem.
    console.warn("[sync-client] dropped malformed frame:", err.message);
  }
}
