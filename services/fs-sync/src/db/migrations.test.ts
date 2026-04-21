import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, CURRENT_SCHEMA_VERSION } from "./migrations.js";

let cleanup: string[] = [];

afterEach(async () => {
  for (const f of cleanup) {
    try {
      await fsp.rm(f, { recursive: true, force: true });
    } catch {
      /* tolerated */
    }
  }
  cleanup = [];
});

function scratchDbPath(): string {
  const f = path.join(
    os.tmpdir(),
    `ft5-sync-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  cleanup.push(f);
  return f;
}

describe("applyMigrations", () => {
  it("creates all four core tables on a fresh DB", () => {
    const db = new Database(scratchDbPath());
    try {
      applyMigrations(db);
      const rows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      const names = rows.map((r) => r.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "jobs",
          "retry_policies",
          "schema_migrations",
          "service_meta",
          "sync_snapshot",
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("seeds service_meta with exactly one row carrying schemaVersion = 1", () => {
    const db = new Database(scratchDbPath());
    try {
      applyMigrations(db);
      const rows = db
        .prepare("SELECT schema_version, service_uuid FROM service_meta")
        .all() as Array<{ schema_version: number; service_uuid: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.schema_version).toBe(CURRENT_SCHEMA_VERSION);
      expect(rows[0]?.service_uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    } finally {
      db.close();
    }
  });

  it("is idempotent (second application is a no-op)", () => {
    const file = scratchDbPath();
    const db = new Database(file);
    try {
      applyMigrations(db);
      const firstUuid = (
        db.prepare("SELECT service_uuid FROM service_meta").get() as {
          service_uuid: string;
        }
      ).service_uuid;

      applyMigrations(db);
      const secondUuid = (
        db.prepare("SELECT service_uuid FROM service_meta").get() as {
          service_uuid: string;
        }
      ).service_uuid;

      expect(secondUuid).toBe(firstUuid);
      const count = (
        db.prepare("SELECT COUNT(*) as c FROM service_meta").get() as {
          c: number;
        }
      ).c;
      expect(count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("records each migration in schema_migrations", () => {
    const db = new Database(scratchDbPath());
    try {
      applyMigrations(db);
      const rows = db
        .prepare(
          "SELECT name FROM schema_migrations ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(rows.map((r) => r.name)).toEqual(["0001_initial.sql"]);
    } finally {
      db.close();
    }
  });

  it("honours a custom migrationsDir option (forward-compat)", async () => {
    const dir = path.join(
      os.tmpdir(),
      `ft5-sync-mig-custom-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    cleanup.push(dir);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "0001_test.sql"),
      "CREATE TABLE custom_t (x INTEGER);",
    );
    const db = new Database(scratchDbPath());
    try {
      applyMigrations(db, { migrationsDir: dir });
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='custom_t'",
        )
        .get();
      expect(row).toBeTruthy();
    } finally {
      db.close();
    }
  });
});
