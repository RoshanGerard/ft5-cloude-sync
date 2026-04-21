import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations } from "../db/migrations.js";
import { JobRepository } from "../jobs/repository.js";

import { recoverRunningJobs } from "./recovery.js";

let cleanup: string[] = [];
let db: Database.Database;
let repo: JobRepository;

beforeEach(() => {
  const file = path.join(
    os.tmpdir(),
    `ft5-sync-recov-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

function insertAt(id: string): void {
  repo.insert({
    id,
    kind: "upload",
    datasourceId: "ds",
    sourcePath: "/x",
    targetPath: "/y",
    conflictPolicy: "overwrite",
  });
}

describe("recoverRunningJobs", () => {
  it("transitions every status='running' row back to queued with attempt++ and lastErrorTag='service-restart'", () => {
    insertAt("a");
    insertAt("b");
    insertAt("c");
    repo.transition("a", "running");
    repo.transition("b", "running");
    repo.transition("c", "running");
    repo.transition("c", "completed");

    const recovered = recoverRunningJobs(db);
    const ids = [...recovered].map((r) => r.jobId).sort();
    expect(ids).toEqual(["a", "b"]);

    expect(repo.getById("a")).toMatchObject({
      status: "queued",
      attempt: 1, // queued→running here doesn't increment; recovery adds +1
      lastErrorTag: "service-restart",
    });
    expect(repo.getById("b")).toMatchObject({
      status: "queued",
      attempt: 1,
      lastErrorTag: "service-restart",
    });
    // Completed row is unchanged.
    expect(repo.getById("c")).toMatchObject({
      status: "completed",
      attempt: 0,
    });
  });

  it("leaves waiting-network rows untouched", () => {
    insertAt("a");
    repo.transition("a", "running");
    repo.transition("a", "waiting-network", {
      lastErrorTag: "network-error",
      incrementAttempt: true,
    });
    const before = repo.getById("a");
    recoverRunningJobs(db);
    const after = repo.getById("a");
    expect(after).toEqual(before);
  });

  it("is idempotent (no-op on a DB with no running rows)", () => {
    insertAt("a");
    repo.transition("a", "running");
    repo.transition("a", "completed");

    const recovered = recoverRunningJobs(db);
    expect(recovered).toHaveLength(0);
    expect(repo.getById("a")).toMatchObject({ status: "completed" });
  });

  it("clears payload_json on recovery (running-only state should not bleed through)", () => {
    insertAt("a");
    // Simulate the executor having stashed running state.
    db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(
      '{"txn":"xyz"}',
      "a",
    );
    repo.transition("a", "running");

    recoverRunningJobs(db);
    const payload = (
      db.prepare("SELECT payload_json FROM jobs WHERE id = ?").get("a") as {
        payload_json: string | null;
      }
    ).payload_json;
    expect(payload).toBeNull();
  });
});
