// Barrel export for the renderer-facing sync-service IPC contract surface.
// Imported by the desktop main process (IPC handlers), the preload script,
// and the renderer. This module MUST NOT re-export any transport / wire
// symbols (e.g. `RequestFrame`, `Frame`) from `../sync-service/`; those are
// strictly for the main ↔ service daemon hop.

// Renderer-relevant subset of the wire-side `JobSummary` shape (and the
// constituent enums). Re-exported here so renderer code never has to reach
// into the wire subpath for the per-job row type that arrives through
// `sync-state-seed` and `sync:list-jobs`.
export type {
  ConflictPolicy,
  JobKind,
  JobStatus,
  JobSummary,
} from "../sync-service/commands.js";

export type {
  SerializableAuthCompletion,
  SerializableAuthIntent,
  ServiceConfig,
  SyncListJobsRequest,
  SyncListJobsResponse,
  SyncGetJobRequest,
  SyncGetJobResponse,
  SyncEnqueueUploadRequest,
  SyncEnqueueUploadResponse,
  SyncEnqueueMirrorRequest,
  SyncEnqueueMirrorResponse,
  SyncCancelJobRequest,
  SyncCancelJobResponse,
  SyncCancelDownloadRequest,
  SyncCancelDownloadResponse,
  SyncAuthenticateStartRequest,
  SyncAuthenticateStartResponse,
  SyncAuthenticateCompleteRequest,
  SyncAuthenticateCompleteResponse,
  SyncAuthenticateCancelRequest,
  SyncAuthenticateCancelResponse,
  SyncGetConfigRequest,
  SyncGetConfigResponse,
  SyncSetConfigRequest,
  SyncSetConfigResponse,
  SyncDeleteCredentialsRequest,
  SyncDeleteCredentialsResponse,
  SyncGetStatusRequest,
  SyncGetStatusResponse,
  SyncGetRetryPolicyRequest,
  SyncGetRetryPolicyResponse,
  SyncSetRetryPolicyRequest,
  SyncSetRetryPolicyResponse,
} from "./requests.js";

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
  ServiceDisconnectedPayload,
  ServiceReconnectedPayload,
  SourceUnavailablePayload,
  SyncCompletedPayload,
  SyncEvent,
  SyncEventKind,
  SyncEventPayloadMap,
  SyncStateSeedPayload,
} from "./events.js";
export { SYNC_EVENT_KINDS } from "./events.js";

export type { SyncChannelName } from "./channels.js";
export { SYNC_CHANNELS } from "./channels.js";
