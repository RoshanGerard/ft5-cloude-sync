// Barrel export for the sync-service IPC contract surface. Imported by the
// service runtime (`services/fs-sync/src/`) and by any client that needs to
// speak its protocol (including the desktop app, once wired in a follow-up
// change).

export type {
  ErrorShape,
  EventFrame,
  Frame,
  RequestFrame,
  ResponseFrame,
} from "./frames.js";

export type {
  BackoffStrategy,
  CommandError,
  CommandMap,
  CommandName,
  CommandParams,
  CommandResult,
  ConflictPolicy,
  DownloadJob,
  DownloadsListActiveRequest,
  DownloadsListActiveResponse,
  FilesCommandErrorShape,
  FilesErrorTag,
  FilesRemoveEntryResult,
  JobKind,
  JobStatus,
  JobSummary,
  NotCancelableErrorShape,
  NotFoundErrorShape,
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
  UnknownCommandErrorShape,
  ValidationErrorShape,
} from "./commands.js";
export { COMMAND_NAMES } from "./commands.js";

export type {
  AuthCancelledPayload,
  AuthCompletedPayload,
  AuthFailedPayload,
  AuthFailedTag,
  AuthInitiatedPayload,
  AuthTimeoutPayload,
  CredentialPersistedPayload,
  CredentialStorePermissionViolationPayload,
  DownloadCancelledPayload,
  DownloadFailedPayload,
  DownloadingPayload,
  EventName,
  EventPayloadMap,
  FileDownloadedPayload,
  JobCancelledPayload,
  JobCompletedPayload,
  JobEnqueuedPayload,
  JobFailedPayload,
  JobProgressPayload,
  JobRecoveredPayload,
  JobStartedPayload,
  NetworkAvailablePayload,
  OAuthOpenUrlPayload,
  ServiceEvent,
  SourceUnavailablePayload,
  SyncCompletedPayload,
} from "./events.js";
export { EVENT_NAMES } from "./events.js";

export type { ServiceErrorTag } from "./errors.js";
export { SERVICE_ERROR_TAGS } from "./errors.js";
