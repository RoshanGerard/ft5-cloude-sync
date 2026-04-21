// Explicit adjacency map for job lifecycle transitions. Every legal edge
// is listed here; any attempt to transition along an unlisted edge throws
// `IllegalJobTransitionError` before any DB write occurs.
//
// Spec: "Jobs table state machine" — `queued → running`; `queued →
// cancelled`; `running → waiting-network`; `running → completed`; `running
// → failed`; `running → cancelled`; `waiting-network → queued`;
// `waiting-network → cancelled`. Terminal: completed, failed, cancelled.

import type { JobStatus } from "@ft5/ipc-contracts/sync-service";

const ADJACENCY: Record<JobStatus, ReadonlyArray<JobStatus>> = {
  queued: ["running", "cancelled"],
  running: ["waiting-network", "completed", "failed", "cancelled"],
  "waiting-network": ["queued", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: ReadonlyArray<JobStatus> = [
  "completed",
  "failed",
  "cancelled",
];

export class IllegalJobTransitionError extends Error {
  readonly from: JobStatus;
  readonly to: JobStatus;
  readonly jobId: string;
  constructor(jobId: string, from: JobStatus, to: JobStatus) {
    super(
      `illegal job transition for ${jobId}: ${from} → ${to} is not a legal edge`,
    );
    this.name = "IllegalJobTransitionError";
    this.jobId = jobId;
    this.from = from;
    this.to = to;
  }
}

/**
 * Check whether `from → to` is a legal edge. Identity edges (same status)
 * are forbidden; every legal edge MUST be listed explicitly.
 */
export function isLegalTransition(from: JobStatus, to: JobStatus): boolean {
  return (ADJACENCY[from] ?? []).includes(to);
}

/** Throw on illegal transition. Intended as a pre-write guard. */
export function assertLegalTransition(
  jobId: string,
  from: JobStatus,
  to: JobStatus,
): void {
  if (!isLegalTransition(from, to)) {
    throw new IllegalJobTransitionError(jobId, from, to);
  }
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
