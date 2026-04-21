// UploadJobExecutor — handles `kind: 'upload'` jobs. Resolves a
// DatasourceClient via the engine's ClientFactory, calls uploadFile with
// Target{kind:'path', path: targetPath}, and maps the returned FileEntry
// to a job-completed event. Respects `conflictPolicy: 'skip'` by
// swallowing DatasourceError{tag:'conflict'}.
//
// Spec: "UploadJobExecutor performs a single-file upload via the engine"
// and "Per-job conflictPolicy is set at enqueue and the service never
// prompts".

import type {
  ClientFactory,
  DatasourceClient,
  DatasourceError,
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

    try {
      const entry: DatasourceFileEntry<DatasourceType> = await client.uploadFile(
        { kind: "path", path: job.targetPath },
        { path: job.sourcePath },
      );
      bus.emit("job-progress", {
        jobId: job.id,
        bytesSent: entry.size ?? 0,
        totalBytes: entry.size ?? null,
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
    }
  };
}
