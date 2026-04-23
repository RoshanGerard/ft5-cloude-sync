// Phase 9d — `handleDatasourcesAction` runs pause / resume / sync-now via
// the DB-backed registry.
//   * pause / resume flip `registry.setPaused`.
//   * sync-now updates the local bookkeeping row (status=syncing,
//     last_sync_at bumped). The former DATASOURCE_ENGINE_LIVE branch that
//     resolved credentials + constructed a client was removed in
//     wire-fs-sync-service section 9 — the fs-sync service now owns all
//     credential-bearing provider calls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIXTURE_SUMMARIES } from "./helpers.js";

import { openDatabase, runMigrations } from "../../../db/database.js";
import { DEFAULT_MIGRATIONS } from "../../../db/migrations.js";
import {
  getEngine,
  initEngine,
  resetEngineForTests,
} from "../../../datasources/engine.js";
import { handleDatasourcesAction } from "../action.js";
import { handleDatasourcesList } from "../list.js";

type SqliteDatabase = ReturnType<typeof openDatabase>;

function findByStatus(status: string) {
  return handleDatasourcesList().datasources.find((ds) => ds.status === status);
}

describe("handleDatasourcesAction", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    resetEngineForTests();
    db = openDatabase(":memory:");
    runMigrations(db, DEFAULT_MIGRATIONS);
    initEngine(db);
    const { registry } = getEngine();
    for (const summary of FIXTURE_SUMMARIES) {
      const seed =
        summary.status === "paused"
          ? { ...summary, status: "connected" as const }
          : summary;
      registry.add(seed);
      if (summary.status === "paused") {
        registry.setPaused(summary.id, true);
      }
    }
  });

  afterEach(() => {
    resetEngineForTests();
    db.close();
  });

  // ---------------------------------------------------------------------
  // pause / resume.
  // ---------------------------------------------------------------------

  it("pause: sets status to paused", async () => {
    const target = findByStatus("connected")!;
    const { datasource } = await handleDatasourcesAction({
      datasourceId: target.id,
      action: "pause",
    });
    expect(datasource.status).toBe("paused");
    expect(datasource.id).toBe(target.id);
  });

  it("pause: flips registry.setPaused(id, true)", async () => {
    const { registry } = getEngine();
    const spy = vi.spyOn(registry, "setPaused");
    const target = findByStatus("connected")!;
    await handleDatasourcesAction({ datasourceId: target.id, action: "pause" });
    expect(spy).toHaveBeenCalledWith(target.id, true);
  });

  it("resume: sets status to connected", async () => {
    const target = findByStatus("paused")!;
    const { datasource } = await handleDatasourcesAction({
      datasourceId: target.id,
      action: "resume",
    });
    // Underlying seeded status is "connected"; resume unpauses so that's
    // what list() now projects.
    expect(datasource.status).toBe("connected");
  });

  // ---------------------------------------------------------------------
  // sync-now — registry-only bookkeeping.
  // ---------------------------------------------------------------------

  it("sync-now: sets status to syncing and updates lastSyncAt forward", async () => {
    const target = findByStatus("connected")!;
    const before = Date.now();
    const { datasource } = await handleDatasourcesAction({
      datasourceId: target.id,
      action: "sync-now",
    });
    expect(datasource.status).toBe("syncing");
    expect(datasource.lastSyncAt).not.toBeNull();
    expect(datasource.lastSyncAt!).toBeGreaterThanOrEqual(before - 100);
  });

  it("sync-now: does not touch the factory", async () => {
    const { factory } = getEngine();
    const spy = vi.spyOn(factory, "create");
    const target = findByStatus("connected")!;
    await handleDatasourcesAction({ datasourceId: target.id, action: "sync-now" });
    expect(spy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // not-found cases.
  // ---------------------------------------------------------------------

  it("throws for an unknown datasourceId", async () => {
    await expect(
      handleDatasourcesAction({
        datasourceId: "ds-does-not-exist",
        action: "pause",
      }),
    ).rejects.toThrow(/not found/i);
  });
});
