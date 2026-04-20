## ADDED Requirements

### Requirement: Engine is a framework-agnostic workspace package

The FS Datasource Engine SHALL live at `packages/fs-datasource-engine` as a pnpm workspace package. It SHALL import types from `packages/ipc-contracts` and SHALL NOT import from `electron`, `apps/desktop/*`, or any renderer-scoped specifier. The engine SHALL expose exactly one entry point: the public `DatasourceClient<T>` interface, the `ClientFactory.create(...)` constructor, the `EventBus` subscriber surface, and port types (`CredentialStore`, `AuthIntent`). Implementations of those ports are supplied by the Electron host at wiring time.

#### Scenario: No Electron imports in the engine package

- **WHEN** a Vitest test grep-scans every `.ts` file under `packages/fs-datasource-engine/src/` for import specifiers
- **THEN** no file imports from `electron`, `@electron/*`, or any path under `apps/desktop/`; the only runtime imports are `@ft5/ipc-contracts`, Node built-ins, and provider SDK packages (`@aws-sdk/client-s3`, `@microsoft/microsoft-graph-client`, `googleapis`)

#### Scenario: Engine is consumed only by main-process IPC handlers

- **WHEN** a Vitest test scans every `.ts` / `.tsx` file under `apps/desktop/src/renderer/` and `apps/desktop/src/preload/`
- **THEN** no file imports from `@ft5/fs-datasource-engine`; only files under `apps/desktop/src/main/` (specifically the IPC handlers) import the engine

### Requirement: Public contract is the generic `DatasourceClient<T>` Strategy interface

The engine SHALL export a public interface `DatasourceClient<T extends DatasourceType>` with the methods `status`, `testConnection`, `authenticate`, `listDirectory`, `search`, `getMetadata`, `createFile`, `uploadFile`, `deleteFile`, `deleteDirectory`, and `getQuota`. The type parameter `T` SHALL flow into every generic return payload (`FileEntry<T>`, `FileMetadata<T>`, and event payloads). Concrete implementations (`S3Client`, `OneDriveClient`, `GoogleDriveClient`) SHALL conform to this interface and SHALL be constructible only via the engine's factory — not via `new` directly by consumers.

#### Scenario: Every concrete client conforms to the shared interface

- **WHEN** a contract test in `packages/fs-datasource-engine/src/__tests__/strategy-contract.test.ts` enumerates every exported client class
- **THEN** each class is `assignable` to `DatasourceClient<its provider type>`, every method on the interface is present with the correct signature, and a shared suite of scenarios (list, search, upload, delete, error) passes against each

#### Scenario: Consumers program to the interface, not the concrete class

- **WHEN** a Vitest test scans `apps/desktop/src/main/ipc/` for type annotations
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

### Requirement: Event schema is typed per provider via `PayloadMap`

The engine SHALL define event types generically: `type DatasourceEvent<T extends DatasourceType, K extends keyof PayloadMap[T]> = { event: K; datasourceType: T; datasourceId: string; ts: number; streaming?: true; payload: PayloadMap[T][K] }`. `PayloadMap` SHALL be declared in `packages/ipc-contracts` keyed by provider type → event name → payload shape. At minimum, the following event names SHALL be present for every provider: `uploading`, `upload-failed`, `file-created`, `deleted`, `delete-failed`, `authenticated`, `authentication-failed`, `token-refreshed`, `token-expired`, `status-changed`, `rate-limited`. Each payload SHALL carry provider-native fields (e.g., S3 emits `{ bucket, key, etag }` on `file-created`; Google Drive emits `{ fileId, mimeType, parents }`).

#### Scenario: Consumer narrowing works via switch

- **WHEN** a subscriber receives a `DatasourceEvent` and switches on `e.datasourceType`
- **THEN** within the `case "amazon-s3":` branch the compiler narrows `e.payload` to S3's payload shape, within the `case "google-drive":` branch the compiler narrows to Drive's shape, with no manual casting

#### Scenario: Adding a new provider requires only a PayloadMap entry

- **WHEN** a hypothetical fourth provider is added in a test fixture by extending `PayloadMap` with a new key and registering a new strategy
- **THEN** the engine's bus, base class, factory, and existing subscribers compile unchanged; only the new strategy and its `PayloadMap[newProvider]` entry are authored

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

### Requirement: CredentialStore port + SqliteCredentialStore implementation

The engine SHALL declare an abstract port `interface CredentialStore { get(datasourceId: string): Promise<StoredCredentials | null>; put(datasourceId: string, creds: StoredCredentials): Promise<void>; delete(datasourceId: string): Promise<void> }`. The Electron host SHALL provide `SqliteCredentialStore` which implements the port by (a) serializing `creds` to JSON, (b) encrypting via `safeStorage.encryptString`, (c) persisting the ciphertext as a `BLOB` in table `datasource_credentials (datasource_id TEXT PRIMARY KEY, encrypted_blob BLOB NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`. Reads SHALL decrypt via `safeStorage.decryptString` and parse JSON. If `safeStorage.isEncryptionAvailable()` returns `false` at process start, `SqliteCredentialStore` SHALL refuse construction and the main process SHALL surface a startup error; plaintext fallback is FORBIDDEN.

#### Scenario: Credentials round-trip through encryption

- **WHEN** a test invokes `store.put("ds-1", { accessToken: "abc", refreshToken: "def" })` and then `store.get("ds-1")`
- **THEN** `get` resolves with an object structurally equal to the input; inspecting the SQLite row directly shows `encrypted_blob` is a non-empty buffer that does NOT contain the literal substring `"abc"` or `"def"`

#### Scenario: Unavailable encryption refuses to operate

- **WHEN** `safeStorage.isEncryptionAvailable()` is stubbed to return `false` at store construction time
- **THEN** `new SqliteCredentialStore(...)` throws a startup error identifying the missing capability, and no row is written or read

#### Scenario: Schema version tag is present on writes

- **WHEN** `put` is called
- **THEN** the persisted row has `schema_version === 1`, and `created_at` / `updated_at` are Unix-millis numbers set to (approximately) the call time

### Requirement: Normalized `DatasourceError` with 8-tag taxonomy

The engine SHALL expose `class DatasourceError<T extends DatasourceType = DatasourceType> extends Error` from `packages/ipc-contracts`. Instances SHALL carry `tag: DatasourceErrorTag`, `datasourceType: T`, `datasourceId: string`, `retryable: boolean`, `retryAfterMs?: number`, and `raw?: unknown`. `DatasourceErrorTag` SHALL be the union `"auth-expired" | "auth-revoked" | "not-found" | "conflict" | "unsupported" | "rate-limited" | "network-error" | "provider-error"`. Every concrete strategy's `normalizeError(e: unknown)` SHALL return an instance of this class; strategies SHALL NOT throw raw provider exceptions from their `doX` methods as observed by the base class.

#### Scenario: Every strategy normalizes raw exceptions

- **WHEN** a contract test injects a raw provider exception of each documented kind into each strategy's `normalizeError`
- **THEN** the returned instance is a `DatasourceError`, its `tag` matches the documented mapping, `retryable` is `true` exactly when `tag ∈ { "rate-limited", "network-error" }`, and `raw` is the original exception

#### Scenario: Unknown provider exceptions fall through to provider-error

- **WHEN** an unrecognized exception is passed to `normalizeError`
- **THEN** the returned instance has `tag === "provider-error"`, `retryable === false`, and `raw` is the original exception

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

The engine SHALL expose `ClientFactory.create(providerId: ProviderId, credentials: StoredCredentials, ctx: EngineContext): DatasourceClient<T>` where `EngineContext = { bus: EventBus; credentialStore: CredentialStore }`. A `ProviderRegistry` (internal to the engine) SHALL map each known `ProviderId` to the corresponding factory function. Unknown `providerId` values SHALL cause `ClientFactory.create` to throw `DatasourceError` with `tag === "unsupported"`. Adding a new provider SHALL require exactly (a) a new concrete strategy class, (b) a new `PayloadMap[providerId]` entry in `ipc-contracts`, and (c) a new registry entry — no other engine files change.

#### Scenario: Factory returns a configured client

- **WHEN** `ClientFactory.create("amazon-s3", creds, { bus, credentialStore })` is called with valid S3 credentials
- **THEN** the returned value is an instance of `S3Client`, assignable to `DatasourceClient<"amazon-s3">`, whose subsequent event emissions flow through the supplied bus

#### Scenario: Unknown provider id throws Unsupported

- **WHEN** `ClientFactory.create("dropbox" as ProviderId, creds, ctx)` is called (casting to satisfy the type)
- **THEN** the call throws a `DatasourceError` with `tag === "unsupported"`

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
