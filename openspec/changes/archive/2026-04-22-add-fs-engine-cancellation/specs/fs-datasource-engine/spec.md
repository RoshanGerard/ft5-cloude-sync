## ADDED Requirements

### Requirement: `DatasourceClient<T>` exposes `cancelUpload` for in-flight uploads

The public `DatasourceClient<T>` interface SHALL gain a method `cancelUpload(transactionId: string, reason?: "user" | "timeout" | "shutdown"): Promise<void>`. The method SHALL:

- Resolve without error when `transactionId` is unknown (never started, already terminal, or cancelled previously) — cancel is idempotent.
- When `transactionId` is in-flight, trigger cancellation such that (a) the provider-side upload state (S3 multipart, OneDrive resumable session, Drive resumable session) is cleaned up via the provider's documented cancellation primitive, (b) a `upload-cancelled` event fires exactly once for that `transactionId`, and (c) the original `uploadFile(...)` promise rejects with `DatasourceError<T>{ tag: "cancelled", retryable: false }` (NOT a `upload-failed` event).
- Default `reason` to `"user"` when the caller omits it.
- Be callable before the strategy's session-init HTTP round-trip completes (cancel-before-register race): the base SHALL buffer the cancel and apply it as soon as the strategy registers its cancel closure, or — if the session-init observes the base's `AbortSignal` — unwind without opening provider-side state at all.

#### Scenario: cancelUpload mid-upload emits upload-cancelled and rejects with cancelled tag

- **WHEN** a caller invokes `uploadFile` on a large file, receives a `transactionId` via the first `uploading` event, and then calls `cancelUpload(transactionId)` while chunks are still being streamed
- **THEN** the bus observes exactly one `upload-cancelled` event carrying `{ transactionId, bytesUploaded, bytesTotal, reason: "user" }`, no `upload-failed` event fires, and the original `uploadFile` promise rejects with `DatasourceError<T>{ tag: "cancelled", retryable: false }`

#### Scenario: cancelUpload with unknown transactionId resolves silently

- **WHEN** a caller invokes `cancelUpload("tx-does-not-exist")` or calls `cancelUpload` a second time for a transaction that already cancelled / completed
- **THEN** the call resolves without rejection, no event fires, and no side-effect hits the provider

#### Scenario: cancel against an upload the strategy opted not to register is a silent no-op — the upload completes normally

- **WHEN** a caller invokes `cancelUpload(transactionId)` during a small-file upload path that the strategy chose not to register with (e.g. OneDrive's `<= 4 MiB` `PUT /content` path, where no resumable session exists to DELETE and the Graph SDK's `.put()` does not honour an `AbortSignal`)
- **THEN** the base aborts its `AbortSignal` but has no `cancel` closure to invoke; the strategy's in-flight PUT completes normally and returns a `DriveItem`; the base's `uploadFile` emits `file-created` on the success branch, does NOT emit `upload-cancelled`, and the caller's `cancelUpload` awaiter resolves `undefined` once the upload's tracker is removed by the success path — the file lands on the provider despite the cancel call, which is documented behaviour for non-cancellable upload paths

#### Scenario: cancel-before-register race is handled

- **WHEN** a caller invokes `uploadFile` and immediately calls `cancelUpload(transactionId)` in the synchronous turn after the first `uploading` event — before the strategy has finished its session-init HTTP round-trip and called `register(cancel)` on the base
- **THEN** the cancel is buffered on the tracker; when the strategy either (a) calls `register`, the base invokes the closure immediately, or (b) observes the base's `AbortSignal` during the session-init fetch and unwinds without completing the session — in either case a single `upload-cancelled` event fires and `uploadFile` rejects with `DatasourceError<T>{ tag: "cancelled" }`

### Requirement: `upload-cancelled` terminal event is declared on every provider's PayloadMap

The `CanonicalEventPayloads` shape SHALL declare a twelfth event name `"upload-cancelled"` with payload type `{ transactionId: string; bytesUploaded: number; bytesTotal: number; reason: "user" | "timeout" | "shutdown" }`. Every provider's entry in `PayloadMap` SHALL inherit this event name through the canonical shape; no provider-specific override is permitted. The event SHALL be terminal (not `streaming: true`), bypassing the engine's streaming coalescer the same way `file-created` and `upload-failed` do.

#### Scenario: upload-cancelled is on every provider's PayloadMap

- **WHEN** a type-test scans `PayloadMap[T]["upload-cancelled"]` for `T` in `"amazon-s3" | "google-drive" | "onedrive"`
- **THEN** every entry equals `{ transactionId: string; bytesUploaded: number; bytesTotal: number; reason: "user" | "timeout" | "shutdown" }`, and the existing `PayloadMap[T]` canonical-keys `toEqualTypeOf` tripwire is updated to enumerate 12 event names rather than 11

#### Scenario: upload-cancelled is terminal, not streaming

- **WHEN** the base emits `upload-cancelled` in response to a `cancelUpload` call
- **THEN** the `DatasourceEvent` envelope has `streaming` absent (not `true`); a subscriber reading the bus observes the event as a terminal signal that does not pass through the streaming coalescer throttle

### Requirement: `DatasourceErrorTag` gains `"cancelled"`

The `DatasourceErrorTag` union SHALL add a ninth tag `"cancelled"`. A `DatasourceError<T>` tagged `"cancelled"` SHALL have `retryable: false`. The base SHALL throw this error from `uploadFile(...)` when the upload terminates due to a `cancelUpload` call; strategies' `normalizeError` SHALL NOT tag any provider-native exception `"cancelled"` — the tag is reserved for base-originated cancellation.

#### Scenario: cancelled tag flows through system-retry and user-retry as terminal

- **WHEN** `services/fs-sync`'s scheduler consumes a job whose upload rejected with `tag: "cancelled"` and hands it to `classifySystemRetry` / `decideUserRetry`
- **THEN** `classifySystemRetry` returns `{ branch: "terminal" }` (unknown-to-system tag falls through), `decideUserRetry` returns `{ branch: "terminal", reason: "not-retryable" }` (`"cancelled" !== "provider-error"`), and the job ends as `failed` without further retry attempts

#### Scenario: DatasourceErrorTag tripwire test updated

- **WHEN** the existing `DatasourceErrorTag` `toEqualTypeOf` assertion in `packages/ipc-contracts/src/__tests__/datasources-engine.test-d.ts` runs against the updated taxonomy
- **THEN** the asserted union enumerates the nine tags (`"auth-expired" | "auth-revoked" | "not-found" | "conflict" | "unsupported" | "rate-limited" | "network-error" | "provider-error" | "cancelled"`) and the test passes

### Requirement: Strategies wire SDK-native cancellation via a `register(cancel)` callback

Each concrete strategy's `doUploadFileImpl` SHALL accept two new parameters: a `register(cancel: () => Promise<void>)` callback and an `AbortSignal`. The strategy SHALL:

- Call `register` exactly once, as early as possible after the provider-side upload state is created, passing a closure that invokes the provider's documented cancellation primitive (see per-strategy scenarios below).
- Pass the `AbortSignal` to HTTP calls that accept one (raw `fetch` for OneDrive chunk PUTs, raw `fetch` for Drive chunk PUTs, the `Upload` constructor's `abortController` for S3) so in-flight HTTP requests unblock promptly when the base aborts.
- NOT emit events directly in the cancel path (the base emits `upload-cancelled`; strategies remain emission-free per the engine's existing Requirement: *Template base class wraps every operation with emission, refresh, and error normalization*).

#### Scenario: S3 strategy registers Upload.abort() as its cancel closure

- **WHEN** `S3Client.doUploadFileImpl` constructs the `@aws-sdk/lib-storage` `Upload` and invokes `register`
- **THEN** the registered closure calls `upload.abort()`, which (via the SDK's internal `markUploadAsAborted`) sends `AbortMultipartUploadCommand` if `UploadId` was allocated — no orphan multipart state remains on S3

#### Scenario: OneDrive strategy registers DELETE sessionUrl as its cancel closure

- **WHEN** `OneDriveClient.doUploadFileImpl` creates the resumable session, receives `uploadUrl`, and invokes `register`
- **THEN** the registered closure issues `fetch(uploadUrl, { method: "DELETE" })` — per Graph documentation this cancels the session server-side, releasing the `uploadUrl` and any uploaded ranges

#### Scenario: Google Drive strategy registers DELETE sessionUrl as its cancel closure

- **WHEN** `GoogleDriveClient.doUploadFileImpl` initiates the resumable session, extracts the session URL from the `Location` header, and invokes `register`
- **THEN** the registered closure issues `fetch(sessionUrl, { method: "DELETE", headers: { "Content-Range": "bytes */<total>" } })` (or `"bytes */0"` when total is unknown) — per Drive documentation this cancels the session server-side

### Requirement: Engine's cancel is scoped to in-flight upload; sync-service queue coordination is out of scope

The engine's `cancelUpload` SHALL affect ONLY the currently-in-flight upload identified by `transactionId`. It SHALL NOT:

- Remove queued jobs from `services/fs-sync`'s scheduler.
- De-prioritise or re-order other pending uploads.
- Cascade into any sync-service state.

The queue-coordination behaviour (when cancel-a-file also means remove-from-queue) is owned by `services/fs-sync`'s `Scheduler.cancel(jobId)` path and is out of scope for this change. The engine primitive is a building block the scheduler calls into; it is not the whole story.

#### Scenario: Engine cancel leaves sync-service queue untouched

- **WHEN** `services/fs-sync` has a queued mirror-sync job about to execute upload A, another upload B running, and upload C queued behind; the host calls `cancelUpload(B.transactionId)` directly against the engine
- **THEN** only upload B aborts; A and C remain queued and the scheduler's state is unchanged; coordination of the queue is the caller's responsibility (typically via `services/fs-sync`'s own `Scheduler.cancel(B.jobId)` which in turn calls the engine's `cancelUpload`)
