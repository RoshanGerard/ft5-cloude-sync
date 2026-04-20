## 1. Package scaffold + contract types

- [x] 1.1 Create workspace package `packages/fs-datasource-engine` with `package.json` (name `@ft5/fs-datasource-engine`), `tsconfig.json` extending the repo base, and `src/index.ts` with empty re-export stubs. Add it to `pnpm-workspace.yaml`.
- [x] 1.2 Add the engine package as a runtime dependency of `apps/desktop` and a type-only dependency on `@ft5/ipc-contracts`. Verify `pnpm -w install` succeeds and workspace resolution works.
- [x] 1.3 RED: add a `test-d.ts` in `packages/ipc-contracts/src/__tests__/datasources-engine.test-d.ts` asserting the existence and shape of the new types (`Target`, `FileEntry<T>`, `FileMetadata<T>`, `PayloadMap`, `DatasourceEvent<T, K>`, `AuthIntent`, `AuthResult`, `Quota`, `StoredCredentials`, `DatasourceErrorTag`).
- [x] 1.4 GREEN: author the types in `packages/ipc-contracts/src/fs-datasource-engine.ts` (or split across focused files) and re-export from the package index. Run `pnpm -C packages/ipc-contracts typecheck` and confirm the test-d suite passes.
- [x] 1.5 RED: add a runtime test for `DatasourceError` covering construction, property presence, `instanceof Error`, and `instanceof DatasourceError`.
- [x] 1.6 GREEN: implement `DatasourceError<T>` class in `packages/ipc-contracts/src/fs-datasource-engine.ts`. Verify the runtime test passes.
- [x] 1.7 Add a `DATASOURCES_CHANNELS.event` entry (string `"datasources:event"`) to the existing `DATASOURCES_CHANNELS` export; update the type-d test for `datasources.ts` to include it.

## 2. Event bus with throttle

- [x] 2.1 RED: write `packages/fs-datasource-engine/src/event-bus.test.ts` covering: (a) non-streaming events deliver immediately, (b) streaming events coalesce at 1-second boundaries, (c) streaming events emit on ≥10% progress delta, (d) terminal events bypass the throttle synchronously, (e) throttle keys are per-`(datasourceId, transactionId)`.
- [x] 2.2 GREEN: implement `EventBus` in `packages/fs-datasource-engine/src/event-bus.ts`. Use `setTimeout` / `queueMicrotask` for scheduling; inject a clock via constructor for tests.
- [x] 2.3 Refactor: extract the coalescing filter into a `StreamingCoalescer` helper if it clarifies the bus. Verify all tests still pass.
- [x] 2.4 Request code review for Phase 2 via `superpowers:requesting-code-review` before proceeding.

## 3. BaseDatasourceClient template

- [x] 3.1 RED: write `packages/fs-datasource-engine/src/base-client.test.ts` against a `FakeDatasourceClient extends BaseDatasourceClient<"fake">` test fixture covering: (a) successful op emits pre + post events in order, (b) failing op emits pre + failed event and throws normalized error, (c) single-flight refresh on 5 concurrent 401s triggers exactly one `refreshToken`, (d) refresh success persists via `CredentialStore.put` before retry, (e) refresh failure emits `token-expired` + `authentication-failed` and throws AuthExpired, (f) strategies cannot emit events directly (grep test over concrete class source).
- [x] 3.2 GREEN: implement `BaseDatasourceClient<T>` in `packages/fs-datasource-engine/src/base-client.ts` with the abstract `doX` surface and concrete `uploadFile` / `deleteFile` / `createFile` / `listDirectory` / `search` / `getMetadata` / `authenticate` / `status` / `testConnection` wrappers. Single-flight mutex is a `Map<datasourceId, Promise<AuthResult>>`.
- [x] 3.3 GREEN: implement `deleteDirectory` as a final method that unconditionally throws `DatasourceError.Unsupported` with `raw: "disabled-for-product-stability"`.
- [x] 3.4 GREEN: implement `getQuota` that consults the injected `ProviderDescriptor.capabilities.quota` flag and throws `Unsupported` with `raw: "not-supported-by-provider"` when false, otherwise delegates to `protected abstract doGetQuota()`.
- [x] 3.5 Refactor: review the event emission boilerplate for duplication; extract a `withEvents(methodName, op)` helper if it eliminates drift. Keep tests green.
- [x] 3.6 Request code review for Phase 3.

## 4. CredentialStore port + SqliteCredentialStore

- [x] 4.1 Author the `CredentialStore` port interface in `packages/fs-datasource-engine/src/credential-store.ts` (abstract, no impl).
- [x] 4.2 RED: write `apps/desktop/src/main/credential-store.test.ts` covering: (a) put + get round-trips, (b) encrypted blob does not contain plaintext credential strings, (c) `safeStorage.isEncryptionAvailable() === false` at construction throws, (d) `schema_version === 1` on writes, (e) delete removes the row.
- [x] 4.3 GREEN: add a Drizzle (or direct) SQLite migration creating `datasource_credentials` with the columns specified in the spec. Wire it into the existing main-process DB init.
- [x] 4.4 GREEN: implement `SqliteCredentialStore` in `apps/desktop/src/main/datasources/sqlite-credential-store.ts` implementing the port. Use `safeStorage.encryptString` / `decryptString` around `JSON.stringify` / `JSON.parse`. Check `isEncryptionAvailable()` in the constructor.
- [x] 4.5 Refactor: review key-rotation extensibility; confirm the `schema_version` tag leaves room for a future re-encryption helper without changing the port.
- [x] 4.6 Request code review for Phase 4.

## 5. ProviderRegistry + ClientFactory

- [x] 5.1 RED: write `packages/fs-datasource-engine/src/factory.test.ts` covering: (a) unknown provider id throws `Unsupported`, (b) known provider id returns a `DatasourceClient<T>` with a `bus` wired to the supplied `EngineContext`, (c) the factory re-uses cached clients for the same `(providerId, datasourceId)` within an `EngineContext` session (or explicitly creates fresh — decide per test rubric).
- [x] 5.2 GREEN: implement `ProviderRegistry` as a `Record<ProviderId, (creds, ctx) => BaseDatasourceClient<any>>` seeded in the engine's index file. Implement `ClientFactory.create` on top.
- [x] 5.3 Register placeholder factory stubs for all three providers (tests pass against `FakeDatasourceClient` instances until Phases 6–8 replace them).
- [x] 5.4 Request code review for Phase 5.

## 6. S3Client strategy

- [x] 6.1 Add `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` as dependencies of `packages/fs-datasource-engine`. Justify in `design.md` (already done under Decision 1 / Impact).
- [x] 6.2 RED: write `packages/fs-datasource-engine/src/strategies/s3-client.test.ts` against `@aws-sdk/client-mock` covering: list (prefix query), upload (multipart), delete, getMetadata (HeadObject), search (prefix + client-side filter), authenticate (credentials-form intent), `refreshToken` (no-op for AWS static creds), `normalizeError` for each error tag, and `getQuota` throws `Unsupported`.
- [x] 6.3 GREEN: implement `S3Client extends BaseDatasourceClient<"amazon-s3">` with the abstract method set. Use `Upload` from `@aws-sdk/lib-storage` for streaming. Path targets map to `Key`; handles are the same as paths for S3 (but still populated explicitly so callers can interchange).
- [x] 6.4 RED: add a contract-suite test that runs the shared `strategy-contract.test.ts` scenarios (list → returns entries, upload → emits correct events, delete-directory → throws Unsupported, etc.) against `S3Client`.
- [x] 6.5 GREEN: make the contract suite pass for `S3Client`.
- [x] 6.6 Wire `S3Client` into `ProviderRegistry`, replacing its placeholder stub. Factory test from 5.1 now returns a real `S3Client` for `"amazon-s3"`.
- [x] 6.7 Request code review for Phase 6.

## 7. OneDriveClient strategy

- [x] 7.1 Add `@microsoft/microsoft-graph-client` as a dependency of the engine package.
- [x] 7.2 RED: write `packages/fs-datasource-engine/src/strategies/onedrive-client.test.ts` against a Graph-client mock covering: list (by path and by drive-item-id handle), upload (resumable-session for >4MB, simple PUT for smaller), delete, getMetadata, search (Graph search endpoint), authenticate (OAuth intent), `refreshToken`, `normalizeError` for Graph error codes, and `getQuota` against `/me/drive` quota.
- [x] 7.3 GREEN: implement `OneDriveClient extends BaseDatasourceClient<"onedrive">`. Maintain an internal LRU path↔driveItemId cache invalidated on `deleted` / `file-created` emissions.
- [x] 7.4 Run the shared contract suite against `OneDriveClient`. Make it pass.
- [x] 7.5 Wire into `ProviderRegistry`; Factory test now returns a real client for `"onedrive"`.
- [x] 7.6 Request code review for Phase 7.

## 8. GoogleDriveClient strategy

- [x] 8.1 Add `googleapis` as a dependency of the engine package.
- [x] 8.2 RED: write `packages/fs-datasource-engine/src/strategies/googledrive-client.test.ts` covering: list (files.list by `parents in`), upload (resumable), delete, getMetadata, search (Drive Query), authenticate (OAuth intent), `refreshToken`, `normalizeError` for Drive error shapes, and `getQuota` against `about.get`.
- [x] 8.3 GREEN: implement `GoogleDriveClient extends BaseDatasourceClient<"google-drive">`. Path→fileId resolution walks `files.list` with `orderBy: "createdTime asc"` and a `name='<seg>' and '<parent>' in parents and trashed=false` filter at each path segment; results are cached in the LRU. Path ambiguity (two files same name in the same parent) surfaces via `providerMetadata.ambiguous = true` plus `providerMetadata.ambiguousSiblings` listing the other fileIds — the chosen entry is the oldest by createdTime, and siblings remain reachable via handle-form `Target`. Strategies do not emit events for this; ambiguity is data attached to the entry, not an operation-lifecycle signal.
- [x] 8.4 Run the shared contract suite against `GoogleDriveClient`. Make it pass.
- [x] 8.5 Wire into `ProviderRegistry`; Factory test now returns a real client for `"google-drive"`.
- [x] 8.6 Request code review for Phase 8.

## 9. IPC handler rewiring + datasource-registry persistence

Scope decisions (2026-04-20): (A) `files/*` handlers are deferred — they live on the `ui-file-explorer` branch and the engine lacks `rename` / `download` primitives. Cross-change note captured in `design.md`. (B) Phase 9 owns the first real main-process DB open: `better-sqlite3` database + migration runner. (C) A persistent `datasources` table replaces the in-memory `store.ts` fixture; management handlers (`list`, `add`, `remove`, `action`) become DB-backed.

### 9a. Main-process DB + migration runner

- [x] 9.1 RED: write `apps/desktop/src/main/db/database.test.ts` covering: (a) DB opens at `app.getPath("userData")/ft5.db`, (b) missing directory is created automatically, (c) migrations run in order on startup, (d) re-opening the same file does not re-run a migration, (e) `openDatabase(":memory:")` works for tests.
- [x] 9.2 GREEN: implement `apps/desktop/src/main/db/database.ts` exporting `openDatabase(pathOrMemory): Database` and `runMigrations(db, migrations): void`. Use `better-sqlite3` (already a dep of `SqliteCredentialStore`).
- [x] 9.3 GREEN: add migration `0001_datasource_credentials` matching the existing `datasource_credentials` schema from `SqliteCredentialStore`; confirm the store keeps working when its DB is pre-migrated by the shared runner instead of its own inline migration.
- [x] 9.4 GREEN: add migration `0002_datasources` creating table `datasources (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, display_name TEXT NOT NULL, item_count INTEGER, last_sync_at INTEGER, status TEXT NOT NULL, error_reason TEXT, paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`.
- [x] 9.5 GREEN: wire `openDatabase(app.getPath("userData")/ft5.db)` + migrations into `main/index.ts` before handler registration; construct `SqliteCredentialStore(db)` from the shared handle.

### 9b. DB-backed datasource registry (replaces `store.ts`)

- [ ] 9.6 RED: write `apps/desktop/src/main/datasources/registry.test.ts` covering: (a) `list()` returns all rows mapped to `DatasourceSummary`, (b) `add(summary)` inserts with created_at/updated_at stamps, (c) `remove(id)` deletes the row AND calls `credentialStore.delete(id)`, (d) `setPaused(id, paused)` flips the flag, (e) `setStatus(id, status, errorReason?)` updates status columns without touching `paused`.
- [ ] 9.7 GREEN: implement `apps/desktop/src/main/datasources/registry.ts` exporting `DatasourceRegistry` class wrapping the DB + credential-store. Use prepared statements.
- [ ] 9.8 Refactor: delete `apps/desktop/src/main/ipc/datasources/store.ts` (in-memory fixture). Update any imports.

### 9c. EngineContext singleton + feature flag

- [ ] 9.9 GREEN: wire a singleton `EngineContext` (bus + credential store) in `main/index.ts` after DB init; expose via `getEngine()` accessor at `apps/desktop/src/main/datasources/engine.ts`. Document the lazy-init choice inline.

### 9d. Datasources IPC handlers → registry + engine

- [ ] 9.10 RED: update handler tests at `apps/desktop/src/main/ipc/datasources/__tests__/*.test.ts` to spy on `ClientFactory.create`, the returned client methods, and `DatasourceRegistry`. Assert: (a) `list` forwards to `registry.list()`, (b) `add` inserts via registry and persists creds, (c) `remove` deletes from registry (which cascades to credential-store), (d) `action: "pause" | "resume"` flips `registry.setPaused`, (e) `action: "sync-now"` — behaviour TBD below, (f) `upload` resolves the provider via the registry and calls `client.uploadFile(parent, file)` with a path-form `Target`.
- [ ] 9.11 GREEN: rewrite `datasources/*.ts` handler bodies. Keep the legacy fixture code behind `if (!process.env.DATASOURCE_ENGINE_LIVE) return fixtureResponse(...)`; flip the flag for test runs. `action: "sync-now"` maps to `client.status()` (refreshes the DatasourceSummary's `itemCount` / `lastSyncAt` via registry update) for this phase — a proper sync queue is a follow-up change.

### 9e. Grep guardrail

- [ ] 9.12 RED: add a Vitest grep test asserting no file under `apps/desktop/src/main/ipc/` imports `googleapis`, `@microsoft/microsoft-graph-client`, or `@aws-sdk/client-s3` directly. Ensure it passes.

### 9f. Review

- [ ] 9.13 Request code review for Phase 9.

## 10. Event bridge IPC

- [ ] 10.1 Add `DATASOURCES_CHANNELS.event === "datasources:event"` to `packages/ipc-contracts/src/datasources.ts`. Update the existing `datasources.test-d.ts` to assert its presence.
- [ ] 10.2 RED: write a test for the main-process event forwarder that subscribes to `EngineContext.bus`, serializes events via structured-clone, and calls `BrowserWindow.webContents.send` for each active window. Cover (a) per-window broadcast, (b) dead windows are cleaned up, (c) structured-clone of `DatasourceError.raw` strips functions.
- [ ] 10.3 GREEN: implement the forwarder in `apps/desktop/src/main/ipc/datasources/event-bridge.ts`; wire it into the main-process entrypoint after `EngineContext` construction.
- [ ] 10.4 RED: write a preload test asserting `window.api.datasources.onEvent(cb)` delivers events over `DATASOURCES_CHANNELS.event` and returns an unsubscribe function.
- [ ] 10.5 GREEN: add the `onEvent` binding to the preload's `contextBridge.exposeInMainWorld` surface. Type it using `DatasourceEvent<T, K>` from `ipc-contracts`.
- [ ] 10.6 RED: write a renderer integration test (Vitest + `@testing-library`) subscribing via `window.api.datasources.onEvent(cb)` and asserting narrowed payload types under `switch (e.datasourceType)`.
- [ ] 10.7 GREEN: add a tiny wrapper in `apps/desktop/src/renderer/src/features/datasources/event-stream.ts` that exports a typed `useDatasourceEvents(cb)` React hook built on `onEvent`.
- [ ] 10.8 Request code review for Phase 10.

## 11. Integration, cross-change note, verification

- [ ] 11.1 Add an integration smoke test at `apps/desktop/src/main/ipc/__tests__/engine-smoke.test.ts` that drives a full upload round-trip against the `S3Client` (backed by `@aws-sdk/client-mock`): handler call → engine call → mock response → event bus → IPC forward → renderer callback invocation. Assert event ordering.
- [ ] 11.2 Update `openspec/changes/ui-file-explorer/design.md` with a short cross-change note: "The real provider-backed handlers referenced here are delivered by change `add-fs-datasource-engine`; no contract conflict — the engine is called by these handlers, not a replacement for their `ipc-contracts` types."
- [ ] 11.3 Run `pnpm -w typecheck`, `pnpm -w lint`, and `pnpm -w test` in the worktree. Confirm all pass.
- [ ] 11.4 Run `openspec validate add-fs-datasource-engine --strict` and resolve any reported issues.
- [ ] 11.5 Manually exercise the feature flag path with `DATASOURCE_ENGINE_LIVE=1 pnpm -C apps/desktop dev`: add a mock S3 datasource (access-key form), trigger a list, observe a `status-changed` or `file-created` event in the renderer DevTools, and confirm no crash / no regressions in the dashboard.
- [ ] 11.6 Request the final code review via `superpowers:requesting-code-review` with a consolidated summary of the full engine surface before moving to `/opsx:archive`.

## 12. Open-question resolution (before archive)

- [ ] 12.1 Concurrency: decide whether per-datasource mutation queues land in this change or a follow-up. If follow-up, capture a TODO in `design.md`'s Open Questions and leave the code path non-serialized for now.
- [ ] 12.2 Event replay: confirm the "late subscriber sees only future events" policy and add a renderer-side test verifying a terminal event is still delivered if subscribe happens after upload-start but before upload-completion.
- [ ] 12.3 Cancellation: file a follow-up OpenSpec change proposal stub named `add-fs-engine-cancellation` and reference it from `design.md`'s Open Questions. Do NOT implement cancellation in this change.
- [ ] 12.4 `authentication-failed` payload: decide whether the payload carries the full `DatasourceError` or only a reason string. Update `specs/fs-datasource-engine/spec.md` to reflect the decision before archive.
