// Renderer-facing request / response types for `window.api.sync.*`.
//
// Style decision (wire-fs-sync-service task 1.1): HYBRID — flat result types
// for happy-path calls (matching the `DATASOURCES_*Response` pattern in
// `datasources.ts`), and a typed `{ result } | { error }` union ONLY for the
// two calls the spec explicitly names as fallible at the renderer boundary:
// `enqueueMirror` (can fail with `sync-already-running`) and `cancelJob`
// (can fail with `not-cancelable`).
//
// These types deliberately mirror — but do NOT re-export — the wire contract
// shapes from `@ft5/ipc-contracts/sync-service`. The renderer must NEVER
// import wire-format types like `RequestFrame`. The `listJobs` response adds
// the `derivedSyncingDatasourceIds` field computed by the main-process IPC
// handler (see spec "Main-process IPC proxy translates renderer calls to
// service commands").

import type {
  AuthIntent,
  AuthResult,
  DatasourceType,
} from "../fs-datasource-engine.js";
import type {
  BackoffStrategy,
  ConflictPolicy,
  JobStatus,
  JobSummary,
  NotCancelableErrorShape,
  RetryPolicy,
  RetryPolicyScope,
  SyncAlreadyRunningErrorShape,
} from "../sync-service/commands.js";

// ---- listJobs ------------------------------------------------------------

export interface SyncListJobsRequest {
  readonly filter?: {
    readonly statuses?: ReadonlyArray<JobStatus>;
    readonly datasourceId?: string;
  };
}

export interface SyncListJobsResponse {
  readonly jobs: ReadonlyArray<JobSummary>;
  /**
   * Set of `datasourceId`s for which at least one returned job has
   * `kind === 'sync'` and `status ∈ {running, queued, waiting-network}`.
   * Computed by the main-process handler, NOT by the service.
   */
  readonly derivedSyncingDatasourceIds: ReadonlyArray<string>;
}

// ---- getJob --------------------------------------------------------------

export interface SyncGetJobRequest {
  readonly jobId: string;
}

export interface SyncGetJobResponse {
  readonly job: JobSummary | null;
}

// ---- enqueueUpload -------------------------------------------------------

export interface SyncEnqueueUploadRequest {
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly conflictPolicy: ConflictPolicy;
}

export interface SyncEnqueueUploadResponse {
  readonly jobId: string;
}

// ---- enqueueMirror (FALLIBLE) -------------------------------------------

export interface SyncEnqueueMirrorRequest {
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly conflictPolicy?: ConflictPolicy;
}

export type SyncEnqueueMirrorResponse =
  | { readonly jobId: string }
  | { readonly error: SyncAlreadyRunningErrorShape };

// ---- cancelJob (FALLIBLE) ------------------------------------------------

export interface SyncCancelJobRequest {
  readonly jobId: string;
}

export type SyncCancelJobResponse =
  | { readonly cancelled: true }
  | { readonly error: NotCancelableErrorShape };

// ---- authenticate --------------------------------------------------------

export interface SyncAuthenticateRequest {
  readonly datasourceId: string;
  readonly type: DatasourceType;
  readonly intent: AuthIntent;
}

export interface SyncAuthenticateResponse {
  readonly authResult: AuthResult;
}

// ---- getStatus -----------------------------------------------------------

export type SyncGetStatusRequest = void;

export interface SyncGetStatusResponse {
  readonly version: string;
  readonly serviceUuid: string;
  readonly runningJobs: number;
  readonly queuedJobs: number;
  readonly waitingNetworkJobs: number;
}

// ---- getRetryPolicy ------------------------------------------------------

export interface SyncGetRetryPolicyRequest {
  readonly scope: RetryPolicyScope;
  readonly datasourceId?: string;
}

export interface SyncGetRetryPolicyResponse {
  readonly policy: RetryPolicy;
}

// ---- setRetryPolicy ------------------------------------------------------

export interface SyncSetRetryPolicyRequest {
  readonly scope: RetryPolicyScope;
  readonly datasourceId?: string;
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly backoffStrategy: BackoffStrategy;
  readonly maxAgeMs?: number;
}

export interface SyncSetRetryPolicyResponse {
  readonly policy: RetryPolicy;
}
