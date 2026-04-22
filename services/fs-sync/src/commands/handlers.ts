// Command handler factory for the sync service. Each handler is a pure
// function of (params, deps) that returns the response shape defined by
// the IPC contract. The scheduler and executors are NOT consulted here —
// handlers touch the DB and emit events; background work is driven by the
// scheduler on its own timer (wired in Phase 9).

import { randomUUID } from "node:crypto";

import type {
  CommandHandlers,
  Connection,
} from "../ipc/server.js";
import { enqueueMirror, SyncAlreadyRunningError } from "../jobs/enqueue.js";
import { JobRepository } from "../jobs/repository.js";
import type { EventBus } from "../events/event-bus.js";
import { PolicyStore } from "../retry/policy-store.js";
import type Database from "better-sqlite3";

import { handleAuthenticateStart } from "./authenticate-start.js";

export interface HandlersDeps {
  readonly db: Database.Database;
  readonly bus: EventBus;
  readonly serviceVersion: string;
  readonly serviceUuid: string;
}

export function buildCommandHandlers(deps: HandlersDeps): CommandHandlers {
  const repo = new JobRepository(deps.db);
  const policies = new PolicyStore(deps.db);

  return {
    "sync:get-status": async () => ({
      ok: true,
      result: {
        version: deps.serviceVersion,
        serviceUuid: deps.serviceUuid,
        runningJobs: repo.countByStatus(["running"]),
        queuedJobs: repo.countByStatus(["queued"]),
        waitingNetworkJobs: repo.countByStatus(["waiting-network"]),
        monitorConnected: false,
      },
    }),

    "sync:enqueue-upload": async (params) => {
      const jobId = randomUUID();
      repo.insert({
        id: jobId,
        kind: "upload",
        datasourceId: params.datasourceId,
        sourcePath: params.sourcePath,
        targetPath: params.targetPath,
        conflictPolicy: params.conflictPolicy,
      });
      deps.bus.emit("job-enqueued", {
        jobId,
        kind: "upload",
        datasourceId: params.datasourceId,
        sourcePath: params.sourcePath,
        targetPath: params.targetPath,
        conflictPolicy: params.conflictPolicy,
        enqueuedAt: Date.now(),
      });
      return { ok: true, result: { jobId } };
    },

    "sync:enqueue-mirror": async (params) => {
      try {
        const { jobId } = enqueueMirror(deps.db, {
          datasourceId: params.datasourceId,
          sourcePath: params.sourcePath,
          conflictPolicy: params.conflictPolicy ?? "overwrite",
        });
        deps.bus.emit("job-enqueued", {
          jobId,
          kind: "sync",
          datasourceId: params.datasourceId,
          sourcePath: params.sourcePath,
          targetPath: null,
          conflictPolicy: params.conflictPolicy ?? "overwrite",
          enqueuedAt: Date.now(),
        });
        return { ok: true, result: { jobId } };
      } catch (err) {
        if (err instanceof SyncAlreadyRunningError) {
          return {
            ok: false,
            error: {
              tag: "sync-already-running",
              message: err.message,
              details: {
                existingJobId: err.existingJobId,
                datasourceId: err.datasourceId,
                sourcePath: err.sourcePath,
              },
            },
          };
        }
        throw err;
      }
    },

    "sync:list-jobs": async (params) => {
      let jobs = repo.listAll();
      if (params.filter?.status) {
        const set = new Set(params.filter.status);
        jobs = jobs.filter((j) => set.has(j.status));
      }
      if (params.filter?.datasourceId) {
        jobs = jobs.filter((j) => j.datasourceId === params.filter!.datasourceId);
      }
      if (params.filter?.kind) {
        jobs = jobs.filter((j) => j.kind === params.filter!.kind);
      }
      return { ok: true, result: { jobs } };
    },

    "sync:get-job": async (params) => {
      const job = repo.getById(params.jobId);
      if (!job) {
        return {
          ok: false,
          error: {
            tag: "not-found",
            message: `no job with id ${params.jobId}`,
          },
        };
      }
      return { ok: true, result: { job } };
    },

    "sync:cancel-job": async (params) => {
      const job = repo.getById(params.jobId);
      if (!job) {
        return {
          ok: false,
          error: { tag: "not-found", message: `no job with id ${params.jobId}` },
        };
      }
      if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "cancelled"
      ) {
        return {
          ok: false,
          error: {
            tag: "not-cancelable",
            message: `job ${params.jobId} is already in terminal state ${job.status}`,
          },
        };
      }
      const prior = job.status;
      // queued → cancelled and waiting-network → cancelled are legal.
      // running → cancelled happens via the scheduler (it needs to abort
      // the in-flight executor first); for the handler, we trust the
      // scheduler to process the transition asynchronously.
      if (prior === "running") {
        // TODO(phase 9): signal AbortController via scheduler.
        return {
          ok: false,
          error: {
            tag: "not-cancelable",
            message:
              `job ${params.jobId} is running; cancellation requires the scheduler — not yet wired`,
          },
        };
      }
      repo.transition(params.jobId, "cancelled");
      deps.bus.emit("job-cancelled", {
        jobId: params.jobId,
        cancelledAt: Date.now(),
        priorStatus: prior,
      });
      return { ok: true, result: { cancelled: true } };
    },

    "sync:set-retry-policy": async (params) => {
      policies.upsert({
        scope: params.scope,
        datasourceId: params.datasourceId ?? null,
        maxAttempts: params.maxAttempts,
        backoffMs: params.backoffMs,
        backoffStrategy: params.backoffStrategy,
        maxAgeMs: params.maxAgeMs ?? null,
      });
      const stored = policies.get(params.scope, params.datasourceId);
      return { ok: true, result: { policy: stored! } };
    },

    "sync:get-retry-policy": async (params) => {
      const stored = policies.get(params.scope, params.datasourceId);
      if (!stored) {
        return {
          ok: false,
          error: {
            tag: "not-found",
            message: `no policy for scope=${params.scope} datasourceId=${params.datasourceId ?? ""}`,
          },
        };
      }
      return { ok: true, result: { policy: stored } };
    },

    "sync:subscribe-events": async () => {
      // Subscription wiring lands in phase 16 — for v1 of this file we
      // accept the subscribe and return ok. The connection-level event
      // fan-out is installed in that phase; until then, broadcast via
      // the server.broadcast() path reaches every connected client
      // regardless of explicit subscription.
      return { ok: true, result: { subscribed: true } };
    },

    "sync:unsubscribe-events": async () => ({
      ok: true,
      result: { unsubscribed: true },
    }),

    "sync:authenticate-start": handleAuthenticateStart,
  };
}

// Connection-typed re-export so callers can pass ctx through the handler
// factory if they need to capture per-connection state in later phases.
export type { Connection };
