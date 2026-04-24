// Phase 9d — `handleDatasourcesList` exercises the DB-backed registry
// through `getEngine()`. The in-memory `store.ts` fixture is gone; seed the
// registry with canonical summaries via the helper.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { providers } from "@ft5/ipc-contracts";
import type { DatasourceStatus, DatasourceSummary } from "@ft5/ipc-contracts";

import { FIXTURE_SUMMARIES } from "./helpers.js";

import { openDatabase, runMigrations } from "../../../db/database.js";
import { DEFAULT_MIGRATIONS } from "../../../db/migrations.js";
import {
  getEngine,
  initEngine,
  resetEngineForTests,
} from "../../../datasources/engine.js";
import { handleDatasourcesList } from "../list.js";

type SqliteDatabase = ReturnType<typeof openDatabase>;

describe("handleDatasourcesList", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    resetEngineForTests();
    db = openDatabase(":memory:");
    runMigrations(db, DEFAULT_MIGRATIONS);
    initEngine(db);
    const { registry } = getEngine();
    for (const summary of FIXTURE_SUMMARIES) {
      if (summary.status === "paused") {
        // `paused` is a separate boolean column — seed with the underlying
        // status="connected" and then flip the flag, so list() projects
        // "paused" like the old in-memory fixture did.
        registry.add({ ...summary, status: "connected" });
        registry.setPaused(summary.id, true);
      } else {
        registry.add(summary);
      }
    }
  });

  afterEach(() => {
    resetEngineForTests();
    db.close();
  });

  it("returns a structured-clone-safe { datasources: DatasourceSummary[] }", () => {
    const response = handleDatasourcesList();
    expect(response).toHaveProperty("datasources");
    expect(Array.isArray(response.datasources)).toBe(true);
    for (const ds of response.datasources) {
      expect(typeof ds.id).toBe("string");
      expect(typeof ds.displayName).toBe("string");
      expect(typeof ds.providerId).toBe("string");
      expect(["connected", "syncing", "paused", "error"]).toContain(ds.status);
      expect(ds.lastSyncAt === null || typeof ds.lastSyncAt === "number").toBe(
        true,
      );
      expect(typeof ds.itemCount).toBe("number");
      if (ds.errorReason !== undefined) {
        expect(typeof ds.errorReason).toBe("string");
      }
    }
  });

  it("fixture includes at least one datasource of each status variant", () => {
    const { datasources } = handleDatasourcesList();
    const statusesPresent = new Set<DatasourceStatus>(
      datasources.map((ds) => ds.status),
    );
    expect(statusesPresent.has("connected")).toBe(true);
    expect(statusesPresent.has("syncing")).toBe(true);
    expect(statusesPresent.has("paused")).toBe(true);
    expect(statusesPresent.has("error")).toBe(true);
  });

  it("fixture includes a quota=false provider (S3) alongside quota=true providers", () => {
    const { datasources } = handleDatasourcesList();
    const withQuotaTrue = datasources.filter((ds) => {
      const descriptor = providers[ds.providerId as keyof typeof providers];
      return descriptor?.capabilities.quota === true;
    });
    const withQuotaFalse = datasources.filter((ds) => {
      const descriptor = providers[ds.providerId as keyof typeof providers];
      return descriptor?.capabilities.quota === false;
    });
    expect(withQuotaTrue.length).toBeGreaterThanOrEqual(1);
    expect(withQuotaFalse.length).toBeGreaterThanOrEqual(1);
  });

  it("datasources with error status include an errorReason string", () => {
    const { datasources } = handleDatasourcesList();
    const errorOnes = datasources.filter(
      (ds: DatasourceSummary) => ds.status === "error",
    );
    for (const ds of errorOnes) {
      expect(typeof ds.errorReason).toBe("string");
      expect(ds.errorReason!.length).toBeGreaterThan(0);
    }
  });
});
