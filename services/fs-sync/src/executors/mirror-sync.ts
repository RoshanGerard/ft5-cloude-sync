// MirrorSyncJobExecutor — composes source-health + walker + diff + per-file
// ops + snapshot update + terminal summary event.

import * as path from "node:path";

import type {
  DatasourceClient,
  DatasourceError,
} from "@ft5/fs-datasource-engine";
import { withAuthRefresh } from "@ft5/fs-datasource-engine";
import type { DatasourceType } from "@ft5/ipc-contracts";
import { DatasourceErrorTag, EntryKind } from "@ft5/ipc-contracts";

import { SnapshotRepository } from "../jobs/snapshot-repository.js";
import type { Executor, ExecutorResult } from "../scheduler/scheduler.js";

import { diffLocalAgainstSnapshot } from "./diff.js";
import { hashFileSha256 } from "./hasher.js";
import { walkLocalTree } from "./local-walker.js";
import { checkSourceHealth } from "./source-health.js";

export interface MirrorSyncDeps {
  readonly db: import("better-sqlite3").Database;
  readonly resolveClient: (
    datasourceId: string,
  ) => Promise<DatasourceClient<DatasourceType>>;
  /** Test seam for deterministic hashes. Defaults to real streaming sha256. */
  readonly hashFile?: (absPath: string) => Promise<string>;
}

export function buildMirrorSyncExecutor(deps: MirrorSyncDeps): Executor {
  return async (ctx): Promise<ExecutorResult> => {
    const { job, signal, bus } = ctx;
    const snapshots = new SnapshotRepository(deps.db);

    const health = await checkSourceHealth(job.sourcePath);
    if (health.kind === "unavailable") {
      bus.emit("source-unavailable", {
        jobId: job.id,
        sourcePath: job.sourcePath,
        errorCode: health.errorCode,
        message: health.message,
      });
      return {
        outcome: "failed",
        errorTag: "source-unavailable",
        errorMessage: health.message,
      };
    }

    if (signal.aborted) return { outcome: "cancelled" };

    const local = await walkLocalTree(job.sourcePath);
    const snapshot = snapshots.listForDatasource(job.datasourceId);

    const hashFile = deps.hashFile ?? ((abs: string) => hashFileSha256(abs));
    const ops = await diffLocalAgainstSnapshot(local, snapshot, (relPath) =>
      hashFile(path.join(job.sourcePath, relPath)),
    );

    if (signal.aborted) return { outcome: "cancelled" };

    let client: DatasourceClient<DatasourceType>;
    try {
      client = await deps.resolveClient(job.datasourceId);
    } catch (err) {
      return {
        outcome: "failed",
        errorTag: (err as { tag?: string }).tag ?? "internal-error",
        errorMessage: (err as { message?: string }).message ?? "resolve failed",
      };
    }

    let uploaded = 0;
    let updated = 0;
    let deleted = 0;
    let skipped = 0;

    for (const op of ops) {
      if (signal.aborted) return { outcome: "cancelled" };
      try {
        if (op.kind === "upload-new" || op.kind === "upload-changed") {
          const abs = path.join(job.sourcePath, op.relPath);
          // migrate-upload-orchestration-out-of-engine §12.1 — uploadFile
          // now takes an options object with `signal` (and optional
          // `onProgress`). Mirror-sync forwards the executor's signal
          // so an in-flight chunk-PUT aborts promptly when the scheduler
          // cancels the job; per-file progress is not surfaced to the
          // renderer (mirror-sync emits only the terminal `sync-completed`
          // event), so `onProgress` is intentionally omitted.
          // migrate-engine-retry-policy-to-consumer Decision 4 / spec
          // "Mirror-sync refreshes once on auth-expired via withAuthRefresh"
          // — the engine no longer auto-refreshes; the executor wraps each
          // engine call in `withAuthRefresh` so a stale-but-refreshable token
          // refreshes once and retries BEFORE any error escapes to the
          // scheduler. A second `auth-expired` (post-refresh dead token)
          // propagates into the catch below and surfaces as a terminal
          // failure — the scheduler does NOT intercept it.
          const entry = await withAuthRefresh(client, () =>
            client.uploadFile(
              { kind: "path", path: `${job.sourcePath}/${op.relPath}` },
              { path: abs },
              { signal },
            ),
          );
          const sha =
            op.kind === "upload-new"
              ? await hashFile(abs)
              : op.sha256;
          snapshots.upsert(job.datasourceId, {
            relPath: op.relPath,
            size: op.size,
            mtimeMs: op.mtimeMs,
            sha256: sha,
            remoteHandle:
              (entry as { id?: string; path?: string }).id ??
              (entry as { path?: string }).path ??
              op.relPath,
          });
          if (op.kind === "upload-new") uploaded++;
          else updated++;
        } else if (op.kind === "skip") {
          skipped++;
        } else if (op.kind === "skip-refresh-mtime") {
          snapshots.refreshMtime(
            job.datasourceId,
            op.relPath,
            op.newMtimeMs,
          );
          skipped++;
        } else {
          // delete-remote — same `withAuthRefresh` wrap as the upload path
          // above (Decision 4).
          await withAuthRefresh(client, () =>
            client.delete(
              { kind: "handle", handle: op.remoteHandle },
              EntryKind.File,
            ),
          );
          snapshots.delete(job.datasourceId, op.relPath);
          deleted++;
        }
      } catch (err) {
        const e = err as DatasourceError<DatasourceType>;
        const tag = (e as { tag?: string }).tag ?? "internal-error";
        const message = (e as { message?: string }).message ?? "op failed";
        if (tag === DatasourceErrorTag.NetworkError) {
          return {
            outcome: "waiting-network",
            errorTag: tag,
            errorMessage: message,
          };
        }
        return { outcome: "failed", errorTag: tag, errorMessage: message };
      }
    }

    bus.emit("sync-completed", {
      jobId: job.id,
      uploaded,
      updated,
      deleted,
      skipped,
      completedAt: Date.now(),
    });

    return { outcome: "completed" };
  };
}
