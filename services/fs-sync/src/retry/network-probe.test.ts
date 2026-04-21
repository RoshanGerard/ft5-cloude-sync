import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrations } from "../db/migrations.js";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import { JobRepository } from "../jobs/repository.js";

import { NetworkProbe } from "./network-probe.js";

let cleanup: string[] = [];
let db: Database.Database;
let bus: EventBus;
let repo: JobRepository;

beforeEach(() => {
  const file = path.join(
    os.tmpdir(),
    `ft5-sync-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

function enqueueWaiting(id: string): void {
  repo.insert({
    id,
    kind: "upload",
    datasourceId: "ds",
    sourcePath: "/x",
    targetPath: "/y",
    conflictPolicy: "overwrite",
  });
  repo.transition(id, "running");
  repo.transition(id, "waiting-network", {
    lastErrorTag: "network-error",
    incrementAttempt: true,
  });
}

describe("NetworkProbe — arming policy", () => {
  it("is idle when no waiting-network jobs exist", () => {
    const probe = new NetworkProbe({ db, bus });
    probe.reconcile();
    expect(probe.isArmed()).toBe(false);
  });

  it("arms on 0→>0 transition, disarms on →0", async () => {
    const resolver = vi.fn(async () => ["1.1.1.1"]);
    const probe = new NetworkProbe({
      db,
      bus,
      intervalMs: 100,
      resolver,
    });
    enqueueWaiting("j-1");
    probe.reconcile();
    expect(probe.isArmed()).toBe(true);
    // Let the probe tick at least once and transition the job.
    await new Promise((r) => setTimeout(r, 150));
    // Probe releases the waiting job to queued, then self-disarms.
    expect(repo.getById("j-1")?.status).toBe("queued");
    expect(probe.isArmed()).toBe(false);
    await probe.stop();
  });
});

describe("NetworkProbe — success path", () => {
  it("releases every waiting-network row in a single UPDATE and emits one network-available event", async () => {
    const resolver = vi.fn(async () => ["1.1.1.1"]);
    const probe = new NetworkProbe({
      db,
      bus,
      intervalMs: 100,
      resolver,
    });
    enqueueWaiting("a");
    enqueueWaiting("b");
    enqueueWaiting("c");

    const emitted: Array<{ name: string; payload: unknown }> = [];
    bus.subscribe((n, p) => {
      emitted.push({ name: n, payload: p });
    });

    probe.reconcile();
    await new Promise((r) => setTimeout(r, 150));

    const events = emitted.filter((e) => e.name === "network-available");
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { releasedJobIds: string[] };
    expect(payload.releasedJobIds.sort()).toEqual(["a", "b", "c"]);

    expect(repo.listByStatus("queued").map((j) => j.id).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(repo.listByStatus("waiting-network")).toHaveLength(0);
    await probe.stop();
  });

  it("failed resolver: does not release jobs, does not emit event", async () => {
    const resolver = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    const probe = new NetworkProbe({
      db,
      bus,
      intervalMs: 50,
      resolver,
    });
    enqueueWaiting("j-1");
    const emitted: string[] = [];
    bus.subscribe((n) => emitted.push(n));
    probe.reconcile();
    await new Promise((r) => setTimeout(r, 150));
    expect(emitted.filter((e) => e === "network-available")).toHaveLength(0);
    expect(repo.getById("j-1")?.status).toBe("waiting-network");
    await probe.stop();
  });
});
