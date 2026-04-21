// Typed error shapes returned on the Response-frame `error` field. Mirrors
// the set of tags the service's command handlers and dispatcher produce.

export type {
  NotCancelableErrorShape,
  NotFoundErrorShape,
  SyncAlreadyRunningErrorShape,
  UnknownCommandErrorShape,
  ValidationErrorShape,
} from "./commands.js";

export type ServiceErrorTag =
  | "sync-already-running"
  | "not-found"
  | "not-cancelable"
  | "unknown-command"
  | "validation-error"
  | "authentication-failed"
  | "parse-error"
  | "internal-error";

export const SERVICE_ERROR_TAGS: ReadonlyArray<ServiceErrorTag> = [
  "sync-already-running",
  "not-found",
  "not-cancelable",
  "unknown-command",
  "validation-error",
  "authentication-failed",
  "parse-error",
  "internal-error",
] as const;
