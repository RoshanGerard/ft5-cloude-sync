import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations } from "../db/migrations.js";

import { JobRepository } from "./repository.js";
import { IllegalJobTransitionError } from "./state-machine.js";

let cleanup: string[] = [];
let db: Database.Database;
let repo: JobRepository;

beforeEach(() => {
  const file = path.join(
    os.tmpdir(),
    `ft5-sync-repo-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  cleanup.push(file);
  db = new Database(file);
  applyMigrations(db);
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

describe("JobRepository — insert + getById round-trip", () => {
  it("insert returns a JobSummary with status='queued' and attempt=0", () => {
    const job = repo.insert({
      id: "j-1",
      kind: "upload",
      datasourceId: "ds-1",
      sourcePath: "/tmp/a.txt",
      targetPath: "/remote/a.txt",
      conflictPolicy: "overwrite",
    });
    expect(job.id).toBe("j-1");
    expect(job.kind).toBe("upload");
    expect(job.status).toBe("queued");
    expect(job.attempt).toBe(0);
    expect(job.targetPath).toBe("/remote/a.txt");
    expect(job.lastErrorTag).toBeNull();
  });

  it("getById returns null for unknown id", () => {
    expect(repo.getById("nope")).toBeNull();
  });

  it("getById round-trips the inserted fields", () => {
    repo.insert({
      id: "j-2",
      kind: "sync",
      datasourceId: "ds-2",
      sourcePath: "/home/u/pics",
      conflictPolicy: "skip",
    });
    const back = repo.getById("j-2");
    expect(back).toMatchObject({
      id: "j-2",
      kind: "sync",
      datasourceId: "ds-2",
      sourcePath: "/home/u/pics",
      targetPath: null,
      conflictPolicy: "skip",
      status: "queued",
    });
  });
});

describe("JobRepository — listByStatus + countByStatus", () => {
  beforeEach(() => {
    repo.insert({
      id: "a",
      kind: "upload",
      datasourceId: "ds",
      sourcePath: "/1",
      conflictPolicy: "overwrite",
    });
    repo.insert({
      id: "b",
      kind: "upload",
      datasourceId: "ds",
      sourcePath: "/2",
      conflictPolicy: "overwrite",
    });
    repo.transition("b", "running");
  });

  it("listByStatus returns only rows in that status, ordered by createdAt", () => {
    const queued = repo.listByStatus("queued");
    expect(queued.map((j) => j.id)).toEqual(["a"]);

    const running = repo.listByStatus("running");
    expect(running.map((j) => j.id)).toEqual(["b"]);
  });

  it("countByStatus counts multiple statuses", () => {
    expect(repo.countByStatus(["queued", "running"])).toBe(2);
    expect(repo.countByStatus(["completed"])).toBe(0);
  });
});

describe("JobRepository.transition", () => {
  it("follows legal edges and updates updated_at", async () => {
    const t0 = Date.now();
    repo.insert({
      id: "j-1",
      kind: "upload",
      datasourceId: "ds",
      sourcePath: "/1",
      conflictPolicy: "overwrite",
    });
    await new Promise((r) => setTimeout(r, 2));
    const running = repo.transition("j-1", "running");
    expect(running.status).toBe("running");
    expect(running.updatedAt).toBeGreaterThanOrEqual(t0);
  });

  it("rejects an illegal edge (queued → completed) BEFORE any write", () => {
    repo.insert({
      id: "j-2",
      kind: "upload",
      datasourceId: "ds",
      sourcePath: "/1",
      conflictPolicy: "overwrite",
    });
    expect(() => repo.transition("j-2", "completed")).toThrow(
      IllegalJobTransitionError,
    );
    const row = repo.getById("j-2");
    expect(row?.status).toBe("queued");
  });

  it("increments attempt and sets lastErrorTag on opts", () => {
    repo.insert({
      id: "j-3",
      kind: "upload",
      datasourceId: "ds",
      sourcePath: "/1",
      conflictPolicy: "overwrite",
    });
    repo.transition("j-3", "running");
    repo.transition("j-3", "waiting-network", {
      incrementAttempt: true,
      lastErrorTag: "network-error",
      lastErrorMessage: "DNS fail",
    });
    const row = repo.getById("j-3");
    expect(row).toMatchObject({
      status: "waiting-network",
      attempt: 1,
      lastErrorTag: "network-error",
      lastErrorMessage: "DNS fail",
    });
  });

  it("refuses transitions out of terminal statuses", () => {
    repo.insert({
      id: "j-4",
      kind: "upload",
      datasourceId: "ds",
      sourcePath: "/1",
      conflictPolicy: "overwrite",
    });
    repo.transition("j-4", "running");
    repo.transition("j-4", "completed");
    expect(() => repo.transition("j-4", "queued")).toThrow(
      IllegalJobTransitionError,
    );
  });
});
