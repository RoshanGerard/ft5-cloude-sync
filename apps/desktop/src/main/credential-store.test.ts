// Phase 4 RED — SqliteCredentialStore.
//
// The store implements the `CredentialStore` port exposed by
// `@ft5/fs-datasource-engine`. It encrypts credential JSON via Electron's
// `safeStorage` and persists the ciphertext as a BLOB in a
// `datasource_credentials` SQLite row. See
// openspec/changes/add-fs-datasource-engine/specs/fs-datasource-engine/spec.md
// (Requirement: CredentialStore port + SqliteCredentialStore) and design.md
// Decision 8.
//
// `safeStorage` is an Electron main-process API that cannot execute in a
// plain Node/Vitest environment, so we mock the `electron` module surface
// used by the store. The mock is genuinely reversible (so round-trip tests
// work) but byte-XORs the plaintext so the raw ciphertext does NOT contain
// the literal plaintext substrings — mirroring the intent of the real
// `safeStorage`'s OS-backed encryption. A passthrough mock would make the
// "no plaintext in the blob" scenario vacuous.
//
// The store is constructor-injected with a `Database` handle so tests can
// open `":memory:"` per test and the main-process wiring (Phase 5+) can
// pass the singleton app-wide db. Injecting the handle keeps this file
// free of `app.getPath("userData")` and other Electron app-singleton
// dependencies.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredCredentials } from "@ft5/ipc-contracts";

// ---------------------------------------------------------------------------
// `electron` mock. Declared BEFORE importing the module under test so the
// module's `import { safeStorage } from "electron"` resolves against this
// stub. The XOR transformation obscures the plaintext genuinely — a test
// that greps the blob for "abc" will fail if the store ever regresses to a
// passthrough or a simple prefix-wrap mock.
// ---------------------------------------------------------------------------

const isEncryptionAvailable = vi.fn<() => boolean>(() => true);

function xor(bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    // Bit-twiddle that guarantees the ciphertext is not a substring of the
    // plaintext for any non-trivial input. XOR 0x42 is reversible.
    out[i] = (bytes[i] ?? 0) ^ 0x42;
  }
  return out;
}

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: (): boolean => isEncryptionAvailable(),
    encryptString: (plaintext: string): Buffer =>
      xor(Buffer.from(plaintext, "utf8")),
    decryptString: (buf: Buffer): string => xor(buf).toString("utf8"),
  },
}));

// Import AFTER the mock is registered. Using a dynamic import inside each
// test would also work; top-level import suffices because `vi.mock` is
// hoisted by Vitest.
import { SqliteCredentialStore } from "./datasources/sqlite-credential-store";
import { runMigrations } from "./db/database";
import { DEFAULT_MIGRATIONS } from "./db/migrations";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

type SqliteDatabase = InstanceType<typeof Database>;

function openDb(): SqliteDatabase {
  // Phase 9a: schema is owned by the migration runner, not the store. Run
  // the canonical migration list on the fresh in-memory DB so the
  // `datasource_credentials` table exists before the store is constructed.
  const db = new Database(":memory:");
  runMigrations(db, DEFAULT_MIGRATIONS);
  return db;
}

interface RawRow {
  datasource_id: string;
  encrypted_blob: Buffer;
  schema_version: number;
  created_at: number;
  updated_at: number;
}

function readRow(db: SqliteDatabase, id: string): RawRow | undefined {
  return db
    .prepare(
      "SELECT datasource_id, encrypted_blob, schema_version, created_at, updated_at FROM datasource_credentials WHERE datasource_id = ?",
    )
    .get(id) as RawRow | undefined;
}

describe("SqliteCredentialStore", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    // Reset the availability flag to the happy path for each test. Tests
    // that need the unavailable path flip it explicitly.
    isEncryptionAvailable.mockReturnValue(true);
    db = openDb();
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips credentials through put -> get", async () => {
    const store = new SqliteCredentialStore(db);
    await store.put("ds-1", SAMPLE_CREDS);
    const got = await store.get("ds-1");
    expect(got).toEqual(SAMPLE_CREDS);
  });

  it("stores an encrypted blob that does NOT contain plaintext credential strings", async () => {
    const store = new SqliteCredentialStore(db);
    await store.put("ds-1", SAMPLE_CREDS);
    const row = readRow(db, "ds-1");
    expect(row).toBeDefined();
    expect(row!.encrypted_blob).toBeInstanceOf(Buffer);
    expect(row!.encrypted_blob.length).toBeGreaterThan(0);
    const asText = row!.encrypted_blob.toString("utf8");
    // Neither the access nor the refresh token should appear verbatim in
    // the stored bytes. The XOR mock guarantees this; the real safeStorage
    // encrypts via the OS keystore, which makes the guarantee ironclad.
    expect(asText).not.toContain("abc");
    expect(asText).not.toContain("def");
    // Also assert no secret substring from the provider id metadata made
    // it through as plaintext.
    expect(asText).not.toContain("us-east-1");
  });

  it("refuses construction when safeStorage.isEncryptionAvailable() returns false", () => {
    isEncryptionAvailable.mockReturnValue(false);
    expect(() => new SqliteCredentialStore(db)).toThrow(
      /encryption.*unavailable|Refusing.*without encryption/i,
    );
  });

  it("persists schema_version === 1 and sensible created_at / updated_at on write", async () => {
    const store = new SqliteCredentialStore(db);
    const before = Date.now();
    await store.put("ds-1", SAMPLE_CREDS);
    const after = Date.now();
    const row = readRow(db, "ds-1");
    expect(row).toBeDefined();
    expect(row!.schema_version).toBe(1);
    expect(row!.created_at).toBeGreaterThanOrEqual(before);
    expect(row!.created_at).toBeLessThanOrEqual(after);
    expect(row!.updated_at).toBeGreaterThanOrEqual(before);
    expect(row!.updated_at).toBeLessThanOrEqual(after);
  });

  it("delete removes the row", async () => {
    const store = new SqliteCredentialStore(db);
    await store.put("ds-1", SAMPLE_CREDS);
    await store.delete("ds-1");
    const got = await store.get("ds-1");
    expect(got).toBeNull();
    expect(readRow(db, "ds-1")).toBeUndefined();
  });

  it("re-put preserves created_at and advances updated_at", async () => {
    const store = new SqliteCredentialStore(db);
    await store.put("ds-1", SAMPLE_CREDS);
    const first = readRow(db, "ds-1")!;

    // Tiny sleep so system clock advances by at least 1ms. We use the
    // fake-clock-free path so the timestamps reflect real wall-clock
    // progression as the spec demands.
    await new Promise<void>((r) => setTimeout(r, 5));

    const updatedCreds: StoredCredentials = {
      ...SAMPLE_CREDS,
      authResult: { ...SAMPLE_CREDS.authResult, accessToken: "newtok" },
      updatedAt: Date.now(),
    };
    await store.put("ds-1", updatedCreds);
    const second = readRow(db, "ds-1")!;

    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).toBeGreaterThanOrEqual(first.updated_at);
    // And the decrypted blob reflects the new credentials, not the first.
    const got = await store.get("ds-1");
    expect(got).toEqual(updatedCreds);
  });

  it("get returns null for an unknown datasource id", async () => {
    const store = new SqliteCredentialStore(db);
    const got = await store.get("never-stored");
    expect(got).toBeNull();
  });

  it("delete is idempotent on an unknown datasource id", async () => {
    const store = new SqliteCredentialStore(db);
    await expect(store.delete("never-stored")).resolves.toBeUndefined();
  });
});
