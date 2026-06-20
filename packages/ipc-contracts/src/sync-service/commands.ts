// IPC command surface for `services/fs-sync`. Every command the service
// dispatches SHALL appear exactly once in `CommandMap` below. The controller
// uses `CommandName`, `CommandParams<N>`, `CommandResult<N>`, and
// `CommandError<N>` to build and correlate Request / Response frames with
// end-to-end type safety.
//
// See design.md D2+D3 and the base spec "IPC command surface" requirement.

import type {
  CredentialsSchema,
  DatasourceSummary,
  ProviderId,
} from "../datasources.js";
import type {
  EntryKind,
  FileEntry,
  FilesErrorTag,
  FilesRemoveEntryResult,
} from "../files.js";
import type { ErrorShape } from "./frames.js";

export type ConflictPolicy = "overwrite" | "duplicate" | "skip";

export type JobKind = "upload" | "sync";

export type JobStatus =
  | "queued"
  | "running"
  | "waiting-network"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobSummary {
  readonly id: string;
  readonly kind: JobKind;
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly targetPath: string | null;
  readonly conflictPolicy: ConflictPolicy;
  readonly status: JobStatus;
  readonly attempt: number;
  readonly lastErrorTag: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type BackoffStrategy = "fixed" | "exponential";

export type RetryPolicyScope = "global" | "datasource";

export interface RetryPolicy {
  readonly scope: RetryPolicyScope;
  readonly datasourceId: string | null;
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly backoffStrategy: BackoffStrategy;
  readonly maxAgeMs: number | null;
}

export interface SyncAlreadyRunningErrorShape extends ErrorShape {
  readonly tag: "sync-already-running";
  readonly details: {
    readonly existingJobId: string;
    readonly datasourceId: string;
    readonly sourcePath: string;
  };
}

export interface NotFoundErrorShape extends ErrorShape {
  readonly tag: "not-found";
}

export interface NotCancelableErrorShape extends ErrorShape {
  readonly tag: "not-cancelable";
}

export interface UnknownCommandErrorShape extends ErrorShape {
  readonly tag: "unknown-command";
}

export interface ValidationErrorShape extends ErrorShape {
  readonly tag: "validation-error";
}

// ---- Individual command definitions --------------------------------------

// migrate-upload-orchestration-out-of-engine §7.4 — `EnqueueUploadCommand`
// (`sync:enqueue-upload`) REMOVED. The queue-based single-file upload
// path was replaced by `files:upload` (a direct RPC; see
// `packages/ipc-contracts/src/files.ts` `FilesUploadCommand`). The
// service-side dispatcher (`services/fs-sync/src/commands/handlers.ts`),
// the desktop bridge (`apps/desktop/src/main/ipc/sync/enqueue-upload.ts`),
// the typed wrapper (`SyncClient.enqueueUpload`), the
// `SYNC_CHANNELS.enqueueUpload` constant, the
// `SyncEnqueueUploadRequest` / `SyncEnqueueUploadResponse` interfaces,
// and the preload binding (`window.api.sync.enqueueUpload`) were all
// deleted in chunk F. The `UploadJobExecutor` was deleted alongside;
// the `'upload'` value remains in `JobKind` / DB CHECK constraint so
// historical rows in user DBs stay readable, but no new `kind: 'upload'`
// jobs can be enqueued.

interface EnqueueMirrorCommand {
  readonly command: "sync:enqueue-mirror";
  readonly params: {
    readonly datasourceId: string;
    readonly sourcePath: string;
    readonly conflictPolicy?: ConflictPolicy;
  };
  readonly result: { readonly jobId: string };
  readonly error: SyncAlreadyRunningErrorShape | ValidationErrorShape;
}

interface ListJobsCommand {
  readonly command: "sync:list-jobs";
  readonly params: {
    readonly filter?: {
      readonly status?: ReadonlyArray<JobStatus>;
      readonly datasourceId?: string;
      readonly kind?: JobKind;
    };
  };
  readonly result: { readonly jobs: ReadonlyArray<JobSummary> };
  readonly error: ErrorShape;
}

interface GetJobCommand {
  readonly command: "sync:get-job";
  readonly params: { readonly jobId: string };
  readonly result: { readonly job: JobSummary };
  readonly error: NotFoundErrorShape;
}

interface CancelJobCommand {
  readonly command: "sync:cancel-job";
  readonly params: { readonly jobId: string };
  readonly result: { readonly cancelled: true };
  readonly error: NotFoundErrorShape | NotCancelableErrorShape;
}

interface SubscribeEventsCommand {
  readonly command: "sync:subscribe-events";
  readonly params: {
    readonly filter?: {
      readonly names?: ReadonlyArray<string>;
    };
  };
  readonly result: { readonly subscribed: true };
  readonly error: ErrorShape;
}

interface UnsubscribeEventsCommand {
  readonly command: "sync:unsubscribe-events";
  readonly params: Record<string, never>;
  readonly result: { readonly unsubscribed: true };
  readonly error: ErrorShape;
}

interface SetRetryPolicyCommand {
  readonly command: "sync:set-retry-policy";
  readonly params: {
    readonly scope: RetryPolicyScope;
    readonly datasourceId?: string;
    readonly maxAttempts: number;
    readonly backoffMs: number;
    readonly backoffStrategy: BackoffStrategy;
    readonly maxAgeMs?: number;
  };
  readonly result: { readonly policy: RetryPolicy };
  readonly error: ValidationErrorShape;
}

interface GetRetryPolicyCommand {
  readonly command: "sync:get-retry-policy";
  readonly params: {
    readonly scope: RetryPolicyScope;
    readonly datasourceId?: string;
  };
  readonly result: { readonly policy: RetryPolicy };
  readonly error: NotFoundErrorShape;
}

// ---- Authenticate (implement-datasource-onboarding) ----------------------
//
// The `wire-fs-sync-service` change shipped a stub authenticate-split. The
// `implement-datasource-onboarding` change reshapes the wire surface into
// its real shape:
//
//   * The retired single-shot `sync:authenticate` command is gone — every
//     authenticate flow goes through the three-command split.
//   * `sync:authenticate-start` returns a pure-data result keyed on `kind`
//     (`oauth` | `credentials-form`). The OAuth result carries only a
//     correlationId — the loopback HTTP listener inside the service drives
//     the `code → tokens` exchange via its own out-of-band events. The
//     credentials-form result carries the form schema the renderer needs to
//     render the field set.
//   * `sync:authenticate-complete` accepts ONLY `kind: "credentials-form"`
//     completions on the wire — OAuth completions arrive via the loopback
//     callback inside the service, not through the renderer.
//   * `sync:authenticate-cancel` is the symmetric idempotent cancel.
//   * The `not-implemented` stub variants are removed from both error
//     unions per design.md Decision 9.
//
// See `openspec/changes/implement-datasource-onboarding/design.md`
// Decisions 7 + 9 + 12.

/**
 * Wire-safe view of an auth intent — the renderer needs to know whether the
 * server-side flow is OAuth (browser-driven) or credentials-form (renderer
 * collects values and posts them back). For credentials-form the renderer
 * uses `formSchema` to pick the right form component.
 */
export type SerializableAuthIntent =
  | { readonly kind: "oauth"; readonly authorizeUrl: string }
  | { readonly kind: "credentials-form"; readonly schema: CredentialsSchema };

/**
 * Wire-safe payload the renderer sends with `sync:authenticate-complete`.
 * Only credentials-form completions cross the wire — OAuth completions land
 * on the service's loopback HTTP listener and are processed in-process.
 */
export type SerializableAuthCompletion = {
  readonly kind: "credentials-form";
  readonly values: Record<string, unknown>;
};

/**
 * Discriminated error union for `sync:authenticate-start`. See design.md
 * Decision 9 (stub-tag removal) and the new `service-config-missing`
 * requirement on `fs-sync-service`.
 */
export type SyncAuthenticateStartError =
  | ValidationErrorShape
  | {
      readonly tag: "service-config-missing";
      readonly path: string;
      readonly providerId: string;
      readonly message?: string;
    }
  | {
      readonly tag: "unknown-provider";
      readonly providerId: string;
      readonly message?: string;
    }
  | {
      readonly tag: "engine-error";
      readonly message: string;
    };

interface AuthenticateStartCommand {
  readonly command: "sync:authenticate-start";
  readonly params: {
    readonly providerId: ProviderId;
    readonly datasourceId?: string;
  };
  readonly result:
    | {
        readonly correlationId: string;
        readonly kind: "oauth";
      }
    | {
        readonly correlationId: string;
        readonly kind: "credentials-form";
        readonly formSchema: CredentialsSchema;
      };
  readonly error: SyncAuthenticateStartError;
}

/**
 * Discriminated error union for `sync:authenticate-complete`. The
 * `not-implemented` stub variant was retired in this change.
 */
export type SyncAuthenticateCompleteError =
  | ValidationErrorShape
  | {
      readonly tag: "correlation-expired";
      readonly correlationId: string;
      readonly message?: string;
    }
  | {
      readonly tag: "intent-kind-mismatch";
      readonly expected: "oauth" | "credentials-form";
      readonly actual: "oauth" | "credentials-form";
      readonly message?: string;
    }
  | {
      readonly tag: "engine-error";
      readonly message: string;
    };

interface AuthenticateCompleteCommand {
  readonly command: "sync:authenticate-complete";
  readonly params: {
    readonly correlationId: string;
    readonly completion: SerializableAuthCompletion;
  };
  readonly result: {
    readonly datasourceId: string;
    readonly summary: DatasourceSummary;
  };
  readonly error: SyncAuthenticateCompleteError;
}

/**
 * Discriminated error union for `sync:authenticate-cancel`. Cancel is
 * idempotent — a second cancel against the same correlationId returns
 * `{ ok: true, result: { cancelled: false } }`. The error path fires only
 * when the correlationId was malformed; absence is not an error.
 */
export type SyncAuthenticateCancelError =
  | ValidationErrorShape
  | {
      readonly tag: "correlation-not-found";
      readonly correlationId: string;
      readonly message?: string;
    };

interface AuthenticateCancelCommand {
  readonly command: "sync:authenticate-cancel";
  readonly params: {
    readonly correlationId: string;
  };
  readonly result: {
    readonly cancelled: boolean;
  };
  readonly error: SyncAuthenticateCancelError;
}

// ---- Service config (sync:get-config / sync:set-config) -------------------
//
// Per-provider OAuth app config (clientId / clientSecret) is sourced from a
// service-owned JSON file (`~/ft5/sync_app/config.json`) per design.md
// Decision 4. These commands expose that file to the desktop for a future
// settings UI; the renderer does NOT consume them in this change.

/**
 * Schema-versioned per-provider OAuth app config. The file ships at
 * `services/fs-sync/config.example.json` and is read by `ServiceConfigStore`
 * at `sync:authenticate-start` time. `redirectUri` is computed by the
 * loopback broker at session-start (the OS-allocated ephemeral port lands
 * inside the URL) — it is NOT persisted in the file.
 */
export type ServiceConfig = {
  readonly schemaVersion: 1;
  readonly providers: Readonly<
    Partial<
      Record<
        ProviderId,
        { readonly clientId: string; readonly clientSecret: string }
      >
    >
  >;
};

export type SyncGetConfigError =
  | ValidationErrorShape
  | {
      readonly tag: "io-error";
      readonly message: string;
    };

interface GetConfigCommand {
  readonly command: "sync:get-config";
  readonly params: Record<string, never>;
  readonly result: { readonly config: ServiceConfig };
  readonly error: SyncGetConfigError;
}

export type SyncSetConfigError =
  | ValidationErrorShape
  | {
      readonly tag: "io-error";
      readonly message: string;
    };

interface SetConfigCommand {
  readonly command: "sync:set-config";
  readonly params: { readonly config: ServiceConfig };
  readonly result: { readonly ok: true };
  readonly error: SyncSetConfigError;
}

// ---- Credential cleanup (sync:delete-credentials) -------------------------
//
// Symmetric counterpart of authenticate per design.md Decision 12. The
// desktop's `datasources:remove` IPC handler calls this command after
// `registry.remove` succeeds so the per-user credential entry at
// `~/ft5/sync_app/credentials.json` is cleaned up alongside the registry
// row. Best-effort cleanup — most failures still return
// `{ ok: true, result: { deleted: false } }` per the service handler spec.

export type SyncDeleteCredentialsError =
  | ValidationErrorShape
  | {
      readonly tag: "io-error";
      readonly message: string;
    };

interface DeleteCredentialsCommand {
  readonly command: "sync:delete-credentials";
  readonly params: { readonly datasourceId: string };
  readonly result: { readonly deleted: boolean };
  readonly error: SyncDeleteCredentialsError;
}

interface GetStatusCommand {
  readonly command: "sync:get-status";
  readonly params: Record<string, never>;
  readonly result: {
    readonly version: string;
    readonly serviceUuid: string;
    readonly runningJobs: number;
    readonly queuedJobs: number;
    readonly waitingNetworkJobs: number;
    readonly monitorConnected: boolean;
  };
  readonly error: ErrorShape;
}

// ---- files:* commands (wire-file-explorer-to-service design Decision 1) ---
//
// The renderer's file-explorer reads/writes provider content through these
// four commands on `services/fs-sync`. Every command's `error` is the same
// tagged shape so the renderer can branch on `.error.tag` for auth / network
// / rate-limit recovery UX without string-matching message bodies. Per-path
// failures on bulk operations (remove) travel inside `result.results`, not
// `error`; the command-level `error` fires only when the whole request was
// rejected (e.g. unknown `datasourceId`, auth revoked before any path was
// attempted).

// Canonical `FilesErrorTag` lives in `../files.ts` (the renderer-facing
// envelope file). Re-exported here so command authors keep a single import
// path for the tag set; the union is declared once and used in both
// layers.
export type { FilesErrorTag };

/**
 * Command-level error shape shared by every `files:*` command. `retryable`
 * lets the caller distinguish a transient failure (network hiccup, rate
 * limit) from a terminal one (auth revoked). `retryAfterMs` is populated
 * only when the provider surfaced a concrete backoff (typically paired
 * with `tag: "rate-limited"`); callers MUST treat its absence as
 * "unknown — use your own policy", not as "retry immediately".
 *
 * `existingPath` is populated only when `tag === "conflict"` (per
 * add-engine-rename-download design.md Decision 7) — surfaces the
 * colliding remote sibling path so the renderer's
 * ConflictResolutionDialog can prompt the user with the exact path.
 * Flat-optional shape mirrors `retryAfterMs` (NOT a discriminated
 * union) so callers can read the field without re-narrowing on tag.
 *
 * `existingSize` + `existingModifiedAt` are populated by the
 * `files:download` conflict gate (per add-download-overwrite-confirm
 * design.md Decision 3) from the same `fs.stat(toPath)` call that
 * detects existence — `stats.size` and `stats.mtime.toISOString()`
 * respectively. Both are flat-optional. Rename callers MAY populate
 * either field if the strategy already has the data on hand, but are
 * NOT required to — existing rename callsites work unchanged with both
 * absent. The renderer's RenameConflictDialog renders the hint block
 * when at least one is present and omits it when both are absent.
 */
export interface FilesCommandErrorShape extends ErrorShape {
  readonly tag: FilesErrorTag;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly existingPath?: string;
  readonly existingSize?: number;
  readonly existingModifiedAt?: string;
  /**
   * Populated only when `tag === "conflict"` is surfaced from the
   * `files:upload` concurrent-target guard (per
   * migrate-upload-orchestration-out-of-engine design.md Decision 10 +
   * spec scenario "Concurrent-target upload conflict guard"). Carries
   * the `uploadJobId` of the FIRST in-flight upload occupying the
   * `(datasourceId, targetPath)` slot — the renderer surfaces it in a
   * Sonner error toast pointing at the existing toast. Flat-optional
   * shape mirrors `existingPath` / `retryAfterMs` (NOT a discriminated
   * union) so callers can read the field without re-narrowing on tag.
   *
   * Conflicts on `files:rename` continue to use `existingPath` only —
   * rename does not have a job-identity concept and the colliding
   * sibling path is the only useful piece of context.
   */
  readonly existingUploadJobId?: string;
}

// Canonical `FilesRemoveEntryResult` lives in `../files.ts`. Re-exported
// here so callers working against the sync-service surface keep a single
// import path; the union is declared once and shared across layers.
export type { FilesRemoveEntryResult };

// `files:list` (add-engine-listdirectory-pagination §5.2). The request gains
// optional `cursor` (opaque continuation token from the prior page) and
// `pageSize` (desired entries-per-page; strategies clamp + default). The
// result gains required `nextCursor: string | null` (the next page's opaque
// cursor, or `null` when exhausted). `truncated` is RETAINED but DERIVED by
// the handler as `nextCursor !== null` (Decision 6 — no longer hard-coded).
interface FilesListCommand {
  readonly command: "files:list";
  readonly params: {
    readonly datasourceId: string;
    readonly path: string;
    readonly cursor?: string;
    readonly pageSize?: number;
  };
  readonly result: {
    readonly entries: readonly FileEntry[];
    readonly truncated: boolean;
    readonly nextCursor: string | null;
  };
  readonly error: FilesCommandErrorShape;
}

interface FilesStatCommand {
  readonly command: "files:stat";
  readonly params: {
    readonly datasourceId: string;
    readonly path: string;
  };
  readonly result: {
    readonly entry: FileEntry;
  };
  readonly error: FilesCommandErrorShape;
}

interface FilesSearchCommand {
  readonly command: "files:search";
  readonly params: {
    readonly datasourceId: string;
    readonly query: string;
    readonly path: string;
  };
  readonly result: {
    readonly entries: readonly FileEntry[];
    readonly truncated: boolean;
  };
  readonly error: FilesCommandErrorShape;
}

// `files:remove` addresses each entry by `handle` (the authoritative,
// unambiguous engine ID) while preserving `path` for the response's
// per-path result matching. `kind` is passed straight to the engine's
// unified `delete(target, entryKind)`, letting the handler skip a second
// `getMetadata` round-trip — and skipping that round-trip is the whole
// point of this shape, since `getMetadata({ kind: "path", ... })` is itself
// ambiguity-vulnerable on providers that allow multiple entries with
// the same path (Google Drive).
interface FilesRemoveTargetShape {
  readonly path: string;
  readonly handle: string;
  readonly kind: EntryKind;
}

interface FilesRemoveCommand {
  readonly command: "files:remove";
  readonly params: {
    readonly datasourceId: string;
    readonly targets: readonly FilesRemoveTargetShape[];
  };
  readonly result: {
    readonly results: readonly FilesRemoveEntryResult[];
  };
  readonly error: FilesCommandErrorShape;
}

// `files:rename` (add-engine-rename-download §12). The handler resolves
// the engine client for `datasourceId`, builds the engine `Target` from
// `path` plus optional `handle` (the same handle-first convention as
// `files:remove`), and forwards `(target, newName, conflictPolicy)` to
// `client.rename`. The handler does NOT inspect or carry `kind` — the
// strategy resolves kind within its own provider context (per
// design.md Decision 1). Error envelope's `existingPath` lights up
// for `tag: "conflict"` per design.md Decision 7.
interface FilesRenameCommand {
  readonly command: "files:rename";
  readonly params: {
    readonly datasourceId: string;
    readonly path: string;
    readonly handle?: string;
    readonly newName: string;
    readonly conflictPolicy: "fail" | "overwrite" | "keep-both";
  };
  readonly result: {
    readonly entry: FileEntry;
  };
  readonly error: FilesCommandErrorShape;
}

// `files:download` (add-engine-rename-download §13). The handler validates
// `toPath`, mints a `downloadJobId`, creates an AbortController, drives the
// engine's `downloadFile` retry loop (resume-after-mid-stream-auth-expired
// per design.md Decision 3), pipes the response stream to disk, runs the
// post-pipe byte-count + integrity-hash assertions, emits `downloading` /
// `file-downloaded` / `download-failed` / `download-cancelled` derived
// events on the IPC event channel, and replies with the saved-file
// summary. Cancel surface lives on the sibling `sync:cancel-download`
// command. Error envelope tags collapse the four sub-failures
// (range-not-supported, range-mismatch, byte-count-mismatch,
// integrity-failed) under `tag: "other"` per spec.md line 73 / 115; the
// distinct `tag: "cancelled"` exists for user-driven cancels per spec
// line 78.
// `conflictPolicy` was added to the `files:download` wire shape by
// `add-download-overwrite-confirm` (design.md Decision 1). Optional with
// default-to-`"fail"` semantics enforced by the handler — a request that
// omits the field is treated as `"fail"`, which gates on the destination's
// existence and returns a `tag: "conflict"` envelope (with `existingPath`,
// `existingSize`, `existingModifiedAt` hints) when the file is present.
// Reuses the rename `conflictPolicy` enum verbatim; distinct from upload's
// `ConflictPolicy` (`"overwrite" | "duplicate" | "skip"`).
interface FilesDownloadCommand {
  readonly command: "files:download";
  readonly params: {
    readonly datasourceId: string;
    readonly path: string;
    readonly toPath: string;
    readonly conflictPolicy?: "fail" | "overwrite" | "keep-both";
  };
  readonly result: {
    readonly savedPath: string;
    readonly bytes: number;
  };
  readonly error: FilesCommandErrorShape;
}

// `files:upload` (migrate-upload-orchestration-out-of-engine §9). The
// service handler validates the request envelope, mints a service-level
// `uploadJobId`, creates an AbortController, registers the in-flight job
// in the `UploadRegistry`, and invokes `client.uploadFile(parent, file,
// { signal, onProgress })` on the resolved engine client. The handler
// emits four uploadJobId-keyed lifecycle events on `sync:event-stream`
// (`uploading` / `file-created` / `upload-failed` / `upload-cancelled`)
// — the engine no longer participates in upload event emission. Cancel
// surface lives on the sibling `sync:cancel-upload` command. Concurrent
// uploads to the same `(datasourceId, targetPath)` are rejected with
// `tag: "conflict"` BEFORE any engine call (Decision 10 — the
// `existingUploadJobId` field on `FilesCommandErrorShape` carries the
// pre-existing job's id so the renderer can surface it in a Sonner
// error toast). The `existingPath` field on the same shape carries the
// disputed `targetPath`.
interface FilesUploadCommand {
  readonly command: "files:upload";
  readonly params: {
    readonly datasourceId: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly conflictPolicy: ConflictPolicy;
  };
  readonly result: {
    readonly uploadJobId: string;
  };
  readonly error: FilesCommandErrorShape;
}

// `sync:cancel-download` (add-engine-rename-download §13.15-§13.16).
// Cancels an in-flight `files:download` identified by its
// `downloadJobId`. Idempotent — cancel of an unknown / already-terminal
// job resolves with `cancelled: false` rather than erroring; cancel of a
// live job invokes `abortController.abort()`, the in-flight pipeline
// rejects with AbortError, the handler emits a single
// `download-cancelled` event, and the original `files:download`
// promise resolves with `{ ok: false, error: { tag: "cancelled" } }`.
interface SyncCancelDownloadCommand {
  readonly command: "sync:cancel-download";
  readonly params: {
    readonly downloadJobId: string;
  };
  readonly result: {
    readonly cancelled: boolean;
  };
  readonly error: ValidationErrorShape;
}

// ---- downloads:* commands (add-engine-rename-download §3.1/§3.2) ---------
//
// `downloads:list-active` returns the live snapshot of in-flight download
// jobs the service is tracking in its `DownloadRegistry` (see design.md
// Decision 3 + tasks §11). Each `DownloadJob` is keyed by the per-job
// business-domain id (`downloadJobId`) — the engine bus's
// `(datasourceId, path)` is reverse-indexed in the registry, but the
// list response uses the consumer-facing key.
//
// The renderer hydrates its toaster strip on first connect from this
// snapshot; the live progress feed thereafter arrives through fs-sync's
// `downloading` events on the `sync:subscribe-events` stream.

/**
 * One in-flight download job, as observed by the service's
 * `DownloadRegistry`. `bytesDownloaded` advances over the job's lifetime;
 * `contentLength` is `null` when the provider did not advertise it
 * upfront (the renderer renders an indeterminate progress bar in that
 * case). `startedAt` is epoch milliseconds (UTC) and is the response's
 * stable ordering key.
 */
export interface DownloadJob {
  readonly downloadJobId: string;
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly bytesDownloaded: number;
  readonly contentLength: number | null;
  readonly startedAt: number;
}

/**
 * Wire-shape alias for the `downloads:list-active` request. Empty params
 * — the service returns all live jobs across every datasource. (Filtered
 * variants are out of scope for v1; the renderer fans out the snapshot
 * across its toaster strip.)
 */
export type DownloadsListActiveRequest = Record<string, never>;

/**
 * Wire-shape alias for the `downloads:list-active` response, expressed
 * as the standard tagged envelope used across the sync-service surface.
 * Subscribers branch on `ok` to pick out `value.jobs` vs `error`.
 */
export type DownloadsListActiveResponse =
  | { readonly ok: true; readonly value: { readonly jobs: readonly DownloadJob[] } }
  | { readonly ok: false; readonly error: FilesCommandErrorShape };

interface DownloadsListActiveCommand {
  readonly command: "downloads:list-active";
  readonly params: DownloadsListActiveRequest;
  readonly result: { readonly jobs: readonly DownloadJob[] };
  readonly error: FilesCommandErrorShape;
}

// ---- uploads:* commands (migrate-upload-orchestration-out-of-engine §7) ---
//
// `uploads:list-active` returns the live snapshot of in-flight upload jobs
// the service is tracking in its `UploadRegistry` (see design.md Decision 6
// + tasks §10.1). Each `UploadJob` is keyed by the per-job business-domain
// id (`uploadJobId`) — the registry's reverse-index on
// `(datasourceId, targetPath)` is internal to the service and never
// surfaces on the wire.
//
// The renderer hydrates its toaster strip on first connect from this
// snapshot; the live progress feed thereafter arrives through fs-sync's
// `uploading` / `file-created` / `upload-failed` / `upload-cancelled`
// events on the `sync:subscribe-events` stream.
//
// `abortController` is NOT part of the wire shape — it is process-local
// state only present on the in-memory registry entry, never serialized
// out. The wire `UploadJob` mirrors `DownloadJob` exactly minus the
// upload-vs-download field renames (`bytesUploaded`, `contentLength`).

/**
 * One in-flight upload job, as observed by the service's
 * `UploadRegistry`. `bytesUploaded` advances over the job's lifetime;
 * `contentLength` is `null` until the strategy reports it via
 * `onProgress(loaded, total)` (the value comes from `fs.stat` of the
 * local source file at upload start, so it is typically known
 * immediately and rarely-`null`). `startedAt` is epoch milliseconds
 * (UTC) and is the response's stable ordering key.
 */
export interface UploadJob {
  readonly uploadJobId: string;
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly bytesUploaded: number;
  readonly contentLength: number | null;
  readonly startedAt: number;
}

/**
 * Wire-shape alias for the `uploads:list-active` request. Empty params
 * — the service returns all live uploads across every datasource. Mirrors
 * `DownloadsListActiveRequest`.
 */
export type UploadsListActiveRequest = Record<string, never>;

/**
 * Wire-shape alias for the `uploads:list-active` response, expressed
 * as the standard tagged envelope used across the sync-service surface.
 * Subscribers branch on `ok` to pick out `value.jobs` vs `error`.
 */
export type UploadsListActiveResponse =
  | { readonly ok: true; readonly value: { readonly jobs: readonly UploadJob[] } }
  | { readonly ok: false; readonly error: FilesCommandErrorShape };

interface UploadsListActiveCommand {
  readonly command: "uploads:list-active";
  readonly params: UploadsListActiveRequest;
  readonly result: { readonly jobs: readonly UploadJob[] };
  readonly error: FilesCommandErrorShape;
}

// `sync:cancel-upload` (migrate-upload-orchestration-out-of-engine §7.3 +
// fs-sync-service spec "sync:cancel-upload RPC"). Cancels an in-flight
// `files:upload` identified by its `uploadJobId`. Idempotent — cancel of an
// unknown / already-terminal job resolves with `cancelled: false` rather
// than erroring; cancel of a live job invokes
// `entry.abortController.abort()`, the in-flight strategy rejects with
// `DatasourceError { tag: "cancelled" }`, the `files:upload` handler emits
// a single `upload-cancelled` event, and the original `files:upload`
// promise rejects with the cancelled error. Mirrors `sync:cancel-download`.
interface SyncCancelUploadCommand {
  readonly command: "sync:cancel-upload";
  readonly params: {
    readonly uploadJobId: string;
  };
  readonly result: {
    readonly cancelled: boolean;
  };
  readonly error: ValidationErrorShape;
}

// ---- Command map + derived helpers ---------------------------------------

export interface CommandMap {
  // migrate-upload-orchestration-out-of-engine §7.4 — `"sync:enqueue-upload"`
  // entry removed. See the EnqueueUploadCommand tombstone above.
  "sync:enqueue-mirror": EnqueueMirrorCommand;
  "sync:list-jobs": ListJobsCommand;
  "sync:get-job": GetJobCommand;
  "sync:cancel-job": CancelJobCommand;
  "sync:subscribe-events": SubscribeEventsCommand;
  "sync:unsubscribe-events": UnsubscribeEventsCommand;
  "sync:set-retry-policy": SetRetryPolicyCommand;
  "sync:get-retry-policy": GetRetryPolicyCommand;
  "sync:authenticate-start": AuthenticateStartCommand;
  "sync:authenticate-complete": AuthenticateCompleteCommand;
  "sync:authenticate-cancel": AuthenticateCancelCommand;
  "sync:get-config": GetConfigCommand;
  "sync:set-config": SetConfigCommand;
  "sync:delete-credentials": DeleteCredentialsCommand;
  "sync:get-status": GetStatusCommand;
  "files:list": FilesListCommand;
  "files:stat": FilesStatCommand;
  "files:search": FilesSearchCommand;
  "files:remove": FilesRemoveCommand;
  "files:rename": FilesRenameCommand;
  "files:download": FilesDownloadCommand;
  "files:upload": FilesUploadCommand;
  "sync:cancel-download": SyncCancelDownloadCommand;
  "downloads:list-active": DownloadsListActiveCommand;
  "uploads:list-active": UploadsListActiveCommand;
  "sync:cancel-upload": SyncCancelUploadCommand;
}

export type CommandName = keyof CommandMap;

export type CommandParams<N extends CommandName> = CommandMap[N]["params"];
export type CommandResult<N extends CommandName> = CommandMap[N]["result"];
export type CommandError<N extends CommandName> = CommandMap[N]["error"];

// The full set of command names as a runtime-accessible readonly tuple —
// `Object.keys(commandMap)` at runtime isn't statically typed and the
// dispatcher needs the enumerated set for exhaustive switch coverage.
export const COMMAND_NAMES: ReadonlyArray<CommandName> = [
  // migrate-upload-orchestration-out-of-engine §7.4 — `"sync:enqueue-upload"`
  // entry removed.
  "sync:enqueue-mirror",
  "sync:list-jobs",
  "sync:get-job",
  "sync:cancel-job",
  "sync:subscribe-events",
  "sync:unsubscribe-events",
  "sync:set-retry-policy",
  "sync:get-retry-policy",
  "sync:authenticate-start",
  "sync:authenticate-complete",
  "sync:authenticate-cancel",
  "sync:get-config",
  "sync:set-config",
  "sync:delete-credentials",
  "sync:get-status",
  "files:list",
  "files:stat",
  "files:search",
  "files:remove",
  "files:rename",
  "files:download",
  "files:upload",
  "sync:cancel-download",
  "downloads:list-active",
  "uploads:list-active",
  "sync:cancel-upload",
] as const;
