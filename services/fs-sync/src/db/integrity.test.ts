import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { DatabaseIntegrityError, openDatabase } from "./open.js";

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
    `ft5-sync-int-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  cleanup.push(f);
  return f;
}

describe("openDatabase", () => {
  it("opens a fresh DB in WAL mode and NORMAL sync", () => {
    const db = openDatabase(scratchDbPath());
    try {
      const journal = db.pragma("journal_mode", { simple: true });
      const sync = db.pragma("synchronous", { simple: true });
      expect(journal).toBe("wal");
      // synchronous: 0=OFF, 1=NORMAL, 2=FULL
      expect(sync).toBe(1);
    } finally {
      db.close();
    }
  });

  it("throws DatabaseIntegrityError on a corrupted DB file", async () => {
    const file = scratchDbPath();
    // Create a plausible SQLite header then garbage. better-sqlite3's
    // integrity_check will report "non-ok".
    await fsp.writeFile(file, Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.alloc(512, 0xff),
    ]));
    expect(() => openDatabase(file)).toThrow(DatabaseIntegrityError);
  });

  it("DatabaseIntegrityError carries the observed string", async () => {
    const file = scratchDbPath();
    await fsp.writeFile(file, Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.alloc(512, 0xff),
    ]));
    try {
      openDatabase(file);
      expect.fail("expected DatabaseIntegrityError");
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseIntegrityError);
      expect((err as DatabaseIntegrityError).observed).toMatch(/./);
    }
  });

  it("does not throw on an intact DB after migrations", async () => {
    const file = scratchDbPath();
    // Initialise an intact DB first, then reopen via openDatabase.
    const init = new Database(file);
    init.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
    init.close();

    const db = openDatabase(file);
    try {
      const row = db.prepare("SELECT x FROM t").get() as { x: number };
      expect(row.x).toBe(1);
    } finally {
      db.close();
    }
  });
});
