// Barrel export for the renderer-facing sync-service IPC contract surface.
// Imported by the desktop main process (IPC handlers), the preload script,
// and the renderer. This module MUST NOT re-export any transport / wire
// symbols (e.g. `RequestFrame`, `Frame`) from `../sync-service/`; those are
// strictly for the main ↔ service daemon hop.

export type {
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
  SyncAuthenticateRequest,
  SyncAuthenticateResponse,
  SyncGetStatusRequest,
  SyncGetStatusResponse,
  SyncGetRetryPolicyRequest,
  SyncGetRetryPolicyResponse,
  SyncSetRetryPolicyRequest,
  SyncSetRetryPolicyResponse,
} from "./requests.js";

export type {
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
