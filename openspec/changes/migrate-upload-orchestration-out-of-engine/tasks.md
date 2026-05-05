# Tasks: `migrate-upload-orchestration-out-of-engine`

## 0. Prerequisites — `/opsx:apply` is unblocked

No blocking prerequisites. `add-engine-rename-download` (the orchestration template) merged 2026-04-29.

- [ ] 0.1 Pre-apply staleness check on `design.md` file paths and function names per CLAUDE.md `## Workflow` step 5

## 1. Engine — `BaseDatasourceClient.uploadFile` reshape

- [ ] 1.1 Update `BaseDatasourceClient.uploadFile` in `packages/fs-datasource-engine/src/base-client.ts` to the one-shot signature: `uploadFile(parent, file, options?: { signal?: AbortSignal; onProgress?: (loaded, total) => void }): Promise<DatasourceFileEntry<T>>`. Body becomes `return this.withRefresh(() => this.doUploadFileImpl(parent, file, options ?? {}))`.
- [ ] 1.2 Delete the `activeUploads: Map<...>` field, `UploadTracker` interface, and any internal `newTransactionId`-for-upload helper from `BaseDatasourceClient`.
- [ ] 1.3 Delete `BaseDatasourceClient.cancelUpload` method entirely (including its public declaration on `DatasourceClient<T>` and JSDoc).
- [ ] 1.4 Remove all upload-related `this.emit(...)` calls from `BaseDatasourceClient` (`uploading`, `file-created`-via-upload, `upload-failed`, `upload-cancelled`).
- [ ] 1.5 Update the `protected abstract doUploadFileImpl` signature: drop the `register` parameter; new shape `(parent: Target, file: { path; name?; mimeType? }, options: { signal?: AbortSignal; onProgress?: (l, t) => void }): Promise<DatasourceFileEntry<T>>`.
- [ ] 1.6 Update comments in `base-client.ts` (currently reference `cancelUpload`, `activeUploads`, the tracker pattern) to reflect the new architecture.

## 2. Engine — `createFile` deletion

- [ ] 2.1 Delete `BaseDatasourceClient.createFile` method (including its public declaration on `DatasourceClient<T>` and JSDoc).
- [ ] 2.2 Delete `protected abstract doCreateFileImpl` from `BaseDatasourceClient`.
- [ ] 2.3 Delete `GoogleDriveClient.doCreateFileImpl` from `packages/fs-datasource-engine/src/strategies/googledrive-client.ts`.
- [ ] 2.4 Delete `OneDriveClient.doCreateFileImpl` from `packages/fs-datasource-engine/src/strategies/onedrive-client.ts`.
- [ ] 2.5 Delete `S3Client.doCreateFileImpl` from `packages/fs-datasource-engine/src/strategies/s3-client.ts`.
- [ ] 2.6 Sweep all `createFile` references in comments across `base-client.ts`, the three strategy files, and `packages/ipc-contracts/src/fs-datasource-engine.ts`. Delete or rephrase to remove the `createFile` mention.
- [ ] 2.7 Delete createFile-related test cases: `base-client.test.ts` (tests around line 545 + the abstract `doCreateFileImpl` mock around line 236), `s3-client.test.ts` (lines ~487, 509, 533), `onedrive-client.test.ts` (line ~1272). Verify no other test files reference `createFile`.
- [ ] 2.8 Run the engine test suite — confirm createFile-deletion didn't leave dangling references; the test surface SHALL pass with the deletions.

## 3. Engine — Google Drive strategy

- [ ] 3.1 Update `GoogleDriveClient.doUploadFileImpl` signature in `packages/fs-datasource-engine/src/strategies/googledrive-client.ts` to the new shape (drop `register`, drop `onProgress` and `signal` from positional params, accept `options` object instead).
- [ ] 3.2 Inside `doUploadFileImpl`, after the resumable-session URL is acquired: register `options.signal?.addEventListener('abort', cleanup, { once: true })`. The `cleanup` closure issues `fetch(sessionUrl, { method: "DELETE", headers: { "Content-Range": "bytes */*" }, signal: AbortSignal.timeout(5000) })` and `.catch()` logs the failure. NOT the user's signal.
- [ ] 3.3 Forward `options.signal` directly into the chunked PUT calls so abort unblocks promptly.
- [ ] 3.4 Forward `options.onProgress?` to the existing per-chunk progress hook.
- [ ] 3.5 Inside the success branch (after the strategy's resumable-session completes and returns the `DatasourceFileEntry<"google-drive">`), invoke `this.pathHandleCache.set(entry.path, entry.handle)` directly — replaces the prior `file-created` bus emission as the LRU population mechanism.
- [ ] 3.6 In the strategy's constructor, drop the `else if (e.event === "file-created")` arm of the bus subscription. Keep the `deleted` arm.
- [ ] 3.7 Remove the helper-shared `noopRegister` and `neverAborted` constants if they are exclusively for the deleted createFile path. Otherwise keep them (the helper itself stays untouched).
- [ ] 3.8 Update `googledrive-client.test.ts` cancel-related tests (around line 1839+) to assert signal-driven cleanup: aborting the user signal triggers a DELETE on a fresh AbortController; the DELETE itself does NOT abort if the user signal cleans up later.
- [ ] 3.9 Update `googledrive-client.test.ts` upload tests (around line 1700+) to assert NO `file-created` bus emission; LRU population is observable via `pathHandleCache.get(entry.path) === entry.handle` post-resolve.

## 4. Engine — OneDrive strategy

- [ ] 4.1 Update `OneDriveClient.doUploadFileImpl` signature in `packages/fs-datasource-engine/src/strategies/onedrive-client.ts` (drop `register`, accept `options`).
- [ ] 4.2 For the resumable-session path (>4 MiB): register `options.signal?.addEventListener('abort', cleanup, { once: true })` with cleanup issuing `fetch(uploadUrl, { method: "DELETE", signal: AbortSignal.timeout(5000) })`.
- [ ] 4.3 For the small-file `<= 4 MiB` `PUT /content` path: forward `options.signal` to the underlying fetch. If signal aborts post-resolve (the SDK's `.put()` may not honor abort cleanly), branch on `options.signal?.aborted` and reject with `DatasourceError { tag: "cancelled" }`. Match the existing "non-cancellable upload path" behavior.
- [ ] 4.4 Forward `options.onProgress?` to the chunk-PUT progress hooks (resumable path) or the SDK's progress callback (small path).
- [ ] 4.5 Inside the success branch: invoke `this.pathHandleCache.set(entry.path, entry.handle)` directly.
- [ ] 4.6 In the constructor, drop the `else if (e.event === "file-created")` arm of the bus subscription (line ~442).
- [ ] 4.7 Update `onedrive-client.test.ts` cancel-related tests (around line 957+) to assert signal-driven cleanup with fresh AbortController + 5s timeout.
- [ ] 4.8 Update `onedrive-client.test.ts` upload tests (around line 737+) to assert NO `file-created` bus emission; LRU population observable directly.
- [ ] 4.9 Verify OneDrive's small-file path's "non-cancellable" semantics still work end-to-end (test the post-resolve abort branch).

## 5. Engine — S3 strategy

- [ ] 5.1 Update `S3Client.doUploadFileImpl` signature in `packages/fs-datasource-engine/src/strategies/s3-client.ts` (drop `register`, accept `options`).
- [ ] 5.2 For the `@aws-sdk/lib-storage` `Upload` path: register `options.signal?.addEventListener('abort', () => upload.abort(), { once: true })`. The `Upload.abort()` issues `AbortMultipartUploadCommand` internally — no need for a fresh AbortController on the cleanup side because `Upload` manages its own controller.
- [ ] 5.3 Forward `options.onProgress?` to the existing `httpUploadProgress` event subscription.
- [ ] 5.4 The `_signal: AbortSignal` ignored parameter is removed. Replace with `options.signal` use throughout the body.
- [ ] 5.5 Inside the success branch: invoke `this.pathHandleCache.set(entry.path, entry.handle)` directly (S3 strategy LRU mirrors Drive's pattern; verify the cache field exists and is wired).
- [ ] 5.6 If S3's strategy has a similar bus subscription pattern for `file-created` invalidation, drop the upload arm and keep deletion. (Drive and OneDrive have the bus subscription; verify whether S3 mirrors it — if so, same treatment.)
- [ ] 5.7 Update `s3-client.test.ts` cancel-related tests (around line 582+) to assert signal-driven `upload.abort()` triggering.
- [ ] 5.8 Update `s3-client.test.ts` upload tests (around line 484+) to assert NO `file-created` bus emission.

## 6. Engine — strategy-contract test

- [ ] 6.1 Update `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` to remove the `cancelUpload` method check (line ~390+).
- [ ] 6.2 Update the upload contract scenario (line ~283+) — replace "emits uploading → file-created" assertion with "resolves with the entry; no upload-related bus events fire". Include LRU population assertion.
- [ ] 6.3 Add a contract scenario asserting AbortSignal-driven cancel: every strategy aborts its underlying provider call when `options.signal` aborts; cleanup HTTP is issued where applicable; reject is `DatasourceError { tag: "cancelled" }`.
- [ ] 6.4 Remove the `createFile` scenario from the strategy-contract suite (find via grep on `createFile` in the file).
- [ ] 6.5 Update the `assignable to DatasourceClient<...>` interface check — the interface no longer has `createFile` or `cancelUpload`; the test should reflect the shrunk surface.

## 7. IPC contracts

- [ ] 7.1 Update `packages/ipc-contracts/src/files.ts` `FilesUploadValue.jobId` JSDoc — clarify that the field is now the service-minted `uploadJobId` (was specified but unused).
- [ ] 7.2 Add `UploadsListActiveCommand` to `packages/ipc-contracts/src/sync-service/commands.ts` (mirror `DownloadsListActiveCommand` shape).
- [ ] 7.3 Add `SyncCancelUploadCommand` to `packages/ipc-contracts/src/sync-service/commands.ts` (mirror `SyncCancelDownloadCommand`: params `{ uploadJobId }`, result `{ cancelled: boolean }`).
- [ ] 7.4 Remove `SyncEnqueueUploadCommand` from the same file.
- [ ] 7.5 Update `packages/ipc-contracts/src/datasources.ts` — remove the `DatasourcesUploadProgressEvent` shape and its preload binding declaration.
- [ ] 7.6 Update `packages/ipc-contracts/src/fs-datasource-engine.ts` — remove the `upload-cancelled` event entry from `CanonicalEventPayloads`; remove the `UploadCancelReason` union; remove the `transactionId` keying from upload-related types.
- [ ] 7.7 Update `packages/ipc-contracts/src/__tests__/datasources-engine.test-d.ts` — assert the shrunk PayloadMap (no `uploading`, `file-created`-via-upload, `upload-failed`, `upload-cancelled` for upload paths). The `cancelled` tag is RETAINED in `DatasourceErrorTag` for signal-driven uploads.
- [ ] 7.8 Add type tests for the new `UploadsListActiveCommand` and `SyncCancelUploadCommand` shapes (mirror existing download command type-tests).
- [ ] 7.9 Update preload `apps/desktop/src/preload/index.ts` (or equivalent): remove `window.api.datasources.onUploadProgress`; add `window.api.uploads.listActive`, the cancel binding, and the upload-event subscription on `sync:event-stream`.

## 8. Service — `UploadRegistry` module

- [ ] 8.1 Create `services/fs-sync/src/uploads/registry.ts` with `UploadJobEntry` interface and `UploadRegistry` interface (`set`, `get`, `update`, `delete`, `snapshot`, `findByTarget`).
- [ ] 8.2 Implement the registry as a class with a forward `Map<uploadJobId, UploadJobEntry>` and a reverse-index `Map<string, string>` keyed `${datasourceId}::${targetPath}` → `uploadJobId`.
- [ ] 8.3 Both indexes update atomically on `set` and `delete` (no reverse-index leak on rapid set/delete cycles).
- [ ] 8.4 `snapshot()` returns a fresh array (no shared reference); mutations to the returned array don't affect later snapshots.
- [ ] 8.5 Create `services/fs-sync/src/uploads/registry.test.ts` covering: set + get + delete; reverse-index hit-after-set, miss-after-delete; concurrent set/delete atomicity; snapshot immutability.

## 9. Service — `files:upload` handler

- [ ] 9.1 Create `services/fs-sync/src/commands/files-upload.ts` mirroring `files-download.ts` shape.
- [ ] 9.2 Validate `sourcePath` is absolute, `targetPath` is syntactically valid; reject with `tag: "other"` on validation failure.
- [ ] 9.3 Check `registry.findByTarget(datasourceId, targetPath)` — if hit, reject with `tag: "conflict"` payload `{ existingUploadJobId, targetPath }` BEFORE engine call.
- [ ] 9.4 Mint `uploadJobId = crypto.randomUUID()`; create `AbortController`; insert `UploadJobEntry` into registry.
- [ ] 9.5 Resolve `DatasourceClient<T>` via `ClientFactory.create(datasourceId)`.
- [ ] 9.6 Invoke `await client.uploadFile(target, file, { signal: abortController.signal, onProgress: <emit-throttled-uploading> })`.
- [ ] 9.7 `onProgress` callback updates registry entry's `bytesUploaded` and `contentLength`; emits `uploading` on `sync:event-stream` with throttle (1s OR 10% delta).
- [ ] 9.8 On engine resolve: emit `file-created` on `sync:event-stream`; delete registry entry; reply `{ uploadJobId }`.
- [ ] 9.9 On engine reject `tag === "cancelled"`: emit `upload-cancelled`; delete registry entry; reply with cancelled error (mirror download handler's cancel reply convention).
- [ ] 9.10 On engine reject other tag: emit `upload-failed`; delete registry entry; reply with normalized error.
- [ ] 9.11 Wire `files-upload.ts` into the dispatcher at `services/fs-sync/src/commands/handlers.ts` (or wherever the dispatcher lives).
- [ ] 9.12 Create `services/fs-sync/src/commands/__tests__/files-upload.test.ts` covering: happy-path resolve with single file-created event; engine network-error → upload-failed event + reject; mid-upload cancel → upload-cancelled event + cleanup; concurrent-target rejection (Decision 10); duplicate `(datasourceId, targetPath)` with different sourcePath → still rejected; same target on different datasourceId → both succeed.
- [ ] 9.13 Verify `SELECT COUNT(*) FROM jobs WHERE kind = 'upload'` returns 0 after `files:upload` completes (queue is bypassed).

## 10. Service — `uploads:list-active` and `sync:cancel-upload` handlers

- [ ] 10.1 Create `services/fs-sync/src/commands/uploads-list-active.ts`. Returns `{ ok: true, value: registry.snapshot().map(entry => omit(entry, 'abortController')) }`.
- [ ] 10.2 Create `services/fs-sync/src/commands/sync-cancel-upload.ts`. Looks up `registry.get(uploadJobId)`; if entry exists, calls `entry.abortController.abort()`; replies `{ cancelled: <boolean> }`.
- [ ] 10.3 Wire both into `commands/handlers.ts`.
- [ ] 10.4 Create `services/fs-sync/src/commands/__tests__/uploads-list-active.test.ts` (mirrors `downloads-list-active.test.ts` structure): empty case, populated case, abortController stripped from wire shape.
- [ ] 10.5 Create `services/fs-sync/src/commands/__tests__/sync-cancel-upload.test.ts`: known id → `cancelled: true` + signal aborted; unknown id → `cancelled: false`; idempotent on repeat cancel.

## 11. Service — `UploadJobExecutor` deletion

- [ ] 11.1 Delete `services/fs-sync/src/scheduler/executors/upload-job-executor.ts` (or wherever it lives — locate via grep on `UploadJobExecutor`).
- [ ] 11.2 Delete adjacent test file(s) for `UploadJobExecutor`.
- [ ] 11.3 Remove the `'upload'` discriminator value from the `JobExecutor<...>` union type and any factory that maps `kind → executor`.
- [ ] 11.4 Verify no `MirrorSyncJobExecutor` test or production path depends on `UploadJobExecutor` (grep — should be clean since they're separate executors).
- [ ] 11.5 Remove any database migration or seed code that mentions `kind = 'upload'` rows in `jobs` (if present; usually just SQL constraint / type definition).

## 12. Service — `MirrorSyncJobExecutor` adapt to new uploadFile signature

- [ ] 12.1 Update `MirrorSyncJobExecutor`'s `client.uploadFile(...)` call site(s) to pass the new options object: `client.uploadFile(target, file, { signal: <executor's signal>, onProgress: <optional> })`.
- [ ] 12.2 Mirror-sync inner per-file progress: not surfaced to the renderer historically; verify and keep as-is. If progress IS surfaced, plumb through the new `onProgress` hook.
- [ ] 12.3 Verify mirror-sync's network-error retry pattern still works (the scheduler's `waiting-network` state machine is unchanged; only the `client.uploadFile` call shape changes).
- [ ] 12.4 Update `MirrorSyncJobExecutor` tests for the new signature.

## 13. Desktop main — thin bridges

- [ ] 13.1 Rewrite `apps/desktop/src/main/ipc/files/upload.ts` to forward renderer's `files:upload` IPC to `SyncClient.request("files:upload", req)` directly. Remove any pre-existing queue / job tracking code.
- [ ] 13.2 Create `apps/desktop/src/main/ipc/sync/cancel-upload.ts` forwarding to `SyncClient.request("sync:cancel-upload", req)`.
- [ ] 13.3 Create `apps/desktop/src/main/sync/on-connect-hydrate-uploads.ts`. On supervisor connect, query `uploads:list-active`, forward the snapshot to the renderer over the existing event-relay infrastructure. Mirrors `on-connect-hydrate-downloads.ts`.
- [ ] 13.4 Remove the `datasources:upload:progress` channel handler from main; the renderer subscribes to `sync:event-stream` for upload events instead.
- [ ] 13.5 Update `apps/desktop/src/main/ipc/files/__tests__/upload.test.ts` (or analogous test file) to reflect the new direct-forwarding shape.
- [ ] 13.6 Remove any `cancelUpload(transactionId)` IPC handler in main (if present from the legacy engine path).

## 14. Renderer — orchestrator + toast rewire

- [ ] 14.1 Update `apps/desktop/src/renderer/src/features/file-explorer/use-upload-orchestrator.ts`: swap the event subscription from `window.api.datasources.onUploadProgress(transactionId, callback)` to a `sync:event-stream` subscription filtered on event names `{ uploading, file-created, upload-failed, upload-cancelled }` AND `uploadJobId === <this orchestrator's jobId>`.
- [ ] 14.2 Update `apps/desktop/src/renderer/src/features/file-explorer/upload-job-toast.ts`: rewire to the same subscription pattern. Toast keying changes from `transactionId` to `uploadJobId`.
- [ ] 14.3 On `tag: "conflict"` rejection from `files:upload`: surface a Sonner error toast with the existing-upload-in-progress message; the in-flight upload's toast is unaffected.
- [ ] 14.4 Update tests at `apps/desktop/src/renderer/src/features/file-explorer/__tests__/use-upload-orchestrator.test.ts`: rewire from the old datasources-progress harness to a `sync:event-stream` mock harness; assert the new `uploadJobId` keying; assert the new conflict-toast path on duplicate-target rejection.
- [ ] 14.5 Update `upload-job-toast.test.ts` similarly.
- [ ] 14.6 Confirm no other renderer file imports `DatasourcesUploadProgressEvent` (post-removal of that type).

## 15. Renderer — hydrate-on-connect

- [ ] 15.1 In the renderer's app-init effect (likely `apps/desktop/src/renderer/src/features/datasources/event-stream.tsx` or adjacent), add a call to `window.api.uploads.listActive()` after connection.
- [ ] 15.2 For each entry in the response, mount a Sonner toast subscribed to the `uploadJobId`'s `sync:event-stream` events. Mirror the download hydration path.
- [ ] 15.3 Add a renderer test asserting hydrate-on-connect: simulate a `uploads:list-active` response with two in-flight entries; assert two toasts mount; assert each subscribes to the live event stream.

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
