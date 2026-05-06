# Tasks: `migrate-upload-orchestration-out-of-engine`

## 0. Prerequisites — `/opsx:apply` is unblocked

No blocking prerequisites. `add-engine-rename-download` (the orchestration template) merged 2026-04-29.

- [x] 0.1 Pre-apply staleness check on `design.md` file paths and function names per CLAUDE.md `## Workflow` step 5 [Verified 2026-05-06: download templates all exist as design.md predicts; `UploadJobExecutor` lives at `services/fs-sync/src/executors/upload.ts` (not `scheduler/executors/upload-job-executor.ts`) — tasks.md §11.1 already noted "or wherever it lives"; 41 files reference `sync:enqueue-upload` (confirms §7.4 + §11 chunk-E scope).]

## 1. Engine — `BaseDatasourceClient.uploadFile` reshape

- [x] 1.1 Update `BaseDatasourceClient.uploadFile` in `packages/fs-datasource-engine/src/base-client.ts` to the one-shot signature: `uploadFile(parent, file, options?: { signal?: AbortSignal; onProgress?: (loaded, total) => void }): Promise<DatasourceFileEntry<T>>`. Body becomes `return this.withRefresh(() => this.doUploadFileImpl(parent, file, options ?? {}))`.
- [x] 1.2 Delete the `activeUploads: Map<...>` field, `UploadTracker` interface, and any internal `newTransactionId`-for-upload helper from `BaseDatasourceClient`.
- [x] 1.3 Delete `BaseDatasourceClient.cancelUpload` method entirely (including its public declaration on `DatasourceClient<T>` and JSDoc).
- [x] 1.4 Remove all upload-related `this.emit(...)` calls from `BaseDatasourceClient` (`uploading`, `file-created`-via-upload, `upload-failed`, `upload-cancelled`).
- [x] 1.5 Update the `protected abstract doUploadFileImpl` signature: drop the `register` parameter; new shape `(parent: Target, file: { path; name?; mimeType? }, options: { signal?: AbortSignal; onProgress?: (l, t) => void }): Promise<DatasourceFileEntry<T>>`.
- [x] 1.6 Update comments in `base-client.ts` (currently reference `cancelUpload`, `activeUploads`, the tracker pattern) to reflect the new architecture.

## 2. Engine — `createFile` deletion

- [x] 2.1 Delete `BaseDatasourceClient.createFile` method (including its public declaration on `DatasourceClient<T>` and JSDoc).
- [x] 2.2 Delete `protected abstract doCreateFileImpl` from `BaseDatasourceClient`.
- [x] 2.3 Delete `GoogleDriveClient.doCreateFileImpl` from `packages/fs-datasource-engine/src/strategies/googledrive-client.ts`.
- [x] 2.4 Delete `OneDriveClient.doCreateFileImpl` from `packages/fs-datasource-engine/src/strategies/onedrive-client.ts`.
- [x] 2.5 Delete `S3Client.doCreateFileImpl` from `packages/fs-datasource-engine/src/strategies/s3-client.ts`.
- [x] 2.6 Sweep all `createFile` references in comments across `base-client.ts`, the three strategy files, and `packages/ipc-contracts/src/fs-datasource-engine.ts`. Delete or rephrase to remove the `createFile` mention.
- [x] 2.7 Delete createFile-related test cases: `base-client.test.ts` (tests around line 545 + the abstract `doCreateFileImpl` mock around line 236), `s3-client.test.ts` (lines ~487, 509, 533), `onedrive-client.test.ts` (line ~1272). Verify no other test files reference `createFile`.
- [x] 2.8 Run the engine test suite — confirm createFile-deletion didn't leave dangling references; the test surface SHALL pass with the deletions.

## 3. Engine — Google Drive strategy

- [x] 3.1 Update `GoogleDriveClient.doUploadFileImpl` signature in `packages/fs-datasource-engine/src/strategies/googledrive-client.ts` to the new shape (drop `register`, drop `onProgress` and `signal` from positional params, accept `options` object instead).
- [x] 3.2 Inside `doUploadFileImpl`, after the resumable-session URL is acquired: register `options.signal?.addEventListener('abort', cleanup, { once: true })`. The `cleanup` closure issues `fetch(sessionUrl, { method: "DELETE", headers: { "Content-Range": "bytes */*" }, signal: AbortSignal.timeout(5000) })` and `.catch()` logs the failure. NOT the user's signal.
- [x] 3.3 Forward `options.signal` directly into the chunked PUT calls so abort unblocks promptly.
- [x] 3.4 Forward `options.onProgress?` to the existing per-chunk progress hook.
- [x] 3.5 Inside the success branch (after the strategy's resumable-session completes and returns the `DatasourceFileEntry<"google-drive">`), invoke `this.pathHandleCache.set(entry.path, entry.handle)` directly — replaces the prior `file-created` bus emission as the LRU population mechanism.
- [x] 3.6 In the strategy's constructor, drop the `else if (e.event === "file-created")` arm of the bus subscription. Keep the `deleted` arm.
- [x] 3.7 Remove the helper-shared `noopRegister` and `neverAborted` constants if they are exclusively for the deleted createFile path. Otherwise keep them (the helper itself stays untouched).
- [x] 3.8 Update `googledrive-client.test.ts` cancel-related tests (around line 1839+) to assert signal-driven cleanup: aborting the user signal triggers a DELETE on a fresh AbortController; the DELETE itself does NOT abort if the user signal cleans up later.
- [x] 3.9 Update `googledrive-client.test.ts` upload tests (around line 1700+) to assert NO `file-created` bus emission; LRU population is observable via `pathHandleCache.get(entry.path) === entry.handle` post-resolve.

## 4. Engine — OneDrive strategy

- [x] 4.1 Update `OneDriveClient.doUploadFileImpl` signature in `packages/fs-datasource-engine/src/strategies/onedrive-client.ts` (drop `register`, accept `options`).
- [x] 4.2 For the resumable-session path (>4 MiB): register `options.signal?.addEventListener('abort', cleanup, { once: true })` with cleanup issuing `fetch(uploadUrl, { method: "DELETE", signal: AbortSignal.timeout(5000) })`.
- [x] 4.3 For the small-file `<= 4 MiB` `PUT /content` path: forward `options.signal` to the underlying fetch. If signal aborts post-resolve (the SDK's `.put()` may not honor abort cleanly), branch on `options.signal?.aborted` and reject with `DatasourceError { tag: "cancelled" }`. Match the existing "non-cancellable upload path" behavior.
- [x] 4.4 Forward `options.onProgress?` to the chunk-PUT progress hooks (resumable path) or the SDK's progress callback (small path).
- [x] 4.5 Inside the success branch: invoke `this.pathHandleCache.set(entry.path, entry.handle)` directly.
- [x] 4.6 In the constructor, drop the `else if (e.event === "file-created")` arm of the bus subscription (line ~442).
- [x] 4.7 Update `onedrive-client.test.ts` cancel-related tests (around line 957+) to assert signal-driven cleanup with fresh AbortController + 5s timeout.
- [x] 4.8 Update `onedrive-client.test.ts` upload tests (around line 737+) to assert NO `file-created` bus emission; LRU population observable directly.
- [x] 4.9 Verify OneDrive's small-file path's "non-cancellable" semantics still work end-to-end (test the post-resolve abort branch).

## 5. Engine — S3 strategy

- [x] 5.1 Update `S3Client.doUploadFileImpl` signature in `packages/fs-datasource-engine/src/strategies/s3-client.ts` (drop `register`, accept `options`).
- [x] 5.2 For the `@aws-sdk/lib-storage` `Upload` path: register `options.signal?.addEventListener('abort', () => upload.abort(), { once: true })`. The `Upload.abort()` issues `AbortMultipartUploadCommand` internally — no need for a fresh AbortController on the cleanup side because `Upload` manages its own controller.
- [x] 5.3 Forward `options.onProgress?` to the existing `httpUploadProgress` event subscription.
- [x] 5.4 The `_signal: AbortSignal` ignored parameter is removed. Replace with `options.signal` use throughout the body.
- [x] 5.5 Inside the success branch: invoke `this.pathHandleCache.set(entry.path, entry.handle)` directly (S3 strategy LRU mirrors Drive's pattern; verify the cache field exists and is wired). [No-op: S3 has no `pathHandleCache` field — verified via grep.]
- [x] 5.6 If S3's strategy has a similar bus subscription pattern for `file-created` invalidation, drop the upload arm and keep deletion. (Drive and OneDrive have the bus subscription; verify whether S3 mirrors it — if so, same treatment.) [No-op: S3 has no bus subscription — verified via grep.]
- [x] 5.7 Update `s3-client.test.ts` cancel-related tests (around line 582+) to assert signal-driven `upload.abort()` triggering.
- [x] 5.8 Update `s3-client.test.ts` upload tests (around line 484+) to assert NO `file-created` bus emission.

## 6. Engine — strategy-contract test

- [x] 6.1 Update `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` to remove the `cancelUpload` method check (line ~390+). [Chunk B + Chunk C]
- [x] 6.2 Update the upload contract scenario (line ~283+) — replace "emits uploading → file-created" assertion with "resolves with the entry; no upload-related bus events fire". Include LRU population assertion. [Chunk C]
- [x] 6.3 Add a contract scenario asserting AbortSignal-driven cancel: every strategy aborts its underlying provider call when `options.signal` aborts; cleanup HTTP is issued where applicable; reject is `DatasourceError { tag: "cancelled" }`. [Chunk C — added `primeUploadCancellable` + `observedFreshCancelCleanup` hooks; Drive/OneDrive verify DELETE on session URL with non-user signal; S3 spies on `Upload.prototype.abort`.]
- [x] 6.4 Remove the `createFile` scenario from the strategy-contract suite (find via grep on `createFile` in the file). [Chunk A removed; Chunk C verified — only references are in the new shrunk-interface assertion (Task 6.5).]
- [x] 6.5 Update the `assignable to DatasourceClient<...>` interface check — the interface no longer has `createFile` or `cancelUpload`; the test should reflect the shrunk surface. [Chunk C — added explicit type-level assertion that `keyof DatasourceClient<DatasourceType>` excludes both `createFile` and `cancelUpload`.]

## 7. IPC contracts

- [x] 7.1 Update `packages/ipc-contracts/src/files.ts` `FilesUploadValue.jobId` JSDoc — clarify that the field is now the service-minted `uploadJobId` (was specified but unused). [Chunk C]
- [x] 7.2 Add `UploadsListActiveCommand` to `packages/ipc-contracts/src/sync-service/commands.ts` (mirror `DownloadsListActiveCommand` shape). [Chunk C — added `UploadJob` wire shape, `UploadsListActiveRequest`, `UploadsListActiveResponse`, `UploadsListActiveCommand`, registered in `CommandMap` + `COMMAND_NAMES`.]
- [x] 7.3 Add `SyncCancelUploadCommand` to `packages/ipc-contracts/src/sync-service/commands.ts` (mirror `SyncCancelDownloadCommand`: params `{ uploadJobId }`, result `{ cancelled: boolean }`). [Chunk C]
- [x] 7.4 Remove `SyncEnqueueUploadCommand` from the same file. [Chunk F — `EnqueueUploadCommand` interface removed; tombstone in `commands.ts`. `CommandMap`'s `"sync:enqueue-upload"` entry removed; `COMMAND_NAMES` entry removed. Test-d files updated: `commands.test-d.ts` (Expected union shrunk + new `HasEnqueueUpload extends false` invariant test), `authenticate-onboarding.test-d.ts` (Expected union shrunk), `requests.test-d.ts` (the `enqueueUpload request/response` describe block deleted with tombstone). Cascade: `SyncEnqueueUploadRequest` + `SyncEnqueueUploadResponse` removed from `sync-service-desktop/requests.ts`; barrel re-exports trimmed; `SYNC_CHANNELS.enqueueUpload` constant removed from `channels.ts`; `channels.test-d.ts` adds explicit absence assertion + key-list test updated. Downstream live consumers cleaned in lockstep — see §11 below.]
- [x] 7.5 Update `packages/ipc-contracts/src/datasources.ts` — remove the `DatasourcesUploadProgressEvent` shape and its preload binding declaration. [Chunk E — `DatasourcesUploadProgressEvent` removed; `DATASOURCES_CHANNELS.uploadProgress` channel constant removed; legacy `onUploadProgress` preload binding removed; corresponding test in `datasources.test-d.ts` flipped to assert REMOVAL.]
- [x] 7.6 Update `packages/ipc-contracts/src/fs-datasource-engine.ts` — remove the `upload-cancelled` event entry from `CanonicalEventPayloads`; remove the `UploadCancelReason` union; remove the `transactionId` keying from upload-related types. [Chunk E — `"upload-cancelled"` slot removed from `CanonicalEventPayloads`; `UploadCancelReason` + engine-bus `UploadCancelledPayload` exports removed; barrel re-exports updated. The `cancelled` tag in `DatasourceErrorTag` is RETAINED — strategies still reject with it on AbortSignal cancellation.]
- [x] 7.7 Update `packages/ipc-contracts/src/__tests__/datasources-engine.test-d.ts` — assert the shrunk PayloadMap (no `uploading`, `file-created`-via-upload, `upload-failed`, `upload-cancelled` for upload paths). The `cancelled` tag is RETAINED in `DatasourceErrorTag` for signal-driven uploads. [Chunk E — `Canonical` enumeration shrunk to 16 names (was 17); added explicit `"upload-cancelled" extends keyof PayloadMap[T]` ⇒ `never` guard tests for all three providers; legacy upload-cancelled payload-shape test removed.]
- [x] 7.8 Add type tests for the new `UploadsListActiveCommand` and `SyncCancelUploadCommand` shapes (mirror existing download command type-tests). [Chunk C — new file `packages/ipc-contracts/src/sync-service/__tests__/uploads-commands.test-d.ts` (15 tests); `requests.test-d.ts` adds `cancelUpload` + `uploadsListActive` round-trip assertions; `commands.test-d.ts` + `authenticate-onboarding.test-d.ts` `Expected` unions extended.]
- [x] 7.9 Update preload `apps/desktop/src/preload/index.ts` (or equivalent): remove `window.api.datasources.onUploadProgress`; add `window.api.uploads.listActive`, the cancel binding, and the upload-event subscription on `sync:event-stream`. [Chunk C added the additive bindings; Chunk E removes `window.api.datasources.onUploadProgress` and adds `window.api.files.onActiveUploadsHydrate` (the symmetric upload-side hydrate channel parallel to download). The upload-event subscription on `sync:event-stream` happens INSIDE the renderer's `createUploadJobToaster` (filtered to the four upload event kinds) — preload doesn't need a dedicated `sync.onUploadEvent` because it already exposes a generic `sync.onEvent` that the toaster filters client-side. `DatasourcesUploadProgressEvent` import dropped from preload + window-api type files; `onActiveUploadsHydrate(callback: (jobs: readonly UploadJob[]) => void)` added.]

## 8. Service — `UploadRegistry` module

- [x] 8.1 Create `services/fs-sync/src/uploads/registry.ts` with `UploadJobEntry` interface and `UploadRegistry` interface (`set`, `get`, `update`, `delete`, `snapshot`, `findByTarget`).
- [x] 8.2 Implement the registry as a class with a forward `Map<uploadJobId, UploadJobEntry>` and a reverse-index `Map<string, string>` keyed `${datasourceId}::${targetPath}` → `uploadJobId`.
- [x] 8.3 Both indexes update atomically on `set` and `delete` (no reverse-index leak on rapid set/delete cycles).
- [x] 8.4 `snapshot()` returns a fresh array (no shared reference); mutations to the returned array don't affect later snapshots.
- [x] 8.5 Create `services/fs-sync/src/uploads/__tests__/registry.test.ts` covering: set + get + delete; reverse-index hit-after-set, miss-after-delete; concurrent set/delete atomicity; snapshot immutability.

## 9. Service — `files:upload` handler

- [x] 9.1 Create `services/fs-sync/src/commands/files-upload.ts` mirroring `files-download.ts` shape.
- [x] 9.2 Validate `sourcePath` is absolute, `targetPath` is syntactically valid; reject with `tag: "other"` on validation failure.
- [x] 9.3 Check `registry.findByTarget(datasourceId, targetPath)` — if hit, reject with `tag: "conflict"` payload `{ existingUploadJobId, targetPath }` BEFORE engine call.
- [x] 9.4 Mint `uploadJobId = crypto.randomUUID()`; create `AbortController`; insert `UploadJobEntry` into registry.
- [x] 9.5 Resolve `DatasourceClient<T>` via `ClientFactory.create(datasourceId)`. [Implemented via the same `resolveClient` dependency the download handler uses — `services/fs-sync/src/main/resolve-client.ts` wraps the factory.]
- [x] 9.6 Invoke `await client.uploadFile(target, file, { signal: abortController.signal, onProgress: <emit-throttled-uploading> })`.
- [x] 9.7 `onProgress` callback updates registry entry's `bytesUploaded` and `contentLength`; emits `uploading` on `sync:event-stream` with throttle (1s OR 10% delta).
- [x] 9.8 On engine resolve: emit `file-created` on `sync:event-stream`; delete registry entry; reply `{ uploadJobId }`.
- [x] 9.9 On engine reject `tag === "cancelled"`: emit `upload-cancelled`; delete registry entry; reply with cancelled error (mirror download handler's cancel reply convention).
- [x] 9.10 On engine reject other tag: emit `upload-failed`; delete registry entry; reply with normalized error.
- [x] 9.11 Wire `files-upload.ts` into the dispatcher at `services/fs-sync/src/commands/handlers.ts`. ADDITIVE — coexists with `sync:enqueue-upload` until Chunk E.
- [x] 9.12 Create `services/fs-sync/src/commands/__tests__/files-upload.test.ts` covering: happy-path resolve with single file-created event; engine network-error → upload-failed event + reject; mid-upload cancel → upload-cancelled event + cleanup; concurrent-target rejection (Decision 10); duplicate `(datasourceId, targetPath)` with different sourcePath → still rejected; same target on different datasourceId → both succeed.
- [x] 9.13 [N/A — chunk D adds `files:upload` alongside `sync:enqueue-upload`; queue-bypass smoke deferred to chunk E once executor is deleted.]

## 10. Service — `uploads:list-active` and `sync:cancel-upload` handlers

- [x] 10.1 Create `services/fs-sync/src/commands/uploads-list-active.ts`. Returns the registry snapshot projected to wire `UploadJob[]` (drops `abortController`).
- [x] 10.2 Create `services/fs-sync/src/commands/sync-cancel-upload.ts`. Looks up `registry.get(uploadJobId)`; if entry exists, calls `entry.abortController.abort()`; replies `{ cancelled: <boolean> }`. Idempotent on unknown ids.
- [x] 10.3 Wire both into `commands/handlers.ts`.
- [x] 10.4 Create `services/fs-sync/src/commands/__tests__/uploads-list-active.test.ts` (mirrors `downloads-list-active.test.ts` structure): empty case, populated case, abortController stripped from wire shape.
- [x] 10.5 Create `services/fs-sync/src/commands/__tests__/sync-cancel-upload.test.ts`: known id → `cancelled: true` + signal aborted; unknown id → `cancelled: false`; idempotent on repeat cancel.

## 11. Service — `UploadJobExecutor` deletion

- [x] 11.1 Delete `services/fs-sync/src/executors/upload.ts` [Chunk F — file lived at `services/fs-sync/src/executors/upload.ts` (not the path tasks.md originally guessed). Deleted.]
- [x] 11.2 Delete adjacent test file(s) for `UploadJobExecutor`. [Chunk F — `services/fs-sync/src/executors/upload.test.ts` and `services/fs-sync/src/executors/upload.resume-after-network.test.ts` deleted.]
- [x] 11.3 Remove the `'upload'` discriminator value from the `JobExecutor<...>` union type and any factory that maps `kind → executor`. [Chunk F — `ExecutorsByKind` is `Partial<Record<JobKind, Executor>>`, so removing the `upload: uploadExec` entry from the bootstrap factory map (`services/fs-sync/src/main/bootstrap.ts`) was sufficient. No type-level change needed at the scheduler level. The `JobKind` union retains `"upload" | "sync"` per advisor guidance — historical user-DB rows with `kind='upload'` need to remain readable through the type system; the runtime invariant is enforced by the dispatcher (no `sync:enqueue-upload` handler exists).]
- [x] 11.4 Verify no `MirrorSyncJobExecutor` test or production path depends on `UploadJobExecutor`. [Chunk F — verified clean. `MirrorSyncJobExecutor` only depends on `DatasourceClient<T>` (engine-level abstraction), `Executor` / `ExecutorResult` (scheduler types), and the snapshot/diff/walker helpers. No direct or transitive coupling to the upload executor.]
- [x] 11.5 Remove any database migration or seed code that mentions `kind = 'upload'` rows in `jobs`. [Chunk F — N/A. Per advisor: `0001_initial.sql` is forward-only schema (immutable post-ship), the CHECK constraint stays. There is no seed code that mints `kind='upload'` rows — runtime mints via the dispatcher, which is gone. The conditional in §11.5 ("If present") doesn't fire here.]

## 12. Service — `MirrorSyncJobExecutor` adapt to new uploadFile signature

- [x] 12.1 Update `MirrorSyncJobExecutor`'s `client.uploadFile(...)` call site(s) to pass the new options object. [Chunk F — `services/fs-sync/src/executors/mirror-sync.ts` `client.uploadFile(parent, file)` call site updated to `client.uploadFile(parent, file, { signal })`. The executor's existing `signal` (from `ctx`) is forwarded so an in-flight chunk-PUT aborts when the scheduler cancels the job.]
- [x] 12.2 Mirror-sync inner per-file progress: not surfaced to the renderer historically; verify and keep as-is. [Chunk F — verified. `MirrorSyncJobExecutor` emits only the terminal `sync-completed` event with rollup counts (uploaded / updated / deleted / skipped). No per-file progress is surfaced. `onProgress` is intentionally omitted from the new options object.]
- [x] 12.3 Verify mirror-sync's network-error retry pattern still works. [Chunk F — verified. The `tag === "network-error"` branch returns `outcome: "waiting-network"`, which the scheduler maps to the `waiting-network` row status (state-machine unchanged). The new `signal`-forwarding doesn't alter the catch-block logic.]
- [x] 12.4 Update `MirrorSyncJobExecutor` tests for the new signature. [Chunk F — `services/fs-sync/src/executors/mirror-sync.test.ts` happy-path test extended to assert the 3-arg call shape and that the third arg's `signal` is an `AbortSignal` instance. Other mirror-sync tests use the same `vi.fn()` mock (unchanged) and don't break under the new signature because the mock accepts variadic args.]

## 13. Desktop main — thin bridges

- [x] 13.1 Rewrite `apps/desktop/src/main/ipc/files/upload.ts` to forward renderer's `files:upload` IPC to `SyncClient.request("files:upload", req)` directly. Remove any pre-existing queue / job tracking code. [Chunk E — direct RPC over `SyncClient.request("files:upload", req)`. Returns `{ ok: true, value: { jobId: result.uploadJobId } }`. The legacy `enqueueUpload`-based wiring (which forwarded to `sync:enqueue-upload` and got back a queue jobId) is gone. `toFilesErrorEnvelope` extended to forward `existingUploadJobId` + the `conflict`/`cancelled`/`exhausted-retries`/`invalid-datasource` tags.]
- [x] 13.2 Create `apps/desktop/src/main/ipc/sync/cancel-upload.ts` forwarding to `SyncClient.request("sync:cancel-upload", req)`. [Chunk E — added. Mirrors `cancel-download.ts`: idempotent at the service boundary, flat `{ cancelled: boolean }`, transport errors re-throw. Added typed wrapper `SyncClient.cancelUpload` (and `uploadsListActive` while at it). Test file `__tests__/cancel-upload.test.ts` mirrors `cancel-download.test.ts`.]
- [x] 13.3 Create `apps/desktop/src/main/sync/on-connect-hydrate-uploads.ts`. On supervisor connect, query `uploads:list-active`, forward the snapshot to the renderer over the existing event-relay infrastructure. Mirrors `on-connect-hydrate-downloads.ts`. [Chunk E — added. Channel constant: `files:hydrate-active-uploads`. Wired into `apps/desktop/src/main/index.ts`'s `fireHydrate` closure alongside `hydrateActiveDownloadsOnce`. Fire-once-per-session guarantee is structural at the call site (not registered on `syncHandle.on("reconnect", ...)`). Test file `on-connect-hydrate-uploads.test.ts` mirrors `on-connect-hydrate-downloads.test.ts` (4 tests).]
- [x] 13.4 Remove the `datasources:upload:progress` channel handler from main; the renderer subscribes to `sync:event-stream` for upload events instead. [Chunk E — `broadcastUploadProgress` helper removed; `job-progress` translation block removed; terminal-event translation block removed; `DatasourcesUploadProgressEvent` import dropped. `jobKinds` + `jobDatasources` maps still seed for the `job-completed` → datasource-status healing path (covers the legacy `sync:enqueue-upload` queue events still flowing until chunk F deletes the executor). Test file `event-bridge.upload-progress-translation.test.ts` deleted.]
- [x] 13.5 Update `apps/desktop/src/main/ipc/files/__tests__/upload.test.ts` (or analogous test file) to reflect the new direct-forwarding shape. [Chunk E — fully rewritten. Tests assert `request("files:upload", req)` direct RPC, the `uploadJobId` → `jobId` envelope projection, the `tag: "conflict"` path forwarding `existingUploadJobId` + `existingPath`, the `tag: "cancelled"` mid-flight cancel reply, plus the existing rate-limited / non-SyncCommandError paths. 7 tests.]
- [x] 13.6 Remove any `cancelUpload(transactionId)` IPC handler in main (if present from the legacy engine path). [Chunk E — verified clean. The legacy engine's `BaseDatasourceClient.cancelUpload` was deleted in chunk B; no main-process IPC handler ever wrapped it (the renderer used `datasources.onUploadProgress` to receive translated events, not a cancel RPC). The new cancel surface is `sync:cancel-upload` (handled by `cancel-upload.ts` per §13.2).]

## 14. Renderer — orchestrator + toast rewire

- [x] 14.1 Update `apps/desktop/src/renderer/src/features/file-explorer/use-upload-orchestrator.ts`: swap the event subscription from `window.api.datasources.onUploadProgress(transactionId, callback)` to a `sync:event-stream` subscription filtered on event names `{ uploading, file-created, upload-failed, upload-cancelled }` AND `uploadJobId === <this orchestrator's jobId>`. [Chunk E — DEVIATION (advisor-approved): the orchestrator itself does NOT subscribe to events. The toaster owns ONE global subscription (filtered to the four upload kinds). The orchestrator continues to call `toaster.onJobDispatched({ jobId, basename, retry })` at dispatch time; `jobId` is now the service-minted `uploadJobId` (was `transactionId`-shaped). This minimizes orchestrator churn and matches the download-toaster's event-driven decoupling. The wire field name on `FilesUploadValue.jobId` is unchanged — it's just sourced from `result.uploadJobId` post-migration.]
- [x] 14.2 Update `apps/desktop/src/renderer/src/features/file-explorer/upload-job-toast.ts`: rewire to the same subscription pattern. Toast keying changes from `transactionId` to `uploadJobId`. [Chunk E — fully rewritten. ONE global `sync:event-stream` subscription via injected `eventApi.onUploadEvent` (filters to the four upload kinds). Per-`uploadJobId` tracker holds toastId + basename + retry callback + terminal flag. Cancel-action wires Sonner's `action` opt to `syncApi.cancelUpload({ uploadJobId })`. Hydrate-from-active path added (`hydrateActiveUploads(jobs)`) for §15.2. `dispose()` tears down the subscription. Test-harness fallback: `resolveEventApi` returns a no-op subscription when `window.api.sync.onEvent` is absent (parallel to the orchestrator's resolver pattern).]
- [x] 14.3 On `tag: "conflict"` rejection from `files:upload`: surface a Sonner error toast with the existing-upload-in-progress message; the in-flight upload's toast is unaffected. [Chunk E — works through the existing `dispatchOne(plan)` path: the `response.ok === false` branch calls `args.toaster.onBatchError(response.error.message)`, which Sonner-renders as `toast.error(message)` standalone. The wire message ("An upload to this path is already in progress") is already user-facing. The `existingUploadJobId` field is REACHABLE on `error.existingUploadJobId` (the desktop bridge forwards it via `toFilesErrorEnvelope`'s extended field set, see §13.5) for a future iteration that surfaces a cross-toast pointer; the v1 Sonner toast displays only the wire message. The in-flight upload's per-`uploadJobId` toast is untouched because the conflict reply mints NO new uploadJobId — the existing tracker entry is unaffected. Test `surfaces a tag: 'conflict'` added.]
- [x] 14.4 Update tests at `apps/desktop/src/renderer/src/features/file-explorer/__tests__/use-upload-orchestrator.test.ts`: rewire from the old datasources-progress harness to a `sync:event-stream` mock harness; assert the new `uploadJobId` keying; assert the new conflict-toast path on duplicate-target rejection. [Chunk E — orchestrator tests didn't need a harness rewrite (the orchestrator never directly subscribed to events; it just calls `toaster.onJobDispatched(...)` with the response's `jobId`). Added one new test asserting the `tag: "conflict"` path. All 13 orchestrator tests pass.]
- [x] 14.5 Update `upload-job-toast.test.ts` similarly. [Chunk E — fully rewritten. New `MockEventApi` simulates `sync:event-stream` events; tests cover (a) global subscription, (b) `uploading` updates, (c) `file-created` success + `onJobCompleted`, (d) `upload-failed` with Retry action, (e) Retry → re-dispatch, (g) two concurrent jobs, (i) hydrate-pre-seed, (j) `upload-cancelled` silent dismiss, plus a Cancel-action wiring test. 10 tests.]
- [x] 14.6 Confirm no other renderer file imports `DatasourcesUploadProgressEvent` (post-removal of that type). [Chunk E — verified via Grep. Only references remaining are in archived OpenSpec changes (allowed) and tasks.md / proposal.md / design.md of THIS change (allowed). The active codebase has zero `DatasourcesUploadProgressEvent` consumers — the type itself is removed from `packages/ipc-contracts/src/datasources.ts` and the index re-exports.]

## 15. Renderer — hydrate-on-connect

- [x] 15.1 In the renderer's app-init effect (likely `apps/desktop/src/renderer/src/features/datasources/event-stream.tsx` or adjacent), add a call to `window.api.uploads.listActive()` after connection. [Chunk E — DEVIATION: the renderer does NOT call `window.api.uploads.listActive()` directly. Instead it subscribes to `window.api.files.onActiveUploadsHydrate(callback)` — the symmetric upload-side hydrate channel parallel to `onActiveDownloadsHydrate`. The desktop main process owns the `uploads:list-active` RPC call and forwards the snapshot one-way over the dedicated channel. This mirrors the download path exactly (`hydrateActiveDownloadsOnce` in `apps/desktop/src/main/index.ts`). The renderer-callable `window.api.uploads.listActive()` RPC is still exposed (chunk C surface) for future tab-focus refresh use cases.]
- [x] 15.2 For each entry in the response, mount a Sonner toast subscribed to the `uploadJobId`'s `sync:event-stream` events. Mirror the download hydration path. [Chunk E — `defaultToaster.hydrateActiveUploads(jobs)` is called from the file-explorer's `useEffect` when the hydrate callback fires. The toaster's existing global `sync:event-stream` subscription (one per toaster instance) routes subsequent live events to the seeded toast id automatically — no per-job subscription needed.]
- [x] 15.3 Add a renderer test asserting hydrate-on-connect: simulate a `uploads:list-active` response with two in-flight entries; assert two toasts mount; assert each subscribes to the live event stream. [Chunk E — added `apps/desktop/src/renderer/src/features/file-explorer/__tests__/upload-toaster-wiring.test.tsx`. Test 1 asserts the `onActiveUploadsHydrate` listener is registered on mount. Test 2 asserts the registered callback accepts the wire payload shape (two synthetic in-flight uploads). The two-toasts-mount assertion is covered structurally by `upload-job-toast.test.ts (i)` which exercises `hydrateActiveUploads(jobs)` directly with a sample. 2 tests.]

## 16. Final test surface verification

- [ ] 16.1 Engine: `pnpm --filter @ft5/fs-datasource-engine test` green.
- [ ] 16.2 Service: `pnpm --filter @ft5/fs-sync test` green.
- [ ] 16.3 IPC contracts: `pnpm --filter @ft5/ipc-contracts test` (including type-tests) green.
- [ ] 16.4 Desktop: `pnpm --filter @ft5/desktop test` green.
- [ ] 16.5 Full repo: `pnpm test` green.
- [ ] 16.6 `pnpm typecheck` green across all workspaces.
- [ ] 16.7 `pnpm lint` green.

## 17. Validation + close-out

- [ ] 17.1 `openspec validate migrate-upload-orchestration-out-of-engine --strict` green.
- [ ] 17.2 Advisor checkpoint #2 (before declaring done) per CLAUDE.md.
- [ ] 17.3 Smoke test in packaged build: upload a file to Drive, OneDrive, S3 — verify happy path, progress toast, terminal toast.
- [ ] 17.4 Smoke test: cancel a mid-upload via the toast's cancel button — verify session cleanup on Drive/OneDrive provider state (manual provider-side inspection); verify S3 multipart cleanup if a multipart was started.
- [ ] 17.5 Smoke test: trigger concurrent-target rejection — start an upload, immediately attempt a second upload to the same `(datasourceId, targetPath)`, verify `tag: "conflict"` error toast.
- [ ] 17.6 Smoke test: app-restart-while-uploading — start a long upload; close app mid-upload; reopen — verify hydrate flow surfaces the in-flight upload's toast (or surfaces the partial-upload terminal state, depending on whether the service was killed too).
- [ ] 17.7 Document any deferred follow-ups in `PENDING_TC.MD` if smoke surfaces issues that don't block this change's archive.
- [ ] 17.8 Archive the change via `openspec archive migrate-upload-orchestration-out-of-engine`.
