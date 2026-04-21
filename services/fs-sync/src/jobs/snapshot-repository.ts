// DAO for the `sync_snapshot` table. Pure Drizzle-free SQL wrapper.

import type Database from "better-sqlite3";

import type { SnapshotEntry } from "../executors/diff.js";

export class SnapshotRepository {
  constructor(private readonly db: Database.Database) {}

  listForDatasource(datasourceId: string): ReadonlyArray<SnapshotEntry> {
    const rows = this.db
      .prepare(
        `SELECT rel_path, size, mtime_ms, sha256, remote_handle
         FROM sync_snapshot WHERE datasource_id = ?`,
      )
      .all(datasourceId) as Array<{
      rel_path: string;
      size: number;
      mtime_ms: number;
      sha256: string | null;
      remote_handle: string;
    }>;
    return rows.map((r) => ({
      relPath: r.rel_path,
      size: r.size,
      mtimeMs: r.mtime_ms,
      sha256: r.sha256,
      remoteHandle: r.remote_handle,
    }));
  }

  upsert(
    datasourceId: string,
    row: {
      relPath: string;
      size: number;
      mtimeMs: number;
      sha256: string | null;
      remoteHandle: string;
      remoteEtag?: string | null;
    },
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sync_snapshot
           (datasource_id, rel_path, size, mtime_ms, sha256, remote_handle, remote_etag, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(datasource_id, rel_path) DO UPDATE SET
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           sha256 = excluded.sha256,
           remote_handle = excluded.remote_handle,
           remote_etag = excluded.remote_etag,
           synced_at = excluded.synced_at`,
      )
      .run(
        datasourceId,
        row.relPath,
        row.size,
        row.mtimeMs,
        row.sha256 ?? null,
        row.remoteHandle,
        row.remoteEtag ?? null,
        now,
      );
  }

  refreshMtime(datasourceId: string, relPath: string, newMtimeMs: number): void {
    this.db
      .prepare(
        `UPDATE sync_snapshot SET mtime_ms = ?, synced_at = ?
         WHERE datasource_id = ? AND rel_path = ?`,
      )
      .run(newMtimeMs, Date.now(), datasourceId, relPath);
  }

  delete(datasourceId: string, relPath: string): void {
    this.db
      .prepare(
        `DELETE FROM sync_snapshot WHERE datasource_id = ? AND rel_path = ?`,
      )
      .run(datasourceId, relPath);
  }
}
