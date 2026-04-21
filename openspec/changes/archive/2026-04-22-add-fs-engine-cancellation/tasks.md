# Implementation tasks — add-fs-engine-cancellation

Six phases; each task is a discrete, reviewable checkpoint. Tests land with the code in the same phase — no "tests for everything" catch-all at the end.

## 1. `@ft5/ipc-contracts` — taxonomy + event surface

- [x] 1.1 Extend `DatasourceErrorTag` in `packages/ipc-contracts/src/fs-datasource-engine.ts` to add `"cancelled"` (ninth member).
- [x] 1.2 Extend `CanonicalEventPayloads<T>` to add the 12th event name `"upload-cancelled"` with payload type `{ transactionId: string; bytesUploaded: number; bytesTotal: number; reason: "user" | "timeout" | "shutdown" }`. Export a named type alias `UploadCancelledPayload` for re-use in the engine.
- [x] 1.3 Update the `DatasourceErrorTag` 8-tag `toEqualTypeOf` tripwire in `packages/ipc-contracts/src/__tests__/datasources-engine.test-d.ts` to enumerate the 9 tags. Run `pnpm --filter @ft5/ipc-contracts build`.
- [x] 1.4 Update the 11-event-name `PayloadMap` `toEqualTypeOf` tripwire to enumerate 12 event names and add a positive assertion that `PayloadMap[T]["upload-cancelled"]` has the expected shape on every provider.
- [x] 1.5 Add a type-only re-export from `@ft5/ipc-contracts` root so `UploadCancelledPayload` is importable by downstream packages without reaching into the submodule.

## 2. `fs-datasource-engine` base — activeUploads map + public `cancelUpload`

- [x] 2.1 Add the `DatasourceClient<T>` public method `cancelUpload(transactionId: string, reason?: "user" | "timeout" | "shutdown"): Promise<void>` in `packages/fs-datasource-engine/src/base-client.ts`. Document invariants (idempotent, silent on unknown tx, cancel-before-register race handled by tracker).
- [x] 2.2 Introduce an internal `UploadTracker` shape: `{ bytesUploaded: number; bytesTotal: number; abortController: AbortController; cancel: (() => Promise<void>) | null; cancelPending: { reason: CancelReason } | null }`. Store in `private readonly activeUploads: Map<string, UploadTracker>` on `BaseDatasourceClient<T>`.
- [x] 2.3 Change the signature of `protected abstract doUploadFileImpl` to accept two additional args: `register: (cancel: () => Promise<void>) => void` and `signal: AbortSignal`. Keep `onProgress` optional as today.
- [x] 2.4 Rewrite `uploadFile` in the base so that it (a) creates the tracker + AbortController before calling `doUploadFileImpl`, (b) passes `register` and `signal` in, (c) updates `bytesUploaded` / `bytesTotal` from every `onProgress` tick, (d) in the success branch removes the tracker and emits `file-created` as today, (e) in the catch branch — if tracker is flagged cancelled — emits `upload-cancelled` with the tracker's final byte counts and throws a `DatasourceError<T>{ tag: "cancelled", retryable: false, message: "upload cancelled" }`; else emits `upload-failed` as today and throws the normalized error; either way removes the tracker.
- [x] 2.5 Implement `cancelUpload(tx, reason = "user")` such that: missing tx → resolve; present tx → set `cancelPending = { reason }` (or immediately invoke `tracker.cancel?.()` if already registered) and `abortController.abort()`. Return a promise that resolves once the tracker is removed (i.e., once `uploadFile`'s catch branch has run).
- [x] 2.6 Add a private helper that `register` wires through: if `cancelPending` was set before registration, invoke the closure synchronously in the registration turn (mirrors Decision 5 of design.md). The closure's rejection is swallowed — the AbortSignal will still propagate, and the base preserves the cancelled state either way.
- [x] 2.7 Tests: `base-client.test.ts` — cover (a) mid-upload cancel via a fake strategy that buffers `register`, (b) cancel-before-register race (two variants: early-unwind-via-signal + register-still-reached), (c) idempotent double-cancel, (d) cancel against unknown tx, (e) normal completion clears the tracker so cancel after completion is a no-op, (f) `upload-cancelled` fires exactly once, `upload-failed` does NOT fire on cancel, (g) explicit reason arg is carried through.

## 3. S3 strategy — `Upload.abort()`

- [x] 3.1 Update `S3Client.doUploadFileImpl` in `packages/fs-datasource-engine/src/strategies/s3-client.ts` to accept `register` and `signal`. (Refined: the SDK owns its own internal AbortController, so passing the base's controller is unnecessary — `register(() => upload.abort())` is sufficient and the `signal` param is retained as `_signal` for future use.)
- [x] 3.2 Call `register(async () => { upload.abort(); })` immediately after constructing the `Upload` (before `await upload.done()`). The SDK's `markUploadAsAborted` path sends `AbortMultipartUploadCommand` internally — no supplementary send needed.
- [x] 3.3 Tests: `s3-client.test.ts` — cancel mid-upload aborts the `Upload` and causes `doUploadFileImpl` to reject; uses `aws-sdk-client-mock` to hold `PutObjectCommand` open and cancels mid-flight.

## 4. OneDrive strategy — DELETE session URL

- [x] 4.1 Update `OneDriveClient.doUploadFileImpl` signature to accept `register` and `signal`. Small-upload path (`<= RESUMABLE_THRESHOLD_BYTES`): does NOT call `register` — small uploads are a single `PUT /content` and not cancellable mid-flight. Documented explicitly in a code comment.
- [x] 4.2 Resumable-upload path: after the `/createUploadSession` POST returns `uploadUrl`, call `register(async () => { await this.fetchImpl(uploadUrl, { method: "DELETE" }); })`. Base swallows closure errors for best-effort cleanup.
- [x] 4.3 Pass the `signal` into every chunk `PUT` so that an abort mid-chunk unblocks promptly.
- [x] 4.4 Tests: `onedrive-client.test.ts` — resumable cancel path: DELETE issued to session URL, upload-cancelled event, cancelled tag; small-upload post-completion cancel no-ops gracefully.

## 5. Google Drive strategy — DELETE session URL

- [x] 5.1 Update `GoogleDriveClient.doUploadFileImpl` signature to accept `register` and `signal`. Threaded the same pair into `uploadResumable`; `doCreateFileImpl` supplies a no-op register + never-aborted signal because createFile is not a cancellable surface.
- [x] 5.2 After the session-init POST returns the `Location` header, `register(async () => fetchImpl(sessionUrl, { method: "DELETE", headers: { "Content-Range": total > 0 ? \`bytes */\${total}\` : "bytes */0" } }))`. Errors swallowed by the base.
- [x] 5.3 Pass the `signal` into every chunk `PUT` (both the streaming branch and the zero-byte branch).
- [x] 5.4 Tests: `googledrive-client.test.ts` — cancel DELETE hits session URL with exact `Content-Range: bytes */<total>`; upload-cancelled event emitted; cancelled tag thrown.

## 6. Contract surface + integration

- [x] 6.1 Update `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` to exercise `cancelUpload` against every concrete client via the shared fake-fixture. (Refined to the universal idempotent-unknown-tx scenario — mid-upload cancel is covered per-strategy in each provider's own test file, avoiding fixture-level upload-suspension hooks.)
- [x] 6.2 Update `DatasourceClient<T>` in `base-client.ts` (interface section) to declare `cancelUpload(transactionId: string, reason?: "user" | "timeout" | "shutdown"): Promise<void>`. Build + typecheck green (`pnpm --filter @ft5/fs-datasource-engine build` and `pnpm -w typecheck`).
- [x] 6.3 Add a test-d assertion in `packages/ipc-contracts/src/__tests__/datasources-engine.test-d.ts` that `PayloadMap["amazon-s3" | "google-drive" | "onedrive"]["upload-cancelled"]` resolves to the declared payload shape.
- [x] 6.4 Full workspace suite green: `pnpm -w test --run` → 1309 passed / 8 skipped / 149 test files; `pnpm -w typecheck` → no errors; `pnpm -w lint` → no errors. No strict-mode diagnostics surfaced from the tracker map.
- [ ] 6.5 Manual smoke: from `apps/desktop` dev mode, invoke the engine from a scratch main-process handler to confirm the wire-level contract compiles against the host's existing `DatasourceClient<T>` variable bindings. *(Intentionally left unticked — this is a backend-only change with no consuming UI flow in v1; the workspace-wide `tsc -b` already covers the wire-level compile check.)*
