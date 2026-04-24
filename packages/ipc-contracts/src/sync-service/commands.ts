// IPC command surface for `services/fs-sync`. Every command the service
// dispatches SHALL appear exactly once in `CommandMap` below. The controller
// uses `CommandName`, `CommandParams<N>`, `CommandResult<N>`, and
// `CommandError<N>` to build and correlate Request / Response frames with
// end-to-end type safety.
//
// See design.md D2+D3 and the base spec "IPC command surface" requirement.

import type { CredentialsSchema } from "../datasources.js";
import type {
  AuthIntent,
  AuthResult,
  DatasourceType,
  SerializedDatasourceError,
} from "../fs-datasource-engine.js";
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

interface EnqueueUploadCommand {
  readonly command: "sync:enqueue-upload";
  readonly params: {
    readonly datasourceId: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly conflictPolicy: ConflictPolicy;
  };
  readonly result: { readonly jobId: string };
  readonly error: ValidationErrorShape;
}

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

interface AuthenticateCommand {
  readonly command: "sync:authenticate";
  readonly params: {
    readonly datasourceId: string;
    readonly type: DatasourceType;
    readonly intent: AuthIntent;
  };
  readonly result: { readonly authResult: AuthResult };
  readonly error:
    | ValidationErrorShape
    | {
        readonly tag: "authentication-failed";
        readonly message: string;
        readonly details: SerializedDatasourceError<DatasourceType>;
      };
}

// ---- Authenticate split (design.md Decision 10) --------------------------
//
// `AuthIntent` carries closures (`completeWith` / `submit`) that cannot cross
// the JSON-over-socket wire or the Electron structured-clone IPC boundary.
// The split pair replaces the single-shot `sync:authenticate` with:
//   1. `sync:authenticate-start` — service runs `engine.authenticate`, stashes
//      the live intent in an in-memory correlation map, returns a pure-data
//      descriptor.
//   2. `sync:authenticate-complete` — caller supplies the correlation id and
//      the user's response (OAuth code / form values); service looks up the
//      stashed intent and dispatches on its kind.
// The old `AuthenticateCommand` stays live until the atomic swap in the
// section-5 handler / registration replacement.

/**
 * Wire-safe view of {@link AuthIntent}: the same discriminated union with
 * the function fields stripped, leaving only data that JSON-serializes.
 */
export type SerializableAuthIntent =
  | { readonly kind: "oauth"; readonly authorizeUrl: string }
  | { readonly kind: "credentials-form"; readonly schema: CredentialsSchema };

/**
 * Wire-safe payload the caller sends with `sync:authenticate-complete` —
 * whichever response the user produced for the intent they were shown.
 */
export type SerializableAuthCompletion =
  | { readonly kind: "oauth"; readonly code: string }
  | {
      readonly kind: "credentials-form";
      readonly values: Record<string, unknown>;
    };

interface AuthenticateStartCommand {
  readonly command: "sync:authenticate-start";
  readonly params: {
    readonly datasourceId: string;
    readonly type: DatasourceType;
  };
  readonly result: {
    readonly correlationId: string;
    readonly intent: SerializableAuthIntent;
  };
  readonly error:
    | ValidationErrorShape
    | {
        readonly tag: "authentication-failed";
        readonly message: string;
        readonly details: SerializedDatasourceError<DatasourceType>;
      }
    | {
        // Present while the service-side handler ships as a stub (see
        // openspec design.md Decision 11). The follow-up change
        // `implement-datasource-onboarding` removes this variant; callers
        // should treat it defensively as "service does not yet support
        // this operation" rather than as a domain error.
        readonly tag: "not-implemented";
        readonly message: string;
      };
}

interface AuthenticateCompleteCommand {
  readonly command: "sync:authenticate-complete";
  readonly params: {
    readonly correlationId: string;
    readonly completion: SerializableAuthCompletion;
  };
  readonly result: { readonly authResult: AuthResult };
  readonly error:
    | ValidationErrorShape
    | {
        readonly tag: "authentication-failed";
        readonly message: string;
        readonly details: SerializedDatasourceError<DatasourceType>;
      }
    | {
        readonly tag: "correlation-expired";
        readonly message: string;
        readonly details?: unknown;
      }
    | {
        readonly tag: "correlation-kind-mismatch";
        readonly message: string;
        readonly details: {
          readonly expectedKind: "oauth" | "credentials-form";
          readonly receivedKind: "oauth" | "credentials-form";
        };
      }
    | {
        // Present while the service-side handler ships as a stub (see
        // openspec design.md Decision 11). The follow-up change
        // `implement-datasource-onboarding` removes this variant; callers
        // should treat it defensively as "service does not yet support
        // this operation" rather than as a domain error.
        readonly tag: "not-implemented";
        readonly message: string;
      };
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

// ---- Command map + derived helpers ---------------------------------------

export interface CommandMap {
  "sync:enqueue-upload": EnqueueUploadCommand;
  "sync:enqueue-mirror": EnqueueMirrorCommand;
  "sync:list-jobs": ListJobsCommand;
  "sync:get-job": GetJobCommand;
  "sync:cancel-job": CancelJobCommand;
  "sync:subscribe-events": SubscribeEventsCommand;
  "sync:unsubscribe-events": UnsubscribeEventsCommand;
  "sync:set-retry-policy": SetRetryPolicyCommand;
  "sync:get-retry-policy": GetRetryPolicyCommand;
  "sync:authenticate": AuthenticateCommand;
  "sync:authenticate-start": AuthenticateStartCommand;
  "sync:authenticate-complete": AuthenticateCompleteCommand;
  "sync:get-status": GetStatusCommand;
}

export type CommandName = keyof CommandMap;

export type CommandParams<N extends CommandName> = CommandMap[N]["params"];
export type CommandResult<N extends CommandName> = CommandMap[N]["result"];
export type CommandError<N extends CommandName> = CommandMap[N]["error"];

// The full set of command names as a runtime-accessible readonly tuple —
// `Object.keys(commandMap)` at runtime isn't statically typed and the
// dispatcher needs the enumerated set for exhaustive switch coverage.
export const COMMAND_NAMES: ReadonlyArray<CommandName> = [
  "sync:enqueue-upload",
  "sync:enqueue-mirror",
  "sync:list-jobs",
  "sync:get-job",
  "sync:cancel-job",
  "sync:subscribe-events",
  "sync:unsubscribe-events",
  "sync:set-retry-policy",
  "sync:get-retry-policy",
  "sync:authenticate",
  "sync:authenticate-start",
  "sync:authenticate-complete",
  "sync:get-status",
] as const;
