// Main-process SQLite migrations — Phase 9a.
//
// Order matters: the runner applies entries in array order and records each
// id in the `_migrations` bookkeeping table. Appending is the only safe
// change — never re-order, never rename, never rewrite an already-shipped
// migration. To reverse a prior migration, append a new one that
// compensates.
//
// Current migrations:
//   - 0001_datasource_credentials: mirror of `SqliteCredentialStore`'s
//     inline `CREATE TABLE IF NOT EXISTS`. The store still keeps its inline
//     `IF NOT EXISTS` as a defense-in-depth no-op so existing tests (which
//     do not run the shared runner) still pass; in production the shared
//     runner is guaranteed to have created the table first.
//   - 0002_datasources: the datasource-registry table used by the new
//     `DatasourceRegistry` (Phase 9b).

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

/**
 * The canonical migration list. Append-only.
 */
export const DEFAULT_MIGRATIONS = [
  migration_0001_datasource_credentials,
  migration_0002_datasources,
] as const;
