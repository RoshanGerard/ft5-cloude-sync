// Renderer-observable event union delivered over `SYNC_CHANNELS.event`.
//
// Envelope shape is `{ kind, payload }` — deliberately renamed from the wire
// contract's `{ name, payload }` so the renderer can `switch (event.kind)`
// without `name` colliding with `Error.name`-style intuition in IDE hover.
//
// The renderer sees THREE categories of events, all multiplexed through the
// same envelope so a single `onEvent(cb)` listener can switch on `kind`
// exhaustively:
//
//   1. The 10 lifecycle events emitted by the fs-sync service itself. Their
//      payload shapes are re-exported (NOT duplicated) from the wire
//      contract at `@ft5/ipc-contracts/sync-service`.
//   2. `sync-state-seed` — a synthetic event emitted once per supervisor
//      connection carrying the in-progress JobSummary snapshot from the
//      app-open reconciliation handshake (spec: "App-open reconciliation
//      seeds renderer with in-progress jobs").
//   3. `service-disconnected` / `service-reconnected` — synthetic events
//      raised by the desktop supervisor when its underlying socket to the
//      service closes or re-establishes. The renderer uses these to surface
//      "sync paused" UI state and to invalidate local job state on
//      reconnect (spec: "Sync client speaks the service's wire protocol",
//      "Service events are relayed to the renderer").

import type { JobSummary } from "../sync-service/commands.js";
import type {
  AuthCancelledPayload,
  AuthCompletedPayload,
  AuthFailedPayload,
  AuthFailedTag,
  AuthInitiatedPayload,
  AuthTimeoutPayload,
  JobCancelledPayload,
  JobCompletedPayload,
  JobEnqueuedPayload,
  JobFailedPayload,
  JobProgressPayload,
  JobRecoveredPayload,
  JobStartedPayload,
  NetworkAvailablePayload,
  SourceUnavailablePayload,
  SyncCompletedPayload,
} from "../sync-service/events.js";

// Re-export the wire-contract payload shapes so downstream consumers can
// import them from the renderer-facing subpath without reaching into the
// wire contract. Re-exports mirror the import list above — keep them in sync.
//
// `oauth-open-url` and `credential-persisted` are intentionally NOT
// re-exported — they are bridge-only events filtered out of the renderer
// forward path per implement-datasource-onboarding design Decision 7.
export type {
  AuthCancelledPayload,
  AuthCompletedPayload,
  AuthFailedPayload,
  AuthFailedTag,
  AuthInitiatedPayload,
  AuthTimeoutPayload,
  JobCancelledPayload,
  JobCompletedPayload,
  JobEnqueuedPayload,
  JobFailedPayload,
  JobProgressPayload,
  JobRecoveredPayload,
  JobStartedPayload,
  NetworkAvailablePayload,
  SourceUnavailablePayload,
  SyncCompletedPayload,
};

/**
 * Snapshot of in-progress jobs delivered to the renderer once per supervisor
 * connection. Jobs are filtered to `status ∈ {running, queued,
 * waiting-network}` by the main-process event bridge.
 */
export interface SyncStateSeedPayload {
  readonly jobs: ReadonlyArray<JobSummary>;
}

/**
 * Raised by the desktop supervisor when the socket to the service closes.
 * All in-flight renderer IPC calls reject with `service-disconnected` as a
 * side-effect of this state transition; the event itself is an
 * informational notification for the renderer's UI state.
 */
export interface ServiceDisconnectedPayload {
  readonly reason: "socket-closed" | "service-crashed" | "unknown";
  readonly observedAt: number;
}

/**
 * Raised by the desktop supervisor after a successful reconnect. A fresh
 * `sync-state-seed` event follows on the same connection so the renderer
 * can reconcile its local job state against post-reconnect reality.
 */
export interface ServiceReconnectedPayload {
  readonly observedAt: number;
  readonly reconnectAttempts: number;
}

// ---- Event map + derived helpers -----------------------------------------

export interface SyncEventPayloadMap {
  "sync-state-seed": SyncStateSeedPayload;
  "job-enqueued": JobEnqueuedPayload;
  "job-started": JobStartedPayload;
  "job-progress": JobProgressPayload;
  "job-completed": JobCompletedPayload;
  "job-failed": JobFailedPayload;
  "job-cancelled": JobCancelledPayload;
  "job-recovered": JobRecoveredPayload;
  "sync-completed": SyncCompletedPayload;
  "source-unavailable": SourceUnavailablePayload;
  "network-available": NetworkAvailablePayload;
  "service-disconnected": ServiceDisconnectedPayload;
  "service-reconnected": ServiceReconnectedPayload;
  // Authenticate lifecycle (implement-datasource-onboarding design
  // Decision 7). The bridge filters out `oauth-open-url` and
  // `credential-persisted` before forwarding, so the renderer-facing
  // map contains only the five renderer-bound variants.
  "auth-initiated": AuthInitiatedPayload;
  "auth-completed": AuthCompletedPayload;
  "auth-cancelled": AuthCancelledPayload;
  "auth-failed": AuthFailedPayload;
  "auth-timeout": AuthTimeoutPayload;
}

export type SyncEventKind = keyof SyncEventPayloadMap;

export type SyncEvent = {
  [K in SyncEventKind]: {
    readonly kind: K;
    readonly payload: SyncEventPayloadMap[K];
  };
}[SyncEventKind];

/**
 * Runtime-accessible enumeration of every `SyncEventKind`. Callers that need
 * to validate arriving event envelopes against a stable allow-list (e.g.
 * the preload's `onEvent` bridge) should compare against this tuple.
 */
export const SYNC_EVENT_KINDS: ReadonlyArray<SyncEventKind> = [
  "sync-state-seed",
  "job-enqueued",
  "job-started",
  "job-progress",
  "job-completed",
  "job-failed",
  "job-cancelled",
  "job-recovered",
  "sync-completed",
  "source-unavailable",
  "network-available",
  "service-disconnected",
  "service-reconnected",
  "auth-initiated",
  "auth-completed",
  "auth-cancelled",
  "auth-failed",
  "auth-timeout",
] as const;
