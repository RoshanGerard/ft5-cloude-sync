// Phase 9d — `handleDatasourcesAdd` persists via the DB-backed registry
// (`getEngine().registry`) and stores credentials via the
// `SqliteCredentialStore`. The test boots a fresh in-memory engine each
// run so additions are isolated.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above all imports, so the factory cannot close
// over a module-scoped import. Inline the factory via `vi.hoisted` so it
// is fully self-contained (the XOR body here matches the credential-store
// test's mock — it genuinely obscures plaintext).
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

import { openDatabase, runMigrations } from "../../../db/database.js";
import { DEFAULT_MIGRATIONS } from "../../../db/migrations.js";
import {
  getEngine,
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

  it("persists credentials alongside the datasource row", async () => {
    const { datasource } = await handleDatasourcesAdd({
      providerId: "amazon-s3",
      credentials: {
        accessKeyId: "AKIA-TEST",
        secretAccessKey: "secret-shh",
      },
    });
    const { credentialStore } = getEngine();
    const creds = await credentialStore.get(datasource.id);
    expect(creds).not.toBeNull();
    expect(creds!.providerId).toBe("amazon-s3");
    // Raw credentials blob is preserved under authResult.meta so the
    // engine's ClientFactory can consume provider-specific fields.
    expect(
      (creds!.authResult.meta as Record<string, unknown>).accessKeyId,
    ).toBe("AKIA-TEST");
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
