import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations } from "../db/migrations.js";

import { DEFAULT_POLICY, PolicyStore } from "./policy-store.js";

let cleanup: string[] = [];
let db: Database.Database;
let store: PolicyStore;

beforeEach(() => {
  const file = path.join(
    os.tmpdir(),
    `ft5-sync-policy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  cleanup.push(file);
  db = new Database(file);
  applyMigrations(db);
  store = new PolicyStore(db);
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

describe("PolicyStore", () => {
  it("returns null for a policy that has not been set", () => {
    expect(store.get("global")).toBeNull();
    expect(store.get("datasource", "ds-1")).toBeNull();
  });

  it("upsert + get round-trips a global policy", () => {
    store.upsert({
      scope: "global",
      datasourceId: null,
      maxAttempts: 5,
      backoffMs: 1000,
      backoffStrategy: "fixed",
      maxAgeMs: 60_000,
    });
    const p = store.get("global");
    expect(p).toMatchObject({
      scope: "global",
      datasourceId: null,
      maxAttempts: 5,
      backoffMs: 1000,
      backoffStrategy: "fixed",
      maxAgeMs: 60_000,
    });
  });

  it("upsert updates an existing row in place", () => {
    store.upsert({
      scope: "global",
      datasourceId: null,
      maxAttempts: 1,
      backoffMs: 100,
      backoffStrategy: "fixed",
      maxAgeMs: null,
    });
    store.upsert({
      scope: "global",
      datasourceId: null,
      maxAttempts: 9,
      backoffMs: 100,
      backoffStrategy: "fixed",
      maxAgeMs: null,
    });
    const p = store.get("global");
    expect(p?.maxAttempts).toBe(9);
  });

  it("effectiveFor prefers per-datasource policy, then global, then defaults", () => {
    expect(store.effectiveFor("ds-unknown")).toEqual(DEFAULT_POLICY);

    store.upsert({
      scope: "global",
      datasourceId: null,
      maxAttempts: 7,
      backoffMs: 500,
      backoffStrategy: "exponential",
      maxAgeMs: null,
    });
    expect(store.effectiveFor("ds-1").maxAttempts).toBe(7);

    store.upsert({
      scope: "datasource",
      datasourceId: "ds-1",
      maxAttempts: 2,
      backoffMs: 100,
      backoffStrategy: "fixed",
      maxAgeMs: null,
    });
    const perDs = store.effectiveFor("ds-1");
    expect(perDs.maxAttempts).toBe(2);
    expect(perDs.backoffMs).toBe(100);

    // A different datasource still gets the global fallback.
    expect(store.effectiveFor("ds-2").maxAttempts).toBe(7);
  });
});
