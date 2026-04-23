// Main-process engine singleton — Phase 9c.
//
// Holds the long-lived per-process state that IPC handlers need:
//   - the shared EventBus (all strategy events flow through this bus),
//   - the DatasourceRegistry (persistent datasource table),
//   - the ClientFactory (provider-id → DatasourceClient constructor).
//
// Credentials are NOT part of the engine: the fs-sync service owns them
// end-to-end (wire-fs-sync-service section 9). The desktop main process
// neither reads nor writes credentials; every provider call that needs
// them goes through the service over the sync IPC channel.
//
// Lazy init — `main/index.ts` calls `initEngine(db)` exactly once after DB
// migrations run and before IPC handler registration. IPC handlers then call
// `getEngine()` on each request; the singleton is cached until process exit
// (or `resetEngineForTests()` between Vitest cases).
//
// Why a singleton and not DI per-handler:
//   * IPC handlers are module-scope functions (see `apps/desktop/src/main/
//     ipc/datasources/*.ts`); threading a DI context through every one
//     would require touching every registration site for zero product
//     value.
//   * The engine's state is truly per-process (one bus, one DB). Passing it
//     around would just be a layer of indirection over what this module
//     already models.
//   * Tests that need isolation call `resetEngineForTests()` and then
//     `initEngine(...)` with their own in-memory DB.
//
// Design refs:
//   - openspec/changes/add-fs-datasource-engine/design.md Phase 9 scoping.
//   - openspec/changes/add-fs-datasource-engine/tasks.md 9.9.
//   - openspec/changes/wire-fs-sync-service/tasks.md 9.1-9.5.

import {
  createClientFactory,
  createDefaultProviderRegistry,
  createEventBus,
  type ClientFactory,
  type EventBus,
} from "@ft5/fs-datasource-engine";

import type { SqliteDatabase } from "../db/database.js";
import { DatasourceRegistry } from "./registry.js";

export interface Engine {
  readonly bus: EventBus;
  readonly registry: DatasourceRegistry;
  readonly factory: ClientFactory;
}

let engineInstance: Engine | null = null;

/**
 * Initialize the main-process engine with a shared DB handle. Must be
 * called exactly once per process — a second call throws. Construct an
 * `Engine` by wiring a `DatasourceRegistry` over the given DB, creating a
 * fresh `EventBus`, and constructing the default provider `ClientFactory`.
 *
 * Call order at bootstrap (enforced by `main/index.ts`):
 *   openDatabase → runMigrations → initEngine → registerIpcHandlers
 */
export function initEngine(db: SqliteDatabase): void {
  if (engineInstance !== null) {
    throw new Error(
      "Engine already initialized — call resetEngineForTests() first in tests, or do not call initEngine twice in production",
    );
  }
  const registry = new DatasourceRegistry(db);
  const bus = createEventBus();
  const factory = createClientFactory(createDefaultProviderRegistry());
  engineInstance = { bus, registry, factory };
}

/**
 * Access the process-wide engine. Throws if `initEngine` has not yet run.
 * IPC handlers call this on each request and read the fields they need.
 */
export function getEngine(): Engine {
  if (engineInstance === null) {
    throw new Error(
      "Engine not initialized — initEngine(db) must be called at app bootstrap before any IPC handler runs",
    );
  }
  return engineInstance;
}

/**
 * Test-only: clear the singleton so a new `initEngine(db)` call succeeds.
 * Never call this from production code.
 */
export function resetEngineForTests(): void {
  engineInstance = null;
}
