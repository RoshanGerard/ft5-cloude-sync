// Phase 9c — engine singleton accessor test.
//
// `getEngine()` is the process-wide accessor every IPC handler calls to get
// the shared EngineContext + ClientFactory + DatasourceRegistry. Tests
// must be able to reset the singleton between runs via
// `resetEngineForTests()`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isEncryptionAvailable = vi.fn<() => boolean>(() => true);
function xor(bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[i] = (bytes[i] ?? 0) ^ 0x42;
  }
  return out;
}
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: (): boolean => isEncryptionAvailable(),
    encryptString: (p: string): Buffer => xor(Buffer.from(p, "utf8")),
    decryptString: (b: Buffer): string => xor(b).toString("utf8"),
  },
}));

import { openDatabase, runMigrations } from "../db/database.js";
import { DEFAULT_MIGRATIONS } from "../db/migrations.js";
import {
  getEngine,
  initEngine,
  resetEngineForTests,
} from "./engine.js";

describe("engine singleton (Phase 9c)", () => {
  beforeEach(() => {
    isEncryptionAvailable.mockReturnValue(true);
    resetEngineForTests();
  });

  afterEach(() => {
    resetEngineForTests();
  });

  it("getEngine() throws before initEngine() has been called", () => {
    expect(() => getEngine()).toThrow(/initEngine/i);
  });

  it("initEngine(db) then getEngine() returns an engine with bus, credentialStore, registry, factory", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, DEFAULT_MIGRATIONS);
    initEngine(db);
    const engine = getEngine();
    expect(engine.bus).toBeDefined();
    expect(engine.credentialStore).toBeDefined();
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
