## Context

`add-fs-datasource-engine` shipped `DatasourceClient<T>` with `uploadFile` / `createFile` / `listDirectory` / `search` / `getMetadata` / `deleteFile`. None of these are cancellable once started. For small files (<4 MB on OneDrive, a single `PutObject` on S3) this is fine — the operation completes faster than a user could intervene. For large files that traverse the resumable-session path (OneDrive `>4 MB`, Drive always, S3 lib-storage multipart) the upload can run for minutes, and today the only recovery is to let it finish or kill the process.

This change adds engine-side cancellation for in-flight uploads. It is being shipped **ahead of a consuming UI flow** — no "Stop upload" button, drag-and-drop queue, or bulk-ops surface exists yet. The engine contract is designed so that when such a surface lands, the wiring is a `cancelUpload(transactionId)` call against a `transactionId` the caller already received on the first `uploading` event. The ergonomics of the eventual UI (per-row confirm dialog? bulk cancel? visible queue?) are deferred to whichever change introduces the flow.

The scope is intentionally narrow: *uploads only*, *engine-side only*. Non-upload operations stay non-cancellable (they return quickly; a cancel would be cosmetic). Queue coordination with `fs-sync-service` stays owned by the queue — the engine exposes the primitive, the queue decides when to call it.

## Goals / Non-Goals

**Goals:**

- `DatasourceClient<T>` gains one public method: `cancelUpload(transactionId, reason?): Promise<void>`.
- `cancelUpload` works mid-upload on every strategy (S3, OneDrive, Drive).
- A new terminal event `upload-cancelled` fires exactly once per cancelled upload, carrying `{ transactionId, bytesUploaded, bytesTotal, reason }`. It bypasses the streaming coalescer (same as `upload-failed` / `file-created`).
- On cancel, `uploadFile(...)` rejects with `DatasourceError<T>{ tag: "cancelled", retryable: false }`. The pre-existing `upload-failed` event does NOT fire for cancellations — `upload-cancelled` is its terminal analogue.
- Cancel is idempotent: a second `cancelUpload` call for the same transaction, or a cancel call that races past completion, resolves without error and emits nothing.
- Strategies wire their SDKs' native cancellation primitives (S3 `Upload.abort()`, OneDrive DELETE session, Drive DELETE session) so any multipart state on the provider side is cleaned up, not orphaned.

**Non-Goals:**

- **Non-upload cancellation.** `listDirectory` / `search` / `getMetadata` / `deleteFile` / `createFile` (metadata-only) stay uninterruptable. Revisit if telemetry shows long tails.
- **`fs-sync-service` queue coordination.** The engine aborts the currently-in-flight upload. Removing queued items, de-prioritising, or re-ordering are owned by `services/fs-sync`'s `Scheduler`. The spec documents this boundary explicitly so future readers don't mistake the engine's cancel for a queue-level operation.
- **Renderer-side cancel UI.** No "Stop upload" button, confirmation modal, or progress-bar cancel affordance. That lands with the change that introduces the flow.
- **Cancel during auth-refresh.** If cancel arrives while the base's single-flight refresh is in flight, it waits for the refresh to either succeed (then cancel the retry) or fail (then the upload is already terminal — no-op cancel). No new coordination primitive.

## Decisions

### Decision 1 — Separate method, not `AbortSignal`-through-`uploadFile`

Add `cancelUpload(transactionId, reason?)` as a distinct method on `DatasourceClient<T>`. Keep `uploadFile`'s signature stable.

**Alternatives considered:**

- **`uploadFile(parent, file, { signal: AbortSignal })`.** Standard Web API shape, narrow surface. Rejected because the caller doesn't naturally own an `AbortController` for an engine-originated `transactionId` — the caller knows the transaction ID only *after* the first `uploading` event, which is *after* `uploadFile` was called. Callers would have to stash a controller outside the call site, which is worse ergonomically than calling `cancelUpload(tx)` against the ID they already have from the event.
- **Both — `uploadFile(..., {signal})` AND `cancelUpload(tx)`.** Two ways to do the same thing. Rejected for surface sprawl.

**Why this option won:** Callers already subscribe to the event stream to observe progress; `transactionId` arrives there. A single cancel method against that ID is a smaller, more obvious contract than dual plumbing. The internals still use an `AbortController` — it's a base-class implementation detail, not public surface.

### Decision 2 — Cancel emits `upload-cancelled`, not `upload-failed`

Cancellation has a distinct terminal event. It is NOT an error, not logically anyway — the user asked for it.

**Why:** UI that renders a toast on `upload-failed` should NOT toast "upload failed" for a user-initiated cancel. Audit log / telemetry should distinguish "user cancelled 20 uploads" from "20 uploads failed". A shared event with a discriminator would work but is less grep-able and narrower-typed than two events.

**Payload:** `{ transactionId, bytesUploaded, bytesTotal, reason: "user" | "timeout" | "shutdown" }`. Shared across providers — no provider-specific fields. Pinned in `CanonicalEventPayloads` (mirrors the treatment `authentication-failed` got in `add-fs-datasource-engine` Phase 12).

**Reason values:**
- `"user"` — explicit `cancelUpload(tx)` call. Always the reason when the method is called without an explicit reason arg (default).
- `"timeout"` — reserved for future use (engine-level upload timeout). Not emitted by v1.
- `"shutdown"` — reserved for future use (host is tearing down; in-flight uploads cancelled en masse). Not emitted by v1. The base's `dispose()` stays a no-op on active uploads; the caller is responsible for cancelling before dispose.

### Decision 3 — `DatasourceErrorTag` gains `"cancelled"`

Add a ninth tag: `"cancelled"`. Rejected upload throws `DatasourceError<T>{ tag: "cancelled", retryable: false }`.

**Alternatives considered:**

- **Reject with `provider-error` + `message: "cancelled"`.** Avoids the tag change. Rejected because `provider-error` is the "retryable" tag in `services/fs-sync`'s user-retry path; a cancel getting auto-retried by the sync-service queue would be the opposite of the user's intent.
- **Resolve `uploadFile` normally on cancel.** Rejected — the upload did not complete, the caller should see rejection so control flow is uniform with every other failure mode.

**Blast radius:** The two type-tripwire tests in `packages/ipc-contracts/src/__tests__/datasources-engine.test-d.ts` (the 8-tag and 11-event-name `toEqualTypeOf` assertions) both need updating. `services/fs-sync`'s system-retry classifier accepts any string and falls through to `terminal` for unknown tags; user-retry's `TERMINAL_TAGS` set plus its `errorTag !== "provider-error"` guard both route `"cancelled"` to `terminal` automatically. No runtime consumer regresses. The test updates are intentional — tripwires exist *precisely* so adding a tag is a deliberate, visible edit.

### Decision 4 — Base-class ownership of the transaction map

`BaseDatasourceClient<T>` owns a `Map<transactionId, UploadTracker>`. Strategies hand the base a cancel closure via a `register` callback; the base calls it on `cancelUpload`.

```ts
interface UploadTracker {
  bytesUploaded: number;
  bytesTotal: number;
  abortController: AbortController;
  cancel: (() => Promise<void>) | null;   // null until strategy calls register()
  cancelPending: { reason: CancelReason } | null;  // set if cancelUpload arrives before register
}
```

**Strategy-side contract:** `doUploadFileImpl` receives two new args in addition to `onProgress`:
- `register(cancel)` — call once with a provider-specific cancel closure (e.g., `() => upload.abort()`, or `() => fetch(sessionUrl, { method: "DELETE" })`). If `cancelPending` is set when `register` runs, the base invokes the closure immediately (see Decision 5).
- `signal: AbortSignal` — pass through to fetch/SDK calls where supported so in-progress HTTP requests can be aborted promptly (otherwise the cancel waits for the current chunk's PUT to finish).

**Emission flow on cancel:**
1. Host calls `cancelUpload(tx, reason)`.
2. Base looks up `tx`. If not present → resolve immediately (idempotent no-op).
3. Base marks tracker as cancelled (no new progress events emit). Base invokes `tracker.cancel()` (if registered) and aborts the `AbortController`.
4. `doUploadFileImpl` eventually throws (strategy's cancel closure triggered SDK-level abort; abort signal unblocked any in-flight chunk).
5. Base's `uploadFile` catch branch detects cancelled state, emits `upload-cancelled { transactionId, bytesUploaded, bytesTotal, reason }`, throws `DatasourceError<T>{ tag: "cancelled" }`. `upload-failed` does NOT fire.
6. Base removes tracker from map.

On normal completion or non-cancel failure, the base also removes the tracker from the map.

### Decision 5 — Cancel-before-register race

There is a real window between `uploadFile(...)` being called and the strategy invoking `register(cancel)` — the session-init HTTP round-trip (OneDrive `/createUploadSession`, Drive POST to resumable endpoint, S3 multipart `CreateMultipartUploadCommand`). During that window the tracker exists (base created it before invoking the strategy) but has no cancel closure. A cancel call must not be lost.

**Resolution:** `cancelUpload` sets `tracker.cancelPending = { reason }` and aborts the `AbortController`. When the strategy later calls `register(cancel)`, the base checks `cancelPending`: if set, invoke the closure immediately and propagate the cancelled state. The strategy's own in-flight session-init call observes the `AbortSignal` and unwinds (for OneDrive/Drive via fetch's signal handling; for S3 the `Upload` constructor accepts the abortController so even pre-multipart work honours the signal).

For S3 specifically: because our strategy passes the host's `AbortController` into `new Upload({ abortController, ... })`, an abort before `.done()` causes the Upload to unwind without sending `CreateMultipartUpload` at all. No orphan multipart uploads.

## Risks

- **Orphaned multipart / session state on provider side.** If the cancel closure itself fails (e.g., network unavailable between `cancelUpload` and the DELETE session fetch), the provider may keep the multipart state for its default TTL (S3: 7 days on an un-aborted MPU, OneDrive: ~1 week on an unused session, Drive: ~1 week). This is a quality-of-storage concern, not a correctness bug. Document in the per-strategy spec that consumers accept this risk; a `retryable` cancel path is a follow-up if telemetry shows it matters.
- **Progress events after cancel are gated.** The `onProgress` callback inside `uploadFile` checks `tracker.cancelPending !== null` before emitting and returns early when set, so new progress ticks from strategies that fire `onProgress` after the abort signal land in `/dev/null` rather than on the bus. The streaming coalescer may still flush any already-queued `uploading` event, but that queue is drained by the coalescer's own tick — the base stops adding to it the moment `cancelUpload` runs. Callers treat `upload-cancelled` as the canonical terminal signal in either case.
- **S3 `.abort()` timing.** Calling `Upload.abort()` before `.done()` is called is supported (sets the abortController's signal); `__doMultipartUpload()` checks the signal after `Promise.all(concurrentUploaders)` and then calls `markUploadAsAborted` which sends `AbortMultipartUploadCommand` if `uploadId` was set. Verified in `@aws-sdk/lib-storage@3.1032.0/dist-cjs/index.js` lines 229–231, 420–424, 466–470. No supplementary `AbortMultipartUploadCommand` send is needed — the SDK does it.

## Open Questions

None at proposal time — each of the four stub-level questions is now decided above.

## References

- `packages/fs-datasource-engine/src/base-client.ts:316-365` — current `uploadFile` flow this change wraps.
- `packages/fs-datasource-engine/src/strategies/s3-client.ts:552-599` — S3 upload path (`Upload` class, `onProgress`).
- `packages/fs-datasource-engine/src/strategies/onedrive-client.ts:640-730` — OneDrive `/createUploadSession` + chunked PUT.
- `packages/fs-datasource-engine/src/strategies/googledrive-client.ts:870-1035` — Drive resumable session.
- `openspec/changes/archive/2026-04-21-add-fs-datasource-engine/design.md` — style reference + non-streaming terminal event precedent.
- `node_modules/@aws-sdk/lib-storage@3.1032.0/dist-cjs/index.js:229-470` — Upload abort lifecycle.
