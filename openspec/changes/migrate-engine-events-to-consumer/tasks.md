# Tasks: Remove the engine `EventBus`; consumers own event emission

> Applied under a worktree, TDD per slice, subagent-per-task with code review between slices. Slice 1 is deliberately first: it relocates the download-progress throttle (the one behavioral risk) and proves it green BEFORE the engine bus — the current throttle source — is removed.

## 1. fs-sync download handler: consume `onProgress`, relocate throttle (Decision 2)

- [x] 1.1 Write failing tests in `services/fs-sync/src/commands/__tests__/files-download.test.ts` for handler-owned progress throttling: (a) raw `onProgress` ticks are coalesced to at most one `downloading` IPC emit per 1s OR 10% delta; (b) the final pending progress is flushed as a `downloading` BEFORE the terminal `file-downloaded` emit; (c) no `downloading` is emitted after the terminal event. Drive progress by invoking the `onProgress` passed to a fake `engine.downloadFile`, NOT via an engine bus.
- [x] 1.2 Implement a small handler-local progress coalescer (1s OR 10% delta; flush-pending-on-terminal) in `files-download.ts`. Do NOT extract a shared util (YAGNI — download is the only streaming consumer; Risk note in design).
- [x] 1.3 Replace the `deps.engineBus.subscribe(...)` block (`files-download.ts:753`) with an `onProgress` callback passed into `engine.downloadFile(target, { …, onProgress })`. Route registry `bytesDownloaded` updates and the `downloading` IPC emit through the coalescer; preserve the Decision-17d contentLength-preservation rule and the `inflightId` re-claim guard. (As-built: registry write stays PER-TICK — only the `downloading` IPC emit is throttled, per Decision 2; the emit + registry both use ABSOLUTE bytes `effectiveRangeStart + loaded` so they agree on resume cycles.)
- [x] 1.4 Remove the `engineBus` dependency from the download handler wiring: `EngineBusSubscriber` interface + `engineBus` params in `files-download.ts`, `handlers.ts` (the `deps.engineBus &&` gate + factory dep), and `bootstrap.ts` (drop the `engineBus` pass to `buildCommandHandlers`). NOTE (slice boundary): `resolve-client.ts` (`ResolveClientDeps.engineBus`) and `bootstrap`'s `createEngineEventBus()` are NOT removed in slice 1 — they still feed `EngineContext.bus`; that removal is slice 2 (engine bus removal + `EngineContext`). The engine clients are still constructed with `{ bus, credentialStore }` until then.
- [x] 1.5 Run the fs-sync suite; confirm download progress/terminal behavior green with the bus gone from fs-sync. (73 files / 556 tests pass, 9 skipped; fs-sync `tsc -b` clean.)

## 2. Engine: remove the `EventBus` (Decision 1)

- [ ] 2.1 Update the engine guard/contract tests first (red): replace "only base-client emits" with "no `.emit(`/`this.bus`/`ctx.bus`/`EventBus`/`createEventBus` anywhere in `packages/fs-datasource-engine/src`"; assert `EngineContext` is `{ credentialStore }`.
- [ ] 2.2 Remove the private `emit()` (`base-client.ts:1094-1108`) and all ~21 call sites (status/auth/token/delete/rename/download emissions). For `downloadFile`, remove `emitDownloading`'s bus emit and the terminal `emitTerminal` bus logic (`base-client.ts:806-858`); KEEP the strategy→`options.onProgress` invocation. Re-evaluate whether `activeDownloads`/`recordProgress` can be deleted once terminal bus emissions are gone.
- [ ] 2.3 Remove the `bus` field from `BaseClientContext` (`base-client.ts:268-272`) and `EngineContext` (`factory.ts:88-91`); update `factory.create`/`createForAuth` and the per-create context assembly to `{ credentialStore }`.
- [ ] 2.4 Delete `packages/fs-datasource-engine/src/event-bus.ts`; remove `createEventBus`/`EventBus`/`EventBusOptions`/`Clock`/`ClockTimer` from `index.ts`.
- [ ] 2.5 Fix the stale OneDrive class-header comment (`onedrive-client.ts:41-45`, "a strategy MAY subscribe — and we do") to reflect no subscription / no bus.
- [ ] 2.6 `pnpm --filter @ft5/fs-datasource-engine test` green.

## 3. ipc-contracts: remove the event types + channel (Decisions 1, 4)

- [ ] 3.1 Grep-verify no surviving production importer, then remove `DatasourceEvent`, `AnyDatasourceEvent`, `PayloadMap`, `CanonicalEventPayloads` from `packages/ipc-contracts/src/fs-datasource-engine.ts` and their re-exports in `index.ts`.
- [ ] 3.2 Remove `DATASOURCES_CHANNELS.event` (`datasources:event`) from `packages/ipc-contracts/src/datasources.ts`.
- [ ] 3.3 Update `packages/ipc-contracts/src/__tests__/datasources-engine.test-d.ts` for the removed types; `pnpm --filter @ft5/ipc-contracts test` green.

## 4. Desktop + preload + renderer: delete the dead datasources event path (Decision 4)

- [x] 4.1 Delete `apps/desktop/src/main/ipc/datasources/event-bridge.ts` and its test `__tests__/event-bridge.test.ts`.
- [x] 4.2 Remove the `createEventBridge` wiring in `apps/desktop/src/main/index.ts:254-262`. (Surgical: the block was interleaved with the surviving `syncEventBridge` registerWindow/dispose lines; removed only the datasources-bridge import + comment + creation + registerWindow + its dispose line, kept the sync bridge. Also dropped the now-unused `getEngine` import + a stale "bus +" comment.)
- [x] 4.3 Remove the `bus`/`createEventBus` from the desktop `Engine` singleton (`apps/desktop/src/main/datasources/engine.ts:37,69` + the `bus` field on `Engine`); update `engine.test.ts`. (Also updated the module header + `initEngine` doc comments that described "the shared EventBus".)
- [x] 4.4 Remove `window.api.datasources.onEvent` from preload `index.ts:155-168` and both type decls (`apps/desktop/src/preload/window-api.d.ts` + `apps/desktop/src/renderer/src/types/window-api.d.ts`); update `preload/__tests__/window-api.types.test-d.ts` + `exposed-api.test.ts`. (Dropped the now-unused `AnyDatasourceEvent`/`DatasourceEvent` imports from preload index + both .d.ts + both tests. Replaced the removed type-d `onEvent` test with an absence assertion; added an absence assertion to `exposed-api.test.ts`. Updated three stale precedent comments that referenced `datasources.onEvent`.)
- [x] 4.5 Delete the renderer hook `apps/desktop/src/renderer/src/features/datasources/event-stream.ts` and its test `__tests__/event-stream.test.tsx`.
- [x] 4.6 `pnpm --filter @ft5/desktop test` green; renderer build clean. (Ran `vitest run apps/desktop/src`: 157 files / 1305 tests passed, Type Errors: no errors — vitest's typecheck pass covers the `.test-d.ts` surface tests. `tsc -b apps/desktop/tsconfig.json` clean. The full preload-bundle/render-budget gates run later per slice scope.)

## 5. Engine/strategy/factory test sweep (transform bus assertions)

- [ ] 5.1 DELETE `packages/fs-datasource-engine/src/event-bus.test.ts` (tests the removed component).
- [ ] 5.2 Transform `base-client.test.ts`: replace the `collect(bus)` helper + emission assertions with return-value / thrown-error assertions; delete the strategy-emit guard meta-test (`:2089-2106`).
- [ ] 5.3 Transform strategy tests (`s3-client`/`googledrive-client`/`onedrive-client`.test.ts + `*-preauth.test.ts`): drop `createEventBus`/`bus.subscribe`; assert outcomes via return/throw.
- [ ] 5.4 Transform factory tests (`factory.test.ts`, `factory-create-for-auth.test.ts`, `factory-invalid-datasource.test.ts`): drop `bus` from the test `EngineContext`.
- [ ] 5.5 Clean up unused `EngineEventBus`/`fakeEngineBus` type imports in fs-sync: `authenticate-*.test.ts`, `oauth/__tests__/loopback-broker*.test.ts`, `main/__tests__/resolve-client.test.ts`, and the `makeEngineBus()` fakes in `downloads-list-active.test.ts` + `__integration__/download-conflict.test.ts`.

## 6. Verification + spec sync (Decision 7)

- [ ] 6.1 Full repo suite: `pnpm abi:node` + `pnpm --filter @ft5/desktop build` + `pnpm test` — green (modulo the documented `authenticate-flow` S3 `vi.mock` main-checkout env flake, which this change does not touch).
- [ ] 6.2 `pnpm -w typecheck` (tsc -b) + lint clean across touched packages.
- [ ] 6.3 `openspec validate migrate-engine-events-to-consumer --strict` green.
- [ ] 6.4 Advisor checkpoint #2 (before declaring done / before archive) — verify the implementation matches the design and no observable behavior regressed.
- [ ] 6.5 During `/opsx:sync`/archive: also correct the `fs-datasource-engine` spec `## Purpose` prose (drop "the typed event bus with its streaming-throttle semantics" and "wraps every operation with event emission"), then per-cap validate all four touched capabilities: `openspec validate fs-datasource-engine --type spec`, `datasources-ui`, `fs-sync-service`, `fs-sync-supervisor` — all green.
