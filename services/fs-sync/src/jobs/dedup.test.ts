import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations } from "../db/migrations.js";

import { enqueueMirror, SyncAlreadyRunningError } from "./enqueue.js";
import { JobRepository } from "./repository.js";

let cleanup: string[] = [];
let db: Database.Database;

beforeEach(() => {
  const file = path.join(
    os.tmpdir(),
    `ft5-sync-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  cleanup.push(file);
  db = new Database(file);
  applyMigrations(db);
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

describe("enqueueMirror dedup", () => {
  it("first enqueue succeeds with a fresh uuid", () => {
    const res = enqueueMirror(db, {
      datasourceId: "ds-1",
      sourcePath: "/home/u/pics",
      conflictPolicy: "overwrite",
    });
    expect(res.jobId).toMatch(/^[0-9a-f-]{36}$/);

    const row = new JobRepository(db).getById(res.jobId);
    expect(row?.status).toBe("queued");
  });

  it("rejects duplicate (datasourceId, sourcePath) while first is queued", () => {
    const first = enqueueMirror(db, {
      datasourceId: "ds-1",
      sourcePath: "/home/u/pics",
      conflictPolicy: "overwrite",
    });

    try {
      enqueueMirror(db, {
        datasourceId: "ds-1",
        sourcePath: "/home/u/pics",
        conflictPolicy: "overwrite",
      });
      expect.fail("second enqueue should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SyncAlreadyRunningError);
      const e = err as SyncAlreadyRunningError;
      expect(e.existingJobId).toBe(first.jobId);
      expect(e.datasourceId).toBe("ds-1");
      expect(e.sourcePath).toBe("/home/u/pics");
    }

    // Only one row persists.
    const rows = new JobRepository(db).listAll();
    expect(rows).toHaveLength(1);
  });

  it("allows a duplicate once the first completes", () => {
    const first = enqueueMirror(db, {
      datasourceId: "ds-1",
      sourcePath: "/home/u/pics",
      conflictPolicy: "overwrite",
    });
    const repo = new JobRepository(db);
    repo.transition(first.jobId, "running");
    repo.transition(first.jobId, "completed");

    const second = enqueueMirror(db, {
      datasourceId: "ds-1",
      sourcePath: "/home/u/pics",
      conflictPolicy: "overwrite",
    });
    expect(second.jobId).not.toBe(first.jobId);
  });

  it("different sourcePath is not a dedup conflict", () => {
    enqueueMirror(db, {
      datasourceId: "ds-1",
      sourcePath: "/a",
      conflictPolicy: "overwrite",
    });
    const res = enqueueMirror(db, {
      datasourceId: "ds-1",
      sourcePath: "/b",
      conflictPolicy: "overwrite",
    });
    expect(res.jobId).toBeTruthy();

    const rows = new JobRepository(db).listAll();
    expect(rows).toHaveLength(2);
  });

  it("dedup covers running and waiting-network statuses as well as queued", () => {
    const first = enqueueMirror(db, {
      datasourceId: "ds-1",
      sourcePath: "/home/u/pics",
      conflictPolicy: "overwrite",
    });
    const repo = new JobRepository(db);
    repo.transition(first.jobId, "running");

    expect(() =>
      enqueueMirror(db, {
        datasourceId: "ds-1",
        sourcePath: "/home/u/pics",
        conflictPolicy: "overwrite",
      }),
    ).toThrow(SyncAlreadyRunningError);

    repo.transition(first.jobId, "waiting-network", {
      incrementAttempt: true,
      lastErrorTag: "network-error",
    });
    expect(() =>
      enqueueMirror(db, {
        datasourceId: "ds-1",
        sourcePath: "/home/u/pics",
        conflictPolicy: "overwrite",
      }),
    ).toThrow(SyncAlreadyRunningError);
  });
});
