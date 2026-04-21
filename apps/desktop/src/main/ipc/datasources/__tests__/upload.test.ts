// Phase 9d — `handleDatasourcesUpload` runs one of two paths:
//   * Fixture path (flag OFF): emit the canned uploading/completed pair,
//     never touch the provider or the factory. Mirrors the old behaviour.
//   * Live path (flag ON): resolve credentials via `CredentialStore`,
//     construct a client via `ClientFactory.create`, and call
//     `client.uploadFile(parent, file)` with a path-form `Target` per
//     selected file.
//
// The tests spy on `factory.create` (engine is a real singleton backed by
// an in-memory DB) so we assert the exact provider / creds / target
// shape the handler passes to the engine.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import type {
  DatasourcesUploadProgressEvent,
  ProviderId,
} from "@ft5/ipc-contracts";

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
import { handleDatasourcesUpload, type UploadDeps } from "../upload.js";

type SqliteDatabase = ReturnType<typeof openDatabase>;

function makeDeps(overrides: Partial<UploadDeps> = {}): UploadDeps {
  return {
    showOpenDialog: vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ["C:/mock/file-a.txt", "C:/mock/file-b.txt"],
    }),
    sendProgress: vi.fn(),
    nextTransactionId: vi.fn().mockReturnValue("tx-test-1"),
    ...overrides,
  };
}

describe("handleDatasourcesUpload", () => {
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
  // Fixture path (flag OFF)
  // ---------------------------------------------------------------------

  it("opens the main-process dialog and returns a transactionId (fixture path)", async () => {
    vi.stubEnv("DATASOURCE_ENGINE_LIVE", "");
    const deps = makeDeps();
    const response = await handleDatasourcesUpload(
      { datasourceId: "ds-gdrive-personal" },
      deps,
    );
    expect(deps.showOpenDialog).toHaveBeenCalledOnce();
    expect(response.transactionId).toBe("tx-test-1");
  });

  it("emits uploading → completed progress events scoped to the transactionId (fixture path)", async () => {
    vi.stubEnv("DATASOURCE_ENGINE_LIVE", "");
    const deps = makeDeps();
    await handleDatasourcesUpload(
      { datasourceId: "ds-gdrive-personal" },
      deps,
    );
    const sendProgress = deps.sendProgress as unknown as ReturnType<
      typeof vi.fn
    >;
    expect(sendProgress).toHaveBeenCalled();
    const emitted: DatasourcesUploadProgressEvent[] = sendProgress.mock.calls.map(
      (call: unknown[]) => call[0] as DatasourcesUploadProgressEvent,
    );
    for (const ev of emitted) {
      expect(ev.transactionId).toBe("tx-test-1");
    }
    const statuses = emitted.map((ev) => ev.status);
    expect(statuses).toContain("uploading");
    expect(statuses[statuses.length - 1]).toBe("completed");
  });

  it("does not touch the factory on the fixture path", async () => {
    vi.stubEnv("DATASOURCE_ENGINE_LIVE", "");
    const { factory } = getEngine();
    const spy = vi.spyOn(factory, "create");
    await handleDatasourcesUpload(
      { datasourceId: "ds-gdrive-personal" },
      makeDeps(),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws when the user cancels the file picker", async () => {
    vi.stubEnv("DATASOURCE_ENGINE_LIVE", "");
    const deps = makeDeps({
      showOpenDialog: vi
        .fn()
        .mockResolvedValue({ canceled: true, filePaths: [] }),
    });
    await expect(
      handleDatasourcesUpload({ datasourceId: "ds-gdrive-personal" }, deps),
    ).rejects.toThrow(/cancell?ed/i);
    expect(deps.sendProgress).not.toHaveBeenCalled();
  });

  it("throws when the datasource does not exist", async () => {
    vi.stubEnv("DATASOURCE_ENGINE_LIVE", "");
    const deps = makeDeps();
    await expect(
      handleDatasourcesUpload({ datasourceId: "ds-nope" }, deps),
    ).rejects.toThrow(/not found/i);
    expect(deps.showOpenDialog).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Live path (flag ON) — factory + client are spied.
  // ---------------------------------------------------------------------

  it("live path: resolves creds, constructs a client via factory, and calls uploadFile with a path-form Target per file", async () => {
    vi.stubEnv("DATASOURCE_ENGINE_LIVE", "1");
    const uploadFile = vi.fn().mockResolvedValue(undefined);
    const fakeClient = {
      uploadFile,
    } as unknown as DatasourceClient<ProviderId>;
    const { factory } = getEngine();
    const factorySpy = vi
      .spyOn(factory, "create")
      .mockReturnValue(fakeClient);

    const deps = makeDeps();
    const response = await handleDatasourcesUpload(
      { datasourceId: "ds-gdrive-personal" },
      deps,
    );

    // factory.create wired with correct provider + datasource + creds
    expect(factorySpy).toHaveBeenCalledOnce();
    const [providerId, datasourceId, creds] = factorySpy.mock.calls[0]!;
    expect(providerId).toBe("google-drive");
    expect(datasourceId).toBe("ds-gdrive-personal");
    expect(creds.providerId).toBe("google-drive");

    // One uploadFile call per selected file, each with a path-form Target
    // rooted at "/".
    expect(uploadFile).toHaveBeenCalledTimes(2);
    for (const call of uploadFile.mock.calls) {
      const [parent, file] = call;
      expect(parent).toEqual({ kind: "path", path: "/" });
      expect(typeof file.path).toBe("string");
      expect(file.name).toBe(path.basename(file.path));
    }

    // Envelope response shape preserved.
    expect(response.transactionId).toBe("tx-test-1");

    // Final progress event is "completed".
    const sendProgress = deps.sendProgress as unknown as ReturnType<
      typeof vi.fn
    >;
    const emitted: DatasourcesUploadProgressEvent[] = sendProgress.mock.calls.map(
      (call: unknown[]) => call[0] as DatasourcesUploadProgressEvent,
    );
    expect(emitted[emitted.length - 1]!.status).toBe("completed");
  });

  it("live path: missing credentials surfaces a failed progress event", async () => {
    vi.stubEnv("DATASOURCE_ENGINE_LIVE", "1");
    const { credentialStore, registry } = getEngine();
    // Pick a seeded datasource, then wipe its creds out from under the
    // handler. The row remains so the early "not found" guard passes.
    const target = registry.list()[0]!;
    await credentialStore.delete(target.id);

    const deps = makeDeps();
    const response = await handleDatasourcesUpload(
      { datasourceId: target.id },
      deps,
    );
    expect(response.transactionId).toBe("tx-test-1");

    const sendProgress = deps.sendProgress as unknown as ReturnType<
      typeof vi.fn
    >;
    const emitted: DatasourcesUploadProgressEvent[] = sendProgress.mock.calls.map(
      (call: unknown[]) => call[0] as DatasourcesUploadProgressEvent,
    );
    expect(emitted.at(-1)!.status).toBe("failed");
  });
});
