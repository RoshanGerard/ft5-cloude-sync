// Bootstrap — composes every service module in the order the spec requires
// and returns a Runtime handle the caller can stop later. Splitting this
// out of index.ts lets tests drive the same composition deterministically
// against a scratch data dir with path overrides.
//
// Order (tasks.md 2.1, spec "Bootstrap order is observable"):
//   openDatabase → applyMigrations → integrity-ok → acquirePidGuard
//   → construct credential store → construct provider registry
//   → construct client factory → construct scheduler
//   → construct network probe → recoverRunningJobs → ipcServer.listen
//
// Shutdown (Runtime.stop) reverses where dependencies allow:
//   probe.stop → scheduler.stop → server.close → db.close → release PID.

import type Database from "better-sqlite3";

import { COMMAND_NAMES } from "@ft5/ipc-contracts/sync-service";
import {
  createClientFactory,
  createDefaultProviderRegistry,
  createEventBus as createEngineEventBus,
  type ClientFactory,
  type DatasourceClient,
  type ProviderRegistry,
} from "@ft5/fs-datasource-engine";
import type { DatasourceType, ProviderId } from "@ft5/ipc-contracts";

import { buildCommandHandlers } from "../commands/handlers.js";
import { ConfigFileCredentialStore } from "../credential-store/config-file.js";
import { applyMigrations } from "../db/migrations.js";
import { openDatabase } from "../db/open.js";
import { ensureDataDir } from "../env/ensure-dir.js";
import {
  resolveCredentialsPath,
  resolveDataDir,
  resolveDbPath,
  resolvePidPath,
  resolveSocketPath,
} from "../env/paths.js";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import { buildMirrorSyncExecutor } from "../executors/mirror-sync.js";
import { buildUploadExecutor } from "../executors/upload.js";
import { startServer, type RunningServer } from "../ipc/server.js";
import { createSubscriptionRegistry } from "../ipc/subscriptions.js";
import { NetworkProbe } from "../retry/network-probe.js";
import { Scheduler } from "../scheduler/scheduler.js";
import {
  acquirePidGuardSync,
  AlreadyRunningError,
} from "../single-instance/pid-guard.js";
import { recoverRunningJobs } from "../startup/recovery.js";

export type BootstrapStage =
  | "open-database"
  | "apply-migrations"
  | "integrity-ok"
  | "acquire-pid-guard"
  | "construct-credential-store"
  | "construct-provider-registry"
  | "construct-client-factory"
  | "construct-scheduler"
  | "construct-network-probe"
  | "recover-running-jobs"
  | "ipc-listen";

export interface BootstrapObserver {
  onStage(stage: BootstrapStage): void;
}

export interface BootstrapLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
}

export interface BootstrapOptions {
  readonly dev: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly observer?: BootstrapObserver;
  readonly logger?: BootstrapLogger;
  readonly serviceVersion?: string;
  readonly serviceUuid?: string;
  readonly pathOverrides?: {
    readonly dataDir?: string;
    readonly pidPath?: string;
    readonly dbPath?: string;
    readonly socketPath?: string;
    readonly credentialsPath?: string;
  };
}

export interface Runtime {
  readonly pipePath: string;
  readonly stop: () => Promise<void>;
}

export async function bootstrap(options: BootstrapOptions): Promise<Runtime> {
  const { dev, observer, logger } = options;
  const pathOpts = { dev };
  const env = options.env ?? process.env;

  const dataDir = options.pathOverrides?.dataDir ?? resolveDataDir(pathOpts, env);
  const pidPath = options.pathOverrides?.pidPath ?? resolvePidPath(pathOpts, env);
  const dbPath = options.pathOverrides?.dbPath ?? resolveDbPath(pathOpts, env);
  const socketPath =
    options.pathOverrides?.socketPath ?? resolveSocketPath(pathOpts, env);
  const credentialsPath =
    options.pathOverrides?.credentialsPath ??
    resolveCredentialsPath(pathOpts, env);

  // Data directory must exist with the right mode BEFORE anything else
  // touches it (openDatabase will create sync.db inside). This is setup,
  // not a spec stage — it does not fire an observer event.
  await ensureDataDir(dataDir);

  // 1. open-database
  const db = openDatabase(dbPath);
  observer?.onStage("open-database");

  // Track resources so shutdown releases them in the right order regardless
  // of where a failure occurs mid-boot. Populated in the try block below.
  let releasePid: (() => void) | null = null;
  let scheduler: Scheduler | null = null;
  let probe: NetworkProbe | null = null;
  let server: RunningServer | null = null;

  try {
    // 2. apply-migrations
    applyMigrations(db);
    observer?.onStage("apply-migrations");

    // 3. integrity-ok — openDatabase already ran PRAGMA integrity_check;
    //    this stage marks the transition point after migrations have
    //    successfully landed on top of a healthy file.
    observer?.onStage("integrity-ok");

    // 4. acquire-pid-guard
    releasePid = acquirePidGuardSync(pidPath);
    observer?.onStage("acquire-pid-guard");

    // 5. construct-credential-store
    // Two buses: `bus` is the service-internal event bus (scheduler, probe,
    // subscriptions, executors); `engineBus` is the engine's coalescing bus
    // required by EngineContext. They are distinct types — do not cross-wire.
    const bus: EventBus = createEventBus();
    const engineBus = createEngineEventBus();
    const credentialStore = new ConfigFileCredentialStore({
      filePath: credentialsPath,
    });
    // Clean up any orphan `.tmp` left by a prior crash between write+rename.
    await credentialStore.cleanupOrphanTmp();
    observer?.onStage("construct-credential-store");

    // 6. construct-provider-registry
    const registry: ProviderRegistry = createDefaultProviderRegistry();
    observer?.onStage("construct-provider-registry");

    // 7. construct-client-factory
    const factory: ClientFactory = createClientFactory(registry);
    // Per-datasource resolver. Reads credentials from the store, then asks
    // the factory to construct a fresh client. Executors invoke this via
    // the deps.resolveClient port — no strategy SDKs imported here.
    const resolveClient = async (
      datasourceId: string,
    ): Promise<DatasourceClient<DatasourceType>> => {
      const creds = await credentialStore.get(datasourceId);
      if (creds === null) {
        throw new Error(
          `no credentials registered for datasourceId=${datasourceId}`,
        );
      }
      return factory.create(
        creds.providerId as ProviderId,
        datasourceId,
        creds,
        { bus: engineBus, credentialStore },
      ) as DatasourceClient<DatasourceType>;
    };
    observer?.onStage("construct-client-factory");

    // 8. construct-scheduler
    const uploadExec = buildUploadExecutor({ factory, resolveClient });
    const mirrorExec = buildMirrorSyncExecutor({ db, resolveClient });
    scheduler = new Scheduler(db, {
      executors: { upload: uploadExec, sync: mirrorExec },
      bus,
    });
    scheduler.start();
    observer?.onStage("construct-scheduler");

    // 9. construct-network-probe
    probe = new NetworkProbe({ db, bus });
    observer?.onStage("construct-network-probe");

    // 10. recover-running-jobs — re-queue anything stuck in `running` from a
    //     prior crash. Runs AFTER the scheduler is constructed but BEFORE
    //     the IPC listener is bound so no client can observe half-state.
    recoverRunningJobs(db);
    observer?.onStage("recover-running-jobs");

    // 11. ipc-listen — the last observable side-effect. Subscription
    //     registry is wired here so `sync:subscribe-events` works end-to-end,
    //     but it is NOT an observer stage (not in the spec sequence).
    const subs = createSubscriptionRegistry();
    subs.attachBus(bus);
    const baseHandlers = buildCommandHandlers({
      db,
      bus,
      serviceVersion: options.serviceVersion ?? "0.0.0",
      serviceUuid: options.serviceUuid ?? "",
    });
    const handlers = {
      ...baseHandlers,
      "sync:subscribe-events": async (
        _params: unknown,
        ctx: { connection: Parameters<typeof subs.subscribe>[0] },
      ) => {
        subs.subscribe(ctx.connection);
        return { ok: true as const, result: { subscribed: true as const } };
      },
      "sync:unsubscribe-events": async (
        _params: unknown,
        ctx: { connection: Parameters<typeof subs.unsubscribe>[0] },
      ) => {
        subs.unsubscribe(ctx.connection);
        return { ok: true as const, result: { unsubscribed: true as const } };
      },
    };
    server = await startServer({
      pipePath: socketPath,
      handlers: handlers as never,
      commandNames: COMMAND_NAMES,
    });
    observer?.onStage("ipc-listen");

    logger?.info("bootstrap-complete", {
      pid: process.pid,
      mode: dev ? "dev" : "prod",
      pipePath: socketPath,
    });

    const runtimeScheduler = scheduler;
    const runtimeProbe = probe;
    const runtimeServer = server;
    const runtimeRelease = releasePid;
    const runtimeDb: Database.Database = db;
    return {
      pipePath: socketPath,
      async stop(): Promise<void> {
        // Shutdown: probe → scheduler → server → db → PID. Swallow
        // per-step errors so later steps still run.
        try {
          await runtimeProbe.stop();
        } catch {
          /* tolerated */
        }
        try {
          await runtimeScheduler.stop();
        } catch {
          /* tolerated */
        }
        try {
          await runtimeServer.close();
        } catch {
          /* tolerated */
        }
        try {
          runtimeDb.close();
        } catch {
          /* tolerated */
        }
        try {
          runtimeRelease();
        } catch {
          /* tolerated */
        }
      },
    };
  } catch (err) {
    // Mid-boot failure: tear down whatever we've already built, in reverse.
    try {
      if (server) await server.close();
    } catch {
      /* tolerated */
    }
    try {
      if (probe) await probe.stop();
    } catch {
      /* tolerated */
    }
    try {
      if (scheduler) await scheduler.stop();
    } catch {
      /* tolerated */
    }
    try {
      if (releasePid) releasePid();
    } catch {
      /* tolerated */
    }
    try {
      db.close();
    } catch {
      /* tolerated */
    }
    // Rethrow so the top-level caller maps AlreadyRunningError → exit 3,
    // DatabaseIntegrityError → exit 4, etc.
    throw err;
  }
}

export { AlreadyRunningError };
