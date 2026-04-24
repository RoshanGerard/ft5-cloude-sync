// Phase 9d — `handleDatasourcesAdd` persists via the DB-backed registry
// (`getEngine().registry`). The test boots a fresh in-memory engine each
// run so additions are isolated.
//
// As of wire-fs-sync-service section 9 the handler silently ignores
// `req.credentials` — the fs-sync service owns credentials end-to-end.
// The IPC contract still carries the field so renderer code keeps
// compiling, but nothing is persisted on the desktop side.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, runMigrations } from "../../../db/database.js";
import { DEFAULT_MIGRATIONS } from "../../../db/migrations.js";
import {
  initEngine,
  resetEngineForTests,
} from "../../../datasources/engine.js";
import { handleDatasourcesAdd } from "../add.js";
import { handleDatasourcesList } from "../list.js";

type SqliteDatabase = ReturnType<typeof openDatabase>;

describe("handleDatasourcesAdd", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    resetEngineForTests();
    db = openDatabase(":memory:");
    runMigrations(db, DEFAULT_MIGRATIONS);
    initEngine(db);
  });

  afterEach(() => {
    resetEngineForTests();
    db.close();
  });

  it("creates a connected datasource for google-drive and returns it", async () => {
    const response = await handleDatasourcesAdd({
      providerId: "google-drive",
      credentials: { accessToken: "mock-token" },
    });
    expect(response.datasource.id).toMatch(/^ds-google-drive-/);
    expect(response.datasource.providerId).toBe("google-drive");
    expect(response.datasource.status).toBe("connected");
    expect(response.datasource.lastSyncAt).toBeNull();
    expect(response.datasource.itemCount).toBe(0);
    expect(response.datasource.usage).toBeDefined();
    expect(response.datasource.usage!.used).toBe(0);
  });

  it("creates an amazon-s3 datasource WITHOUT usage (quota=false provider)", async () => {
    const response = await handleDatasourcesAdd({
      providerId: "amazon-s3",
      credentials: { accessKeyId: "K", secretAccessKey: "S", bucket: "b" },
    });
    expect(response.datasource.providerId).toBe("amazon-s3");
    expect(response.datasource.usage).toBeUndefined();
  });

  it("appends the new datasource so list() returns it", async () => {
    const before = handleDatasourcesList().datasources.length;
    const { datasource } = await handleDatasourcesAdd({
      providerId: "onedrive",
      credentials: { accessToken: "t" },
    });
    const after = handleDatasourcesList().datasources;
    expect(after.length).toBe(before + 1);
    expect(after.some((ds) => ds.id === datasource.id)).toBe(true);
  });

  it("throws for an unknown providerId", async () => {
    await expect(
      handleDatasourcesAdd({
        providerId: "dropbox",
        credentials: {},
      }),
    ).rejects.toThrow(/unknown provider/i);
  });
});
