// Phase 9d — `handleDatasourcesRemove` deletes both the datasource row
// and its encrypted credential blob via the DB-backed registry. The
// handler has no flag-gated branch — `list`-style pure-DB paths run under
// both regimes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// See add.test.ts for the rationale — `vi.mock` is hoisted above all
// imports, so the factory must be self-contained via `vi.hoisted`.
const { electronMockFactory } = vi.hoisted(() => {
  function xor(bytes: Buffer): Buffer {
    const out = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
      out[i] = (bytes[i] ?? 0) ^ 0x42;
    }
    return out;
  }
  return {
    electronMockFactory: () => ({
      safeStorage: {
        isEncryptionAvailable: (): boolean => true,
        encryptString: (p: string): Buffer => xor(Buffer.from(p, "utf8")),
        decryptString: (b: Buffer): string => xor(b).toString("utf8"),
      },
    }),
  };
});

vi.mock("electron", electronMockFactory);

import { FIXTURE_SUMMARIES, makeCreds } from "./helpers.js";

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

  beforeEach(async () => {
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
      await registry.add(seed, makeCreds(summary.providerId));
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

  it("cascades to the credential store — credential blob is gone after remove", async () => {
    const target = handleDatasourcesList().datasources[0]!;
    const { credentialStore } = getEngine();
    // Sanity: the seed put creds there.
    expect(await credentialStore.get(target.id)).not.toBeNull();
    await handleDatasourcesRemove({ datasourceId: target.id });
    expect(await credentialStore.get(target.id)).toBeNull();
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

  it("behaves identically with DATASOURCE_ENGINE_LIVE unset (no provider/engine call)", async () => {
    // Guard: vi.stubEnv makes sure no other test bleeds the flag into this
    // one. remove has no flag branch, but we still assert that toggling
    // it off does not change behaviour and does not trigger a factory
    // call (factory is wired but must never be touched by remove).
    vi.stubEnv("DATASOURCE_ENGINE_LIVE", "");
    const { factory } = getEngine();
    const factorySpy = vi.spyOn(factory, "create");
    const target = handleDatasourcesList().datasources[0]!;
    await handleDatasourcesRemove({ datasourceId: target.id });
    expect(factorySpy).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
