// Phase 9d — `handleDatasourcesAction` runs pause / resume / sync-now via
// the DB-backed registry.
//   * pause / resume flip `registry.setPaused` regardless of the flag.
//   * sync-now fixture path (flag OFF): mirror the old behaviour — flip
//     the row's status to "syncing" and bump `last_sync_at`.
//   * sync-now live path (flag ON): resolve creds via CredentialStore,
//     construct a client via factory.create, call client.status(), then
//     mirror that back into the registry.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import type { ProviderId } from "@ft5/ipc-contracts";

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
import { handleDatasourcesAction } from "../action.js";
import { handleDatasourcesList } from "../list.js";

type SqliteDatabase = ReturnType<typeof openDatabase>;

function findByStatus(status: string) {
  return handleDatasourcesList().datasources.find((ds) => ds.status === status);
}

describe("handleDatasourcesAction", () => {
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
    vi.unstubAllEnvs();
    resetEngineForTests();
    db.close();
  });

  // ---------------------------------------------------------------------
  // pause / resume — flag-independent.
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
  // sync-now — fixture path (flag OFF).
  // ---------------------------------------------------------------------

  it("sync-now (fixture): sets status to syncing and updates lastSyncAt forward", async () => {
    vi.stubEnv("DATASOURCE_ENGINE_LIVE", "");
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

  it("sync-now (fixture): does not touch the factory", async () => {
    vi.stubEnv("DATASOURCE_ENGINE_LIVE", "");
    const { factory } = getEngine();
    const spy = vi.spyOn(factory, "create");
    const target = findByStatus("connected")!;
    await handleDatasourcesAction({ datasourceId: target.id, action: "sync-now" });
    expect(spy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // sync-now — live path (flag ON).
  // ---------------------------------------------------------------------

  it("sync-now (live): constructs a client and mirrors client.status() back into the registry", async () => {
    vi.stubEnv("DATASOURCE_ENGINE_LIVE", "1");
    const status = vi.fn().mockResolvedValue("connected");
    const fakeClient = { status } as unknown as DatasourceClient<ProviderId>;
    const { factory } = getEngine();
    const factorySpy = vi.spyOn(factory, "create").mockReturnValue(fakeClient);

    const target = findByStatus("connected")!;
    const { datasource } = await handleDatasourcesAction({
      datasourceId: target.id,
      action: "sync-now",
    });

    expect(factorySpy).toHaveBeenCalledOnce();
    const [providerId, datasourceId] = factorySpy.mock.calls[0]!;
    expect(providerId).toBe(target.providerId);
    expect(datasourceId).toBe(target.id);
    expect(status).toHaveBeenCalledOnce();
    expect(datasource.status).toBe("connected");
    expect(datasource.lastSyncAt).not.toBeNull();
  });

  it("sync-now (live): client failure lands as status=error with an errorReason", async () => {
    vi.stubEnv("DATASOURCE_ENGINE_LIVE", "1");
    const status = vi.fn().mockRejectedValue(new Error("network down"));
    const fakeClient = { status } as unknown as DatasourceClient<ProviderId>;
    const { factory } = getEngine();
    vi.spyOn(factory, "create").mockReturnValue(fakeClient);

    const target = findByStatus("connected")!;
    const { datasource } = await handleDatasourcesAction({
      datasourceId: target.id,
      action: "sync-now",
    });
    expect(datasource.status).toBe("error");
    expect(typeof datasource.errorReason).toBe("string");
    expect(datasource.errorReason).toMatch(/network down/i);
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
