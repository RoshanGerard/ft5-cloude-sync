// SqliteCredentialStore — Electron-backed implementation of the engine's
// `CredentialStore` port. Credentials are JSON-serialized, encrypted via
// `safeStorage.encryptString`, and persisted as a BLOB in the
// `datasource_credentials` SQLite table.
//
// Design references:
//   - openspec/changes/add-fs-datasource-engine/design.md Decision 8.
//   - openspec/changes/add-fs-datasource-engine/specs/fs-datasource-engine/spec.md
//     Requirement "CredentialStore port + SqliteCredentialStore implementation".
//
// Policy highlights enforced here:
//   1. Strict refuse: if `safeStorage.isEncryptionAvailable()` returns `false`
//      at construction, the constructor throws and the instance never enters
//      a useful state. There is NO plaintext fallback. On Linux this means
//      the host machine must have libsecret (gnome-keyring, KWallet) present;
//      the error message tells the user so. See Risks in design.md.
//   2. Upsert, not REPLACE: re-putting an existing id preserves the row's
//      `created_at` and advances only `updated_at`. `INSERT OR REPLACE` would
//      delete-then-insert, losing `created_at`. We use `INSERT ... ON
//      CONFLICT DO UPDATE` instead.
//   3. `schema_version` is hard-coded to `1` on every write. The column
//      exists so a future change can introduce a v2 format (e.g., envelope
//      key rotation, AEAD with associated data, or a switch to SQLCipher)
//      alongside a `migrate()` helper WITHOUT changing the engine's
//      `CredentialStore` port contract. The port has three methods — `get`,
//      `put`, `delete` — none of which leak the on-disk version; re-encryption
//      can be a host-only concern that iterates rows, decrypts with the old
//      scheme, re-encrypts with the new, and bumps `schema_version`. Phase 4
//      ships only v1; reads currently do not branch on the version.
//   4. Timestamps are stored as Unix-millis `INTEGER` (what `Date.now()`
//      produces). They are wall-clock numbers, not UTC strings.
//
// Constructor-injected DB: the store accepts an opened `Database` handle
// instead of opening one itself. This keeps the store trivially testable
// (in-memory DB per test) and leaves "where does the app open its single
// main-process DB?" to Phase 5+ which owns the `EngineContext` wiring.

import type Database from "better-sqlite3";
import { safeStorage } from "electron";

import type { CredentialStore } from "@ft5/fs-datasource-engine";
import type { StoredCredentials } from "@ft5/ipc-contracts";

// Schema + migration. Idempotent via `IF NOT EXISTS`, so calling it on a DB
// that already has the table (e.g., the app's singleton DB opened once at
// boot) is safe. The column shapes are spec-mandated.
const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS datasource_credentials (
    datasource_id  TEXT    PRIMARY KEY,
    encrypted_blob BLOB    NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
`;

// Upsert: on conflict, update the encrypted blob + updated_at but preserve
// the original created_at. `excluded.*` refers to the values of the proposed
// new row. We intentionally do NOT copy `excluded.created_at` into the
// existing row — that would break the "re-put preserves created_at"
// guarantee. `schema_version` is pinned to 1 so a later version upgrade is
// explicit via a dedicated migration, not a silent overwrite.
const UPSERT_SQL = `
  INSERT INTO datasource_credentials
    (datasource_id, encrypted_blob, schema_version, created_at, updated_at)
  VALUES
    (?, ?, 1, ?, ?)
  ON CONFLICT(datasource_id) DO UPDATE SET
    encrypted_blob = excluded.encrypted_blob,
    updated_at     = excluded.updated_at
`;

const SELECT_SQL = `
  SELECT encrypted_blob FROM datasource_credentials WHERE datasource_id = ?
`;

const DELETE_SQL = `
  DELETE FROM datasource_credentials WHERE datasource_id = ?
`;

interface BlobRow {
  encrypted_blob: Buffer;
}

/** Type of an opened `better-sqlite3` database. We import the type via
 * `import type` so this module does not pull the native binding at type-check
 * time; the runtime `safeStorage` import is the only concrete Electron
 * dependency touched here. */
type SqliteDatabase = InstanceType<typeof Database>;

export class SqliteCredentialStore implements CredentialStore {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    // Strict-refuse gate. The check happens BEFORE any DB work so a user on
    // a Linux box without libsecret gets the clearest possible signal at
    // boot rather than a cryptic runtime error on the first credential
    // write.
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "Credential encryption is unavailable on this system — install libsecret-1-0 (Linux) or run on a supported platform. Refusing to start without encryption.",
      );
    }
    this.db = db;
    // Idempotent migration. Running it on every construction is cheap on
    // SQLite and keeps the store self-contained; Phase 5+ can hoist this
    // into a dedicated migration runner if more tables accumulate.
    this.db.exec(MIGRATION_SQL);
  }

  async get(datasourceId: string): Promise<StoredCredentials | null> {
    const row = this.db.prepare(SELECT_SQL).get(datasourceId) as
      | BlobRow
      | undefined;
    if (row === undefined) {
      return null;
    }
    const plaintext = safeStorage.decryptString(row.encrypted_blob);
    // JSON.parse will throw if the blob is corrupt; we surface the throw
    // rather than swallow it — a corrupted credentials row is a host-level
    // concern and callers should see the failure loud and clear.
    return JSON.parse(plaintext) as StoredCredentials;
  }

  async put(datasourceId: string, creds: StoredCredentials): Promise<void> {
    // Encrypt the serialized credentials. `encryptString` returns a `Buffer`
    // on main; we pass it to better-sqlite3 as a BLOB bind parameter — the
    // driver accepts `Buffer` natively.
    const plaintext = JSON.stringify(creds);
    const ciphertext = safeStorage.encryptString(plaintext);
    const now = Date.now();
    this.db.prepare(UPSERT_SQL).run(datasourceId, ciphertext, now, now);
  }

  async delete(datasourceId: string): Promise<void> {
    // Idempotent: `DELETE` on a missing row is a no-op for SQLite — it just
    // reports `changes: 0`. Per the port contract we MUST NOT throw for
    // unknown ids.
    this.db.prepare(DELETE_SQL).run(datasourceId);
  }
}
