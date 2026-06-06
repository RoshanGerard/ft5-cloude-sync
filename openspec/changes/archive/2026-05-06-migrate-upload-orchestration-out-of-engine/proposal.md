# Proposal: Migrate upload orchestration out of the engine

**Status:** Drafted; ready for `/opsx:apply` once human review approves. No
blocking prerequisites — `add-engine-rename-download` (the orchestration
template for download) merged 2026-04-29; this change applies the same
principle to upload.

## Why

`add-engine-rename-download` (archived 2026-04-28) established a sharper
architectural boundary for the engine: it is a thin vendor-API translator.
Consumer-domain orchestration — transaction-id minting, registry maps,
cancel coordination, lifecycle event emission — lives in the consumer
(the fs-sync service handler).

Download was designed against this principle from day one. **Upload was
not** — it predates the principle and still carries the orchestration
pattern in `BaseDatasourceClient`:

- `activeUploads: Map<transactionId, UploadTracker>` with per-tracker
  bytes / abort / cancel / settled fields.
- `cancelUpload(transactionId, reason?)` method coordinating against
  the tracker.
- `uploading` / `file-created` / `upload-failed` / `upload-cancelled`
  bus event emission.
- `register(cancel)` callback threaded through every strategy's
  `doUploadFileImpl` so the base can invoke a provider-native cancel.

This change applies the orchestration migration to upload, paralleling
download's shape: engine becomes one-shot primitives, fs-sync owns
state and events, renderer rewires its event source.

A second concern surfaced during exploration: `BaseDatasourceClient.createFile`
exists as engine surface but has **zero production callers** outside the
engine's own tests. Creating directory or empty-file entries on the
remote datasource is not a planned UX feature. Per YAGNI, this change
also deletes the createFile surface — method, abstract primitive,
all three strategy implementations, tests. The future
`migrate-engine-events-to-consumer` change would have eaten its bus
emission anyway; deleting it now keeps the engine surface honest.

## What Changes

**Engine — `@ft5/fs-datasource-engine`:**

- **BREAKING** — `BaseDatasourceClient.uploadFile(parent, file, options?: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void })` becomes a one-shot wrapper: `withRefresh(() => doUploadFileImpl(parent, file, options))`. Returns the entry on success; throws normalized `DatasourceError` on failure. NO bus emission, NO transaction-id, NO tracker.
- **BREAKING** — `BaseDatasourceClient.cancelUpload(transactionId, reason?)` is removed entirely.
- **BREAKING** — `activeUploads: Map<...>` field, `UploadTracker` interface, `newTransactionId` minting for upload, and the four upload bus event names (`uploading`, `file-created`-via-upload, `upload-failed`, `upload-cancelled`) are removed from the engine layer.
- **BREAKING** — `protected abstract doUploadFileImpl` signature drops the `register: (cancel: () => Promise<void>) => void` parameter. The new signature is `doUploadFileImpl(parent: Target, file: { path; name?; mimeType? }, options: { signal?: AbortSignal; onProgress?: (loaded, total) => void })`. The `signal` is forwarded to the underlying SDK / fetch; cancel becomes signal-driven.
- Strategy resumable-session cleanup (Drive `DELETE /uploadSession/...`, OneDrive `DELETE <uploadUrl>`, S3 `upload.abort()`) becomes signal-driven. The strategy registers `signal.addEventListener('abort', cleanup)` and runs the cleanup HTTP call against a **fresh** AbortController with a 5s timeout, NOT against the user's signal — otherwise the cleanup itself aborts before reaching the provider.
- Strategy LRU path-handle cache invalidation on upload completion becomes strategy-internal: `doUploadFileImpl` invalidates its own LRU directly inside the success path. The constructor's bus subscription drops the `file-created` arm; it keeps the `deleted` arm (deleteFile is NOT migrated by this change and continues to emit on the engine bus).
- **BREAKING** — `BaseDatasourceClient.createFile`, `protected abstract doCreateFileImpl`, all three strategies' `doCreateFileImpl`, and createFile tests are deleted. createFile is unreachable from any UI/service path today; deletion is YAGNI cleanup.
- The `withRefresh` wrapper on `uploadFile` is **retained** in this change. Removing engine-side retry policy is the scope of the follow-up `migrate-engine-retry-policy-to-consumer`. This change does not touch retry semantics.

**Service — `services/fs-sync`:**

- New RPC handler at `services/fs-sync/src/commands/files-upload.ts`. Mirrors `files-download.ts`. Validates `(datasourceId, targetPath)` is not currently in flight, mints `uploadJobId`, creates an `AbortController`, inserts into the new `UploadRegistry`, calls `await client.uploadFile(target, file, { signal, onProgress })`, emits `uploading` / `file-created` / `upload-failed` / `upload-cancelled` events on `sync:event-stream` keyed by `uploadJobId`. Replies `{ uploadJobId }` on success. Concurrent-upload conflict is **detected before the engine call** and rejected with `tag: "conflict"` payload `{ existingUploadJobId, targetPath }`.
- New module `services/fs-sync/src/uploads/registry.ts`. Mirrors `services/fs-sync/src/downloads/registry.ts`. Exports `UploadRegistry` interface and `UploadJobEntry { uploadJobId, datasourceId, sourcePath, targetPath, bytesUploaded, contentLength, startedAt, abortController }`. Maintains a forward map `Map<uploadJobId, UploadJobEntry>` plus a reverse-index `findByTarget(datasourceId, targetPath): string | undefined` for the duplicate-target guard.
- New `uploads:list-active` RPC at `services/fs-sync/src/commands/uploads-list-active.ts`. Returns the registry snapshot; used by the desktop main process on first connect to hydrate Sonner toasts for in-flight uploads (parallel to `downloads:list-active`).
- New `sync:cancel-upload` RPC at `services/fs-sync/src/commands/sync-cancel-upload.ts`. Looks up `uploadJobId` in the registry, calls `abortController.abort()`, resolves `{ cancelled: boolean }`. Idempotent on unknown ids (resolves `{ cancelled: false }`).
- The previous `sync:enqueue-upload` command is removed. Its semantic role (renderer-initiated upload kickoff) is taken over by `files:upload`.

**Contracts — `packages/ipc-contracts`:**

- `FilesUploadValue.jobId` becomes the service-minted `uploadJobId` (was specified but unused; engine returned `transactionId`). Type-shape unchanged.
- New `UploadsListActiveCommand` (request: empty; response: array of `UploadJobEntry`-shaped envelopes). Mirrors `DownloadsListActiveCommand`.
- New `SyncCancelUploadCommand` with `params: { uploadJobId }` and `result: { cancelled: boolean }`. Mirrors `SyncCancelDownloadCommand`.
- Removed: the `SyncEnqueueUploadCommand` shape (was `sync:enqueue-upload`).
- Removed: `cancelUpload`-related types: the `UploadCancelReason` union, the `upload-cancelled` event payload entry on every provider's `PayloadMap`, the `transactionId`-keyed `DatasourcesUploadProgressEvent`, the preload binding for `window.api.datasources.onUploadProgress(transactionId, ...)`. Replaced by `uploadJobId`-keyed events on `sync:event-stream`.
- The progress-channel rename is a breaking wire-contract change. Renderer, desktop main, and service all ship from the same monorepo build, so the migration deploys atomically.

**Desktop main — `apps/desktop/src/main`:**

- `apps/desktop/src/main/ipc/files/upload.ts` becomes a thin bridge: forwards the renderer's `files:upload` IPC to `SyncClient.request("files:upload", req)`, returns `{ uploadJobId }` to the renderer. No state, no orchestration.
- New thin bridges at `apps/desktop/src/main/ipc/sync/cancel-upload.ts` (forwards `sync:cancel-upload`) and `apps/desktop/src/main/sync/on-connect-hydrate-uploads.ts` (queries `uploads:list-active` on supervisor connect, forwards the snapshot to the renderer).
- The `datasources:upload:progress` channel is removed from the preload binding.

**Renderer — `apps/desktop/src/renderer`:**

- `features/file-explorer/use-upload-orchestrator.ts` swaps its event source from `window.api.datasources.onUploadProgress(transactionId, ...)` to a `sync:event-stream` subscription filtered on `uploadJobId`. Same UX, same toast lifecycle, different keying.
- `features/file-explorer/upload-job-toast.ts` rewires the same way.
- On app-init, hydrate Sonner toasts via `window.api.uploads.listActive()`. Mirrors the download hydration path.
- No new UI surface, no new modal, no new settings section. Wire churn only.

## Capabilities

### New Capabilities

None. All work folds into existing capabilities.

### Modified Capabilities

- `fs-datasource-engine` — `DatasourceClient<T>` interface shrinks (`createFile`, `cancelUpload` removed); `uploadFile` becomes a one-shot stateless primitive; `doUploadFileImpl` signature changes; upload bus events leave the engine layer; strategy LRU invalidation on upload becomes strategy-internal; cleanup-on-abort uses fresh AbortController + 5s timeout.
- `fs-sync-service` — gains `files:upload` RPC, `UploadRegistry` module, `uploads:list-active` and `sync:cancel-upload` RPCs, the consumer-domain upload event taxonomy on `sync:event-stream`; gains the concurrent-upload conflict guard; loses `sync:enqueue-upload`.

## Impact

**Code:**

- Engine: `packages/fs-datasource-engine/src/base-client.ts` (uploadFile reshape, cancelUpload + activeUploads + UploadTracker delete, createFile delete, doUploadFileImpl abstract signature change, doCreateFileImpl abstract delete, upload-related bus emission deletes); per-strategy edits to `strategies/{googledrive,onedrive,s3}-client.ts` (signal-driven cancel cleanup, LRU invalidation rewire, doCreateFileImpl deletes); test updates across `base-client.test.ts`, `strategy-contract.ts`, and the three strategy test files.
- Contracts: `packages/ipc-contracts/src/files.ts` (`FilesUploadValue.jobId` semantics doc clarification), `packages/ipc-contracts/src/sync-service/commands.ts` (new `UploadsListActiveCommand`, `SyncCancelUploadCommand`; remove `SyncEnqueueUploadCommand`), `packages/ipc-contracts/src/datasources.ts` (delete `DatasourcesUploadProgressEvent`, the `transactionId`-keyed binding); `packages/ipc-contracts/src/fs-datasource-engine.ts` (drop upload events from PayloadMap + drop `UploadCancelReason`).
- Service: new `services/fs-sync/src/commands/files-upload.ts`, `services/fs-sync/src/commands/uploads-list-active.ts`, `services/fs-sync/src/commands/sync-cancel-upload.ts`, `services/fs-sync/src/uploads/registry.ts`; threading through `commands/handlers.ts`; new test file `services/fs-sync/src/commands/__tests__/files-upload.test.ts` paralleling `files-download.test.ts`.
- Desktop main: new `apps/desktop/src/main/ipc/sync/cancel-upload.ts`, `apps/desktop/src/main/sync/on-connect-hydrate-uploads.ts`; rewrite of `apps/desktop/src/main/ipc/files/upload.ts` from queue-based to direct RPC.
- Renderer: rewrites of `apps/desktop/src/renderer/src/features/file-explorer/use-upload-orchestrator.ts` and `upload-job-toast.ts` to subscribe to `sync:event-stream`; updated tests.
- Preload: drop `window.api.datasources.onUploadProgress`; add `window.api.uploads.listActive` and the cancel binding.

**APIs / Contracts:**

- `DatasourceClient<T>.uploadFile` (engine) — BREAKING signature + return-shape simplification (no transaction-id semantics).
- `DatasourceClient<T>.cancelUpload` and `DatasourceClient<T>.createFile` — REMOVED.
- `files:upload` (service-IPC) — request shape unchanged; response field `jobId` semantics changes from engine `transactionId` to service `uploadJobId` (no type-level break, observable wire change).
- `sync:enqueue-upload` (service-IPC) — REMOVED.
- `uploads:list-active`, `sync:cancel-upload` (service-IPC) — NEW.
- `datasources:upload:progress` (renderer-IPC channel) — REMOVED. Renderer subscribes to `sync:event-stream` filtered on `uploadJobId`.

**Dependencies:** None new.

**Operational:** No new operator-facing config. No installer changes.

**Risks documented in `design.md`:**

- Wire-contract change is observable (`transactionId` → `uploadJobId`, channel rename). Atomic monorepo deploy mitigates.
- Strategy resumable-session cleanup must use a fresh AbortController, NOT the user's signal — otherwise the cleanup itself aborts before reaching the provider.
- Strategy LRU invalidation rewire must be exhaustive — any internal subscriber to `file-created` we missed becomes dead code.
- Concurrent-upload conflict guard is observable new behavior (was UB).

**Tests:**

- Engine: existing upload tests rewrite for one-shot semantics; strategy upload tests rewire `register(cancel)` → `signal.addEventListener('abort')`; `cancelUpload`-method tests delete; `upload-cancelled` event-emission assertions delete; createFile tests delete.
- Service: new `files-upload.test.ts` (registry state machine, duplicate-target rejection, signal-driven cancel cleanup, event emission, concurrent-upload conflict); new `uploads-list-active.test.ts`, `sync-cancel-upload.test.ts`.
- Renderer: `use-upload-orchestrator.test.ts` rewires to `sync:event-stream`; `upload-job-toast.test.ts` same; hydrate-on-connect tests added.
- Smoke (manual, deferred per CLAUDE.md verification rules): exercise upload against real GCP / OneDrive / S3 datasources end-to-end in a packaged build; exercise concurrent-target rejection; exercise mid-upload cancel; exercise app-restart-while-uploading hydrate.

**Out of scope this change (other follow-ups):**

- Resumable uploads (chunked-upload-session resume across app restart). Same boundary as download — service is the durable owner; reliability bugs go in a future `add-upload-resilience` change.
- Removing `withRefresh` from upload (covered by `migrate-engine-retry-policy-to-consumer`).
- Removing the engine bus entirely (covered by `migrate-engine-events-to-consumer`).
- Bulk upload, folder upload, batch APIs.
- Changing the upload conflict-policy taxonomy (`fail` / `overwrite` / `keep-both` stays as-is).

## Provenance

- Spawned during `add-engine-rename-download` brainstorming on 2026-04-28
  when the architectural principle "engine = vendor primitives;
  consumer = orchestration / events" was made explicit by the user and
  follow-up stubs for parallel concerns were requested.
- Direct parallel to the download orchestration migration in
  `add-engine-rename-download` (archived 2026-04-28, merged 2026-04-29).
- createFile removal added 2026-05-06 during this change's brainstorming
  pass when the user observed creating directory/file on the remote
  datasource is not a planned UX feature; YAGNI cleanup of the unused
  engine surface was bundled into this change.
- Cleanup-on-abort fresh-AbortController detail surfaced during the
  advisor checkpoint on 2026-05-06; locked into design.md Risks.
- This change's completion makes `migrate-engine-retry-policy-to-consumer`
  apply-able next per its proposal's sequencing line.
