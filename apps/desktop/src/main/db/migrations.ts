// Main-process SQLite migrations — Phase 9a + wire-fs-sync-service 9.4/9.5.
//
// Order matters: the runner applies entries in array order and records each
// id in the `_migrations` bookkeeping table. Appending is the only safe
// change — never re-order, never rename, never rewrite an already-shipped
// migration. To reverse a prior migration, append a new one that
// compensates.
//
// Current migrations:
//   - 0001_datasource_credentials: retired. Historically created the
//     `datasource_credentials` table used by the now-deleted desktop-side
//     credential store. The export is preserved so existing installs that
//     already recorded this id in `_migrations` retain their bookkeeping;
//     fresh installs skip it entirely because it is no longer in
//     `DEFAULT_MIGRATIONS`. Never add it back to the array — 0003 drops
//     the table it used to create.
//   - 0002_datasources: the datasource-registry table used by the new
//     `DatasourceRegistry` (Phase 9b). The canonical first migration for
//     fresh installs.
//   - 0003_drop_datasource_credentials: drops the `datasource_credentials`
//     table. Part of retiring the desktop-side credential store — the
//     fs-sync service now owns credentials end-to-end. Idempotent
//     (`DROP TABLE IF EXISTS`) so fresh installs that never created the
//     table simply no-op.
//
// Naming note: this migration's id is 0003, not 0002 as the
// wire-fs-sync-service tasks.md originally wrote. The tasks doc was
// authored before `0002_datasources` landed (Phase 9b of
// add-fs-datasource-engine), which already claims the 0002 slot. The
// migration runner tracks ids as strings — there is no requirement that
// ids be contiguous, so 0003 is fine and cannot collide with 0002.

import type { Migration } from "./database.js";

// ---------------------------------------------------------------------------
// 0001 — datasource_credentials (retired — no longer in DEFAULT_MIGRATIONS)
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

// ---------------------------------------------------------------------------
// 0004 — add error_kind column (add-drive-oauth-browser-consent)
// ---------------------------------------------------------------------------
//
// Adds `error_kind TEXT` to the `datasources` table so the registry can
// persist the engine's `DatasourceError.tag` alongside `error_reason`. This
// lets the renderer distinguish auth-class errors (→ AuthErrorBanner) from
// other error kinds without parsing the human-readable `error_reason`.
//
// The column is nullable and defaults to NULL so existing rows are unaffected.
// `ALTER TABLE ... ADD COLUMN` in SQLite adds the column to every existing row
// with the DEFAULT value — no data migration required.

export const migration_0004_datasource_error_kind: Migration = {
  id: "0004_datasource_error_kind",
  up: (db) => {
    db.exec(
      "ALTER TABLE datasources ADD COLUMN error_kind TEXT DEFAULT NULL",
    );
  },
};

/**
 * The canonical migration list. Append-only.
 *
 * Composition as of add-drive-oauth-browser-consent:
 *   - `migration_0002_datasources` — the registry table.
 *   - `migration_0003_drop_datasource_credentials` — drops the retired
 *     credential table.
 *   - `migration_0004_datasource_error_kind` — adds `error_kind` column.
 *
 * `migration_0001_datasource_credentials` is deliberately NOT here anymore.
 */
export const DEFAULT_MIGRATIONS = [
  migration_0002_datasources,
  migration_0003_drop_datasource_credentials,
  migration_0004_datasource_error_kind,
] as const;
