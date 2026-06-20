import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations } from "../db/migrations.js";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import { JobRepository } from "../jobs/repository.js";

import { DatasourceErrorTag } from "@ft5/ipc-contracts";

import { Scheduler, type Executor, type ExecutorResult } from "./scheduler.js";

let cleanup: string[] = [];
let db: Database.Database;
let bus: EventBus;
let repo: JobRepository;

beforeEach(() => {
  const file = path.join(
    os.tmpdir(),
    `ft5-sync-sched-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  cleanup.push(file);
  db = new Database(file);
  applyMigrations(db);
  bus = createEventBus();
  repo = new JobRepository(db);
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    /* tolerated */
  }
  for (const f of cleanup) {
    try {
      await fsp.rm(f, { force: true });
    } catch {
      /* tolerated */
    }
  }
  cleanup = [];
});

function enqueueN(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `job-${i}`;
    repo.insert({
      id,
      kind: "upload",
      datasourceId: "ds",
      sourcePath: `/src/${i}`,
      targetPath: `/dst/${i}`,
      conflictPolicy: "overwrite",
    });
    ids.push(id);
  }
  return ids;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error("waitUntil timeout");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Scheduler — parallel=2 (default)", () => {
  it("runs exactly 2 jobs concurrently when 3 are queued", async () => {
    enqueueN(3);
    let observedMaxConcurrent = 0;
    let active = 0;
    const executor: Executor = async () => {
      active++;
      observedMaxConcurrent = Math.max(observedMaxConcurrent, active);
      await new Promise((r) => setTimeout(r, 120));
      active--;
      return { outcome: "completed" } as ExecutorResult;
    };

    const sched = new Scheduler(db, {
      executors: { upload: executor },
      bus,
      pollIntervalMs: 20,
    });
    sched.start();
    try {
      // At some point during the window the two fastest should be running.
      await new Promise((r) => setTimeout(r, 60));
      expect(repo.listByStatus("running")).toHaveLength(2);

      await waitUntil(() => repo.listByStatus("completed").length === 3, 5000);
      expect(observedMaxConcurrent).toBe(2);
    } finally {
      await sched.stop();
    }
  });
});

describe("Scheduler — sequential fallback (allowParallel=false)", () => {
  it("runs exactly 1 job at a time", async () => {
    enqueueN(3);
    let observedMaxConcurrent = 0;
    let active = 0;
    const executor: Executor = async () => {
      active++;
      observedMaxConcurrent = Math.max(observedMaxConcurrent, active);
      await new Promise((r) => setTimeout(r, 80));
      active--;
      return { outcome: "completed" };
    };

    const sched = new Scheduler(db, {
      executors: { upload: executor },
      bus,
      allowParallel: false,
      pollIntervalMs: 20,
    });
    sched.start();
    try {
      await waitUntil(() => repo.listByStatus("completed").length === 3, 5000);
      expect(observedMaxConcurrent).toBe(1);
    } finally {
      await sched.stop();
    }
  });
});

describe("Scheduler — cancel via AbortSignal during run", () => {
  it("aborts the in-flight executor and transitions to cancelled", async () => {
    const ids = enqueueN(1);
    const id = ids[0]!;
    const seenAbort: string[] = [];
    const executor: Executor = async ({ signal }) => {
      return await new Promise<ExecutorResult>((resolve) => {
        const t = setTimeout(() => {
          resolve({ outcome: "completed" });
        }, 500);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          seenAbort.push("aborted");
          resolve({ outcome: "cancelled" });
        });
      });
    };

    const sched = new Scheduler(db, {
      executors: { upload: executor },
      bus,
      pollIntervalMs: 20,
    });
    sched.start();
    try {
      await waitUntil(() => sched.runningJobIds().length === 1, 2000);
      const cancelled = sched.cancel(id);
      expect(cancelled).toBe(true);
      await waitUntil(() => repo.getById(id)?.status === "cancelled", 2000);
      expect(seenAbort).toEqual(["aborted"]);
    } finally {
      await sched.stop();
    }
  });
});

describe("Scheduler — no-executor fallback", () => {
  it("fails a job whose kind has no registered executor", async () => {
    enqueueN(1);
    const sched = new Scheduler(db, {
      executors: {},
      bus,
      pollIntervalMs: 20,
    });
    sched.start();
    try {
      await waitUntil(
        () => repo.getById("job-0")?.status === "failed",
        2000,
      );
      const job = repo.getById("job-0")!;
      expect(job.lastErrorTag).toBe("unsupported");
    } finally {
      await sched.stop();
    }
  });
});

describe("Scheduler — failure → failed transition and job-failed event", () => {
  it("emits job-failed with attempt and errorTag", async () => {
    enqueueN(1);
    const emitted: Array<{ name: string; payload: unknown }> = [];
    bus.subscribe((name, payload) => {
      emitted.push({ name, payload });
    });
    const executor: Executor = async () => ({
      outcome: "failed",
      errorTag: DatasourceErrorTag.ProviderError,
      errorMessage: "nope",
    });
    const sched = new Scheduler(db, {
      executors: { upload: executor },
      bus,
      pollIntervalMs: 20,
    });
    sched.start();
    try {
      await waitUntil(() => repo.getById("job-0")?.status === "failed", 2000);
      const failed = emitted.find((e) => e.name === "job-failed");
      expect(failed).toBeTruthy();
      expect(
        (failed?.payload as { errorTag: string }).errorTag,
      ).toBe("provider-error");
    } finally {
      await sched.stop();
    }
  });
});
