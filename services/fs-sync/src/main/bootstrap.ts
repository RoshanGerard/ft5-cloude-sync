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
  type ProviderRegistry,
} from "@ft5/fs-datasource-engine";

import { createResolveClient } from "./resolve-client.js";

import { buildCommandHandlers } from "../commands/handlers.js";
import { ServiceConfigStore } from "../config/service-config-store.js";
import { ConfigFileCredentialStore } from "../credential-store/config-file.js";
import { applyMigrations } from "../db/migrations.js";
import { openDatabase } from "../db/open.js";
import { ensureDataDir } from "../env/ensure-dir.js";
import {
  resolveCredentialsPath,
  resolveDataDir,
  resolveDbPath,
  resolvePidPath,
  resolveServiceConfigPath,
  resolveSocketPath,
} from "../env/paths.js";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import { buildMirrorSyncExecutor } from "../executors/mirror-sync.js";
import { buildUploadExecutor } from "../executors/upload.js";
import {
  startServer,
  type CommandHandler,
  type RunningServer,
} from "../ipc/server.js";
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
  | "construct-service-config-store"
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
  // `error` is optional so existing callers passing `{ info }` still type-check.
  // Bootstrap uses it to surface ipc-bind failures (task 2.6) — operators grep
  // the service log for the exact message tag.
  error?(msg: string, fields?: Record<string, unknown>): void;
}

// Raised when stage 11 (`ipcServer.listen`) fails to bind. Distinct from
// `AlreadyRunningError` (stage 4) and `DatabaseIntegrityError` (stage 1) so
// `index.ts` can map it to its own exit code (5). Wraps the underlying
// listen error on `cause` for diagnostics.
export class IpcBindError extends Error {
  constructor(cause: unknown) {
    const suffix =
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "unknown";
    // Use ES2022 Error cause slot (inherited) rather than declaring a shadow
    // field — avoids useDefineForClassFields redefining it at construction.
    super(`ipc-bind-failed: ${suffix}`, { cause });
    this.name = "IpcBindError";
  }
}

export interface BootstrapOptions {
  readonly dev: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly observer?: BootstrapObserver;
  readonly logger?: BootstrapLogger;
  readonly serviceVersion?: string;
  readonly serviceUuid?: string;
  // Path seams. `dataDir` and `socketPath` are the two the spec names
  // explicitly; the remaining three are internal knobs so tests can isolate
  // the PID file, DB file, and credentials file under a scratch dir.
  readonly dataDir?: string;
  readonly socketPath?: string;
  readonly pidPath?: string;
  readonly dbPath?: string;
  readonly credentialsPath?: string;
  // Path seam for the service-owned OAuth-app config file. Optional so
  // tests can scope to a scratch dir; production resolves via
  // `resolveServiceConfigPath`. The store does NOT auto-create this file —
  // the user copies `services/fs-sync/config.example.json` into place per
  // README §Provider OAuth registration.
  readonly configPath?: string;
}

export interface Runtime {
  readonly socketPath: string;
  readonly db: Database.Database;
  readonly scheduler: Scheduler;
  // Available so the §9 authenticate-start handler (and the §12 get/set-config
  // handlers) can reach the same instance that bootstrap composed. Service
  // owns the single source of truth for OAuth app config during process
  // lifetime per design.md Decision 4.
  readonly serviceConfigStore: ServiceConfigStore;
  readonly stop: () => Promise<void>;
}

export async function bootstrap(options: BootstrapOptions): Promise<Runtime> {
  const { dev, observer, logger } = options;
  const pathOpts = { dev };
  const env = options.env ?? process.env;

  const dataDir = options.dataDir ?? resolveDataDir(pathOpts, env);
  const pidPath = options.pidPath ?? resolvePidPath(pathOpts, env);
  const dbPath = options.dbPath ?? resolveDbPath(pathOpts, env);
  const socketPath = options.socketPath ?? resolveSocketPath(pathOpts, env);
  const credentialsPath =
    options.credentialsPath ?? resolveCredentialsPath(pathOpts, env);
  const configPath =
    options.configPath ?? resolveServiceConfigPath(pathOpts, env);

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

    // 5b. construct-service-config-store
    // Per design.md Decision 4: service owns the per-provider OAuth app
    // config. The store does NOT touch disk at construction time; reads are
    // lazy at `sync:authenticate-start` time so a missing/invalid file does
    // not break the boot path — it surfaces as the typed
    // `service-config-missing` wire error inline in the renderer's oauth-form
    // failure state instead.
    const serviceConfigStore = new ServiceConfigStore({
      filePath: configPath,
    });
    observer?.onStage("construct-service-config-store");

    // 6. construct-provider-registry
    const registry: ProviderRegistry = createDefaultProviderRegistry();
    observer?.onStage("construct-provider-registry");

    // 7. construct-client-factory
    const factory: ClientFactory = createClientFactory(registry);
    // Per-datasource resolver lives in `./resolve-client.ts` so its
    // InvalidDatasource throw path is directly unit-testable (per
    // add-invalid-datasource-state §5). Executors still invoke it via
    // the same `deps.resolveClient` port.
    const resolveClient = createResolveClient({
      credentialStore,
      factory,
      engineBus,
    });
    observer?.onStage("construct-client-factory");

    // 8. construct-scheduler
    // Pass engineBus so the executor can translate the engine's streaming
    // `"uploading"` events into service-side `job-progress` events. Without
    // this wiring, progress bars only get the terminal 100% tick.
    const uploadExec = buildUploadExecutor({ factory, resolveClient, engineBus });
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
      resolveClient,
    });
    const subscribeHandler: CommandHandler<"sync:subscribe-events"> = async (
      _params,
      ctx,
    ) => {
      subs.subscribe(ctx.connection);
      return { ok: true, result: { subscribed: true } };
    };
    const unsubscribeHandler: CommandHandler<"sync:unsubscribe-events"> =
      async (_params, ctx) => {
        subs.unsubscribe(ctx.connection);
        return { ok: true, result: { unsubscribed: true } };
      };
    const handlers = {
      ...baseHandlers,
      "sync:subscribe-events": subscribeHandler,
      "sync:unsubscribe-events": unsubscribeHandler,
    };
    try {
      server = await startServer({
        pipePath: socketPath,
        handlers,
        commandNames: COMMAND_NAMES,
      });
    } catch (cause) {
      // Stage 11 bind failure. Emit the operator-visible "ipc-bind-failed"
      // log line, then rethrow as IpcBindError so the outer catch tears down
      // stages 1-10 and `index.ts` can map it to exit code 5.
      // Flatten `cause` into string fields — raw Error objects have no
      // enumerable properties so `JSON.stringify` would drop the code and
      // message, leaving operators nothing to grep for.
      const causeMessage =
        cause instanceof Error ? cause.message : String(cause);
      const causeCode =
        cause && typeof cause === "object" && "code" in cause
          ? String((cause as { code?: unknown }).code)
          : undefined;
      logger?.error?.("ipc-bind-failed", {
        socketPath,
        causeMessage,
        causeCode,
      });
      throw new IpcBindError(cause);
    }
    observer?.onStage("ipc-listen");

    logger?.info("bootstrap-complete", {
      pid: process.pid,
      mode: dev ? "dev" : "prod",
      socketPath,
    });

    const runtimeScheduler = scheduler;
    const runtimeProbe = probe;
    const runtimeServer = server;
    const runtimeRelease = releasePid;
    const runtimeDb: Database.Database = db;
    return {
      socketPath,
      db: runtimeDb,
      scheduler: runtimeScheduler,
      serviceConfigStore,
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
