// Phase 9d — `handleDatasourcesRemove` deletes the datasource row via the
// DB-backed registry.
//
// As of wire-fs-sync-service section 9 the handler no longer cascades to
// a credential store (the fs-sync service owns credentials end-to-end).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIXTURE_SUMMARIES } from "./helpers.js";

import { openDatabase, runMigrations } from "../../../db/database.js";
import { DEFAULT_MIGRATIONS } from "../../../db/migrations.js";
import {
  getEngine,
  initEngine,
  resetEngineForTests,
} from "../../../datasources/engine.js";
import { handleDatasourcesList } from "../list.js";
import { handleDatasourcesRemove } from "../remove.js";

type SqliteDatabase = ReturnType<typeof openDatabase>;

describe("handleDatasourcesRemove", () => {
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

  it("removes an existing datasource and returns { ok: true }", async () => {
    const target = handleDatasourcesList().datasources[0]!;
    const response = await handleDatasourcesRemove({ datasourceId: target.id });
    expect(response).toEqual({ ok: true });
    const remaining = handleDatasourcesList().datasources;
    expect(remaining.some((ds) => ds.id === target.id)).toBe(false);
  });

  it("invokes registry.remove with the target id", async () => {
    const { registry } = getEngine();
    const spy = vi.spyOn(registry, "remove");
    const target = handleDatasourcesList().datasources[0]!;
    await handleDatasourcesRemove({ datasourceId: target.id });
    expect(spy).toHaveBeenCalledWith(target.id);
  });

  it("throws for an unknown datasourceId rather than silently no-op-ing", async () => {
    await expect(
      handleDatasourcesRemove({ datasourceId: "ds-does-not-exist" }),
    ).rejects.toThrow(/not found/i);
  });

  it("does not touch the factory (remove is pure-DB)", async () => {
    const { factory } = getEngine();
    const factorySpy = vi.spyOn(factory, "create");
    const target = handleDatasourcesList().datasources[0]!;
    await handleDatasourcesRemove({ datasourceId: target.id });
    expect(factorySpy).not.toHaveBeenCalled();
  });
});
