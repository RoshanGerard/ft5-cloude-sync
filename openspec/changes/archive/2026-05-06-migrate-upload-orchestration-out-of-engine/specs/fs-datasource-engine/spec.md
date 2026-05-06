# fs-datasource-engine — Delta for `migrate-upload-orchestration-out-of-engine`

## ADDED Requirements

### Requirement: `uploadFile` is a one-shot stateless primitive

`BaseDatasourceClient.uploadFile(parent: Target, file: { path: string; name?: string; mimeType?: string }, options?: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void }): Promise<DatasourceFileEntry<T>>` SHALL be a one-shot wrapper around `withRefresh(() => doUploadFileImpl(parent, file, options))`. The base SHALL NOT mint a transaction-id, SHALL NOT maintain an `activeUploads` tracker map, SHALL NOT emit any of `uploading`, `file-created`, `upload-failed`, `upload-cancelled` from this code path, and SHALL NOT expose a `cancelUpload` method. Cancellation is consumer-driven via `options.signal`. Progress is consumer-observed via `options.onProgress`. The strategy returns the entry on success; rejections propagate as normalized `DatasourceError`.

The `withRefresh` wrapper is retained on `uploadFile` in this change. The follow-up `migrate-engine-retry-policy-to-consumer` covers retry-policy ownership; this change does not touch that wrapper.

#### Scenario: uploadFile resolves with the entry on success and emits no bus events

- **WHEN** a caller invokes `client.uploadFile(parent, { path: "/local/x.txt" }, { onProgress })` against a strategy whose `doUploadFileImpl` resolves with a valid `DatasourceFileEntry<T>`
- **THEN** the call resolves with that entry; the engine bus observes ZERO `uploading`, `file-created`, `upload-failed`, or `upload-cancelled` events for this upload; `onProgress` was invoked at least once during the upload with non-decreasing `loaded` values

#### Scenario: uploadFile rejects with the strategy's normalized error on failure and emits no bus events

- **WHEN** a caller invokes `client.uploadFile(...)` and the strategy's `doUploadFileImpl` throws a raw provider exception
- **THEN** the wrapper invokes `normalizeError(raw)` and rejects with the resulting `DatasourceError<T>`; the engine bus observes ZERO upload-related events

#### Scenario: uploadFile single-flight refreshes once on auth-expired

- **WHEN** two concurrent `uploadFile` calls on the same datasource each receive a raw exception that `normalizeError` tags `"auth-expired"`
- **THEN** `refreshToken` is invoked exactly once, both calls await the same refresh promise, both retry their `doUploadFileImpl` after refresh resolves, and a single `token-refreshed` event is emitted on the engine bus (`withRefresh` semantics unchanged from before this migration)

### Requirement: `doUploadFileImpl` signature is `(parent, file, options)` — no `register` callback

Each concrete strategy's `doUploadFileImpl` SHALL be declared:

```typescript
protected abstract doUploadFileImpl(
  parent: Target,
  file: { path: string; name?: string; mimeType?: string },
  options: {
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
  },
): Promise<DatasourceFileEntry<T>>;
```

The `register: (cancel: () => Promise<void>) => void` parameter SHALL NOT be present. Strategies SHALL forward `options.signal` (when provided) into the underlying SDK / fetch calls so consumer-aborted uploads unblock promptly. Strategies SHALL invoke `options.onProgress` (when provided) with `(loaded, total)` byte counts as bytes flow.

#### Scenario: doUploadFileImpl signature has no register parameter

- **WHEN** a Vitest `expectTypeOf` test asserts the signature of `doUploadFileImpl` against the abstract declaration on `BaseDatasourceClient`
- **THEN** the parameter list is exactly `(parent: Target, file: { path; name?; mimeType? }, options: { signal?: AbortSignal; onProgress?: (l, t) => void })`; no `register` parameter is present at any position

#### Scenario: signal forwarded to provider call unblocks promptly on abort

- **WHEN** a caller invokes `uploadFile(target, { path: "/local/large.bin" }, { signal })` and aborts `signal` mid-stream
- **THEN** the strategy's underlying SDK / fetch call rejects with an `AbortError` (or the SDK equivalent); the strategy throws `DatasourceError { tag: "cancelled", retryable: false }`; the rejection surfaces via `withRefresh` to the caller within 1 second of the abort

### Requirement: Strategy cleanup-on-abort uses a fresh AbortController with a 5s timeout

When a strategy's `doUploadFileImpl` allocates provider-side state that requires cleanup on cancellation (Drive resumable session URL, OneDrive resumable session URL, S3 multipart upload), the strategy SHALL register an `'abort'` listener on `options.signal` (`{ once: true }`). The listener SHALL issue the cleanup HTTP call against a **fresh** `AbortController` with a 5-second timeout, NOT against the user's `signal`. The cleanup is fire-and-forget from the user's perspective; failures are logged but do not affect the user-visible cancel outcome.

#### Scenario: OneDrive cleanup-DELETE uses a fresh AbortController

- **WHEN** a caller invokes `uploadFile` against `OneDriveClient` for a >4 MiB file (resumable-session path), the session URL is acquired, and the caller aborts the user signal mid-upload
- **THEN** the strategy issues `fetch(uploadUrl, { method: "DELETE", signal: <fresh AbortController.timeout(5000)> })`; the `signal` passed to the cleanup fetch is NOT the user's signal; on simulated provider response of 204 No Content within 5 seconds, the cleanup succeeds and is logged

#### Scenario: Drive cleanup-DELETE uses a fresh AbortController

- **WHEN** the analogous resumable-session path on `GoogleDriveClient` is aborted mid-upload
- **THEN** the strategy issues `fetch(sessionUrl, { method: "DELETE", headers: { "Content-Range": "bytes */*" }, signal: <fresh AbortController.timeout(5000)> })`; the user's signal is NOT used for the cleanup

#### Scenario: S3 cleanup uses upload.abort()

- **WHEN** an `S3Client.doUploadFileImpl` upload is aborted mid-stream via `options.signal`
- **THEN** the strategy invokes `upload.abort()` (which the `@aws-sdk/lib-storage` SDK uses to issue `AbortMultipartUploadCommand` if a `UploadId` was allocated); no user-signal coupling is required because the SDK manages its own controller internally

#### Scenario: Cleanup-DELETE timeout does not affect user-visible cancel

- **WHEN** the cleanup-DELETE timer expires (e.g., the provider takes longer than 5s to respond)
- **THEN** the cleanup is logged as a warning; the user-visible cancel completes regardless; the strategy's reject promise from `doUploadFileImpl` was already resolved with `cancelled` before the cleanup timer started

### Requirement: Strategy LRU path-handle invalidation on upload completion is internal

Drive and OneDrive strategies maintain a path-handle LRU cache. After this migration, LRU population on successful upload SHALL be performed internally inside `doUploadFileImpl` (calling `this.pathHandleCache.set(entry.path, entry.handle)` directly before returning), NOT via the engine bus. The strategies' constructor bus subscriptions SHALL drop the `file-created` arm. They SHALL retain the `deleted` arm — `deleteFile` continues to emit `deleted` on the engine bus (not migrated by this change).

#### Scenario: Drive LRU is populated by uploadFile success without engine bus emission

- **WHEN** an upload to Google Drive resolves successfully and returns an entry whose `path` was not previously in the strategy's LRU
- **THEN** the LRU contains `entry.path → entry.handle` after the call resolves; the engine bus observes ZERO `file-created` events for this upload (Decision 1)

#### Scenario: OneDrive LRU is populated by uploadFile success without engine bus emission

- **WHEN** an upload to OneDrive resolves successfully and returns an entry whose `path` was not previously in the strategy's LRU
- **THEN** the LRU contains `entry.path → entry.handle` after the call resolves; the engine bus observes ZERO `file-created` events for this upload

#### Scenario: Drive LRU is invalidated by deleteFile via engine bus subscription

- **WHEN** `deleteFile` succeeds for a path present in the strategy's LRU
- **THEN** the strategy's bus subscription on `deleted` invalidates the path's LRU entry (deleteFile is NOT migrated by this change and continues to emit on the engine bus)

## REMOVED Requirements

### Requirement: `DatasourceClient<T>` exposes `cancelUpload` for in-flight uploads

**Reason**: Removed entirely. Cancel is now consumer-driven via `options.signal` on `uploadFile`. The base class no longer maintains the `activeUploads` tracker map that backed `cancelUpload`; the strategies no longer register a cancel closure. See ADDED Requirement: `uploadFile` is a one-shot stateless primitive.

**Migration**: Callers of `client.cancelUpload(transactionId)` migrate to `abortController.abort()` on the controller they used to construct the upload's `options.signal`. There is one production caller of `cancelUpload`-shape behavior — the renderer's upload UX — which migrates to `sync:cancel-upload` at the service-IPC boundary (consuming the service-minted `uploadJobId`, not the engine's `transactionId`).

### Requirement: `upload-cancelled` terminal event is declared on every provider's PayloadMap

**Reason**: Removed entirely. The engine layer no longer emits `upload-cancelled` because cancellation is now consumer-driven (the consumer aborts its `AbortController` and sees the strategy reject with `tag: "cancelled"`). The fs-sync service handler emits `upload-cancelled` on its own `sync:event-stream` keyed by `uploadJobId` — that emission is specced in the `fs-sync-service` capability, not the engine.

**Migration**: PayloadMap shrinks by one entry. Consumers subscribing to `upload-cancelled` on the engine bus migrate to subscribing on `sync:event-stream` filtered by event name + `uploadJobId`.

### Requirement: Strategies wire SDK-native cancellation via a `register(cancel)` callback

**Reason**: Removed entirely. The `register(cancel)` parameter is gone from `doUploadFileImpl`'s signature. Strategies cancel via `options.signal` directly: signal is forwarded to the underlying SDK / fetch, and an `'abort'` listener on the signal performs cleanup against a fresh AbortController (see ADDED Requirement: Strategy cleanup-on-abort uses a fresh AbortController with a 5s timeout).

**Migration**: Each strategy's `doUploadFileImpl` body replaces `register(...)` calls with `options.signal?.addEventListener('abort', cleanup, { once: true })` and forwards `options.signal` directly into its SDK / fetch calls. Provider-native cancellation primitives are unchanged (Drive/OneDrive `DELETE <sessionUrl>`, S3 `upload.abort()`); only the way the strategy is wired to invoke them changes.

### Requirement: Engine's cancel is scoped to in-flight upload; sync-service queue coordination is out of scope

**Reason**: Removed entirely. The engine no longer exposes a cancel surface. Cancel ownership and queue coordination are entirely owned by the consumer (the fs-sync service handler). The new requirement that the consumer handles cancel via `AbortController` is specced in the `fs-sync-service` capability.

**Migration**: Tests asserting "engine cancel leaves sync-service queue untouched" delete; the analogous concern at the consumer layer is captured by the fs-sync-service spec's `sync:cancel-upload` requirements.

## MODIFIED Requirements

### Requirement: Public contract is the generic `DatasourceClient<T>` Strategy interface

The engine SHALL export a public interface `DatasourceClient<T extends DatasourceType>` with the methods `status`, `testConnection`, `authenticate`, `listDirectory`, `search`, `getMetadata`, `uploadFile`, `deleteFile`, `deleteDirectory`, `getQuota`, `rename`, and `downloadFile`. The methods `createFile` and `cancelUpload` are NOT present (deleted by this change). The type parameter `T` SHALL flow into every generic return payload (`FileEntry<T>`, `FileMetadata<T>`, and event payloads). Concrete implementations (`S3Client`, `OneDriveClient`, `GoogleDriveClient`) SHALL conform to this interface and SHALL be constructible only via the engine's factory — not via `new` directly by consumers.

#### Scenario: Every concrete client conforms to the shared interface

- **WHEN** a contract test in `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` enumerates every exported client class
- **THEN** each class is `assignable` to `DatasourceClient<its provider type>`, every method on the interface is present with the correct signature (no `createFile`, no `cancelUpload`), and a shared suite of scenarios (list, search, upload via signal-driven cancel, delete, error, rename, download with rangeStart, AbortSignal-driven download cancel) passes against each

#### Scenario: Consumers program to the interface, not the concrete class

- **WHEN** a Vitest test scans `apps/desktop/src/main/ipc/` and `services/fs-sync/src/commands/` for type annotations
- **THEN** handler call sites annotate the engine value as `DatasourceClient<DatasourceType>` (or a narrower union), not as `S3Client` / `OneDriveClient` / `GoogleDriveClient` directly

### Requirement: Template base class wraps every operation with emission, refresh, and error normalization

The engine SHALL provide `abstract class BaseDatasourceClient<T extends DatasourceType>` that concrete strategies extend. The base class SHALL wrap operations that emit lifecycle events (`deleteFile`, `rename`, `downloadFile`) such that it (a) emits a pre-operation event where applicable (e.g., `downloading`), (b) emits a post-operation event on success (`deleted`, `entry-renamed`, `file-downloaded`), (c) emits a `*-failed` event and throws `DatasourceError` on failure, (d) attempts single-flight token refresh exactly once on `auth-expired`, (e) calls `normalizeError(e)` to convert any raw exception to `DatasourceError` before emitting or throwing.

The `uploadFile` method is exempt from bus emission (per ADDED Requirement: `uploadFile` is a one-shot stateless primitive); it returns the entry directly without emitting any of `uploading`, `file-created`, `upload-failed`, or `upload-cancelled` from this layer. The `withRefresh` and `normalizeError` wrappers DO apply to `uploadFile`.

Concrete strategies SHALL implement only the `protected abstract doX(...)` methods plus `protected abstract refreshToken(): Promise<AuthResult>` and `protected abstract normalizeError(raw: unknown): DatasourceError<T>`. Strategies SHALL NOT emit events directly and SHALL NOT call the base's retry logic.

#### Scenario: Base does NOT emit upload events for uploadFile

- **WHEN** a concrete strategy's `doUploadFileImpl` resolves successfully or throws
- **THEN** the engine bus observes ZERO `uploading`, `file-created`, `upload-failed`, or `upload-cancelled` events for this upload (these events are emitted by the fs-sync service handler on `sync:event-stream`, not on the engine bus)

#### Scenario: Base emits download lifecycle events

- **WHEN** a concrete strategy's `doDownloadFileImpl` produces bytes flowing through the returned Readable
- **THEN** the engine bus observes the `downloading` streaming event and the appropriate terminal event (`file-downloaded`, `download-failed`, or `download-cancelled`) — download is unchanged by this migration

#### Scenario: Base retries once on auth-expired, serialized per datasource

- **WHEN** two concurrent operations each invoke `doX` on the same `datasourceId` and both throw an error that `normalizeError` tags `auth-expired`
- **THEN** `refreshToken` is called exactly once, both operations await the same refresh promise, both retry their `doX` after refresh resolves, a single `token-refreshed` event is emitted, and no second refresh is attempted on the retry — `withRefresh` semantics are unchanged by this migration

#### Scenario: Strategies do not emit events directly

- **WHEN** a Vitest test scans every concrete strategy class file
- **THEN** no `.emit(` or `this.bus.` reference is present; only the base class references the event bus

### Requirement: Hybrid `Target` type supports both path and handle addressing

The engine SHALL define `type Target = { kind: "path"; path: string } | { kind: "handle"; handle: string }` in `packages/ipc-contracts`. Every method that addresses a filesystem location (`listDirectory`, `getMetadata`, `uploadFile`, `deleteFile`, `deleteDirectory`, `search` scope) SHALL accept `Target` as its location parameter. `FileEntry<T>` SHALL always carry both `path: string` and `handle: string` so any entry returned by a list call can be re-addressed by either mechanism. Internally, each concrete strategy SHALL maintain an LRU path↔handle cache. Cache invalidation SHALL be wired as follows:

- On successful `uploadFile`: invalidation is internal — `doUploadFileImpl` populates the LRU directly inside its success branch, before returning. NO bus event drives invalidation in this path.
- On successful `deleteFile`: invalidation is bus-driven — the strategy's constructor subscribes to `deleted` on the engine bus and invalidates the entry's LRU on observation. (`deleteFile` is not migrated by this change and continues to emit on the engine bus.)
- The `createFile` invalidation path is no longer relevant: `createFile` is deleted by this change.

#### Scenario: listDirectory accepts a path target

- **WHEN** a caller invokes `client.listDirectory({ kind: "path", path: "/photos/2024" })` against a client whose datasource has that folder
- **THEN** the method resolves with a non-empty `FileEntry<T>[]` whose entries each carry both a `path` field starting with `/photos/2024/` and a non-empty `handle` string

#### Scenario: listDirectory accepts a handle target

- **WHEN** a caller obtains a `FileEntry<T>` from a prior `listDirectory` call, then invokes `client.listDirectory({ kind: "handle", handle: entry.handle })` where `entry.kind === "folder"`
- **THEN** the method resolves with the children of that folder, and no path-resolution round-trip is issued to the provider (observable in a spy-wrapped strategy test)

#### Scenario: Handle cache is populated by upload success internally

- **WHEN** a strategy's `doUploadFileImpl` resolves successfully with an entry whose `path` was not previously in the LRU
- **THEN** the LRU contains `entry.path → entry.handle` after the call resolves; the engine bus observes ZERO `file-created` events for the upload

#### Scenario: Handle cache is invalidated by deletion via engine bus

- **WHEN** a strategy successfully deletes an entry at a known path, then another operation addresses the same path
- **THEN** the strategy does NOT return the cached handle; the second operation re-resolves the path (observable by a spy on the provider's name-resolution API)

#### Scenario: Path ambiguity surfaces via providerMetadata, not a status-changed event

- **WHEN** a provider permits duplicate sibling names (e.g., Google Drive) and a `{kind: "path"}` `Target` resolves to more than one provider-side item under the same (parent, name) filter
- **THEN** the strategy selects the oldest hit (e.g., Drive orders by `createdTime asc`), populates the returned `FileEntry<T>.providerMetadata` with `ambiguous: true` and an `ambiguousSiblings` list containing the other items' handles, and emits NO `status-changed` (or any other) event for the ambiguity

### Requirement: `DatasourceErrorTag` gains `"cancelled"`

The `DatasourceErrorTag` union SHALL include the tag `"cancelled"`. A `DatasourceError<T>` tagged `"cancelled"` SHALL have `retryable: false`. The strategy's `doUploadFileImpl` SHALL throw this error when the upload terminates due to `options.signal` being aborted by the caller. Strategies' `normalizeError` SHALL NOT tag any provider-native exception `"cancelled"` — the tag is reserved for signal-driven cancellation paths.

#### Scenario: cancelled tag flows through fs-sync handler as terminal

- **WHEN** the fs-sync service handler awaits `client.uploadFile(...)` with an aborted `signal` and the strategy throws `DatasourceError { tag: "cancelled" }`
- **THEN** the handler emits `upload-cancelled` on `sync:event-stream` with `{ uploadJobId, bytesUploaded, bytesTotal, reason: "user" }`; the registry entry for `uploadJobId` is deleted; the handler's reply rejects with the cancelled error

#### Scenario: DatasourceErrorTag tripwire test updated

- **WHEN** the existing `DatasourceErrorTag` `toEqualTypeOf` assertion in `packages/ipc-contracts/src/__tests__/datasources-engine.test-d.ts` runs against the updated taxonomy
- **THEN** the asserted union enumerates the nine tags including `"cancelled"`; the cancellation source documented in the type's JSDoc reflects signal-driven cancel (no engine `cancelUpload` method)

### Requirement: Streaming events are throttled at 1 second OR 10% progress delta

The engine bus SHALL throttle streaming events emitted from operations that produce continuous byte-flow progress. Throttle scope post-migration: the `downloading` streaming event from `downloadFile`. (The `uploading` streaming event no longer flows through the engine bus per this change; throttle for upload progress is the consumer's concern at the fs-sync handler level.)

#### Scenario: Fast download emits at progress checkpoints regardless of time

- **WHEN** a download streams ≥2 MB of progress in <1 second (faster than the time threshold but exceeding the 10% threshold)
- **THEN** the engine bus emits at least one `downloading` event per 10% delta crossed; not all byte-level updates are emitted

#### Scenario: Slow download emits on the 1-second cadence

- **WHEN** a download streams ~10 KB/s (below the 10% threshold within 1 second)
- **THEN** the engine bus emits exactly one `downloading` event per second of stream lifetime, even though no 10% delta was crossed

#### Scenario: Terminal events bypass the throttle

- **WHEN** a download completes (terminal `file-downloaded`) or aborts (terminal `download-cancelled`)
- **THEN** the terminal event fires immediately regardless of throttle state, and any pending throttled streaming event is flushed before the terminal event

#### Scenario: Throttle keys by path, not just datasource

- **WHEN** two concurrent downloads on the same datasource emit `downloading` events
- **THEN** the throttle is independent per `path` — both streams emit at their own cadences without coalescing

### Requirement: Upload takes a local file path and streams from disk

`uploadFile(parent: Target, file: { path: string; name?: string; mimeType?: string }, options?)` SHALL accept an absolute local filesystem path. The engine SHALL stream the file from disk to the provider in chunks (implementation-defined, but MUST NOT buffer the entire file into memory). Progress is reported via `options.onProgress` (when provided) with `(loaded, total)` byte counts; `total` resolves at stream start from the file's size. The interface SHALL NOT accept a `Blob`, `Readable`, or any renderer-originated stream in this change.

#### Scenario: Upload does not buffer the full file

- **WHEN** a test uploads a 100 MB synthetic file and monitors the Node process's peak heap usage during the call
- **THEN** peak heap growth during the upload is significantly less than 100 MB (implementation-defined ceiling, e.g., ≤ 10 MB), demonstrating chunked streaming

#### Scenario: Upload rejects a non-path input shape

- **WHEN** a test invokes `uploadFile(target, new Blob([...]) as unknown as { path: string })`
- **THEN** TypeScript reports a type error at the call site, and the runtime receives `undefined` for `file.path` and throws a typed validation error before any provider call is issued

#### Scenario: onProgress is invoked with monotonic loaded values

- **WHEN** an `uploadFile` call provides `onProgress` and the strategy uploads bytes
- **THEN** `onProgress` is invoked at least once during the upload; consecutive invocations have non-decreasing `loaded` values; the final `loaded` equals `total` on success
