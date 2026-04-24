// UploadJobExecutor — handles `kind: 'upload'` jobs. Resolves a
// DatasourceClient via the engine's ClientFactory, splits the job's
// targetPath into (parent directory, file name), calls uploadFile, and
// maps the returned FileEntry to a job-completed event. Respects
// `conflictPolicy: 'skip'` by swallowing DatasourceError{tag:'conflict'}.
//
// Spec: "UploadJobExecutor performs a single-file upload via the engine"
// and "Per-job conflictPolicy is set at enqueue and the service never
// prompts".

import { statSync } from "node:fs";
import { posix as posixPath } from "node:path";

import type {
  ClientFactory,
  DatasourceClient,
  DatasourceError,
  EventBus as EngineEventBus,
} from "@ft5/fs-datasource-engine";
import type {
  DatasourceType,
  DatasourceFileEntry,
} from "@ft5/ipc-contracts";

import type { Executor, ExecutorResult } from "../scheduler/scheduler.js";

export interface UploadExecutorDeps {
  readonly factory: ClientFactory;
  /**
   * Resolve a client for a given datasourceId. The service's container
   * caches these; the executor only asks. Abstracted so tests can supply
   * a FakeDatasourceClient without real provider SDK involvement.
   */
  readonly resolveClient: (
    datasourceId: string,
  ) => Promise<DatasourceClient<DatasourceType>>;
  /**
   * Engine event bus. Subscribed to during uploadFile so the engine's
   * streaming `"uploading"` events (with `{transactionId, progress, path}`)
   * are translated into service-side `job-progress` events. Optional so
   * tests can omit it without wiring a full bus fake.
   */
  readonly engineBus?: EngineEventBus;
}

export function buildUploadExecutor(deps: UploadExecutorDeps): Executor {
  return async (ctx): Promise<ExecutorResult> => {
    const { job, signal, bus } = ctx;

    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    if (job.targetPath == null) {
      return {
        outcome: "failed",
        errorTag: "validation-error",
        errorMessage: `upload job ${job.id} has no targetPath`,
      };
    }

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

    // targetPath is the FULL destination path (e.g. "/folder/file.png").
    // The engine's uploadFile takes (parent, file) — parent is the target
    // directory, file.name is the destination filename. Split accordingly.
    const parentPath = posixPath.dirname(job.targetPath);
    const targetName = posixPath.basename(job.targetPath);
    if (targetName === "") {
      return {
        outcome: "failed",
        errorTag: "validation-error",
        errorMessage: `upload job ${job.id} targetPath has no filename: ${job.targetPath}`,
      };
    }

    // Total size of the source file. The engine's streaming `"uploading"`
    // events only carry percent (not bytes), but the renderer derives the
    // progress bar from bytesUploaded/bytesTotal (store.tsx Decision 13).
    // Stat the source once so we can synthesize plausible byte counts from
    // the percent ticks — statSync may fail if the file disappeared; fall
    // back to 0 (bar stays indeterminate in that case).
    let totalBytes = 0;
    try {
      totalBytes = statSync(job.sourcePath).size;
    } catch {
      totalBytes = 0;
    }

    // Bridge engine streaming progress → service job-progress. The engine
    // emits `"uploading"` events carrying {transactionId, progress, path};
    // we match on datasourceId + path (sourcePath) to attribute them to
    // this job.
    const unsubscribe = deps.engineBus?.subscribe((event) => {
      if (event.event !== "uploading") return;
      if (event.datasourceId !== job.datasourceId) return;
      const payload = event.payload as { path?: string; progress?: number };
      if (payload.path !== job.sourcePath) return;
      const percent = typeof payload.progress === "number" ? payload.progress : 0;
      const bytesSent = Math.round((totalBytes * percent) / 100);
      bus.emit("job-progress", {
        jobId: job.id,
        bytesSent,
        totalBytes: totalBytes > 0 ? totalBytes : null,
        percent,
      });
    });

    try {
      // v1 policy: full re-upload on retry. The params are identical on
      // every attempt; there is no startOffset / uploadId / session handle.
      // Resumable-upload sessions (S3 multipart continue / Drive / OneDrive)
      // are a follow-up engine change. See openspec/changes/
      // add-fs-engine-cancellation/ for the umbrella engine-side follow-up.
      const entry: DatasourceFileEntry<DatasourceType> = await client.uploadFile(
        { kind: "path", path: parentPath },
        { path: job.sourcePath, name: targetName },
      );
      // Final 100% tick. Prefer the server-returned size when present,
      // fall back to the pre-stat'd local size so the renderer settles at
      // a real byte count rather than 0 / null.
      const finalTotal = entry.size ?? (totalBytes > 0 ? totalBytes : null);
      bus.emit("job-progress", {
        jobId: job.id,
        bytesSent: finalTotal ?? 0,
        totalBytes: finalTotal,
        percent: 100,
      });
      return { outcome: "completed", resultPayload: entry };
    } catch (err) {
      const e = err as DatasourceError<DatasourceType>;
      const tag = (e as { tag?: string }).tag ?? "internal-error";
      const message = (e as { message?: string }).message ?? "upload failed";

      // Conflict + skip policy → treat as success (no-op).
      if (tag === "conflict" && job.conflictPolicy === "skip") {
        return { outcome: "completed" };
      }

      // Network → waiting-network; rate-limit / auth-expired propagate
      // via the engine's own retry logic for auth-expired and through
      // the scheduler's system-retry branch (phase 12) for network /
      // rate-limited. The executor just reports the tag; applyOutcome
      // chooses the DB status.
      if (tag === "network-error") {
        return { outcome: "waiting-network", errorTag: tag, errorMessage: message };
      }

      return { outcome: "failed", errorTag: tag, errorMessage: message };
    } finally {
      unsubscribe?.();
    }
  };
}
