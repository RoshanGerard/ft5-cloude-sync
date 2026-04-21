// Event surface emitted by the sync service over any subscribed client's
// Event frames. Listed in the base spec under "IPC command surface" (for the
// allow-listed names) and in the individual state-machine / scheduler /
// executor / probe / credential-store requirements.

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
] as const;

