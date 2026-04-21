// Main-process SQLite open + migration runner — Phase 9a.
//
// The app previously had no centralised DB init: `SqliteCredentialStore`
// opened the table inline on construction (see its MIGRATION_SQL), but no
// caller ever opened a persistent handle. Phase 9 introduces the first real
// main-process DB + a tiny migration runner that records applied migration
// ids in a `_migrations` bookkeeping table so re-opening the same file does
// not re-run migrations.
//
// Scope is deliberately minimal — this is NOT a general-purpose ORM-style
// migrator. It is just:
//   - open / create the DB file (parent directory auto-created),
//   - apply a list of ordered `Migration` entries, each inside a transaction,
//     recording the id on success so it runs exactly once.
//
// Callers (currently only `main/index.ts` at bootstrap) pass a stable list;
// adding a new migration = append to the array. Migrations never re-order or
// mutate an already-applied id.
//
// Design refs:
//   - openspec/changes/add-fs-datasource-engine/design.md (Phase 9 scoping).
//   - openspec/changes/add-fs-datasource-engine/tasks.md Phase 9a.

import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** Type of an opened `better-sqlite3` database handle. */
export type SqliteDatabase = InstanceType<typeof Database>;

/** A single migration — `id` is a stable string (typically `NNNN_name`). */
export interface Migration {
  id: string;
  up: (db: SqliteDatabase) => void;
}

/**
 * Open (or create) a SQLite database at `pathOrMemory`. If `pathOrMemory`
 * points to a file under a directory that does not yet exist, the parent
 * chain is created recursively. Pass `":memory:"` to open an anonymous
 * in-memory DB (used by tests).
 *
 * Does NOT run migrations — call `runMigrations(db, [...])` immediately
 * after for that.
 */
export function openDatabase(pathOrMemory: string): SqliteDatabase {
  if (pathOrMemory !== ":memory:") {
    const parent = path.dirname(pathOrMemory);
    // Idempotent — `recursive: true` + existing dir is a no-op.
    mkdirSync(parent, { recursive: true });
  }
  return new Database(pathOrMemory);
}

// The bookkeeping table. Schema version ('v' column) is reserved for a
// future cross-cutting schema bump (e.g., switching to SQLCipher). For now
// every row is v=1.
const BOOKKEEPING_SQL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    id         TEXT    PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    v          INTEGER NOT NULL DEFAULT 1
  );
`;

/**
 * Apply every pending migration in `migrations` in list order. Already-
 * applied migrations (their id present in `_migrations`) are skipped. Each
 * migration runs inside a transaction so a failure rolls back both the DDL
 * and the bookkeeping insert.
 *
 * Throws the original error on failure (not wrapped) — the caller is
 * bootstrap code that should fail loud.
 */
export function runMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[],
): void {
  db.exec(BOOKKEEPING_SQL);

  const isApplied = db.prepare<[string]>(
    "SELECT 1 FROM _migrations WHERE id = ?",
  );
  const recordApplied = db.prepare<[string, number]>(
    "INSERT INTO _migrations (id, applied_at) VALUES (?, ?)",
  );

  for (const migration of migrations) {
    if (isApplied.get(migration.id) !== undefined) {
      continue;
    }
    // better-sqlite3 transactions are synchronous; migrations are sync too.
    const apply = db.transaction(() => {
      migration.up(db);
      recordApplied.run(migration.id, Date.now());
    });
    apply();
  }
}
