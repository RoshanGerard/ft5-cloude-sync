// SyncClient — desktop transport for the fs-sync service.
//
// Owns a connected `net.Socket` (opened by the supervisor), writes
// newline-framed Request frames, and correlates inbound Response frames
// back to their caller by `id`. Scope of this module (tasks.md 3.3–3.8):
//   - typed `request<N>(name, params, { timeoutMs? })` round-trip
//   - per-request timeout (falls back to ctor `defaultTimeoutMs`, else none)
//   - silent drop of responses whose id matches nothing pending
//   - on socket close: flip `isConnected`, reject every pending request
//     with `SyncDisconnectedError` (tag `service-disconnected`), and
//     notify listeners registered via `client.on("disconnect", cb)`
//   - reject requests issued after disconnect with the same error
//   - validate event-frame shape; drop malformed frames silently
//   - fan well-formed event frames out to listeners registered via
//     `onEvent(cb)`; one throwing listener must not break the others
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
  EventFrame,
  Frame,
  RequestFrame,
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

/**
 * Thrown/rejected when the socket is closed (or has already closed) at
 * the moment a request would otherwise be issued or awaited. Carries
 * the in-flight command name for caller diagnostics; empty when the
 * disconnect fired between requests.
 */
export class SyncDisconnectedError extends Error {
  readonly tag = "service-disconnected" as const;
  readonly command: string | undefined;

  constructor(params: { command?: string } = {}) {
    const suffix = params.command ? ` (command=${params.command})` : "";
    super(`sync service disconnected${suffix}`);
    this.name = "SyncDisconnectedError";
    this.command = params.command;
  }
}

interface PendingEntry {
  readonly command: CommandName;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: NodeJS.Timeout | undefined;
}

type DisconnectListener = () => void;
type EventListener = (event: EventFrame) => void;

export class SyncClient {
  private readonly socket: net.Socket;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly defaultTimeoutMs: number | undefined;
  private readonly generateId: () => string;
  private readonly decoder: FramingDecoder;
  private readonly disconnectListeners = new Set<DisconnectListener>();
  private readonly eventListeners = new Set<EventListener>();
  private connected = true;

  constructor(socket: net.Socket, opts: SyncClientOptions = {}) {
    this.socket = socket;
    this.defaultTimeoutMs = opts.defaultTimeoutMs;
    this.generateId = opts.generateId ?? (() => randomUUID());

    this.decoder = new FramingDecoder({
      onFrame: (frame) => this.onFrame(frame),
      onError: (err) => this.onDecoderError(err),
    });
    this.socket.on("data", (chunk) => this.decoder.push(chunk));
    // Absorb the socket-error event so Node's default handler does not
    // rethrow (mid-request ECONNRESET on Windows named pipes is common).
    // Actual disconnect bookkeeping is centralised in `handleDisconnect`,
    // driven by "close" which fires after both "end" and "error".
    this.socket.on("error", () => void 0);
    this.socket.on("close", () => this.handleDisconnect());
    this.socket.on("end", () => this.handleDisconnect());
  }

  /** True from construction until the underlying socket closes. */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Number of in-flight requests (pending response). Exposed so tests can
   * assert the pending map is not leaking on throw/cancel paths. Safe for
   * production readers too — it's just a map size.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Subscribe to the synthetic disconnect event. Returns an unsubscribe
   * function. Listeners fire exactly once (when the socket first closes);
   * listeners registered after disconnect do NOT fire — callers should
   * check `isConnected` first if they attach late.
   */
  on(event: "disconnect", cb: DisconnectListener): () => void {
    // Parameter `event` kept for future extension and clarity at the
    // call site; today "disconnect" is the only supported event.
    void event;
    this.disconnectListeners.add(cb);
    return () => {
      this.disconnectListeners.delete(cb);
    };
  }

  /**
   * Subscribe to well-formed event frames pushed by the service.
   * Returns an unsubscribe function. Each listener receives every
   * event that passes the shape check in `onFrame`; malformed frames
   * are dropped before dispatch. A listener that throws does not
   * prevent its siblings from firing (mirrors the disconnect fan-out).
   *
   * Listeners registered after disconnect do NOT receive any events
   * — the socket is closed, so no new event frames can arrive.
   */
  onEvent(cb: EventListener): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  request<N extends CommandName>(
    name: N,
    params: CommandParams<N>,
    opts: { timeoutMs?: number } = {},
  ): Promise<CommandResult<N>> {
    // Fail fast if the socket has already closed — do NOT write to a
    // destroyed socket and do NOT register a pending entry that would
    // never resolve.
    if (!this.connected) {
      return Promise.reject(new SyncDisconnectedError({ command: name }));
    }

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

      // `socket.write` can throw synchronously if the pipe was torn down
      // between our `isConnected` check and this line (common Windows
      // named-pipe race), or if the frame serialises to something the
      // socket refuses. Without the unwind below the pending entry and
      // its timer would linger — observable as `pendingCount > 0` for
      // the rest of the lifetime, and a stale timer firing `reject()` on
      // an already-settled promise at the timeout mark.
      try {
        this.socket.write(encodeFrame(frame));
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  }

  // ---- Typed wrapper methods per SYNC_CHANNELS -----------------------------
  //
  // Thin delegates over `request()` that name each wire command explicitly.
  // Task 5.1 (section 5) consumes these via `syncClient.listJobs(params)`.
  // The methods return the wire result shape (`CommandResult<N>`); the
  // main-process IPC handler in section 5 is what composes richer
  // renderer-facing shapes like `{ ...wire, derivedSyncingDatasourceIds }`.

  listJobs(
    params: CommandParams<"sync:list-jobs">,
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult<"sync:list-jobs">> {
    return this.request("sync:list-jobs", params, opts);
  }

  getJob(
    params: CommandParams<"sync:get-job">,
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult<"sync:get-job">> {
    return this.request("sync:get-job", params, opts);
  }

  enqueueUpload(
    params: CommandParams<"sync:enqueue-upload">,
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult<"sync:enqueue-upload">> {
    return this.request("sync:enqueue-upload", params, opts);
  }

  enqueueMirror(
    params: CommandParams<"sync:enqueue-mirror">,
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult<"sync:enqueue-mirror">> {
    return this.request("sync:enqueue-mirror", params, opts);
  }

  cancelJob(
    params: CommandParams<"sync:cancel-job">,
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult<"sync:cancel-job">> {
    return this.request("sync:cancel-job", params, opts);
  }

  authenticate(
    params: CommandParams<"sync:authenticate">,
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult<"sync:authenticate">> {
    return this.request("sync:authenticate", params, opts);
  }

  authenticateStart(
    params: CommandParams<"sync:authenticate-start">,
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult<"sync:authenticate-start">> {
    return this.request("sync:authenticate-start", params, opts);
  }

  authenticateComplete(
    params: CommandParams<"sync:authenticate-complete">,
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult<"sync:authenticate-complete">> {
    return this.request("sync:authenticate-complete", params, opts);
  }

  getStatus(
    params: CommandParams<"sync:get-status">,
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult<"sync:get-status">> {
    return this.request("sync:get-status", params, opts);
  }

  getRetryPolicy(
    params: CommandParams<"sync:get-retry-policy">,
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult<"sync:get-retry-policy">> {
    return this.request("sync:get-retry-policy", params, opts);
  }

  setRetryPolicy(
    params: CommandParams<"sync:set-retry-policy">,
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult<"sync:set-retry-policy">> {
    return this.request("sync:set-retry-policy", params, opts);
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
    if (frame.kind === "event") {
      // Shape-check. The decoder parses JSON and the Frame discriminator
      // is structural, so a service bug (or a hostile peer) could emit a
      // "kind":"event" object with a wrong-typed `name`. Drop silently
      // — listeners must not see garbage payloads.
      if (typeof frame.name !== "string") {
        console.warn(
          "[sync-client] dropped malformed event frame (name is not a string)",
        );
        return;
      }
      // Snapshot the listener set so a callback that subscribes or
      // unsubscribes during dispatch cannot perturb the current walk.
      const snapshot = Array.from(this.eventListeners);
      for (const cb of snapshot) {
        try {
          cb(frame);
        } catch (err) {
          // A misbehaving listener must not prevent siblings from firing.
          console.warn("[sync-client] event listener threw:", err);
        }
      }
      return;
    }
  }

  private onDecoderError(err: FrameParseError | FrameTooLargeError): void {
    // Structured logger wiring is a later pair. For now, surface via
    // console.warn so dev builds don't swallow a wire-level problem.
    console.warn("[sync-client] dropped malformed frame:", err.message);
  }

  /**
   * Idempotent disconnect handler. Both "end" and "close" feed into it
   * (close always fires last), so the first invocation does the work
   * and subsequent invocations are no-ops.
   */
  private handleDisconnect(): void {
    if (!this.connected) return;
    this.connected = false;

    // Snapshot and clear BEFORE rejecting. A `.catch` handler running in
    // the microtask tail of `entry.reject` could otherwise observe stale
    // entries via internal paths (or re-enter request, see them linger,
    // and reason incorrectly). Clearing up-front makes the client's
    // observable state fully-settled before any user code runs.
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new SyncDisconnectedError({ command: entry.command }));
    }

    // Snapshot listeners so a callback that unsubscribes itself (or its
    // siblings) during iteration cannot perturb the walk.
    const snapshot = Array.from(this.disconnectListeners);
    for (const cb of snapshot) {
      try {
        cb();
      } catch (err) {
        // A misbehaving listener must not prevent siblings from firing.
        console.warn("[sync-client] disconnect listener threw:", err);
      }
    }
  }
}
