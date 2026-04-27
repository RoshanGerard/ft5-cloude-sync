# Proposal: Migrate upload orchestration out of the engine

**Status**: Stub. Spawned during `add-engine-rename-download` brainstorming on 2026-04-28 when the architectural principle "the engine only facilitates vendor datasource functionality; consumers own orchestration" was made explicit.

## Why

`add-engine-rename-download` establishes a sharper architectural boundary for the engine: it is a thin vendor-API translator. Consumer-domain orchestration — retry policy, byte tracking across stream lifetimes, transaction-id maps, consumer-domain event emission — lives in the consumer (the fs-sync service handler).

Download was designed against this principle from day one in that change. **Upload was not** — it predates the principle and still carries the orchestration pattern in the engine:

```
Currently in BaseDatasourceClient.uploadFile:
  - mints transactionId via newTransactionId()
  - maintains activeUploads: Map<transactionId, UploadTracker>
  - tracker fields: bytesUploaded, bytesTotal, abortController,
    cancel closure, cancelPending, settled promise
  - emits "uploading" (streaming) events on the engine bus
  - emits terminal "file-created" / "upload-failed" /
    "upload-cancelled" events
  - exposes cancelUpload(transactionId, reason?) method that
    coordinates against the tracker

Currently in concrete strategies' doUploadFileImpl:
  - receives a register(cancel) hook to hand the base a
    provider-native cancel closure
  - receives an onProgress callback the base wires to the bus
  - receives an AbortSignal threaded from the base's tracker
```

This is exactly the shape `add-engine-rename-download` rejected for download. Apply the same principle to upload to keep the engine surface consistent.

## What this change does

1. Remove `uploadFile`'s tracker map, `cancelUpload` method, and bus event emission from `BaseDatasourceClient`.
2. New engine surface: `uploadFile(parent, file, options?: { signal?, onProgress? })` — single shot, no transaction-id, no internal state, AbortSignal forwarded to the SDK call.
3. Move upload orchestration to the fs-sync service handler:
   - `services/fs-sync/src/commands/files-upload.ts` (or wherever the handler lives) mints a service-level `uploadJobId`.
   - Maintains the upload registry in service-handler scope (parallel to the new download registry).
   - Emits consumer-domain events (`uploading`, `file-created`, `upload-failed`, `upload-cancelled`) on the service's IPC event stream rather than the engine bus.
   - Cancel via service-side AbortController.
4. Migrate the renderer's `use-upload-orchestrator` and `upload-job-toast` to the new event source (service IPC stream) — wire-level event names stay the same.

## Out of scope

- Changing the upload's user-facing wire contract. `files:upload` request/response shapes stay identical; event names stay identical. Only the source of events (engine bus → service IPC stream) changes.
- Resumable uploads (chunked-upload-session resume on Drive / OneDrive). Separate problem; uploads have their own resilience profile.
- Multi-file batch APIs.

## Open questions (resolve during `/opsx:propose`)

1. **createFile parallelism.** `createFile` has the same "engine emits success/failure events" pattern as `uploadFile`. Should this change cover both, or only `uploadFile`? Recommend: both, since the migration shape is identical; but flag for confirmation since `createFile`'s usage is narrower.

2. **Engine bus future.** With download events moving out (in `add-engine-rename-download`) and upload events moving out (this change), the engine's `EventBus` becomes much smaller — basically just `token-refreshed`, `authentication-*`, and `status-changed`. Does it eventually disappear entirely (replaced by direct return-value + error semantics)? Probably yes for a far-future change; flag in this proposal but don't scope it here.

3. **Tracker semantics across upload variants.** Drive and OneDrive support resumable upload sessions internally (multi-chunk uploads with provider-side state). The strategy's `uploadFile` already abstracts that. The handler-side orchestration just needs the AbortSignal + onProgress hook. Verify no strategy currently relies on the engine's tracker state for its own internal logic.

## Acceptance criteria (once promoted)

- `BaseDatasourceClient` no longer carries an `activeUploads` map, `cancelUpload` method, or per-upload bus emission. Upload becomes a one-shot primitive parallel to download.
- `services/fs-sync/src/commands/files-upload.ts` (or equivalent) owns the upload orchestration: `uploadJobId` minting, registry, cancel via AbortController, IPC event emission.
- Wire contract `files:upload` is unchanged. Renderer's upload UX is unchanged.
- `cancelUpload` IPC command (if exposed at the wire level today) is renamed or rewired to target the service-level `uploadJobId`.
- Existing renderer + service tests for upload pass with no observable wire-level diff.

## Provenance

- Spawned during `add-engine-rename-download` brainstorming on 2026-04-28 when the architectural principle "engine = vendor primitives; consumer = orchestration" was confirmed and the user requested follow-up stubs for similar issues elsewhere in the codebase.
- Direct parallel to the download orchestration migration in `add-engine-rename-download`.
