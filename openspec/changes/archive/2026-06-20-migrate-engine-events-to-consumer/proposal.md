# Proposal: Remove the engine `EventBus`; consumers own event emission

**Status**: Active. Promoted from stub (spawned 2026-04-28 during `add-engine-rename-download` brainstorming) on 2026-06-19. This is the culmination of the engine-decoupling sequence: `add-engine-rename-download` → `migrate-upload-orchestration-out-of-engine` → `migrate-engine-retry-policy-to-consumer` → `migrate-engine-cache-invalidation` (all merged).

## Why

The engine still owns an `EventBus` and emits 13 lifecycle events (`status-changed`, `authenticated`, `authentication-failed`, `token-refreshed`, `token-expired`, `rate-limited`, `deleted`, `delete-failed`, `entry-renamed`, `downloading`, `download-cancelled`, `download-failed`, `file-downloaded`). These are consumer-domain events dressed up as engine concerns: the engine knows whether an SDK call succeeded; the *consumer* decides which successes/failures its domain cares about and what event shape its own consumers want.

After the four merged decoupling changes, that bus is **vestigial** — verified against the current code, not the 2026-04-28 stub framing:

- **Only one event has a live consumer.** `downloading` is consumed by the fs-sync download handler's single subscription at `services/fs-sync/src/commands/files-download.ts:753`. The repo-wide grep finds no other `engineBus.subscribe`.
- **The desktop `datasources:event` bridge is dead end-to-end.** Desktop main never instantiates engine clients (every `getEngine()` reads `.registry`/`.factory`; tests assert `factory.create` is *not* called), so nothing emits onto its engine bus. The renderer hook `useDatasourceEvents` has **zero** production callers; the `consent-*` family that used `datasources.onEvent` was retired for `auth-*` on `sync.onEvent`. Auth/status events reach the renderer via fs-sync's *own* service bus (emitted independently of the engine bus); file-explorer state updates from RPC responses + the optimistic store.
- **The remaining 12 events emit to no one** (auth-cycle, delete/rename/status/rate-limited, download-terminal).

The value: (a) delete vestigial infrastructure — the entire `EventBus` + its streaming coalescer + the dead desktop datasources event path; (b) finish the "engine = vendor primitives; consumers own orchestration/events" principle so the engine carries zero domain-event concerns and zero broadcast surface.

## What Changes

- **BREAKING** (package surface): the engine's `EventBus` is removed entirely — `createEventBus`/`EventBus`/`EventBusOptions`/`Clock`/`ClockTimer` exports drop from `@ft5/fs-datasource-engine`, and `DatasourceEvent`/`AnyDatasourceEvent`/`PayloadMap`/`CanonicalEventPayloads` drop from `@ft5/ipc-contracts`. Only the now-removed dead path imported them.
- **BREAKING** (engine context): `EngineContext` becomes `{ credentialStore: CredentialStore }` — the `bus` field is gone. `ClientFactory.create` / `createForAuth` accept the new shape.
- Engine methods return typed results or throw normalized `DatasourceError` — **no bus side effects**. The base class wraps operations with refresh coordination + error normalization only; strategies emit nothing.
- `downloadFile` progress is observed **only** via `options.onProgress(loaded, total)` (already in the contract). The engine no longer emits `downloading`/`file-downloaded`/`download-failed`/`download-cancelled`.
- The fs-sync download handler stops subscribing to the engine bus and consumes `options.onProgress`, **relocating the 1s-OR-10% throttle (with flush-before-terminal) into the handler** — the engine coalescer that previously bounded progress emissions is gone.
- **Full cleanup** of the dead desktop datasources event path: the `datasources:event` IPC channel, `window.api.datasources.onEvent` (preload + both `window-api.d.ts`), the `useDatasourceEvents` renderer hook, and the orphaned event types.
- The `CredentialStore` port and the `withAuthRefresh` helper are **unchanged** — credential persistence (`CredentialStore.put`) stays in the engine; only the post-persist event emission is removed.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `fs-datasource-engine`: remove the `EventBus` from the public API and remove all bus side-effects from method contracts (`downloadFile`, `deleteFile`, `rename`, `authenticate`, `refreshCredentials`, `status`/`testConnection`/read-ops). Methods return values / throw normalized `DatasourceError`. (Also corrects pre-existing stale spec content that still referenced a `deleted`-event bus subscription, inconsistent with the merged `migrate-engine-cache-invalidation`.)
- `datasources-ui`: remove the `datasources:event` IPC channel, `window.api.datasources.onEvent`, and the `useDatasourceEvents` subscription requirement; the card derives display state from the sync-event stream + seed.
- `fs-sync-service`: the download handler owns download-progress throttling (1s OR 10% delta, flush-before-terminal) via `options.onProgress` instead of an engine-bus subscription; `DownloadRegistry` transitions are driven by `onProgress` + the `downloadFile` promise (the "Service subscribes to engine bus events" requirement is replaced, preserving the one-in-flight-per-`(datasourceId, path)` guard).
- `fs-sync-supervisor`: the supervisor's renderer event relay no longer references the removed `datasources:event` channel, and the `DatasourceCard` live-state requirement derives display state from the sync-event stream + `sync-state-seed` only (the `datasources:event` source is dropped).

## Impact

- **Code**: `packages/fs-datasource-engine` (delete `event-bus.ts`; remove the private `emit()` + ~21 call sites in `base-client.ts`; `EngineContext`/`BaseClientContext`; `index.ts` exports); `packages/ipc-contracts` (remove the event types + `DATASOURCES_CHANNELS.event`); `apps/desktop/src/main` (delete `ipc/datasources/event-bridge.ts`; drop `bus` from the `datasources/engine.ts` singleton + the `index.ts` wiring); `apps/desktop/src/preload` (`index.ts` + `window-api.d.ts`); `apps/desktop/src/renderer` (delete `features/datasources/event-stream.ts`); `services/fs-sync/src/commands/files-download.ts` (swap bus subscription for `onProgress` + handler throttle) and `resolve-client.ts`/`bootstrap.ts`/`handlers.ts` (drop the `engineBus` wiring).
- **Tests**: ~18 files — delete `event-bus.test.ts` + the strategy-emit guard meta-test; transform engine/strategy/factory tests to assert on return/throw; rewire fs-sync download tests onto `onProgress` + throttle/flush assertions; delete the desktop `event-bridge.test.ts` + renderer `event-stream.test.tsx`; trim unused `EngineEventBus` type imports; update `test-d` files for the removed types.
- **Dependencies**: none added.
- **Wire/UX**: unchanged from the renderer's perspective — surviving events (`auth-*`, download progress) still flow via `sync.onEvent`; only the internal source changes.

## Prerequisites

`add-engine-rename-download`, `migrate-upload-orchestration-out-of-engine`, `migrate-engine-retry-policy-to-consumer`, `migrate-engine-cache-invalidation` — all merged. This change enables a bus-free engine; no follow-on depends on the bus surviving.
