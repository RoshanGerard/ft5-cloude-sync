// Phase 9c — engine singleton accessor test.
//
// `getEngine()` is the process-wide accessor every IPC handler calls to get
// the shared EngineContext + ClientFactory + DatasourceRegistry. Tests
// must be able to reset the singleton between runs via
// `resetEngineForTests()`.
//
// As of wire-fs-sync-service section 9 the engine no longer owns a
// credential store (the fs-sync service owns credentials end-to-end), so no
// electron mock is needed here.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, runMigrations } from "../db/database.js";
import { DEFAULT_MIGRATIONS } from "../db/migrations.js";
import {
  getEngine,
  initEngine,
  resetEngineForTests,
} from "./engine.js";

describe("engine singleton (Phase 9c)", () => {
  beforeEach(() => {
    resetEngineForTests();
  });

  afterEach(() => {
    resetEngineForTests();
  });

  it("getEngine() throws before initEngine() has been called", () => {
    expect(() => getEngine()).toThrow(/initEngine/i);
  });

  it("initEngine(db) then getEngine() returns an engine with bus, registry, factory", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, DEFAULT_MIGRATIONS);
    initEngine(db);
    const engine = getEngine();
    expect(engine.bus).toBeDefined();
    expect(engine.registry).toBeDefined();
    expect(engine.factory).toBeDefined();
  });

  it("repeat initEngine calls are rejected (process-wide singleton)", () => {
    const db1 = openDatabase(":memory:");
    runMigrations(db1, DEFAULT_MIGRATIONS);
    initEngine(db1);
    const db2 = openDatabase(":memory:");
    runMigrations(db2, DEFAULT_MIGRATIONS);
    expect(() => initEngine(db2)).toThrow(/already initialized/i);
  });

  it("resetEngineForTests lets you re-initialize", () => {
    const db1 = openDatabase(":memory:");
    runMigrations(db1, DEFAULT_MIGRATIONS);
    initEngine(db1);
    resetEngineForTests();
    const db2 = openDatabase(":memory:");
    runMigrations(db2, DEFAULT_MIGRATIONS);
    expect(() => initEngine(db2)).not.toThrow();
  });
});
