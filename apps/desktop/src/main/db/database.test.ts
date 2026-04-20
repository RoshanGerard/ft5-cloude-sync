// Phase 9a RED — main-process SQLite + migration runner.
//
// The runner owns:
//   - opening a Database at a given filesystem path (or `:memory:` for tests),
//   - auto-creating a missing parent directory,
//   - applying a list of ordered migrations exactly once per DB,
//   - tracking applied migrations in a `_migrations` bookkeeping table so a
//     re-open does not re-run work.
//
// Design refs:
//   - openspec/changes/add-fs-datasource-engine/design.md
//       "RESOLVED (Phase 9 — scoping) — Phase 9 owns the first real
//        main-process DB open."
//   - openspec/changes/add-fs-datasource-engine/tasks.md Phase 9a.

import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, runMigrations, type Migration } from "./database.js";

function mkTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ft5-db-test-"));
}

const createUsersMigration: Migration = {
  id: "0001_create_users",
  up: (db) => {
    db.exec(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
    );
  },
};

const seedUsersMigration: Migration = {
  id: "0002_seed_users",
  up: (db) => {
    db.exec("INSERT INTO users (name) VALUES ('alice'), ('bob');");
  },
};

describe("openDatabase + runMigrations (Phase 9a)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("opens a database at the given filesystem path", () => {
    const dbPath = path.join(tmpDir, "ft5.db");
    const db = openDatabase(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);
      // Confirm we have a live handle that accepts SQL.
      db.exec("CREATE TABLE smoke (x INT);");
      db.prepare("INSERT INTO smoke VALUES (1)").run();
      const row = db.prepare("SELECT x FROM smoke").get() as
        | { x: number }
        | undefined;
      expect(row?.x).toBe(1);
    } finally {
      db.close();
    }
  });

  it("auto-creates a missing parent directory", () => {
    const nestedDir = path.join(tmpDir, "nested", "deep", "folder");
    expect(existsSync(nestedDir)).toBe(false);
    const dbPath = path.join(nestedDir, "ft5.db");
    const db = openDatabase(dbPath);
    try {
      expect(statSync(nestedDir).isDirectory()).toBe(true);
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("runs migrations in order on first open", () => {
    const dbPath = path.join(tmpDir, "ft5.db");
    const db = openDatabase(dbPath);
    try {
      runMigrations(db, [createUsersMigration, seedUsersMigration]);
      const rows = db.prepare("SELECT name FROM users ORDER BY id").all() as {
        name: string;
      }[];
      expect(rows.map((r) => r.name)).toEqual(["alice", "bob"]);
    } finally {
      db.close();
    }
  });

  it("does NOT re-run a migration when opened a second time", () => {
    const dbPath = path.join(tmpDir, "ft5.db");

    const first = openDatabase(dbPath);
    runMigrations(first, [createUsersMigration, seedUsersMigration]);
    first.close();

    const second = openDatabase(dbPath);
    try {
      // If the seed ran again, we'd see 4 rows.
      runMigrations(second, [createUsersMigration, seedUsersMigration]);
      const count = second.prepare("SELECT COUNT(*) AS n FROM users").get() as
        | { n: number }
        | undefined;
      expect(count?.n).toBe(2);
    } finally {
      second.close();
    }
  });

  it("applies later-added migrations without re-running prior ones", () => {
    const dbPath = path.join(tmpDir, "ft5.db");
    const db1 = openDatabase(dbPath);
    runMigrations(db1, [createUsersMigration, seedUsersMigration]);
    db1.close();

    const addColumn: Migration = {
      id: "0003_add_email",
      up: (db) => db.exec("ALTER TABLE users ADD COLUMN email TEXT;"),
    };

    const db2 = openDatabase(dbPath);
    try {
      runMigrations(db2, [
        createUsersMigration,
        seedUsersMigration,
        addColumn,
      ]);
      // Not re-run: still 2 rows, not 4.
      const count = db2.prepare("SELECT COUNT(*) AS n FROM users").get() as
        | { n: number }
        | undefined;
      expect(count?.n).toBe(2);
      // New column exists and is null for pre-existing rows.
      const row = db2
        .prepare("SELECT email FROM users WHERE name = 'alice'")
        .get() as { email: string | null } | undefined;
      expect(row?.email).toBeNull();
    } finally {
      db2.close();
    }
  });

  it('supports openDatabase(":memory:") for tests', () => {
    const db = openDatabase(":memory:");
    try {
      runMigrations(db, [createUsersMigration, seedUsersMigration]);
      const count = db.prepare("SELECT COUNT(*) AS n FROM users").get() as
        | { n: number }
        | undefined;
      expect(count?.n).toBe(2);
    } finally {
      db.close();
    }
  });

  it("records applied migration ids in a bookkeeping table", () => {
    const db = openDatabase(":memory:");
    try {
      runMigrations(db, [createUsersMigration, seedUsersMigration]);
      const ids = db
        .prepare(
          "SELECT id FROM _migrations ORDER BY id",
        )
        .all() as { id: string }[];
      expect(ids.map((r) => r.id)).toEqual([
        "0001_create_users",
        "0002_seed_users",
      ]);
    } finally {
      db.close();
    }
  });

  it("migration failures roll back and leave the bookkeeping row absent", () => {
    const db = openDatabase(":memory:");
    const failing: Migration = {
      id: "0002_broken",
      up: () => {
        throw new Error("boom");
      },
    };
    try {
      expect(() => runMigrations(db, [createUsersMigration, failing])).toThrow(
        /boom/,
      );
      // The first migration applied; the failing one did not and is not
      // recorded.
      const ids = db
        .prepare("SELECT id FROM _migrations ORDER BY id")
        .all() as { id: string }[];
      expect(ids.map((r) => r.id)).toEqual(["0001_create_users"]);
    } finally {
      db.close();
    }
  });
});
