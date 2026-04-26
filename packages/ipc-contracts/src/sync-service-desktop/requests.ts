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
  CredentialsSchema,
  DatasourceSummary,
  ProviderId,
} from "../datasources.js";
import type {
  BackoffStrategy,
  ConflictPolicy,
  JobStatus,
  JobSummary,
  NotCancelableErrorShape,
  RetryPolicy,
  RetryPolicyScope,
  SerializableAuthCompletion,
  SerializableAuthIntent,
  ServiceConfig,
  SyncAlreadyRunningErrorShape,
  SyncAuthenticateCancelError,
  SyncAuthenticateCompleteError,
  SyncAuthenticateStartError,
  SyncDeleteCredentialsError,
  SyncGetConfigError,
  SyncSetConfigError,
} from "../sync-service/commands.js";

// Re-export the wire-safe descriptors so renderer + preload can import
// them from the renderer-facing subpath without reaching into the wire
// contract directly.
export type {
  SerializableAuthCompletion,
  SerializableAuthIntent,
  ServiceConfig,
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

// ---- authenticateStart / authenticateComplete / authenticateCancel -------
//
// Per `implement-datasource-onboarding` design.md Decisions 7 + 9, the
// renderer's authenticate flow is the three-command split. The retired
// single-shot `SyncAuthenticate*` request/response pair is gone. OAuth
// completions land via the loopback HTTP listener inside the service, so
// the wire's `authenticate-complete` handler is credentials-form only.
//
// Each fallible call returns the discriminated `{ ok: true, result } |
// { ok: false, error }` union — distinct from the older
// `enqueueMirror`-style hybrid because the renderer's failure-state UI
// needs to branch on `error.tag` (e.g., `service-config-missing` shows
// the dedicated copy in `oauth-form.tsx`).

export interface SyncAuthenticateStartRequest {
  readonly providerId: ProviderId;
  readonly datasourceId?: string;
}

export type SyncAuthenticateStartResponse =
  | {
      readonly ok: true;
      readonly result:
        | { readonly correlationId: string; readonly kind: "oauth" }
        | {
            readonly correlationId: string;
            readonly kind: "credentials-form";
            readonly formSchema: CredentialsSchema;
          };
    }
  | { readonly ok: false; readonly error: SyncAuthenticateStartError };

export interface SyncAuthenticateCompleteRequest {
  readonly correlationId: string;
  readonly completion: SerializableAuthCompletion;
}

export type SyncAuthenticateCompleteResponse =
  | {
      readonly ok: true;
      readonly result: {
        readonly datasourceId: string;
        readonly summary: DatasourceSummary;
      };
    }
  | { readonly ok: false; readonly error: SyncAuthenticateCompleteError };

export interface SyncAuthenticateCancelRequest {
  readonly correlationId: string;
}

export type SyncAuthenticateCancelResponse =
  | { readonly ok: true; readonly result: { readonly cancelled: boolean } }
  | { readonly ok: false; readonly error: SyncAuthenticateCancelError };

// ---- getConfig / setConfig (design.md Decision 4) -----------------------
//
// Round-trip for the per-provider OAuth app config (`~/ft5/sync_app/
// config.json`). The renderer does NOT call these in this change — they
// exist for a future settings UI. Round-trip coverage proves the contract
// surface from the desktop test client.

export type SyncGetConfigRequest = void;

export type SyncGetConfigResponse =
  | { readonly ok: true; readonly result: { readonly config: ServiceConfig } }
  | { readonly ok: false; readonly error: SyncGetConfigError };

export interface SyncSetConfigRequest {
  readonly config: ServiceConfig;
}

export type SyncSetConfigResponse =
  | { readonly ok: true; readonly result: { readonly ok: true } }
  | { readonly ok: false; readonly error: SyncSetConfigError };

// ---- deleteCredentials (design.md Decision 12) --------------------------
//
// Symmetric counterpart of authenticate. The desktop's `datasources:remove`
// IPC handler calls this command after `registry.remove` succeeds so the
// per-user credential entry at `~/ft5/sync_app/credentials.json` is cleaned
// up alongside the registry row. Best-effort cleanup — most failures still
// return `{ ok: true, result: { deleted: false } }`.

export interface SyncDeleteCredentialsRequest {
  readonly datasourceId: string;
}

export type SyncDeleteCredentialsResponse =
  | { readonly ok: true; readonly result: { readonly deleted: boolean } }
  | { readonly ok: false; readonly error: SyncDeleteCredentialsError };

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
