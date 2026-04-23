// Main-process SQLite migrations — Phase 9a + wire-fs-sync-service 9.4.
//
// Order matters: the runner applies entries in array order and records each
// id in the `_migrations` bookkeeping table. Appending is the only safe
// change — never re-order, never rename, never rewrite an already-shipped
// migration. To reverse a prior migration, append a new one that
// compensates.
//
// Current migrations:
//   - 0001_datasource_credentials: owns the `datasource_credentials` table
//     used by the legacy `SqliteCredentialStore`. The store no longer creates
//     the table itself — callers MUST run
//     `runMigrations(db, DEFAULT_MIGRATIONS)` before constructing the store,
//     including in tests. This is the single source of truth for the schema
//     so later `ALTER TABLE` migrations cannot be silently shadowed by
//     defense-in-depth table creation. Slated for removal from
//     `DEFAULT_MIGRATIONS` once the store is deleted (wire-fs-sync-service
//     tasks 9.1/9.2/9.5 — atomic change).
//   - 0002_datasources: the datasource-registry table used by the new
//     `DatasourceRegistry` (Phase 9b).
//   - 0003_drop_datasource_credentials: drops the `datasource_credentials`
//     table. Added in wire-fs-sync-service as the first half of retiring
//     the desktop-side credential store. Exported but NOT yet appended to
//     `DEFAULT_MIGRATIONS` — see the note below for why.
//
// Naming note: this migration's id is 0003, not 0002 as the
// wire-fs-sync-service tasks.md originally wrote. The tasks doc was
// authored before `0002_datasources` landed (Phase 9b of
// add-fs-datasource-engine), which already claims the 0002 slot. The
// migration runner tracks ids as strings — there is no requirement that
// ids be contiguous, so 0003 is fine and cannot collide with 0002.

import type { Migration } from "./database.js";

// ---------------------------------------------------------------------------
// 0001 — datasource_credentials
// ---------------------------------------------------------------------------

const CREATE_DATASOURCE_CREDENTIALS_SQL = `
  CREATE TABLE IF NOT EXISTS datasource_credentials (
    datasource_id  TEXT    PRIMARY KEY,
    encrypted_blob BLOB    NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
`;

export const migration_0001_datasource_credentials: Migration = {
  id: "0001_datasource_credentials",
  up: (db) => {
    db.exec(CREATE_DATASOURCE_CREDENTIALS_SQL);
  },
};

// ---------------------------------------------------------------------------
// 0002 — datasources (the DB-backed registry replacing `store.ts`)
// ---------------------------------------------------------------------------

const CREATE_DATASOURCES_SQL = `
  CREATE TABLE IF NOT EXISTS datasources (
    id             TEXT    PRIMARY KEY,
    provider_id    TEXT    NOT NULL,
    display_name   TEXT    NOT NULL,
    item_count     INTEGER,
    last_sync_at   INTEGER,
    status         TEXT    NOT NULL,
    error_reason   TEXT,
    paused         INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
`;

export const migration_0002_datasources: Migration = {
  id: "0002_datasources",
  up: (db) => {
    db.exec(CREATE_DATASOURCES_SQL);
  },
};

// ---------------------------------------------------------------------------
// 0003 — drop datasource_credentials (wire-fs-sync-service 9.4)
// ---------------------------------------------------------------------------
//
// The credential store is being retired: credentials now live exclusively in
// the fs-sync service and are never round-tripped through the desktop main
// process. This migration drops the now-unused `datasource_credentials`
// table. `DROP TABLE IF EXISTS` keeps the migration idempotent for fresh
// installs that never ran `0001_datasource_credentials`.

export const migration_0003_drop_datasource_credentials: Migration = {
  id: "0003_drop_datasource_credentials",
  up: (db) => {
    db.exec("DROP TABLE IF EXISTS datasource_credentials");
  },
};

/**
 * The canonical migration list. Append-only.
 *
 * NOTE: `migration_0003_drop_datasource_credentials` is deliberately NOT in
 * this array yet, even though the migration itself is defined and exported.
 * The reason is ordering: `SqliteCredentialStore` is still constructed at
 * bootstrap (`main/index.ts` -> `initEngine(db)`) and every test that
 * exercises the engine / registry / IPC handlers runs
 * `runMigrations(db, DEFAULT_MIGRATIONS)` and then instantiates the store.
 * If 0003 ran in that sequence, the store would find the table missing and
 * the very next credential operation would blow up. The store does NOT have
 * a defensive `CREATE TABLE IF NOT EXISTS` — the schema is owned by the
 * migration runner by design (see `sqlite-credential-store.ts` header).
 *
 * The flip of `DEFAULT_MIGRATIONS` to
 *   `[migration_0002_datasources, migration_0003_drop_datasource_credentials]`
 * happens atomically with the deletion of `SqliteCredentialStore` and its
 * wiring in `datasources/engine.ts`, in the commit that closes
 * wire-fs-sync-service tasks 9.1, 9.2, and 9.5. Old installs retain their
 * `0001_datasource_credentials` bookkeeping row and will run 0003 to drop
 * the table on next start; fresh installs see an empty array-entry of 0001
 * and skip it entirely (the runner is forward-only and id-tracked).
 */
export const DEFAULT_MIGRATIONS = [
  migration_0001_datasource_credentials,
  migration_0002_datasources,
] as const;
