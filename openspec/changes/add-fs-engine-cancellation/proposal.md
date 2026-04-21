# Proposal — `add-fs-engine-cancellation`

## Status

**STUB — not yet proposed.** Filed from `add-fs-datasource-engine` Phase 12.3 to capture the deferred-but-known scope before archive. Do not promote to `/opsx:propose` until a UI flow that needs cancellation is in flight (drag-and-drop with a visible upload queue, a bulk-ops surface, or an explicit "Stop upload" button in the dashboard card).

## Context

`add-fs-datasource-engine` ships the FS Datasource Engine with `uploadFile` / `deleteFile` / `createFile` / `listDirectory` / `search` / `getMetadata` on `DatasourceClient<T>`. None of these are cancellable once started. The renderer currently has no surface that would expose a cancel control, so the lack is hypothetical until a product flow needs it.

When a UI flow does need it — most likely a "Stop upload" affordance on an in-progress row in the datasources dashboard, or a bulk-ops toolbar acting on a selected set of large files — the engine's contract has to gain `cancelUpload(transactionId: string)` and the provider strategies have to wire their SDKs' native cancellation primitives.

## Goal (when proposed)

Add `cancelUpload(transactionId: string): Promise<void>` to `DatasourceClient<T>`. Strategy-side implementations:

- **S3** — abort the `@aws-sdk/lib-storage` `Upload` via its public `abort()` method and issue `AbortMultipartUploadCommand` for any parts already opened.
- **OneDrive** — DELETE the resumable-upload session URL per Graph's documented cancellation.
- **Google Drive** — DELETE the resumable-upload session URL with a `Content-Range: bytes */<size>` header per Drive's documented cancellation.

Emit a new `upload-cancelled` terminal event (bypasses the coalescer, same as `upload-failed`), typed per provider in `PayloadMap[T]`.

## Non-Goals (when proposed)

- Cancelling non-upload operations (`listDirectory`, `search`, `getMetadata`, `delete*`, `create*`). They return quickly; a UI cancel would be cosmetic at best. Revisit if telemetry reveals long tails.
- Cancellation composition with the sync-service queue (`add-fs-sync-service`). If a queue is draining, an item cancel should remove it from the queue AND abort if it is the currently-running item. That coordination belongs in the queue, not here — document the contract, leave the implementation to the queue.

## Decisions to make at proposal time

- **Event payload shape for `upload-cancelled`.** Probably carries `{ transactionId, bytesUploaded, bytesTotal, reason: "user" | "timeout" | "shutdown" }`. Confirm during proposal.
- **Race semantics: cancel-during-completion.** If cancel arrives after the provider accepted the final chunk but before the terminal event fires, does the file remain on the provider (partial-upload cleanup) or complete? Provider-specific; document per strategy.
- **Signal propagation.** Pass a host-supplied `AbortSignal` through `uploadFile` as an optional arg vs. expose `cancelUpload(transactionId)` as a separate method call. Leaning toward the latter (no change to the upload signature, tracked by `transactionId` the caller already has), but confirm during design.

## Blockers / prerequisites

- `add-fs-datasource-engine` must be merged first (provides the strategy surface this change extends).
- A UI flow that actually uses cancellation must be scheduled or in-flight, so the contract is informed by a real consumer rather than guessed.

## References

- `openspec/changes/add-fs-datasource-engine/design.md` — Open Questions → "Upload cancellation" entry pointing to this stub.
- `openspec/changes/add-fs-datasource-engine/specs/fs-datasource-engine/spec.md` — existing `uploadFile` / streaming-event requirements that this change extends.
