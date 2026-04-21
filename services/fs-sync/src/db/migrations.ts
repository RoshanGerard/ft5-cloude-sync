// Forward-only SQL migrations for sync.db. Each file under
// services/fs-sync/drizzle/ is applied once, in lexical order; its execution
// is recorded in `schema_migrations` so reruns are no-ops.
//
// We don't use Drizzle's `migrate()` helper because it expects a specific
// meta-journal format managed by `drizzle-kit generate`. Keeping migrations
// as raw SQL files is simpler for v1 (one file, one table set) and avoids
// pulling in `drizzle-kit` at runtime.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// drizzle/ is a sibling of src/; during tests __dirname is under src/db,
// during build it's under dist/db. Walk up two levels to reach services/
// fs-sync/, then into drizzle/.
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "..", "drizzle");

export const CURRENT_SCHEMA_VERSION = 1 as const;

interface MigrationsRow {
  name: string;
  applied_at: number;
}

export function applyMigrations(
  db: Database.Database,
  opts: { migrationsDir?: string } = {},
): void {
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((row) => (row as MigrationsRow).name),
  );

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const insertApplied = db.prepare(
    "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    // Wrap each migration in its own transaction — better-sqlite3 runs
    // `exec` in an autocommit transaction, and any failure rolls back.
    const txn = db.transaction(() => {
      db.exec(sql);
      insertApplied.run(file, Date.now());
    });
    txn();
  }

  // Seed service_meta with a single row on first-ever application. Idempotent:
  // if a row already exists, leave it alone. We gate on table presence so
  // callers using a custom migrationsDir (for schema-shape tests) don't
  // trip "no such table" by having service_meta implied.
  const hasServiceMeta = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='service_meta'",
    )
    .get();
  if (!hasServiceMeta) return;

  const existing = db
    .prepare("SELECT id FROM service_meta LIMIT 1")
    .get() as { id: number } | undefined;
  if (!existing) {
    db.prepare(
      "INSERT INTO service_meta (id, schema_version, installed_at, service_uuid) VALUES (?, ?, ?, ?)",
    ).run(1, CURRENT_SCHEMA_VERSION, Date.now(), randomUUID());
  }
}
