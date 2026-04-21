// Opens sync.db with WAL + synchronous=NORMAL + PRAGMA integrity_check.
// On integrity failure, throws `DatabaseIntegrityError` — the entry point
// catches this and exits with code 4 (design.md D6 + base spec
// "Integrity failure halts startup").

import Database from "better-sqlite3";

export class DatabaseIntegrityError extends Error {
  readonly observed: string;
  constructor(observed: string) {
    super(
      `sync.db integrity-check-failed: PRAGMA integrity_check returned "${observed}"`,
    );
    this.name = "DatabaseIntegrityError";
    this.observed = observed;
  }
}

export interface OpenDatabaseOptions {
  readonly readonly?: boolean;
}

export function openDatabase(
  filePath: string,
  options: OpenDatabaseOptions = {},
): Database.Database {
  let db: Database.Database;
  try {
    db = new Database(filePath, { readonly: options.readonly ?? false });
  } catch (err) {
    // better-sqlite3 throws SqliteError("file is not a database") or
    // ("database disk image is malformed") at open time for files that
    // have a SQLite-ish header but a corrupted body. Treat any open-time
    // failure on an existing file as an integrity failure.
    const message = (err as { message?: string }).message ?? String(err);
    throw new DatabaseIntegrityError(message);
  }
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    const rows = db.pragma("integrity_check") as ReadonlyArray<{
      integrity_check: string;
    }>;
    const first = rows[0]?.integrity_check ?? "missing";
    if (first !== "ok") {
      db.close();
      throw new DatabaseIntegrityError(first);
    }
    return db;
  } catch (err) {
    if (db.open) db.close();
    if (err instanceof DatabaseIntegrityError) throw err;
    // Any pragma / integrity_check failure past the initial open is also
    // an integrity signal — surface it as such so main's exit 4 path fires.
    const message = (err as { message?: string }).message ?? String(err);
    throw new DatabaseIntegrityError(message);
  }
}
