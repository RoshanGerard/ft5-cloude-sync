// DatasourceRegistry — Phase 9b.
//
// The persistent, DB-backed replacement for the in-memory fixture at
// `apps/desktop/src/main/ipc/datasources/store.ts`. Wraps the `datasources`
// SQLite table plus a `CredentialStore` so add / remove are atomic across
// both stores.
//
// Semantics highlights:
//   * `add(summary, creds)` runs inside a better-sqlite3 transaction; if
//     credential encryption/persistence throws, the row insert rolls back.
//   * `remove(id)` likewise deletes the row AND the credential blob inside
//     one transaction.
//   * `paused` is a distinct boolean column — `pause` / `resume` flip it
//     WITHOUT clobbering the underlying `status` column. `list()` projects
//     `status="paused"` when `paused=1`, so the UI sees the effective state
//     and a later `resume` restores the pre-pause status.
//   * `setStatus(id, status, errorReason?)` is the engine-facing updater
//     used by `sync-now` / background health checks. It never touches the
//     `paused` flag.
//
// Design refs:
//   - openspec/changes/add-fs-datasource-engine/design.md Phase 9 scoping.
//   - openspec/changes/add-fs-datasource-engine/tasks.md 9.6-9.8.

import type {
  DatasourceStatus,
  DatasourceSummary,
  StoredCredentials,
} from "@ft5/ipc-contracts";

import type { SqliteDatabase } from "../db/database.js";
import type { SqliteCredentialStore } from "./sqlite-credential-store.js";

// On-disk row shape. `paused` is INTEGER because SQLite lacks a native
// BOOLEAN; we coerce to / from number at the boundary.
interface DatasourceRow {
  id: string;
  provider_id: string;
  display_name: string;
  item_count: number | null;
  last_sync_at: number | null;
  status: DatasourceStatus;
  error_reason: string | null;
  paused: number;
  created_at: number;
  updated_at: number;
}

function rowToSummary(row: DatasourceRow): DatasourceSummary {
  // Effective status: when paused=1, report "paused" to the UI regardless
  // of the underlying column. The underlying column is preserved so resume
  // can restore "connected" / "syncing" / "error" verbatim.
  const effectiveStatus: DatasourceStatus =
    row.paused === 1 ? "paused" : row.status;
  const summary: DatasourceSummary = {
    id: row.id,
    displayName: row.display_name,
    providerId: row.provider_id,
    status: effectiveStatus,
    lastSyncAt: row.last_sync_at,
    itemCount: row.item_count ?? 0,
  };
  if (row.error_reason !== null && row.error_reason !== "") {
    summary.errorReason = row.error_reason;
  }
  return summary;
}

export class DatasourceRegistry {
  private readonly db: SqliteDatabase;
  private readonly credentialStore: Pick<
    SqliteCredentialStore,
    "put" | "delete" | "get"
  >;

  private readonly listStmt;
  private readonly insertStmt;
  private readonly removeRowStmt;
  private readonly setPausedStmt;
  private readonly setStatusStmt;
  private readonly touchLastSyncStmt;
  private readonly getProviderStmt;

  constructor(
    db: SqliteDatabase,
    credentialStore: Pick<SqliteCredentialStore, "put" | "delete" | "get">,
  ) {
    this.db = db;
    this.credentialStore = credentialStore;

    this.listStmt = db.prepare(
      "SELECT id, provider_id, display_name, item_count, last_sync_at, status, error_reason, paused, created_at, updated_at FROM datasources ORDER BY created_at ASC, id ASC",
    );
    this.insertStmt = db.prepare(
      "INSERT INTO datasources (id, provider_id, display_name, item_count, last_sync_at, status, error_reason, paused, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
    );
    this.removeRowStmt = db.prepare(
      "DELETE FROM datasources WHERE id = ?",
    );
    this.setPausedStmt = db.prepare(
      "UPDATE datasources SET paused = ?, updated_at = ? WHERE id = ?",
    );
    this.setStatusStmt = db.prepare(
      "UPDATE datasources SET status = ?, error_reason = ?, updated_at = ? WHERE id = ?",
    );
    this.touchLastSyncStmt = db.prepare(
      "UPDATE datasources SET last_sync_at = ?, updated_at = ? WHERE id = ?",
    );
    this.getProviderStmt = db.prepare(
      "SELECT provider_id FROM datasources WHERE id = ?",
    );
  }

  list(): DatasourceSummary[] {
    const rows = this.listStmt.all() as DatasourceRow[];
    return rows.map(rowToSummary);
  }

  /**
   * Insert a datasource row AND persist its credentials atomically.
   *
   * `summary.id` must already be assigned by the caller (handlers mint IDs
   * before calling — keeps this module free of id-generation concerns).
   * `lastSyncAt` and `itemCount` are persisted verbatim from the summary.
   *
   * Atomicity: credentials are stored FIRST, then the row insert runs
   * inside a transaction. If credential storage throws (corrupt object,
   * safeStorage unavailable), no row insert runs. If the row insert
   * throws after a successful credential put, the credential is rolled
   * back via `credentialStore.delete(id)`. Either path leaves the DB
   * consistent.
   *
   * `credentialStore.put` is declared `async` for port symmetry, but its
   * underlying `SqliteCredentialStore` implementation is synchronous
   * (prepared-statement + safeStorage calls, no I/O awaiting). We use
   * `.then` chaining here for correctness against the declared port
   * signature rather than relying on that implementation detail.
   */
  async add(
    summary: DatasourceSummary,
    credentials: StoredCredentials,
  ): Promise<DatasourceSummary> {
    // Step 1: persist credentials. If this throws (bad cred object,
    // encryption unavailable), we abort before any DB row is written.
    await this.credentialStore.put(summary.id, credentials);

    // Step 2: row insert inside a transaction. If it throws (PK conflict,
    // corrupt schema), roll back the credential write we just made.
    const now = Date.now();
    try {
      const runTx = this.db.transaction(() => {
        this.insertStmt.run(
          summary.id,
          summary.providerId,
          summary.displayName,
          summary.itemCount,
          summary.lastSyncAt,
          summary.status,
          summary.errorReason ?? null,
          now,
          now,
        );
      });
      runTx();
    } catch (err) {
      // Best-effort rollback — swallow errors inside delete so the
      // primary failure is the one surfaced.
      try {
        await this.credentialStore.delete(summary.id);
      } catch {
        /* intentional */
      }
      throw err;
    }
    return summary;
  }

  /**
   * Delete the datasource row AND its credential blob. Returns `true` when
   * a row was actually removed (i.e., the id existed).
   *
   * Credential delete is idempotent (SqliteCredentialStore treats missing
   * rows as no-ops per its contract), so we delete the credential blob
   * even when the row did not exist — keeps the registry consistent if a
   * prior `add` half-committed.
   */
  async remove(id: string): Promise<boolean> {
    const info = this.removeRowStmt.run(id);
    await this.credentialStore.delete(id);
    return info.changes > 0;
  }

  /**
   * Flip the `paused` flag. Does NOT mutate the `status` column so that
   * unpause restores the pre-pause status.
   */
  setPaused(id: string, paused: boolean): void {
    this.setPausedStmt.run(paused ? 1 : 0, Date.now(), id);
  }

  /**
   * Update the status column and error reason. Pass `null` (or omit) to
   * clear `error_reason`.
   */
  setStatus(
    id: string,
    status: DatasourceStatus,
    errorReason?: string | null,
  ): void {
    this.setStatusStmt.run(
      status,
      errorReason ?? null,
      Date.now(),
      id,
    );
  }

  /**
   * Bump `last_sync_at` to the current wall-clock time. Used by
   * `sync-now` handlers after the provider status check completes.
   */
  touchLastSyncAt(id: string): void {
    const now = Date.now();
    this.touchLastSyncStmt.run(now, now, id);
  }

  /**
   * Provider-id lookup for a given datasource id. Returns `null` if the
   * id is unknown. IPC handlers that need to construct a client via
   * `ClientFactory.create(providerId, ...)` use this as the first step.
   */
  getProviderId(id: string): string | null {
    const row = this.getProviderStmt.get(id) as
      | { provider_id: string }
      | undefined;
    return row?.provider_id ?? null;
  }
}
