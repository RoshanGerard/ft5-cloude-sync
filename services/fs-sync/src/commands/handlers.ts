// Command handler factory for the sync service. Each handler is a pure
// function of (params, deps) that returns the response shape defined by
// the IPC contract. The scheduler and executors are NOT consulted here —
// handlers touch the DB and emit events; background work is driven by the
// scheduler on its own timer (wired in Phase 9).

import type {
  ClientFactory,
  CredentialStore,
  DatasourceClient,
  EngineContext,
} from "@ft5/fs-datasource-engine";
import type { DatasourceType } from "@ft5/ipc-contracts";

import type {
  CommandHandlers,
  Connection,
} from "../ipc/server.js";
import { enqueueMirror, SyncAlreadyRunningError } from "../jobs/enqueue.js";
import { JobRepository } from "../jobs/repository.js";
import type { EventBus } from "../events/event-bus.js";
import { PolicyStore } from "../retry/policy-store.js";
import type Database from "better-sqlite3";

import { makeAuthenticateStartHandler } from "./authenticate-start.js";
import { makeAuthenticateCompleteHandler } from "./authenticate-complete.js";
import { makeAuthenticateCancelHandler } from "./authenticate-cancel.js";
import { makeGetConfigHandler } from "./get-config.js";
import { makeSetConfigHandler } from "./set-config.js";
import { makeDeleteCredentialsHandler } from "./delete-credentials.js";
import { makeFilesListHandler } from "./files-list.js";
import { makeFilesStatHandler } from "./files-stat.js";
import { makeFilesSearchHandler } from "./files-search.js";
import { makeFilesRemoveHandler } from "./files-remove.js";
import { makeFilesRenameHandler } from "./files-rename.js";
import {
  createDefaultFilesDownloadDeps,
  makeFilesDownloadHandler,
  makeSyncCancelDownloadHandler,
  type EngineBusSubscriber,
  type HashComputer,
} from "./files-download.js";
import { makeDownloadsListActiveHandler } from "./downloads-list-active.js";
import {
  createDefaultFilesUploadDeps,
  makeFilesUploadHandler,
} from "./files-upload.js";
import { makeUploadsListActiveHandler } from "./uploads-list-active.js";
import { makeSyncCancelUploadHandler } from "./sync-cancel-upload.js";
import type { DownloadRegistry } from "../downloads/registry.js";
import type { UploadRegistry } from "../uploads/registry.js";
import type { ServiceConfigStore } from "../config/service-config-store.js";
import type { AuthCorrelationStore } from "../state/auth-correlation-store.js";
import type { OAuthLoopbackBroker } from "../oauth/loopback-broker.js";

export interface HandlersDeps {
  readonly db: Database.Database;
  readonly bus: EventBus;
  readonly serviceVersion: string;
  readonly serviceUuid: string;
  /**
   * Per-datasource engine client resolver. When absent (existing tests
   * that predate the `files:*` commands), `files:*` handlers are omitted
   * from the returned map. Production bootstrap always supplies it.
   */
  readonly resolveClient?: (
    datasourceId: string,
  ) => Promise<DatasourceClient<DatasourceType>>;
  /**
   * Auth dependencies — added by implement-datasource-onboarding §9-§13.
   * When ANY of the auth deps are absent, ALL `sync:authenticate-*`,
   * `sync:get-config`, `sync:set-config`, and `sync:delete-credentials`
   * handlers are omitted from the returned map. This keeps existing
   * tests that build `HandlersDeps` without auth wiring (`handlers.test.ts`,
   * `no-auto-sync.test.ts`) compiling unchanged. Production bootstrap
   * always supplies the full bundle.
   */
  readonly correlationStore?: AuthCorrelationStore;
  readonly configStore?: ServiceConfigStore;
  readonly factory?: ClientFactory;
  readonly engineContext?: EngineContext;
  readonly loopbackBroker?: OAuthLoopbackBroker;
  readonly credentialStore?: CredentialStore;
  /**
   * Download-side dependencies — added by add-engine-rename-download §13.
   * The `files:download` handler needs the in-memory `DownloadRegistry`,
   * the engine event bus (for the per-handler-call subscription that
   * drives the §13.25-§13.26 derived-not-relayed IPC events), and a
   * hash computer for the post-download integrity check. When ANY of
   * the trio is absent, `files:download` and `sync:cancel-download` are
   * omitted from the returned map (mirrors the auth-bundle pattern
   * above) so existing tests that pre-date §13 keep compiling.
   */
  readonly downloadRegistry?: DownloadRegistry;
  readonly engineBus?: EngineBusSubscriber;
  readonly hashComputer?: HashComputer;
  /**
   * Upload-side dependencies — added by
   * migrate-upload-orchestration-out-of-engine §9. The `files:upload`
   * handler needs the in-memory `UploadRegistry`. When absent — together
   * with `resolveClient` — `files:upload`, `sync:cancel-upload`, and
   * `uploads:list-active` are omitted from the returned map (mirrors the
   * download-bundle pattern above) so existing tests that pre-date this
   * change keep compiling. Production bootstrap supplies it alongside
   * `resolveClient`. The legacy `sync:enqueue-upload` queue path was
   * deleted in chunk F; uploads are exclusively a service-direct-RPC.
   */
  readonly uploadRegistry?: UploadRegistry;
}

export function buildCommandHandlers(deps: HandlersDeps): CommandHandlers {
  const repo = new JobRepository(deps.db);
  const policies = new PolicyStore(deps.db);

  return {
    "sync:get-status": async () => ({
      ok: true,
      result: {
        version: deps.serviceVersion,
        serviceUuid: deps.serviceUuid,
        runningJobs: repo.countByStatus(["running"]),
        queuedJobs: repo.countByStatus(["queued"]),
        waitingNetworkJobs: repo.countByStatus(["waiting-network"]),
        monitorConnected: false,
      },
    }),

    // migrate-upload-orchestration-out-of-engine §7.4 / §11 — the
    // `sync:enqueue-upload` queue dispatcher entry was removed in chunk F.
    // Single-file uploads are now handled by the `files:upload` direct-RPC
    // (see the additive bundle below). The `UploadJobExecutor` was deleted
    // alongside; no new `kind: 'upload'` rows are minted here. The legacy
    // `'upload'` value remains in `JobKind` / DB CHECK constraint so
    // historical rows in user DBs stay readable.

    "sync:enqueue-mirror": async (params) => {
      try {
        const { jobId } = enqueueMirror(deps.db, {
          datasourceId: params.datasourceId,
          sourcePath: params.sourcePath,
          conflictPolicy: params.conflictPolicy ?? "overwrite",
        });
        deps.bus.emit("job-enqueued", {
          jobId,
          kind: "sync",
          datasourceId: params.datasourceId,
          sourcePath: params.sourcePath,
          targetPath: null,
          conflictPolicy: params.conflictPolicy ?? "overwrite",
          enqueuedAt: Date.now(),
        });
        return { ok: true, result: { jobId } };
      } catch (err) {
        if (err instanceof SyncAlreadyRunningError) {
          return {
            ok: false,
            error: {
              tag: "sync-already-running",
              message: err.message,
              details: {
                existingJobId: err.existingJobId,
                datasourceId: err.datasourceId,
                sourcePath: err.sourcePath,
              },
            },
          };
        }
        throw err;
      }
    },

    "sync:list-jobs": async (params) => {
      let jobs = repo.listAll();
      if (params.filter?.status) {
        const set = new Set(params.filter.status);
        jobs = jobs.filter((j) => set.has(j.status));
      }
      if (params.filter?.datasourceId) {
        jobs = jobs.filter((j) => j.datasourceId === params.filter!.datasourceId);
      }
      if (params.filter?.kind) {
        jobs = jobs.filter((j) => j.kind === params.filter!.kind);
      }
      return { ok: true, result: { jobs } };
    },

    "sync:get-job": async (params) => {
      const job = repo.getById(params.jobId);
      if (!job) {
        return {
          ok: false,
          error: {
            tag: "not-found",
            message: `no job with id ${params.jobId}`,
          },
        };
      }
      return { ok: true, result: { job } };
    },

    "sync:cancel-job": async (params) => {
      const job = repo.getById(params.jobId);
      if (!job) {
        return {
          ok: false,
          error: { tag: "not-found", message: `no job with id ${params.jobId}` },
        };
      }
      if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "cancelled"
      ) {
        return {
          ok: false,
          error: {
            tag: "not-cancelable",
            message: `job ${params.jobId} is already in terminal state ${job.status}`,
          },
        };
      }
      const prior = job.status;
      // queued → cancelled and waiting-network → cancelled are legal.
      // running → cancelled happens via the scheduler (it needs to abort
      // the in-flight executor first); for the handler, we trust the
      // scheduler to process the transition asynchronously.
      if (prior === "running") {
        // TODO(phase 9): signal AbortController via scheduler.
        return {
          ok: false,
          error: {
            tag: "not-cancelable",
            message:
              `job ${params.jobId} is running; cancellation requires the scheduler — not yet wired`,
          },
        };
      }
      repo.transition(params.jobId, "cancelled");
      deps.bus.emit("job-cancelled", {
        jobId: params.jobId,
        cancelledAt: Date.now(),
        priorStatus: prior,
      });
      return { ok: true, result: { cancelled: true } };
    },

    "sync:set-retry-policy": async (params) => {
      policies.upsert({
        scope: params.scope,
        datasourceId: params.datasourceId ?? null,
        maxAttempts: params.maxAttempts,
        backoffMs: params.backoffMs,
        backoffStrategy: params.backoffStrategy,
        maxAgeMs: params.maxAgeMs ?? null,
      });
      const stored = policies.get(params.scope, params.datasourceId);
      return { ok: true, result: { policy: stored! } };
    },

    "sync:get-retry-policy": async (params) => {
      const stored = policies.get(params.scope, params.datasourceId);
      if (!stored) {
        return {
          ok: false,
          error: {
            tag: "not-found",
            message: `no policy for scope=${params.scope} datasourceId=${params.datasourceId ?? ""}`,
          },
        };
      }
      return { ok: true, result: { policy: stored } };
    },

    "sync:subscribe-events": async () => {
      // Subscription wiring lands in phase 16 — for v1 of this file we
      // accept the subscribe and return ok. The connection-level event
      // fan-out is installed in that phase; until then, broadcast via
      // the server.broadcast() path reaches every connected client
      // regardless of explicit subscription.
      return { ok: true, result: { subscribed: true } };
    },

    "sync:unsubscribe-events": async () => ({
      ok: true,
      result: { unsubscribed: true },
    }),

    // Authenticate + config + delete-credentials handlers — wired only
    // when the full auth bundle is supplied (correlationStore +
    // configStore + factory + engineContext + loopbackBroker +
    // credentialStore). Older tests that build handlers without auth
    // deps still type-check; production bootstrap always supplies all.
    ...(deps.correlationStore &&
    deps.configStore &&
    deps.factory &&
    deps.engineContext &&
    deps.loopbackBroker &&
    deps.credentialStore
      ? {
          "sync:authenticate-start": makeAuthenticateStartHandler({
            bus: deps.bus,
            correlationStore: deps.correlationStore,
            factory: deps.factory,
            configStore: deps.configStore,
            loopbackBroker: deps.loopbackBroker,
            engineContext: deps.engineContext,
          }),
          "sync:authenticate-complete": makeAuthenticateCompleteHandler({
            bus: deps.bus,
            correlationStore: deps.correlationStore,
          }),
          "sync:authenticate-cancel": makeAuthenticateCancelHandler({
            bus: deps.bus,
            correlationStore: deps.correlationStore,
            loopbackBroker: deps.loopbackBroker,
          }),
          "sync:get-config": makeGetConfigHandler({
            configStore: deps.configStore,
          }),
          "sync:set-config": makeSetConfigHandler({
            configStore: deps.configStore,
          }),
          "sync:delete-credentials": makeDeleteCredentialsHandler({
            credentialStore: deps.credentialStore,
          }),
        }
      : {}),

    // files:* handlers — wired only when a resolveClient is supplied so
    // older tests that build handlers without engine deps keep compiling.
    ...(deps.resolveClient
      ? {
          "files:list": makeFilesListHandler({ resolveClient: deps.resolveClient }),
          "files:stat": makeFilesStatHandler({ resolveClient: deps.resolveClient }),
          "files:search": makeFilesSearchHandler({
            resolveClient: deps.resolveClient,
          }),
          "files:remove": makeFilesRemoveHandler({
            resolveClient: deps.resolveClient,
          }),
          "files:rename": makeFilesRenameHandler({
            resolveClient: deps.resolveClient,
          }),
        }
      : {}),
    // files:download + sync:cancel-download + downloads:list-active —
    // wired only when the full download-bundle is supplied
    // (resolveClient + downloadRegistry + engineBus + hashComputer).
    // Production bootstrap supplies all four; pre-§13 tests omit them
    // and the keys simply fall out of the map. `downloads:list-active`
    // strictly only needs `downloadRegistry`, but the bundle stays
    // atomic — wiring it any time the registry is present would imply
    // half a feature; keep it gated with the rest per design.md
    // Decision 4.
    ...(deps.resolveClient &&
    deps.downloadRegistry &&
    deps.engineBus &&
    deps.hashComputer
      ? {
          "files:download": makeFilesDownloadHandler(
            createDefaultFilesDownloadDeps({
              resolveClient: deps.resolveClient,
              registry: deps.downloadRegistry,
              fsSyncBus: deps.bus,
              engineBus: deps.engineBus,
              hash: deps.hashComputer,
            }),
          ),
          "sync:cancel-download": makeSyncCancelDownloadHandler({
            registry: deps.downloadRegistry,
          }),
          "downloads:list-active": makeDownloadsListActiveHandler({
            registry: deps.downloadRegistry,
          }),
        }
      : {}),
    // files:upload + sync:cancel-upload + uploads:list-active —
    // wired only when both `resolveClient` and `uploadRegistry` are
    // supplied. Mirrors the download-bundle pattern above. The legacy
    // queue-based `sync:enqueue-upload` dispatcher entry was deleted in
    // chunk F; this is the sole single-file-upload handler bundle.
    ...(deps.resolveClient && deps.uploadRegistry
      ? {
          "files:upload": makeFilesUploadHandler(
            createDefaultFilesUploadDeps({
              resolveClient: deps.resolveClient,
              registry: deps.uploadRegistry,
              fsSyncBus: deps.bus,
            }),
          ),
          "sync:cancel-upload": makeSyncCancelUploadHandler({
            registry: deps.uploadRegistry,
          }),
          "uploads:list-active": makeUploadsListActiveHandler({
            registry: deps.uploadRegistry,
          }),
        }
      : {}),
  };
}

// Connection-typed re-export so callers can pass ctx through the handler
// factory if they need to capture per-connection state in later phases.
export type { Connection };
