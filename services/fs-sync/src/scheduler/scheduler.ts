// Job scheduler. Polls queued rows, acquires a semaphore permit, transitions
// the row to `running`, invokes the registered executor for the job's kind,
// and reconciles the outcome. `cancel(jobId)` signals the in-flight
// executor via its AbortController.
//
// The scheduler is polling-based (not event-driven) because command handlers
// run in separate async contexts and we don't want the scheduler to reach
// into their dispatch paths. A 100 ms poll is cheap and predictable.

import type {
  JobSummary,
  JobKind,
} from "@ft5/ipc-contracts/sync-service";

import type { EventBus } from "../events/event-bus.js";
import { JobRepository } from "../jobs/repository.js";

import { Semaphore } from "./semaphore.js";

export interface ExecutorCtx {
  readonly job: JobSummary;
  readonly signal: AbortSignal;
  readonly bus: EventBus;
}

export interface ExecutorSuccess {
  readonly outcome: "completed";
  readonly resultPayload?: unknown;
}

export interface ExecutorFailure {
  readonly outcome: "failed" | "waiting-network";
  readonly errorTag: string;
  readonly errorMessage: string;
}

export interface ExecutorCancelled {
  readonly outcome: "cancelled";
}

export type ExecutorResult =
  | ExecutorSuccess
  | ExecutorFailure
  | ExecutorCancelled;

export type Executor = (ctx: ExecutorCtx) => Promise<ExecutorResult>;

export type ExecutorsByKind = Partial<Record<JobKind, Executor>>;

export interface SchedulerOptions {
  readonly executors: ExecutorsByKind;
  readonly bus: EventBus;
  readonly allowParallel?: boolean;
  /** Poll interval in ms. Defaults to 100ms. */
  readonly pollIntervalMs?: number;
}

export class Scheduler {
  private readonly repo: JobRepository;
  private readonly executors: ExecutorsByKind;
  private readonly bus: EventBus;
  private readonly semaphore: Semaphore;
  private readonly pollIntervalMs: number;
  private readonly running = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(db: import("better-sqlite3").Database, options: SchedulerOptions) {
    this.repo = new JobRepository(db);
    this.executors = options.executors;
    this.bus = options.bus;
    const permits = options.allowParallel === false ? 1 : 2;
    this.semaphore = new Semaphore(permits);
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => void 0);
    }, this.pollIntervalMs);
    // First tick immediately so tests don't have to wait for the interval.
    void this.tick().catch(() => void 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const ctl of this.running.values()) ctl.abort();
    // Wait for all running executors to settle so tests don't leak timers.
    // We don't know how long they'll take; the caller should bound this.
    while (this.running.size > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  cancel(jobId: string): boolean {
    const ctl = this.running.get(jobId);
    if (ctl) {
      ctl.abort();
      return true;
    }
    // Not running; mark as cancelled if queued or waiting-network.
    const job = this.repo.getById(jobId);
    if (!job) return false;
    if (job.status === "queued" || job.status === "waiting-network") {
      this.repo.transition(jobId, "cancelled");
      this.bus.emit("job-cancelled", {
        jobId,
        cancelledAt: Date.now(),
        priorStatus: job.status,
      });
      return true;
    }
    return false;
  }

  runningJobIds(): ReadonlyArray<string> {
    return Array.from(this.running.keys());
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    // Pull candidate jobs; run as many as we have permits for, non-blocking.
    const queued = this.repo.listByStatus("queued");
    for (const job of queued) {
      if (this.stopped) return;
      if (this.semaphore.availablePermits() === 0) return;
      // Speculatively acquire via tryAcquire semantics: we just call
      // acquire which, since we checked availablePermits above, returns
      // immediately. If another concurrent tick raced us, acquire will
      // still resolve promptly once a permit opens.
      void this.runJob(job);
    }
  }

  private async runJob(job: JobSummary): Promise<void> {
    await this.semaphore.acquire();
    if (this.stopped) {
      this.semaphore.release();
      return;
    }
    try {
      // Re-read the row — another tick may have claimed it while we were
      // awaiting the semaphore, or the user may have cancelled.
      const latest = this.repo.getById(job.id);
      if (!latest || latest.status !== "queued") return;

      const executor = this.executors[latest.kind];
      if (!executor) {
        this.repo.transition(latest.id, "running", { incrementAttempt: true });
        this.repo.transition(latest.id, "failed", {
          lastErrorTag: "unsupported",
          lastErrorMessage: `no executor registered for kind=${latest.kind}`,
        });
        this.bus.emit("job-failed", {
          jobId: latest.id,
          failedAt: Date.now(),
          attempt: latest.attempt + 1,
          errorTag: "unsupported",
          errorMessage: `no executor registered for kind=${latest.kind}`,
        });
        return;
      }

      this.repo.transition(latest.id, "running", { incrementAttempt: true });
      this.bus.emit("job-started", {
        jobId: latest.id,
        attempt: latest.attempt + 1,
        startedAt: Date.now(),
      });

      const ctl = new AbortController();
      this.running.set(latest.id, ctl);
      let result: ExecutorResult;
      try {
        result = await executor({
          job: this.repo.getById(latest.id) ?? latest,
          signal: ctl.signal,
          bus: this.bus,
        });
      } catch (err) {
        const message = (err as { message?: string }).message ?? String(err);
        result = {
          outcome: "failed",
          errorTag: "internal-error",
          errorMessage: message,
        };
      } finally {
        this.running.delete(latest.id);
      }

      await this.applyOutcome(latest.id, result, ctl.signal.aborted);
    } finally {
      this.semaphore.release();
    }
  }

  private async applyOutcome(
    jobId: string,
    result: ExecutorResult,
    aborted: boolean,
  ): Promise<void> {
    if (aborted || result.outcome === "cancelled") {
      const prior = this.repo.getById(jobId);
      if (prior && prior.status === "running") {
        this.repo.transition(jobId, "cancelled");
        this.bus.emit("job-cancelled", {
          jobId,
          cancelledAt: Date.now(),
          priorStatus: "running",
        });
      }
      return;
    }
    if (result.outcome === "completed") {
      this.repo.transition(jobId, "completed");
      this.bus.emit("job-completed", {
        jobId,
        completedAt: Date.now(),
      });
      return;
    }
    if (result.outcome === "waiting-network") {
      this.repo.transition(jobId, "waiting-network", {
        lastErrorTag: result.errorTag,
        lastErrorMessage: result.errorMessage,
      });
      return;
    }
    // failed
    const job = this.repo.getById(jobId);
    this.repo.transition(jobId, "failed", {
      lastErrorTag: result.errorTag,
      lastErrorMessage: result.errorMessage,
    });
    this.bus.emit("job-failed", {
      jobId,
      failedAt: Date.now(),
      attempt: job?.attempt ?? 0,
      errorTag: result.errorTag,
      errorMessage: result.errorMessage,
    });
  }
}
