// Phase 9b RED — DB-backed DatasourceRegistry.
//
// Replaces the in-memory fixture at
// `apps/desktop/src/main/ipc/datasources/store.ts`. Management IPC handlers
// (add / list / remove / action) will be rewritten in Phase 9d to delegate
// to this class. The registry pairs with `SqliteCredentialStore` — `add`
// writes a row AND a credential blob in one transaction; `remove` deletes
// both. `list()` maps DB rows to the shared `DatasourceSummary` contract
// (sets `status="paused"` when the `paused` column is 1, overriding the
// underlying status column so the UI sees the effective state).
//
// Design refs:
//   - openspec/changes/add-fs-datasource-engine/design.md Phase 9 scoping.
//   - openspec/changes/add-fs-datasource-engine/tasks.md 9.6-9.8.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Electron up front — the registry never touches it directly, but we
// import through `SqliteCredentialStore` indirectly in one integration
// spec. Same XOR stub as `credential-store.test.ts`.
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

import type { StoredCredentials } from "@ft5/ipc-contracts";
import { openDatabase, runMigrations } from "../db/database.js";
import { DEFAULT_MIGRATIONS } from "../db/migrations.js";
import { SqliteCredentialStore } from "./sqlite-credential-store.js";
import { DatasourceRegistry } from "./registry.js";

type SqliteDatabase = ReturnType<typeof openDatabase>;

const SAMPLE_CREDS: StoredCredentials = {
  providerId: "amazon-s3",
  authResult: {
    accessToken: "abc",
    refreshToken: "def",
    expiresAt: 1_700_000_000_000,
    meta: { region: "us-east-1" },
  },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

describe("DatasourceRegistry (Phase 9b)", () => {
  let db: SqliteDatabase;
  let credentialStore: SqliteCredentialStore;
  let registry: DatasourceRegistry;

  beforeEach(() => {
    isEncryptionAvailable.mockReturnValue(true);
    db = openDatabase(":memory:");
    runMigrations(db, DEFAULT_MIGRATIONS);
    credentialStore = new SqliteCredentialStore(db);
    registry = new DatasourceRegistry(db, credentialStore);
  });

  afterEach(() => {
    db.close();
  });

  it("list() returns [] on an empty DB", () => {
    expect(registry.list()).toEqual([]);
  });

  it("add() inserts a row and a credential blob atomically", async () => {
    const summary = await registry.add(
      {
        id: "ds-1",
        displayName: "My Bucket",
        providerId: "amazon-s3",
        status: "connected",
        lastSyncAt: null,
        itemCount: 0,
      },
      SAMPLE_CREDS,
    );
    expect(summary.id).toBe("ds-1");
    expect(summary.providerId).toBe("amazon-s3");
    expect(summary.status).toBe("connected");

    const listed = registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe("ds-1");

    // Credentials persisted alongside.
    const got = await credentialStore.get("ds-1");
    expect(got).toEqual(SAMPLE_CREDS);
  });

  it("add() stamps created_at and updated_at to Date.now()", async () => {
    const before = Date.now();
    await registry.add(
      {
        id: "ds-1",
        displayName: "X",
        providerId: "amazon-s3",
        status: "connected",
        lastSyncAt: null,
        itemCount: 0,
      },
      SAMPLE_CREDS,
    );
    const after = Date.now();
    const row = db
      .prepare(
        "SELECT created_at, updated_at FROM datasources WHERE id = ?",
      )
      .get("ds-1") as { created_at: number; updated_at: number };
    expect(row.created_at).toBeGreaterThanOrEqual(before);
    expect(row.created_at).toBeLessThanOrEqual(after);
    expect(row.updated_at).toBeGreaterThanOrEqual(before);
    expect(row.updated_at).toBeLessThanOrEqual(after);
  });

  it("add() is atomic: a credential-write failure rolls back the row insert", async () => {
    // Simulate a safeStorage failure AFTER construction.
    isEncryptionAvailable.mockReturnValue(true);
    const throwingCreds: unknown = {
      get providerId(): string {
        throw new Error("bad credentials");
      },
    };
    await expect(
      registry.add(
        {
          id: "ds-boom",
          displayName: "X",
          providerId: "amazon-s3",
          status: "connected",
          lastSyncAt: null,
          itemCount: 0,
        },
        throwingCreds as StoredCredentials,
      ),
    ).rejects.toThrow();
    // The datasource row should NOT be present — the credential put
    // rejected before any DB insert ran.
    const rowCount = db
      .prepare("SELECT COUNT(*) AS n FROM datasources WHERE id = ?")
      .get("ds-boom") as { n: number };
    expect(rowCount.n).toBe(0);
  });

  it("remove() deletes the row AND the credential blob in one transaction", async () => {
    await registry.add(
      {
        id: "ds-1",
        displayName: "X",
        providerId: "amazon-s3",
        status: "connected",
        lastSyncAt: null,
        itemCount: 0,
      },
      SAMPLE_CREDS,
    );
    const removed = await registry.remove("ds-1");
    expect(removed).toBe(true);
    expect(registry.list()).toEqual([]);
    expect(await credentialStore.get("ds-1")).toBeNull();
  });

  it("remove() returns false for an unknown id", async () => {
    expect(await registry.remove("nope")).toBe(false);
  });

  it("setPaused(true) makes list() report status='paused' without mutating the underlying status column", async () => {
    await registry.add(
      {
        id: "ds-1",
        displayName: "X",
        providerId: "onedrive",
        status: "connected",
        lastSyncAt: null,
        itemCount: 5,
      },
      SAMPLE_CREDS,
    );
    registry.setPaused("ds-1", true);

    // List() projects status='paused' when paused=1.
    const summary = registry.list()[0]!;
    expect(summary.status).toBe("paused");

    // But the status column retains its pre-pause value.
    const row = db
      .prepare("SELECT status, paused FROM datasources WHERE id = ?")
      .get("ds-1") as { status: string; paused: number };
    expect(row.status).toBe("connected");
    expect(row.paused).toBe(1);
  });

  it("setPaused(false) flips the flag back and list() reflects the underlying status again", async () => {
    await registry.add(
      {
        id: "ds-1",
        displayName: "X",
        providerId: "onedrive",
        status: "syncing",
        lastSyncAt: null,
        itemCount: 5,
      },
      SAMPLE_CREDS,
    );
    registry.setPaused("ds-1", true);
    registry.setPaused("ds-1", false);

    const summary = registry.list()[0]!;
    expect(summary.status).toBe("syncing");
  });

  it("setStatus() updates status + errorReason without touching paused", async () => {
    await registry.add(
      {
        id: "ds-1",
        displayName: "X",
        providerId: "google-drive",
        status: "connected",
        lastSyncAt: null,
        itemCount: 0,
      },
      SAMPLE_CREDS,
    );
    registry.setPaused("ds-1", true);
    registry.setStatus("ds-1", "error", "auth token expired");

    const row = db
      .prepare(
        "SELECT status, error_reason, paused FROM datasources WHERE id = ?",
      )
      .get("ds-1") as {
      status: string;
      error_reason: string;
      paused: number;
    };
    expect(row.status).toBe("error");
    expect(row.error_reason).toBe("auth token expired");
    expect(row.paused).toBe(1); // untouched
  });

  it("setStatus() clears error_reason when omitted or null", async () => {
    await registry.add(
      {
        id: "ds-1",
        displayName: "X",
        providerId: "google-drive",
        status: "error",
        lastSyncAt: null,
        itemCount: 0,
        errorReason: "boom",
      },
      SAMPLE_CREDS,
    );
    registry.setStatus("ds-1", "connected");
    const row = db
      .prepare("SELECT error_reason FROM datasources WHERE id = ?")
      .get("ds-1") as { error_reason: string | null };
    expect(row.error_reason).toBeNull();
  });

  it("touchLastSyncAt() bumps last_sync_at to Date.now()", async () => {
    await registry.add(
      {
        id: "ds-1",
        displayName: "X",
        providerId: "amazon-s3",
        status: "connected",
        lastSyncAt: null,
        itemCount: 0,
      },
      SAMPLE_CREDS,
    );
    const before = Date.now();
    registry.touchLastSyncAt("ds-1");
    const after = Date.now();
    const summary = registry.list()[0]!;
    expect(summary.lastSyncAt).not.toBeNull();
    expect(summary.lastSyncAt!).toBeGreaterThanOrEqual(before);
    expect(summary.lastSyncAt!).toBeLessThanOrEqual(after);
  });

  it("getProviderId() returns the provider id for a known datasource or null", async () => {
    await registry.add(
      {
        id: "ds-1",
        displayName: "X",
        providerId: "onedrive",
        status: "connected",
        lastSyncAt: null,
        itemCount: 0,
      },
      SAMPLE_CREDS,
    );
    expect(registry.getProviderId("ds-1")).toBe("onedrive");
    expect(registry.getProviderId("unknown")).toBeNull();
  });

  it("list() maps error_reason to errorReason and preserves item_count / last_sync_at", async () => {
    await registry.add(
      {
        id: "ds-1",
        displayName: "X",
        providerId: "google-drive",
        status: "error",
        lastSyncAt: 1_700_000_000_000,
        itemCount: 42,
        errorReason: "network down",
      },
      SAMPLE_CREDS,
    );
    const [summary] = registry.list();
    expect(summary!.errorReason).toBe("network down");
    expect(summary!.itemCount).toBe(42);
    expect(summary!.lastSyncAt).toBe(1_700_000_000_000);
  });
});
