# fs-datasource-engine

## Purpose

The `fs-datasource-engine` capability is the shared, framework-agnostic main-process module that every datasource IPC handler calls into. It owns the public strategy interface (`DatasourceClient<T>`), the template base class that wraps every operation with event emission and single-flight token refresh, the factory and provider registry, the typed event bus with its streaming-throttle semantics, the credential-store port contract, the authentication-intent surface that keeps Electron UI out of the engine, and the normalized `DatasourceError` taxonomy. Concrete strategies for Amazon S3, OneDrive, and Google Drive conform to the interface; the engine lives at `packages/fs-datasource-engine` and imports only from `@ft5/ipc-contracts`, Node built-ins, and provider SDKs.
## Requirements
### Requirement: Engine is a framework-agnostic workspace package

The FS Datasource Engine SHALL live at `packages/fs-datasource-engine` as a pnpm workspace package. It SHALL import types from `packages/ipc-contracts` and SHALL NOT import from `electron`, `apps/desktop/*`, or any renderer-scoped specifier. The engine SHALL expose exactly one entry point: the public `DatasourceClient<T>` interface, the `ClientFactory.create(...)` constructor, the `EventBus` subscriber surface, and port types (`CredentialStore`, `AuthIntent`). Implementations of those ports are supplied by the Electron host at wiring time.

#### Scenario: No Electron imports in the engine package

- **WHEN** a Vitest test grep-scans every `.ts` file under `packages/fs-datasource-engine/src/` for import specifiers
- **THEN** no file imports from `electron`, `@electron/*`, or any path under `apps/desktop/`; the only runtime imports are `@ft5/ipc-contracts`, Node built-ins, and provider SDK packages (`@aws-sdk/client-s3`, `@microsoft/microsoft-graph-client`, `googleapis`)

#### Scenario: Engine is consumed only by main-process IPC handlers

- **WHEN** a Vitest test scans every `.ts` / `.tsx` file under `apps/desktop/src/renderer/` and `apps/desktop/src/preload/`
- **THEN** no file imports from `@ft5/fs-datasource-engine`; only files under `apps/desktop/src/main/` (specifically the IPC handlers) import the engine

### Requirement: Public contract is the generic `DatasourceClient<T>` Strategy interface

The engine SHALL export a public interface `DatasourceClient<T extends
DatasourceType>` with the methods `status`, `testConnection`, `authenticate`,
`listDirectory`, `search`, `getMetadata`, `createFile`, `uploadFile`,
`cancelUpload`, `deleteFile`, `deleteDirectory`, `getQuota`, `rename`, and
`downloadFile`. The type parameter
`T` SHALL flow into every generic return payload (`FileEntry<T>`,
`FileMetadata<T>`, and event payloads). Concrete implementations
(`S3Client`, `OneDriveClient`, `GoogleDriveClient`) SHALL conform to this
interface and SHALL be constructible only via the engine's factory — not
via `new` directly by consumers.

#### Scenario: Every concrete client conforms to the shared interface

- **WHEN** a contract test in `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` enumerates every exported client class
- **THEN** each class is `assignable` to `DatasourceClient<its provider type>`, every method on the interface (including the two added in this change) is present with the correct signature, and a shared suite of scenarios (list, search, upload, delete, error, rename, download with rangeStart, AbortSignal-driven cancel) passes against each

#### Scenario: Consumers program to the interface, not the concrete class

- **WHEN** a Vitest test scans `apps/desktop/src/main/ipc/` and `services/fs-sync/src/commands/` for type annotations
- **THEN** handler call sites annotate the engine value as `DatasourceClient<DatasourceType>` (or a narrower union), not as `S3Client` / `OneDriveClient` / `GoogleDriveClient` directly

### Requirement: Template base class wraps every operation with emission, refresh, and error normalization

The engine SHALL provide `abstract class BaseDatasourceClient<T extends DatasourceType>` that concrete strategies extend. Every public method SHALL be implemented on the base such that it (a) emits a `pre-operation` event (e.g., `uploading`, `deleting`) before calling the concrete `doX` method, (b) emits a `post-operation` event (`file-created`, `deleted`) on success, (c) emits a `*-failed` event and throws `DatasourceError` on failure, (d) attempts single-flight token refresh exactly once on `auth-expired`, (e) calls `normalizeError(e)` to convert any raw exception to `DatasourceError` before emitting or throwing.

Concrete strategies SHALL implement only the `protected abstract doX(...)` methods plus `protected abstract refreshToken(): Promise<AuthResult>` and `protected abstract normalizeError(raw: unknown): DatasourceError<T>`. Strategies SHALL NOT emit events directly and SHALL NOT call the base's retry logic.

#### Scenario: Base emits uploading, then file-created, on a successful upload

- **WHEN** a concrete strategy's `doUpload` resolves with a valid `FileEntry<T>`
- **THEN** the bus observes in order: at least one `uploading` event (streaming-tagged), exactly one `file-created` event with the returned entry's fields, and the method resolves with that entry

#### Scenario: Base emits upload-failed and throws normalized error on failure

- **WHEN** a concrete strategy's `doUpload` throws a raw provider exception
- **THEN** the bus observes at least one `uploading` event, then exactly one `upload-failed` event whose payload carries the `DatasourceError.tag`, and the caller receives a `DatasourceError<T>` (not the raw exception)

#### Scenario: Base retries once on auth-expired, serialized per datasource

- **WHEN** two concurrent operations each invoke `doX` on the same `datasourceId` and both throw an error that `normalizeError` tags `auth-expired`
- **THEN** `refreshToken` is called exactly once, both operations await the same refresh promise, both retry their `doX` after refresh resolves, a single `token-refreshed` event is emitted, and no second refresh is attempted on the retry

#### Scenario: Strategies do not emit events directly

- **WHEN** a Vitest test scans every concrete strategy class file
- **THEN** no `.emit(` or `this.bus.` reference is present; only the base class references the event bus

### Requirement: Hybrid `Target` type supports both path and handle addressing

The engine SHALL define `type Target = { kind: "path"; path: string } | { kind: "handle"; handle: string }` in `packages/ipc-contracts`. Every method that addresses a filesystem location (`listDirectory`, `getMetadata`, `createFile`, `uploadFile`, `deleteFile`, `deleteDirectory`, `search` scope) SHALL accept `Target` as its location parameter. `FileEntry<T>` SHALL always carry both `path: string` and `handle: string` so any entry returned by a list call can be re-addressed by either mechanism. Internally, each concrete strategy SHALL maintain an LRU path↔handle cache and invalidate it in response to `deleted` and `file-created` events it emits.

#### Scenario: listDirectory accepts a path target

- **WHEN** a caller invokes `client.listDirectory({ kind: "path", path: "/photos/2024" })` against a client whose datasource has that folder
- **THEN** the method resolves with a non-empty `FileEntry<T>[]` whose entries each carry both a `path` field starting with `/photos/2024/` and a non-empty `handle` string

#### Scenario: listDirectory accepts a handle target

- **WHEN** a caller obtains a `FileEntry<T>` from a prior `listDirectory` call, then invokes `client.listDirectory({ kind: "handle", handle: entry.handle })` where `entry.kind === "folder"`
- **THEN** the method resolves with the children of that folder, and no path-resolution round-trip is issued to the provider (observable in a spy-wrapped strategy test)

#### Scenario: Handle cache is invalidated by deletion

- **WHEN** a strategy successfully deletes an entry at a known path, then another operation addresses the same path
- **THEN** the strategy does NOT return the cached handle; the second operation re-resolves the path (observable by a spy on the provider's name-resolution API)

#### Scenario: Path ambiguity surfaces via providerMetadata, not a status-changed event

- **WHEN** a provider permits duplicate sibling names (e.g., Google Drive) and a `{kind: "path"}` `Target` resolves to more than one provider-side item under the same (parent, name) filter
- **THEN** the strategy selects the oldest hit (e.g., Drive orders by `createdTime asc`), populates the returned `FileEntry<T>.providerMetadata` with `ambiguous: true` and an `ambiguousSiblings` list containing the other items' handles, and emits NO `status-changed` (or any other) event for the ambiguity — the siblings remain reachable via subsequent `{kind: "handle"}` `Target` calls, and consumers detect the ambiguity by checking `providerMetadata.ambiguous` on the entry

#### Scenario: Mutation on an ambiguous path-form target is rejected; handle-form bypasses the check

- **WHEN** a mutating operation (e.g., `deleteFile`) targets a `{kind: "path"}` `Target` whose resolution would be ambiguous (multiple provider-side items at the terminal (parent, name))
- **THEN** the strategy rejects with a `DatasourceError` whose `tag` is `"conflict"`, whose `raw` payload includes all candidate handles in `ambiguousSiblings`, and whose `retryable` flag is `false`; no mutation is issued to the provider, and the caller is expected to re-address the desired file via `{kind: "handle"}` to disambiguate. Handle-form targets bypass this check entirely — they explicitly name one provider-side item.

#### Scenario: Search results and handle-form listings expose non-re-addressable synthesized paths

- **WHEN** a caller invokes `client.search(query)` or `client.listDirectory({kind: "handle", handle})` and the provider cannot supply a full engine-facing path for each result
- **THEN** the strategy synthesizes `path: "/<name>"` on each returned `FileEntry` (good enough for display), but this synthesized path is NOT guaranteed to resolve back to the same file via `{kind: "path"}`; callers re-addressing such entries MUST use `{kind: "handle", handle: entry.handle}` — which names the specific provider-side item — so the original file is reached regardless of its real path depth

### Requirement: Event schema is typed per provider via `PayloadMap`

The engine SHALL define event types generically: `type DatasourceEvent<T extends DatasourceType, K extends keyof PayloadMap[T]> = { event: K; datasourceType: T; datasourceId: string; ts: number; streaming?: true; payload: PayloadMap[T][K] }`. `PayloadMap` SHALL be declared in `packages/ipc-contracts` keyed by provider type → event name → payload shape. At minimum, the following event names SHALL be present for every provider: `uploading`, `upload-failed`, `file-created`, `deleted`, `delete-failed`, `authenticated`, `authentication-failed`, `token-refreshed`, `token-expired`, `status-changed`, `rate-limited`. Each payload SHALL carry provider-native fields (e.g., S3 emits `{ bucket, key, etag }` on `file-created`; Google Drive emits `{ fileId, mimeType, parents }`).

#### Scenario: Consumer narrowing works via switch

- **WHEN** a subscriber receives a `DatasourceEvent` and switches on `e.datasourceType`
- **THEN** within the `case "amazon-s3":` branch the compiler narrows `e.payload` to S3's payload shape, within the `case "google-drive":` branch the compiler narrows to Drive's shape, with no manual casting

#### Scenario: Adding a new provider requires only a PayloadMap entry

- **WHEN** a hypothetical fourth provider is added in a test fixture by extending `PayloadMap` with a new key and registering a new strategy
- **THEN** the engine's bus, base class, factory, and existing subscribers compile unchanged; only the new strategy and its `PayloadMap[newProvider]` entry are authored

#### Scenario: `authentication-failed` payload carries the full serialized error

- **WHEN** the engine emits an `authentication-failed` event (from any of: failed `authenticate()`, failed intent-completion, or failed single-flight refresh)
- **THEN** the payload is a `SerializedDatasourceError<T>` carrying `{ tag, datasourceType, datasourceId, retryable, retryAfterMs?, raw?, message }` — not a bare reason string; subscribers reconstruct recovery affordances from the fields and do NOT rely on `instanceof DatasourceError` (structured-clone across IPC drops the class identity)

### Requirement: Streaming events are throttled at 1 second OR 10% progress delta

Events tagged `streaming: true` SHALL pass through a coalescing filter in the `EventBus` keyed by `(datasourceId, transactionId)`. The filter SHALL emit the current event when EITHER (a) at least 1 second has elapsed since the previous emission for that key, OR (b) the `progress` field (if present in the payload) has changed by at least 10 percentage points since the previous emission for that key. Terminal events — events whose `event` name ends in `-created`, `-failed`, `token-refreshed`, `token-expired`, or `deleted` — SHALL bypass the throttle entirely and be delivered immediately on emission, even if a throttled event for the same key is pending.

#### Scenario: Fast upload emits at progress checkpoints regardless of time

- **WHEN** a test emits 20 `uploading` events over 300 ms with progress values 0%, 5%, 10%, 15%, ..., 95%, 100%
- **THEN** subscribers observe at most the events at 10% boundaries (0, 10, 20, ..., 90) plus the final terminal `file-created` event; fewer if some fall inside a <10% delta window

#### Scenario: Slow upload emits on the 1-second cadence

- **WHEN** a test emits `uploading` events once per 200 ms over 3 seconds with progress creeping from 0% to 1.5%
- **THEN** subscribers observe approximately one event per second plus the terminal `file-created` event; the sub-10% progress deltas do not block time-based emission

#### Scenario: Terminal events bypass the throttle

- **WHEN** an `uploading` streaming event is emitted 100 ms after the last delivery and a `file-created` terminal event is emitted 10 ms later
- **THEN** the `file-created` event is delivered to subscribers immediately (within one microtask of emission), regardless of the 1-second window for the streaming event

#### Scenario: Throttle keys by transaction, not just datasource

- **WHEN** two concurrent uploads on the same `datasourceId` (different `transactionId`s) each emit streaming events every 200 ms
- **THEN** each transaction's stream is coalesced independently; the 1-second window of one upload does not suppress the other's emissions

### Requirement: Authentication returns an `AuthIntent`; engine never opens UI

The `authenticate()` method SHALL return an `AuthIntent` discriminated union: `{ kind: "oauth"; authorizeUrl: string; completeWith(code: string): Promise<AuthResult> } | { kind: "credentials-form"; schema: CredentialsSchema; submit(values: Record<string, unknown>): Promise<AuthResult> }`. The engine SHALL NOT import `electron.shell`, SHALL NOT construct a `BrowserWindow`, and SHALL NOT open any URL or render any form. The host (Electron main) SHALL consume the intent, render the appropriate UI, and invoke `completeWith` or `submit` with the user-obtained value. On successful completion, the resolved `AuthResult` SHALL be persisted via `CredentialStore.put` before the `authenticated` event is emitted.

#### Scenario: OAuth intent is host-completed

- **WHEN** a caller invokes `client.authenticate()` on a Google Drive client and receives `{ kind: "oauth", authorizeUrl, completeWith }`, then invokes `completeWith("mock-auth-code-12345")`
- **THEN** the promise resolves with an `AuthResult` containing access and refresh tokens, `CredentialStore.put` has been called exactly once with that result, and the `authenticated` event is emitted after the put resolves

#### Scenario: Credentials-form intent is host-completed

- **WHEN** a caller invokes `client.authenticate()` on an S3 client and receives `{ kind: "credentials-form", schema: "aws-access-key", submit }`, then invokes `submit({ accessKeyId: "...", secretAccessKey: "..." })`
- **THEN** the promise resolves with an `AuthResult`, `CredentialStore.put` is called once, and the `authenticated` event is emitted

#### Scenario: Engine never imports Electron shell or BrowserWindow

- **WHEN** a grep test scans `packages/fs-datasource-engine/src/` for `electron`, `BrowserWindow`, `shell.openExternal`
- **THEN** no match is found

### Requirement: Token refresh is single-flight per datasource

When `normalizeError` tags an exception `auth-expired`, the Template base SHALL attempt exactly one refresh via the concrete strategy's `refreshToken()` and retry the original operation once. Concurrent `auth-expired` failures on the same `datasourceId` SHALL share a single refresh promise: only one `refreshToken()` call is issued, and all waiting operations resume with the refreshed credentials. The refreshed `AuthResult` SHALL be persisted via `CredentialStore.put` before the retry runs. On a successful refresh and retry, a single `token-refreshed` event SHALL be emitted. On refresh failure, `token-expired` and `authentication-failed` events SHALL be emitted and the original operation's `DatasourceError.AuthExpired` SHALL propagate to the caller.

#### Scenario: Concurrent 401s trigger exactly one refresh

- **WHEN** 5 operations on the same client concurrently throw `auth-expired`
- **THEN** `refreshToken` is invoked exactly once (observable via spy), 1 `token-refreshed` event is emitted, and all 5 operations resolve with their retry results

#### Scenario: Refresh is persisted before retry

- **WHEN** a refresh succeeds and the retry of the original operation is about to begin
- **THEN** `CredentialStore.put` has been awaited with the new `AuthResult` (observable via ordering spy)

#### Scenario: Refresh failure throws AuthExpired and emits both events

- **WHEN** `refreshToken` throws
- **THEN** the caller's operation rejects with a `DatasourceError` whose `tag === "auth-expired"`, exactly one `token-expired` event is emitted, exactly one `authentication-failed` event is emitted, and `CredentialStore.put` is NOT called with any new value

### Requirement: Normalized `DatasourceError` with 8-tag taxonomy

The engine SHALL expose `class DatasourceError<T extends DatasourceType = DatasourceType> extends Error` from `packages/ipc-contracts`. Instances SHALL carry `tag: DatasourceErrorTag`, `datasourceType: T`, `datasourceId: string`, `retryable: boolean`, `retryAfterMs?: number`, and `raw?: unknown`. `DatasourceErrorTag` SHALL be exposed as an `as const` object (matching the codebase convention for `FILES_CHANNELS` / `DATASOURCES_CHANNELS`) with a derived type:

```typescript
export const DatasourceErrorTag = {
  AuthExpired: "auth-expired",
  AuthRevoked: "auth-revoked",
  NotFound: "not-found",
  Conflict: "conflict",
  Unsupported: "unsupported",
  RateLimited: "rate-limited",
  NetworkError: "network-error",
  ProviderError: "provider-error",
  Cancelled: "cancelled",
  InvalidDatasource: "invalid-datasource",
} as const;
export type DatasourceErrorTag =
  (typeof DatasourceErrorTag)[keyof typeof DatasourceErrorTag];
```

Every concrete strategy's `normalizeError(e: unknown)` SHALL return an instance of this class; strategies SHALL NOT throw raw provider exceptions from their `doX` methods as observed by the base class. The new `invalid-datasource` member SHALL be reserved for engine-construction-time misconfiguration (see "Factory + Registry construct clients by provider id" requirement); per-strategy `normalizeError` SHALL NOT emit `invalid-datasource` from operational provider exceptions — those continue to map to `auth-revoked`, `network-error`, `rate-limited`, etc.

#### Scenario: Every strategy normalizes raw exceptions

- **WHEN** a contract test injects a raw provider exception of each documented kind into each strategy's `normalizeError`
- **THEN** the returned instance is a `DatasourceError`, its `tag` matches the documented mapping, `retryable` is `true` exactly when `tag ∈ { "rate-limited", "network-error" }`, and `raw` is the original exception

#### Scenario: Unknown provider exceptions fall through to provider-error

- **WHEN** an unrecognized exception is passed to `normalizeError`
- **THEN** the returned instance has `tag === "provider-error"`, `retryable === false`, and `raw` is the original exception

#### Scenario: DatasourceErrorTag is a const object with derived type

- **WHEN** a typed test imports `DatasourceErrorTag` and asserts its shape
- **THEN** `typeof DatasourceErrorTag` is the const object literal type, `DatasourceErrorTag.InvalidDatasource === "invalid-datasource"`, the derived `type DatasourceErrorTag` is assignable to and from each member's literal value, and existing literal call sites such as `tag === "auth-revoked"` continue to type-check unchanged

#### Scenario: Strategies do not emit invalid-datasource from operational errors

- **WHEN** a contract test enumerates each strategy's `normalizeError` mapping
- **THEN** no path in any strategy returns `tag === "invalid-datasource"`; the tag is reserved for the engine factory and the service-side `resolveClient` adapter

### Requirement: `deleteDirectory` and unsupported `getQuota` throw `Unsupported`

`deleteDirectory(target: Target)` SHALL throw `DatasourceError` with `tag === "unsupported"` for every provider in this change regardless of the target. `getQuota()` SHALL throw the same when called on a client whose `providerDescriptor.capabilities.quota === false`. The thrown error's `raw` field MAY carry a human-readable reason (e.g., `"disabled-for-product-stability"` vs `"not-supported-by-provider"`) but the `tag` SHALL be identical in both cases. No `*-failed` event SHALL be emitted for `Unsupported` errors (they are user-input errors, not operational failures).

#### Scenario: deleteDirectory always throws Unsupported

- **WHEN** any concrete client's `deleteDirectory({ kind: "path", path: "/anything" })` is invoked
- **THEN** the method throws a `DatasourceError` with `tag === "unsupported"`, and no `deleted` or `delete-failed` event is emitted

#### Scenario: getQuota throws Unsupported on S3

- **WHEN** `client.getQuota()` is invoked on an `S3Client`
- **THEN** the method throws a `DatasourceError` with `tag === "unsupported"`, and no `status-changed` event is emitted

#### Scenario: getQuota succeeds on providers with quota

- **WHEN** `client.getQuota()` is invoked on a `GoogleDriveClient` with valid credentials
- **THEN** the method resolves with a `Quota` object carrying `used: number` and `quota: number`, both non-negative integers

### Requirement: Factory + Registry construct clients by provider id

The engine SHALL expose `ClientFactory.create(providerId: ProviderId, credentials: StoredCredentials, ctx: EngineContext): DatasourceClient<T>` where `EngineContext = { bus: EventBus; credentialStore: CredentialStore }`. A `ProviderRegistry` (internal to the engine) SHALL map each known `ProviderId` to the corresponding factory function.

`ClientFactory.create` SHALL throw `DatasourceError` with `tag === "invalid-datasource"` when EITHER (a) the supplied `providerId` is not present in the registry, OR (b) the supplied `credentials` value fails the per-provider shape validation declared by the registry entry (e.g., S3 credentials missing `accessKeyId`, Drive credentials missing `accessToken`). The thrown error's `retryable` SHALL be `false`; the `message` field SHALL identify which condition fired (e.g., `"unknown provider \"dropbox\""` vs `"google-drive credential is missing accessToken"`); `raw` MAY carry a structured detail object for diagnostics.

Adding a new provider SHALL require exactly (a) a new concrete strategy class, (b) a new `PayloadMap[providerId]` entry in `ipc-contracts`, (c) a new registry entry, and (d) a credential-shape validator function on the registry entry — no other engine files change.

#### Scenario: Factory returns a configured client

- **WHEN** `ClientFactory.create("amazon-s3", creds, { bus, credentialStore })` is called with valid S3 credentials
- **THEN** the returned value is an instance of `S3Client`, assignable to `DatasourceClient<"amazon-s3">`, whose subsequent event emissions flow through the supplied bus

#### Scenario: Unknown provider id throws InvalidDatasource

- **WHEN** `ClientFactory.create("dropbox" as ProviderId, creds, ctx)` is called (casting to satisfy the type)
- **THEN** the call throws a `DatasourceError` with `tag === "invalid-datasource"`, `retryable === false`, and a `message` that names the unknown provider id

#### Scenario: Wrong-shape credential throws InvalidDatasource

- **WHEN** `ClientFactory.create("google-drive", { accessKeyId: "AKIA…", secretAccessKey: "…" } as unknown as StoredCredentials, ctx)` is called (S3 credentials supplied for a Drive datasource — type-cast to bypass the compile-time guard)
- **THEN** the call throws a `DatasourceError` with `tag === "invalid-datasource"`, `retryable === false`, and a `message` that identifies the failing field (e.g., `"google-drive credential is missing accessToken"`); no client is constructed and no bus event is emitted

### Requirement: IPC handlers call into the engine, preserving contract shapes

All main-process IPC handlers under `apps/desktop/src/main/ipc/files/` and `apps/desktop/src/main/ipc/datasources/` SHALL call into the engine for their authoritative behaviour. The handlers SHALL NOT contain hard-coded fixture arrays, SHALL NOT import provider SDKs directly, and SHALL translate between the engine's `DatasourceClient` surface and the IPC contract types owned by `ipc-contracts` (`DatasourcesListResponse`, `FilesListResponse`, etc.). Contract shapes defined by `datasources-ui` and `ui-file-explorer` SHALL remain unchanged by this requirement — only handler bodies change.

#### Scenario: Handlers forward to the engine

- **WHEN** a Vitest test spies on `ClientFactory.create` and on a per-provider mock strategy, then invokes the `files:list` handler with a valid `datasourceId` and `path`
- **THEN** the factory is invoked exactly once for that datasource (or a cached instance is reused), the strategy's `listDirectory` is invoked exactly once with a `Target` of `{ kind: "path", path }`, and the handler's response conforms to `FilesListResponse`

#### Scenario: No provider SDK imports in IPC handlers

- **WHEN** a grep test scans every file under `apps/desktop/src/main/ipc/`
- **THEN** no file imports from `googleapis`, `@microsoft/microsoft-graph-client`, or `@aws-sdk/client-s3`; these specifiers only appear inside `packages/fs-datasource-engine`

### Requirement: Events bridge from engine to renderer via `datasources:event`

The engine's `EventBus` SHALL be bridged to the renderer by a main-process forwarder that subscribes to every event (streaming and terminal) and transmits it over a one-way IPC channel named `datasources:event`. Payloads SHALL be structured-clone-safe (no functions, no class instances beyond plain data and `DatasourceError`'s serializable fields). The preload SHALL expose `window.api.datasources.onEvent(callback): () => void` via `contextBridge`, returning an unsubscribe function. The subscribed callback SHALL receive events narrowed by the same `DatasourceEvent<T, K>` type as the engine's in-process subscribers.

#### Scenario: Events flow to renderer callbacks

- **WHEN** a test subscribes to `window.api.datasources.onEvent(cb)` and the engine emits a `file-created` event in the main process
- **THEN** the callback is invoked once with an event whose `event === "file-created"` and whose `datasourceType`, `datasourceId`, and `payload` fields match the emission

#### Scenario: Unsubscribe stops delivery

- **WHEN** the returned unsubscribe function is called and a subsequent event is emitted in main
- **THEN** the callback is not invoked again

#### Scenario: Structured-clone safety

- **WHEN** a test emits an event whose `raw` field is a plain object
- **THEN** the renderer receives a structurally-equal plain object (not a reference); emitting a `raw` containing a function SHALL cause the forwarder to strip the function (best-effort) or refuse to forward (strict) — behaviour SHALL be documented and tested

### Requirement: Upload takes a local file path and streams from disk

`uploadFile(parent: Target, file: { path: string; name?: string; mimeType?: string })` SHALL accept an absolute local filesystem path. The engine SHALL stream the file from disk to the provider in chunks (implementation-defined, but MUST NOT buffer the entire file into memory). Progress events SHALL reference bytes transferred vs `file.size` resolved at stream start. The interface SHALL NOT accept a `Blob`, `Readable`, or any renderer-originated stream in this change.

#### Scenario: Upload does not buffer the full file

- **WHEN** a test uploads a 100 MB synthetic file and monitors the Node process's peak heap usage during the call
- **THEN** peak heap growth during the upload is significantly less than 100 MB (implementation-defined ceiling, e.g., ≤ 10 MB), demonstrating chunked streaming

#### Scenario: Upload rejects a non-path input shape

- **WHEN** a test invokes `uploadFile(target, new Blob([...]))` (cast to satisfy types)
- **THEN** TypeScript reports a type error at the call site, and the runtime receives `undefined` for `file.path` and throws a typed validation error before any provider call is issued

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

### Requirement: Google Drive strategy persists the issued OAuth scope on the credential

The `GoogleDriveClient` SHALL capture the issued OAuth scope from every Google token-endpoint response (initial code exchange and refresh-token grant) and persist it to the credential at `authResult.meta.scope` as the verbatim space-separated scope string returned by Google. Concrete strategies SHALL NOT compute scope themselves; they SHALL only forward what Google returns.

For credentials whose `authResult.meta.scope` is unset (legacy credentials predating this requirement), the strategy SHALL on the first call to `status` or `testConnection` per process lifetime call `https://oauth2.googleapis.com/tokeninfo?access_token=<accessToken>`, read the `scope` field from the JSON response, and persist it via the credential-store port. The strategy SHALL NOT call `tokeninfo` again for a credential whose `meta.scope` is set; subsequent reads MUST come from `meta.scope`.

If `tokeninfo` returns a non-2xx response with `error: "invalid_token"` (or equivalent), the strategy SHALL throw `DatasourceError` with `tag: "auth-revoked"` (the existing token-revoked path). If `tokeninfo` fails with a network error, the strategy SHALL throw `DatasourceError` with `tag: "network-error"` and SHALL NOT persist any partial state — the next `status` call retries the backfill.

#### Scenario: New token exchange persists scope

- **WHEN** `exchangeCodeForTokens` receives a token-endpoint response with body `{ "access_token": "...", "refresh_token": "...", "scope": "https://www.googleapis.com/auth/drive openid email", "expires_in": 3599 }`
- **THEN** the resulting `AuthResult.meta.scope` equals `"https://www.googleapis.com/auth/drive openid email"` exactly, and the in-memory `creds.scope` is updated to the same value

#### Scenario: Token refresh persists scope

- **WHEN** `refreshTokenImpl` receives a token-endpoint response that includes a `scope` field
- **THEN** the returned `AuthResult.meta.scope` carries that string and the strategy's in-memory `creds.scope` is updated

#### Scenario: Legacy credential without `meta.scope` is backfilled via tokeninfo on first status

- **GIVEN** a `GoogleDriveClient` constructed from a credential whose `authResult.meta` has `clientId`, `clientSecret`, `redirectUri` but no `scope` field
- **WHEN** `status()` is called for the first time and the injected fetch implementation responds to `https://oauth2.googleapis.com/tokeninfo?access_token=<accessToken>` with `200 { scope: "https://www.googleapis.com/auth/drive.file" }`
- **THEN** the credential-store port's `put` method is called once with a credential whose `authResult.meta.scope === "https://www.googleapis.com/auth/drive.file"`, and on a subsequent `status()` call the `tokeninfo` URL is NOT fetched again

#### Scenario: tokeninfo with invalid_token surfaces auth-revoked

- **GIVEN** a `GoogleDriveClient` whose credential has no `meta.scope`
- **WHEN** `status()` is called and the injected fetch returns `400 { error: "invalid_token" }` from the `tokeninfo` URL
- **THEN** `status()` rejects with a `DatasourceError` whose `tag === "auth-revoked"` and `retryable === false`

#### Scenario: tokeninfo network error surfaces network-error and does not persist

- **GIVEN** a `GoogleDriveClient` whose credential has no `meta.scope`
- **WHEN** `status()` is called and the injected fetch rejects with a system error (`{ code: "ECONNRESET" }`)
- **THEN** `status()` rejects with a `DatasourceError` whose `tag === "network-error"`, the credential-store `put` method is NOT called, and a subsequent `status()` call re-attempts the `tokeninfo` request

### Requirement: Google Drive status / testConnection fail-fast on insufficient scope

When `status()` or `testConnection()` is invoked on a `GoogleDriveClient`, the strategy SHALL — before issuing the existing `about.get` probe — assert that the credential's stored scope grants the engine's mutating operations. The check is satisfied if and only if the space-separated `meta.scope` string contains the literal token `https://www.googleapis.com/auth/drive` (string equality on a space-tokenized split, NOT a prefix match). Other Drive scopes (`drive.file`, `drive.readonly`, `drive.metadata.readonly`, `drive.appdata`) SHALL be considered insufficient on their own, even if combined with each other, because the engine performs `createFile`, `uploadFile`, and `deleteFile` operations.

When the check fails, the strategy SHALL throw a `DatasourceError` constructed with:
- `tag: "auth-revoked"`
- `retryable: false`
- `raw: { kind: "scope-insufficient", requiredScope: "https://www.googleapis.com/auth/drive", actualScope: <verbatim string from meta.scope> }`
- `message`: a human-readable string explaining that Drive permissions are too narrow and the user needs to reconnect with full access

When the check passes, behavior is unchanged: the strategy proceeds to call `about.get({ fields: "storageQuota" })` and returns `"connected"` (for `status`) or resolves (for `testConnection`).

#### Scenario: Sufficient scope passes the check

- **GIVEN** a `GoogleDriveClient` whose `meta.scope === "https://www.googleapis.com/auth/drive"`
- **WHEN** `status()` is called
- **THEN** no `tokeninfo` request is made, the existing `about.get` probe is issued, and the method resolves with `"connected"`

#### Scenario: Sufficient scope embedded in a multi-scope grant passes the check

- **GIVEN** a `GoogleDriveClient` whose `meta.scope === "openid email https://www.googleapis.com/auth/drive profile"`
- **WHEN** `status()` is called
- **THEN** the method resolves with `"connected"` (the full `drive` scope is one of several space-separated tokens)

#### Scenario: drive.file alone is insufficient

- **GIVEN** a `GoogleDriveClient` whose `meta.scope === "https://www.googleapis.com/auth/drive.file"`
- **WHEN** `status()` is called
- **THEN** the method rejects with `DatasourceError` whose `tag === "auth-revoked"`, `retryable === false`, `raw.kind === "scope-insufficient"`, `raw.requiredScope === "https://www.googleapis.com/auth/drive"`, `raw.actualScope === "https://www.googleapis.com/auth/drive.file"`, and `about.get` is NOT called

#### Scenario: drive.readonly is insufficient

- **GIVEN** a `GoogleDriveClient` whose `meta.scope === "https://www.googleapis.com/auth/drive.readonly"`
- **WHEN** `testConnection()` is called
- **THEN** the method rejects with `DatasourceError` whose `tag === "auth-revoked"` and `raw.kind === "scope-insufficient"`

#### Scenario: Combined narrow scopes are still insufficient

- **GIVEN** a `GoogleDriveClient` whose `meta.scope === "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly"`
- **WHEN** `status()` is called
- **THEN** the method rejects with `tag === "auth-revoked"` and `raw.kind === "scope-insufficient"` (no narrow combination satisfies the requirement)

#### Scenario: Status-changed event carries the auth-revoked tag on scope-insufficient rejection

- **GIVEN** a `GoogleDriveClient` configured for emission via the engine bus, whose `meta.scope` is `drive.file`
- **WHEN** `status()` is called and rejects with the scope-insufficient `auth-revoked`
- **THEN** the bus observes exactly one `status-changed` event whose payload is `{ status: "error", error: "auth-revoked" }` (the engine's existing `BaseDatasourceClient.status()` catch path emits `status-changed`, not `authentication-failed`; bus subscribers receive only the tag, while the full structured `raw: { kind: "scope-insufficient", requiredScope, actualScope }` discriminator is carried on the THROWN `DatasourceError` and is verified by the rejection scenarios above)

### Requirement: Google Drive OAuth flow uses PKCE (RFC 7636, S256)

The Google Drive strategy's `doAuthenticateImpl` SHALL generate a fresh `code_verifier` per consent attempt (48 random bytes encoded as base64url, yielding 64 URL-safe characters) and include `code_challenge=base64url(SHA256(verifier))` with `code_challenge_method=S256` in the authorize URL. The `completeWith(code)` closure returned by the intent SHALL pass the same `code_verifier` as a `code_verifier` form field on the token-exchange POST to `https://oauth2.googleapis.com/token`. The verifier SHALL be held only as captured closure state for the lifetime of the intent; it SHALL NOT be persisted via `CredentialStore`, logged, emitted on any event, or returned in the `AuthResult`.

#### Scenario: Authorize URL carries S256 challenge parameters

- **WHEN** a test invokes `GoogleDriveClient.authenticate()` and parses the resulting `authorizeUrl`
- **THEN** the URL's query string contains `code_challenge_method=S256` and a `code_challenge` value that is exactly `base64url(SHA256(code_verifier))` where `code_verifier` is the verifier captured inside the returned `completeWith` closure — the 43-character base64url-encoded SHA256 output, with no padding

#### Scenario: Verifier threads into the token exchange

- **WHEN** a test's injected `fetchImpl` intercepts the POST to `https://oauth2.googleapis.com/token` triggered by `intent.completeWith("fake-code")`
- **THEN** the request body (parsed as `application/x-www-form-urlencoded`) contains exactly one `code_verifier` field whose value matches the verifier embedded in the authorize URL's `code_challenge`

#### Scenario: Fresh verifier per call

- **WHEN** two consecutive `authenticate()` calls on the same `GoogleDriveClient` instance return two intents
- **THEN** the two intents' authorize URLs carry two different `code_challenge` values, derived from two different verifiers

#### Scenario: Verifier is never stored or logged

- **WHEN** a grep scan examines `packages/fs-datasource-engine/src/strategies/googledrive-client.ts` and the project's credentials file after a successful consent
- **THEN** no `code_verifier` value is present in the persisted `StoredCredentials` (neither at the top level nor under `authResult.meta`), no `console.log` / `emit` / `trace` call references the verifier, and the only code path that reads the verifier is the `completeWith` closure's call to `exchangeCodeForTokens`

### Requirement: Factory exposes `createForAuth` for no-credentials authenticate flows

The engine SHALL expose `ClientFactory.createForAuth(providerId: ProviderId, oauthAppConfig: OAuthAppConfig | null, ctx: EngineContext): DatasourceClient<T>` as a sibling to the existing `ClientFactory.create`. `OAuthAppConfig` SHALL be the typed shape `{ clientId: string; clientSecret: string; redirectUri: string }`. The new factory method exists exclusively for the case where the caller has no `StoredCredentials` yet — that is, the very first call to `engine.authenticate()` for a brand-new datasource — and SHALL NOT consult the credential store.

For OAuth-class providers (`google-drive`, `onedrive`), `oauthAppConfig` SHALL be required (non-null); the strategy SHALL receive it via a typed `PreAuthConfig` constructor slot distinct from `StoredCredentials.meta`. For credentials-form providers (`amazon-s3`), `oauthAppConfig` SHALL be `null`; the strategy SHALL be constructed with no credentials.

The strategy's `doAuthenticateImpl()` SHALL be reachable from a client constructed via `createForAuth` without the existing `readCredsFromStored` empty-field rejection. For OAuth providers, `doAuthenticateImpl()` SHALL read `clientId`, `clientSecret`, and `redirectUri` from the `PreAuthConfig` slot (NOT from `StoredCredentials.meta`) when constructing the authorize URL and the token-exchange request. For credentials-form providers, `doAuthenticateImpl()` SHALL return a `CredentialsFormIntent` whose `submit(values)` validates and persists the supplied values via the engine's existing `decorateIntent` pathway.

Adding a new provider type SHALL continue to require exactly the four touch points named under the existing factory requirement, with one additional concern: the registry entry SHALL declare whether the provider is OAuth-class or credentials-form-class so `createForAuth` can validate the `oauthAppConfig` argument.

#### Scenario: OAuth provider built via createForAuth produces a usable OAuthIntent

- **WHEN** `ClientFactory.createForAuth("google-drive", { clientId: "abc", clientSecret: "def", redirectUri: "http://127.0.0.1:55555/callback" }, { bus, credentialStore })` is called and the returned client's `authenticate()` is invoked
- **THEN** the returned `AuthIntent` has `kind === "oauth"`; the `authorizeUrl` contains `client_id=abc` and `redirect_uri=http%3A%2F%2F127.0.0.1%3A55555%2Fcallback` and the PKCE `code_challenge` parameters; the `completeWith(code)` closure threads the same `code_verifier` and `clientSecret` into the token exchange; no read of `credentialStore` occurs during construction or during `authenticate()`

#### Scenario: Credentials-form provider built via createForAuth produces a CredentialsFormIntent

- **WHEN** `ClientFactory.createForAuth("amazon-s3", null, { bus, credentialStore })` is called and the returned client's `authenticate()` is invoked
- **THEN** the returned `AuthIntent` has `kind === "credentials-form"` and exposes a `submit(values)` closure plus the form-field schema; `submit({ accessKeyId, secretAccessKey, region })` validates the values, performs the existing `HeadBucket` connection check, and on success the engine's `decorateIntent` writes the resulting `AuthResult` via `credentialStore.put(datasourceId, …)` exactly once

#### Scenario: createForAuth rejects a null oauthAppConfig for an OAuth provider

- **WHEN** `ClientFactory.createForAuth("google-drive", null, ctx)` is called (passing null for an OAuth-class provider)
- **THEN** the call throws `DatasourceError` with `tag === "invalid-datasource"`, `retryable === false`, and a message identifying the missing OAuth app config

#### Scenario: createForAuth rejects a non-null oauthAppConfig for a credentials-form provider

- **WHEN** `ClientFactory.createForAuth("amazon-s3", { clientId: "x", clientSecret: "y", redirectUri: "z" }, ctx)` is called (passing OAuth config for a credentials-form provider)
- **THEN** the call throws `DatasourceError` with `tag === "invalid-datasource"`, `retryable === false`, and a message identifying the misuse

### Requirement: `DatasourceClient<T>` exposes rename and download primitives

The engine SHALL extend the public `DatasourceClient<T>` interface with two new methods covering rename + download. The methods are:

```typescript
rename(target: Target, newName: string, conflictPolicy: ConflictPolicy):
  Promise<DatasourceFileEntry<T>>;

downloadFile(
  target: Target,
  options?: {
    rangeStart?: number;
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
  }
):
  Promise<{
    stream: Readable;
    contentLength: number | null;
    contentRange?: { start: number; end: number; total: number };
  }>;
```

`ConflictPolicy = "fail" | "overwrite" | "keep-both"`. Concrete strategies SHALL implement `protected abstract doRenameImpl` and `doDownloadFileImpl`, mirroring the existing pattern where the base class wraps each call with single-flight refresh and error normalization. The strategy is responsible for determining whether the target is a file or directory within its own provider context — the engine interface does NOT carry a `kind` parameter.

`downloadFile` is a one-shot HTTP primitive: each call issues exactly ONE provider GET request, wrapped in `withRefresh` (one-shot refresh-and-retry on auth-expired during the initial request only). The engine SHALL NOT carry per-download state across calls; it SHALL NOT mint a transaction ID; it SHALL NOT maintain a download tracker map; it SHALL NOT splice a new stream into a prior Readable; it SHALL NOT expose a `cancelDownload` method. The strategy SHALL forward `options.signal` (if provided) into the underlying provider request so consumer-side cancel propagates to the SDK / fetch.

When `options.rangeStart` is set, the strategy SHALL attach `Range: bytes=<rangeStart>-` to the provider request. The returned `contentRange` SHALL reflect the provider's response (parsed from the `Content-Range` header or SDK equivalent); when the response is 200 OK (full content rather than 206 Partial Content), `contentRange` SHALL be omitted so consumers can detect the range-not-honored case.

When `options.onProgress` is set, the strategy SHALL invoke it with `(loaded, total)` as bytes flow during the response stream's lifetime. The engine ALSO emits the four download lifecycle events on its broadcast bus (see "Engine bus emits download lifecycle events" below); the synchronous `onProgress` callback and the bus emissions fire from the same byte-flow source.

#### Scenario: Every concrete strategy implements the new methods

- **WHEN** the contract test in `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` enumerates every exported client class
- **THEN** each class is `assignable` to `DatasourceClient<its provider type>` including the two new methods (`rename` and `downloadFile`), and the shared scenario suite passes for each (rename a file, rename a directory or surface Unsupported per provider, download a small file end-to-end including AbortSignal-driven cancel, downloadFile with rangeStart issues a 206 Partial Content request)

#### Scenario: S3 rename of a folder surfaces `Unsupported` via strategy introspection

- **WHEN** an S3 client receives a `rename(target, newName, conflictPolicy)` call where `target` resolves to a virtual folder (the strategy's `HeadObject(key)` returns 404 and `ListObjectsV2(Prefix=key+"/", MaxKeys=1)` returns at least one key)
- **THEN** the call rejects with `DatasourceError { tag: "unsupported", retryable: false }` and message "S3 folder rename is not supported in this version"; no `CopyObject` or `DeleteObject` is issued; no events are emitted

#### Scenario: S3 rename of a file proceeds via copy + delete

- **WHEN** an S3 client receives `rename(target, newName, "fail")` where `target` resolves to an object (`HeadObject(key)` returns 200) and the target name does not already exist (a `HeadObject` for the new key returns 404)
- **THEN** the strategy issues `CopyObject` followed by `DeleteObject`; the bus emits exactly one `entry-renamed { from, to }`; the call resolves with the new entry

#### Scenario: Directory rename with `conflictPolicy: "overwrite"` is refused

- **WHEN** any client receives `rename(target, newName, "overwrite")` and the target resolves to a directory (Drive `mimeType: "application/vnd.google-apps.folder"`, OneDrive `folder` facet, or S3 virtual prefix)
- **THEN** the call rejects with `DatasourceError { tag: "unsupported", retryable: false }` and message "directory rename with conflictPolicy 'overwrite' is not supported (would require recursive replacement)"; no rename API call is issued

### Requirement: `entry-renamed` is the single normalized rename event

The engine bus SHALL emit exactly one `entry-renamed` event per successful
`rename` call, regardless of how many provider API calls the strategy
performed internally. The payload shape is:

```typescript
{ from: Target, to: DatasourceFileEntry<T> }
```

`from` carries the original `{datasourceId, path, handle}` so subscribers can
identify the pre-rename entry; `to` is the full new entry including the new
path, name, and any provider-side metadata changes. `*-failed` events on
rename SHALL be emitted via the existing `delete-failed` taxonomy with the
`via: "rename"` discriminator (matching `createFile`'s `via: "createFile"`
pattern on `upload-failed`).

#### Scenario: Drive rename emits `entry-renamed` once

- **WHEN** a Google Drive client successfully renames `welcome.pdf` to `welcome-v2.pdf`
- **THEN** the bus observes exactly one `entry-renamed { from: { path: "/welcome.pdf", … }, to: { path: "/welcome-v2.pdf", name: "welcome-v2.pdf", … } }`; no `file-created` or `deleted` events are emitted

#### Scenario: S3 rename emits `entry-renamed` once despite copy+delete internals

- **WHEN** an S3 client successfully renames `welcome.pdf` to `welcome-v2.pdf` via internal `CopyObject` + `DeleteObject`
- **THEN** the bus observes exactly one `entry-renamed { from: …, to: … }`; the strategy's two provider API calls are not visible on the bus; subscribers cannot distinguish the rename from a Drive/OneDrive rename

#### Scenario: Rename failure emits `delete-failed` with `via: "rename"`

- **WHEN** a rename fails with a provider conflict, `auth-revoked`, or other normalized error
- **THEN** the bus emits `delete-failed { tag, message, via: "rename" }` exactly once and the call rejects with the matching `DatasourceError`

### Requirement: `downloadFile` is a stateless one-shot HTTP primitive

Each `downloadFile(target, options?)` call SHALL issue exactly ONE underlying provider GET request, wrapped in the engine's existing `withRefresh` machinery (one-shot refresh-and-retry on auth-expired during the initial request only). The engine SHALL NOT track download progress, transaction IDs, or cancel state across calls. Mid-stream errors (auth-expired, network, 5xx, rate-limit) on the returned Readable SHALL surface to the consumer as normal stream errors with normalized `DatasourceError` tags; the engine SHALL NOT attempt to refresh and resume internally.

Consumer-domain orchestration of resume — calling `downloadFile` again with `rangeStart = <bytes already written>`, validating the returned `contentRange`, deciding whether to retry vs fail — lives entirely in the consumer (the fs-sync service handler).

#### Scenario: First call returns the initial stream

- **WHEN** the consumer invokes `engine.downloadFile(target)` (no `rangeStart`)
- **THEN** the strategy issues one provider GET (no Range header); the response Body becomes the returned `stream`; `contentLength` reflects the response's total size if the provider advertises it; `contentRange` is undefined; the call resolves with `{ stream, contentLength }` exactly once

#### Scenario: Resume call attaches the Range header

- **WHEN** the consumer invokes `engine.downloadFile(target, { rangeStart: 1048576 })` after a previous call's stream errored at byte 1048576
- **THEN** the strategy issues one provider GET with `Range: bytes=1048576-`; the provider's 206 Partial Content response Body becomes the returned `stream`; `contentRange` is `{ start: 1048576, end: <total - 1>, total: <total> }`; `contentLength` reflects the response's total size; the call resolves with that shape

#### Scenario: Range-not-honored response surfaces via undefined contentRange

- **WHEN** the consumer invokes `engine.downloadFile(target, { rangeStart: 1048576 })` and the provider returns 200 OK (full content from byte 0) instead of 206 Partial Content
- **THEN** `contentRange` is undefined on the returned shape; `contentLength` reflects the full response size; the consumer can detect the range-not-honored case by checking `contentRange === undefined && rangeStart > 0` and refuse to resume the local pipe

#### Scenario: AbortSignal cancels the in-flight provider request

- **WHEN** the consumer invokes `engine.downloadFile(target, { signal })` and aborts the signal mid-stream
- **THEN** the underlying provider request is aborted via the SDK's signal forwarding; the returned stream errors with an AbortError (or normalized `tag: "cancelled"`); no further bytes flow; the engine maintains no per-download state to clean up

#### Scenario: Mid-stream auth-expired surfaces to the consumer

- **WHEN** a `downloadFile` call returned a stream that successfully delivered N bytes, then the underlying provider request errored mid-stream with auth-expired (token expired during the response)
- **THEN** the stream errors with `DatasourceError { tag: "auth-expired" }` reaching the consumer's pipe-to-disk; the engine does NOT refresh or splice internally; the consumer is responsible for deciding whether to call `downloadFile` again with `rangeStart=N` (which goes through `withRefresh` afresh and refreshes the credential)

### Requirement: Engine bus emits download lifecycle events

The engine bus SHALL emit four download lifecycle events during the
lifetime of a `downloadFile` call. These events are raw vendor-API
facts on the broadcast bus — fs-sync (the consumer that owns the
DownloadRegistry) subscribes and applies a business-logic
transformation before emitting its own desktop-facing events with
different payload shapes (`downloadJobId`-keyed, business-decorated).
The engine bus payload shapes are:

```typescript
"downloading":         { datasourceId, path, loaded: number, total: number | null };
"file-downloaded":     { datasourceId, path, bytes: number };
"download-failed":     SerializedDatasourceError<T>;
"download-cancelled":  { datasourceId, path, bytesDownloaded: number, bytesTotal: number | null };
```

(`datasourceId` shown for reader clarity but lives at the `DatasourceEvent<T, K>` envelope level; the inner payload omits it.) The engine emits `file-downloaded` based on its own stream observability — when the strategy's response stream fires `end` cleanly — NOT on consumer feedback. The engine never writes to disk, so it cannot know `savedPath`; that field belongs to fs-sync's transformed desktop-facing event (see fs-sync-service spec).

`download-failed`'s payload IS the `SerializedDatasourceError<T>` directly — no `{ datasourceId, path, error }` wrapper. This mirrors the existing `authentication-failed` per-provider pinning convention (`packages/ipc-contracts/src/fs-datasource-engine.ts:172`): error events on the engine bus are pinned to `SerializedDatasourceError<T>` so subscribers narrow on the envelope's `datasourceType` and read the error fields (`tag`, `retryable`, `retryAfterMs`, `raw`, `message`) directly without a wrapper unwrap. Subscribers that need to correlate a failure to a specific in-flight download key off the envelope's `datasourceId` plus their own out-of-band `(datasourceId, path) → downloadJobId` reverse index (fs-sync owns this mapping per fs-sync-service spec).

The `downloading` event is streaming-tagged (subject to the same
coalescer the engine bus already applies to `uploading`). The three
terminal events bypass the coalescer and fire exactly once per
`downloadFile` invocation. `path` carries the request's `Target.path`
so subscribers can correlate against an in-flight job. The
synchronous `options.onProgress` callback continues to fire from the
same byte-flow source — direct caller path is unchanged; the bus is
the broadcast path consumed by fs-sync's subscription.

When `downloadFile` is invoked again with `rangeStart > 0` (handler-
driven retry-and-resume), the new invocation produces its own fresh
sequence of events: a new `downloading` series whose `loaded` resets
to the provider's response (typically `rangeStart` for a 206 Partial
Content) and its own terminal event. The bus does NOT carry an
invocation-id; subscribers correlate by `(datasourceId, path)`.

#### Scenario: Successful download emits `downloading` then `file-downloaded`

- **WHEN** `engine.downloadFile(target)` resolves and the returned stream's `end` event fires cleanly after all bytes flow
- **THEN** the bus observes one or more `downloading { datasourceId, path, loaded, total }` events as bytes flow (subject to streaming coalescing), followed by exactly one `file-downloaded { datasourceId, path, bytes }` event when the underlying stream completes successfully; no `download-failed` or `download-cancelled` event is emitted

#### Scenario: Mid-stream error emits `downloading` then `download-failed`

- **WHEN** `engine.downloadFile(target)` resolves and the returned stream errors mid-flight (auth-expired, network, 5xx, etc.) before the consumer reports terminal success
- **THEN** the bus observes the `downloading` events that fired up to the failure point, followed by exactly one `download-failed` event whose payload IS the `SerializedDatasourceError<T>` for the normalized `DatasourceError` (per the `authentication-failed` precedent — payload is the error directly, no wrapper); no `file-downloaded` or `download-cancelled` event is emitted

#### Scenario: AbortSignal-driven cancel emits `downloading` then `download-cancelled`

- **WHEN** the consumer invokes `engine.downloadFile(target, { signal })` and aborts the signal while bytes are flowing
- **THEN** the bus observes the `downloading` events that fired up to the abort, followed by exactly one `download-cancelled { datasourceId, path, bytesDownloaded, bytesTotal }` event; no `download-failed` event is emitted (cancel is the terminal classification, not failure); `bytesDownloaded` reflects the last `loaded` value the strategy reported and `bytesTotal` reflects the response's `contentLength` (or `0` if cancelled before the response advertised one)

#### Scenario: Range-resume invocation emits a fresh event sequence

- **WHEN** the consumer invokes `engine.downloadFile(target, { rangeStart: N })` after a prior invocation's terminal event already fired on the bus, and the provider returns 206 Partial Content
- **THEN** the new invocation emits its own fresh `downloading` series (with `loaded` reflecting the provider's response progression — typically starting at `N`) and its own terminal event; the bus does NOT correlate the two invocations via an invocation-id; subscribers correlate by `(datasourceId, path)` if they need to track the resume relationship

### Requirement: Rename conflict surfaces `DatasourceError { tag: "conflict" }` when policy is "fail"

The `DatasourceErrorTag` taxonomy SHALL include a new member `Conflict =
"conflict"`. When `rename` is called with `conflictPolicy: "fail"` and
the target name collides with an existing remote sibling at the same
parent path, the call SHALL reject with
`DatasourceError { tag: "conflict", retryable: false, raw:
{ existingPath: string } }`.

When `conflictPolicy: "overwrite"`, the engine SHALL delete the colliding
sibling (via the existing `deleteFile` path) before performing the rename;
the operation SHALL still emit a single `entry-renamed` (the deletion
event SHALL NOT be emitted to the bus to keep the user-visible rename
single-step).

When `conflictPolicy: "keep-both"`, the engine SHALL append `-2` / `-3` /
… suffix and retry until success or until 99 attempts (then fail with
`tag: "provider-error", message: "exhausted keep-both attempts"`). The
engine `DatasourceErrorTag` taxonomy does not include `"other"`; the
service-side wire mapping at `services/fs-sync/src/commands/files-error-mapping`
collapses `provider-error` → `tag: "other"` before the renderer sees it.

#### Scenario: Rename to existing sibling with policy "fail"

- **WHEN** the user renames `foo.pdf` to `bar.pdf` and `bar.pdf` already exists at the same parent path, with `conflictPolicy: "fail"`
- **THEN** the call rejects with `DatasourceError { tag: "conflict", raw: { existingPath: "/parent/bar.pdf" } }`; no provider mutation occurs; no `entry-renamed` event is emitted

#### Scenario: Rename with policy "overwrite" replaces the colliding sibling

- **WHEN** the user renames `foo.pdf` to `bar.pdf`, `bar.pdf` exists, and `conflictPolicy: "overwrite"`
- **THEN** the engine deletes the existing `bar.pdf` first, then performs the rename; the bus observes exactly one `entry-renamed { from: {…foo.pdf…}, to: {…bar.pdf…} }`; no `deleted` event is emitted

#### Scenario: Rename with policy "keep-both" auto-suffixes

- **WHEN** the user renames `foo.pdf` to `bar.pdf` and both `bar.pdf` and `bar-2.pdf` exist, with `conflictPolicy: "keep-both"`
- **THEN** the engine retries with `bar-2.pdf` (collides), then `bar-3.pdf` (succeeds); the bus emits one `entry-renamed { from: {…foo.pdf…}, to: {…bar-3.pdf…} }`

