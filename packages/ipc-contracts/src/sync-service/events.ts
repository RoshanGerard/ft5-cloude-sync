// Event surface emitted by the sync service over any subscribed client's
// Event frames. Listed in the base spec under "IPC command surface" (for the
// allow-listed names) and in the individual state-machine / scheduler /
// executor / probe / credential-store requirements.

import type { DatasourceSummary, ProviderId } from "../datasources.js";
import type { ConflictPolicy, JobKind, JobStatus } from "./commands.js";

export interface JobEnqueuedPayload {
  readonly jobId: string;
  readonly kind: JobKind;
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly targetPath: string | null;
  readonly conflictPolicy: ConflictPolicy;
  readonly enqueuedAt: number;
}

export interface JobStartedPayload {
  readonly jobId: string;
  readonly attempt: number;
  readonly startedAt: number;
}

export interface JobProgressPayload {
  readonly jobId: string;
  readonly bytesSent: number;
  readonly totalBytes: number | null;
  readonly percent: number | null;
}

export interface JobCompletedPayload {
  readonly jobId: string;
  readonly completedAt: number;
  readonly summary?: {
    readonly skipped?: boolean;
  };
}

export interface JobFailedPayload {
  readonly jobId: string;
  readonly failedAt: number;
  readonly attempt: number;
  readonly errorTag: string;
  readonly errorMessage: string;
}

export interface JobCancelledPayload {
  readonly jobId: string;
  readonly cancelledAt: number;
  readonly priorStatus: Exclude<JobStatus, "cancelled">;
}

export interface JobRecoveredPayload {
  readonly jobId: string;
  readonly attempt: number;
  readonly priorStatus: "running";
  readonly lastErrorTag: "service-restart";
}

export interface SyncCompletedPayload {
  readonly jobId: string;
  readonly uploaded: number;
  readonly updated: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly completedAt: number;
}

export interface SourceUnavailablePayload {
  readonly jobId: string;
  readonly sourcePath: string;
  readonly errorCode: string;
  readonly message: string;
}

export interface NetworkAvailablePayload {
  readonly host: string;
  readonly observedAt: number;
  readonly releasedJobIds: ReadonlyArray<string>;
}

export interface CredentialStorePermissionViolationPayload {
  readonly path: string;
  readonly mode: string;
  readonly observedAt: number;
}

// ---- Authenticate event taxonomy (implement-datasource-onboarding) -------
//
// Per design.md Decision 7, the service emits seven new variants on the
// `sync:event` stream once the datasource onboarding flow runs end-to-end
// inside the service. Five are renderer-bound; two are bridge-only and
// SHALL be filtered out of the renderer-forward path by the desktop's
// sync event-bridge:
//
//   * Renderer-bound: auth-initiated, auth-completed, auth-cancelled,
//     auth-failed, auth-timeout
//   * Bridge-only:    oauth-open-url (drives shell.openExternal),
//                     credential-persisted (drives registry.add)
//
// `auth-completed` and `credential-persisted` carry overlapping data; the
// distinct identities exist so the bridge can filter the bridge-only
// variants without dropping the renderer-bound terminal event.

/** Service emitted `auth-initiated` after `sync:authenticate-start`
 * stashes the live AuthIntent in the correlation store. The renderer's
 * `useAuthSession` hook treats this as the "pending" entry transition. */
export interface AuthInitiatedPayload {
  readonly correlationId: string;
  readonly providerId: ProviderId;
  readonly datasourceId?: string;
}

/** Service emitted `auth-completed` after the engine writes credentials
 * (OAuth loopback callback OR credentials-form submit). The renderer's
 * authenticate UI consumes this to close the dialog and refresh. */
export interface AuthCompletedPayload {
  readonly correlationId: string;
  readonly datasourceId: string;
  readonly summary: DatasourceSummary;
}

/** Service emitted `auth-cancelled` exactly once per active correlation
 * when `sync:authenticate-cancel` consumes it. Idempotent: a second
 * cancel for the same correlationId emits no further event. */
export interface AuthCancelledPayload {
  readonly correlationId: string;
}

/** Tag set carried on `auth-failed` events. The set is intentionally
 * narrow — failure modes that are typed-error-class (e.g.,
 * `service-config-missing`) surface through the request/response path
 * NOT through events. Events cover the loopback and engine-runtime
 * failures that arrive after the response was already sent. */
export type AuthFailedTag =
  | "auth-revoked"
  | "provider-error"
  | "engine-error";

/** Service emitted `auth-failed` on loopback `state` mismatch, on a
 * `completeWith` rejection, or on engine errors during `submit`. */
export interface AuthFailedPayload {
  readonly correlationId: string;
  readonly tag: AuthFailedTag;
  readonly message?: string;
}

/** Service emitted `auth-timeout` when the OAuth loopback's 5-minute
 * timer fires without a callback hit. */
export interface AuthTimeoutPayload {
  readonly correlationId: string;
}

/** Bridge-only `oauth-open-url` event consumed by the desktop sync
 * event-bridge to call `shell.openExternal(authorizeUrl)`. The renderer
 * SHALL NEVER receive this event — the bridge filters it out before
 * forwarding to renderer subscribers. */
export interface OAuthOpenUrlPayload {
  readonly correlationId: string;
  readonly authorizeUrl: string;
}

/** Bridge-only `credential-persisted` event consumed by the desktop
 * sync event-bridge to call `getEngine().registry.add(summary)`. The
 * renderer SHALL NEVER receive this event — `auth-completed` is the
 * renderer-visible terminal event for the same authenticate completion. */
export interface CredentialPersistedPayload {
  readonly correlationId: string;
  readonly datasourceId: string;
  readonly summary: DatasourceSummary;
}

// ---- Download-lifecycle event taxonomy (add-engine-rename-download §13) --
//
// Per spec.md "Service handler emits `downloading`/terminal events on the
// IPC stream" the fs-sync handler emits four DERIVED events on the
// `sync:subscribe-events` channel. These shapes are NOT the engine bus's
// shapes — engine events are `(datasourceId, path)`-keyed and carry raw
// vendor facts; fs-sync events are `downloadJobId`-keyed and carry
// business decoration (throttled progress percentage, savedPath from the
// handler's pipe target, post-integrity decision). The transformation
// runs inside the `files:download` handler's bus subscription per §13.25-
// §13.26; the desktop subscriber sees only the fs-sync shapes.

/** Streaming-tagged progress event. `progress` is the 0..100 percentage
 * derived from the engine bus's `downloading { loaded, total }` (or, when
 * `contentLength` is `null`, the raw `loaded` count divided into a
 * caller-defined heuristic — but in practice every supported provider
 * advertises length, so the renderer treats `progress` as authoritative).
 * `path` is the SOURCE path on the datasource, not the local `toPath` —
 * the renderer correlates against its own entry rows by `(datasourceId,
 * path)` to update the in-flight toaster. */
export interface DownloadingPayload {
  readonly downloadJobId: string;
  readonly datasourceId: string;
  readonly progress: number;
  readonly path: string;
}

/** Terminal success. `savedPath` is the absolute local path the handler
 * piped the stream into; `bytes` is the post-pipe `fs.stat(savedPath).size`
 * the handler asserted equal to the provider's `contentLength`. */
export interface FileDownloadedPayload {
  readonly downloadJobId: string;
  readonly datasourceId: string;
  readonly savedPath: string;
  readonly bytes: number;
}

/** Terminal failure. The handler collapses the engine's
 * `SerializedDatasourceError<T>` taxonomy into the renderer-facing
 * `FilesErrorTag` (range-not-supported, range-mismatch, byte-count-mismatch,
 * and integrity-failed all collapse to `tag: "other"` with descriptive
 * messages per spec.md line 73 / 115). The raw engine error is NOT
 * forwarded — only `tag` + `message` cross the wire.
 *
 * Per add-download-resilience design.md Decision 7, the tag union also
 * includes `"exhausted-retries"` for terminal failure after the handler's
 * environmental-retry budget is spent — both consecutive-failure
 * exhaustion AND wall-time ceiling share this tag, with the message field
 * carrying the discriminator (`"exhausted-retries: <engineCause>"` or
 * `"walltime-exceeded: <engineCause>"`).
 */
export interface DownloadFailedPayload {
  readonly downloadJobId: string;
  readonly datasourceId: string;
  readonly tag: "auth-revoked" | "disconnected" | "rate-limited" | "other"
    | "invalid-datasource" | "exhausted-retries";
  readonly message: string;
}

/** Streaming-style retry signal emitted at the START of each
 * environmental-retry sleep (per add-download-resilience design.md
 * Decision 5). NOT emitted for the auth-expired Layer 2 branch — that
 * retry is fast (no sleep) and the user does not need a separate
 * "refreshing token" indicator.
 *
 * The fs-sync IPC bus is uncoalesced (the engine-bus coalescer that
 * throttles `downloading` does not apply here). Every retry attempt
 * emits exactly one `download-retrying` event.
 *
 * `engineCause` carries the engine-side `DatasourceErrorTag` verbatim —
 * a deliberate engine-taxonomy leak scoped to diagnostic decoration
 * only. The renderer SHALL NOT branch behavior on its value; the
 * wire-level identity for "we're retrying" is the event itself, not
 * the cause string. Telemetry consumers may aggregate on `engineCause`
 * for cause analysis. */
export interface DownloadRetryingPayload {
  readonly downloadJobId: string;
  readonly datasourceId: string;
  /** Current consecutiveFailureCount (1-indexed). */
  readonly attempt: number;
  /** CONSECUTIVE_FAIL_LIMIT — always 5 in v1. */
  readonly limit: number;
  /** Chosen sleep duration in ms (max(retryAfterMs, expBackoff)). */
  readonly waitMs: number;
  /** Engine-side error tag verbatim (diagnostic-only). */
  readonly engineCause: string;
}

/** Terminal cancel. `bytesDownloaded` is the last value the engine reported
 * via `onProgress` before the AbortSignal fired; `bytesTotal` is the
 * provider's advertised `contentLength` (or `null` when unknown).
 * `reason: "user"` is the only v1 source — service-restart / network-drop
 * cancels are not yet wired and would surface through `download-failed`
 * if they occur. The partial file at the handler's `toPath` is NOT
 * auto-deleted (spec line 78). */
export interface DownloadCancelledPayload {
  readonly downloadJobId: string;
  readonly datasourceId: string;
  readonly bytesDownloaded: number;
  readonly bytesTotal: number | null;
  readonly reason: "user";
}

// ---- Event map + derived helpers -----------------------------------------

export interface EventPayloadMap {
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
  "credential-store-permission-violation": CredentialStorePermissionViolationPayload;
  "auth-initiated": AuthInitiatedPayload;
  "auth-completed": AuthCompletedPayload;
  "auth-cancelled": AuthCancelledPayload;
  "auth-failed": AuthFailedPayload;
  "auth-timeout": AuthTimeoutPayload;
  "oauth-open-url": OAuthOpenUrlPayload;
  "credential-persisted": CredentialPersistedPayload;
  // add-engine-rename-download §13 — fs-sync's downloadJobId-keyed
  // download lifecycle events (DERIVED from the engine bus, NOT relayed).
  "downloading": DownloadingPayload;
  // add-download-resilience — emitted at the start of each environmental
  // retry sleep (NOT for the auth-expired Layer 2 branch).
  "download-retrying": DownloadRetryingPayload;
  "file-downloaded": FileDownloadedPayload;
  "download-failed": DownloadFailedPayload;
  "download-cancelled": DownloadCancelledPayload;
}

export type EventName = keyof EventPayloadMap;

export type ServiceEvent = {
  [N in EventName]: {
    readonly name: N;
    readonly payload: EventPayloadMap[N];
  };
}[EventName];

export const EVENT_NAMES: ReadonlyArray<EventName> = [
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
  "credential-store-permission-violation",
  "auth-initiated",
  "auth-completed",
  "auth-cancelled",
  "auth-failed",
  "auth-timeout",
  "oauth-open-url",
  "credential-persisted",
  "downloading",
  "download-retrying",
  "file-downloaded",
  "download-failed",
  "download-cancelled",
] as const;

