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

The engine SHALL export a public interface `DatasourceClient<T extends DatasourceType>` with the methods `status`, `testConnection`, `authenticate`, `listDirectory`, `search`, `getMetadata`, `uploadFile`, `deleteFile`, `deleteDirectory`, `getQuota`, `rename`, and `downloadFile`. The methods `createFile` and `cancelUpload` are NOT present (deleted by this change). The type parameter `T` SHALL flow into every generic return payload (`FileEntry<T>`, `FileMetadata<T>`, and event payloads). Concrete implementations (`S3Client`, `OneDriveClient`, `GoogleDriveClient`) SHALL conform to this interface and SHALL be constructible only via the engine's factory — not via `new` directly by consumers.

#### Scenario: Every concrete client conforms to the shared interface

- **WHEN** a contract test in `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` enumerates every exported client class
- **THEN** each class is `assignable` to `DatasourceClient<its provider type>`, every method on the interface is present with the correct signature (no `createFile`, no `cancelUpload`), and a shared suite of scenarios (list, search, upload via signal-driven cancel, delete, error, rename, download with rangeStart, AbortSignal-driven download cancel) passes against each

#### Scenario: Consumers program to the interface, not the concrete class

- **WHEN** a Vitest test scans `apps/desktop/src/main/ipc/` and `services/fs-sync/src/commands/` for type annotations
- **THEN** handler call sites annotate the engine value as `DatasourceClient<DatasourceType>` (or a narrower union), not as `S3Client` / `OneDriveClient` / `GoogleDriveClient` directly

### Requirement: Template base class wraps every operation with emission, refresh, and error normalization

The engine SHALL provide `abstract class BaseDatasourceClient<T extends DatasourceType>` that concrete strategies extend. The base class SHALL wrap operations that emit lifecycle events (`deleteFile`, `rename`, `downloadFile`) such that it (a) emits a pre-operation event where applicable (e.g., `downloading`), (b) emits a post-operation event on success (`deleted`, `entry-renamed`, `file-downloaded`), (c) emits a `*-failed` event and throws `DatasourceError` on failure, (d) calls `normalizeError(e)` to convert any raw exception to `DatasourceError` before emitting or throwing.

The base SHALL NOT auto-refresh credentials on `auth-expired`. A normalized `auth-expired` error surfaces to the caller unchanged — no refresh, no retry — for every operation. Token refresh remains a base-class responsibility but is no longer auto-wrapped around operations: it is exposed as the public single-flight `refreshCredentials()` primitive (see Requirement: Token refresh is single-flight per datasource), which callers invoke explicitly — typically through the exported `withAuthRefresh` helper (see Requirement: Engine exports a `withAuthRefresh` retry helper).

The `uploadFile` method is exempt from bus emission (per ADDED Requirement: `uploadFile` is a one-shot stateless primitive); it returns the entry directly without emitting any of `uploading`, `file-created`, `upload-failed`, or `upload-cancelled` from this layer. Only the `normalizeError` wrapper applies to `uploadFile` — the base no longer auto-refreshes it.

Concrete strategies SHALL implement only the `protected abstract doX(...)` methods plus `protected abstract refreshTokenImpl(): Promise<AuthResult>` and `protected abstract normalizeError(raw: unknown): DatasourceError<T>`. Strategies SHALL NOT emit events directly and SHALL NOT re-enter the base's refresh path (`refreshCredentials`) from within `refreshTokenImpl`.

#### Scenario: Base does NOT emit upload events for uploadFile

- **WHEN** a concrete strategy's `doUploadFileImpl` resolves successfully or throws
- **THEN** the engine bus observes ZERO `uploading`, `file-created`, `upload-failed`, or `upload-cancelled` events for this upload (these events are emitted by the fs-sync service handler on `sync:event-stream`, not on the engine bus)

#### Scenario: Base emits download lifecycle events

- **WHEN** a concrete strategy's `doDownloadFileImpl` produces bytes flowing through the returned Readable
- **THEN** the engine bus observes the `downloading` streaming event and the appropriate terminal event (`file-downloaded`, `download-failed`, or `download-cancelled`) — download is unchanged by this migration

#### Scenario: Operations surface auth-expired without auto-retry

- **WHEN** any operation's `doXImpl` throws an error that `normalizeError` tags `auth-expired`
- **THEN** the base does NOT call `refreshTokenImpl`, does NOT retry the operation, and the `auth-expired` `DatasourceError` propagates to the caller unchanged (the caller decides whether to call `refreshCredentials()` and retry)

#### Scenario: Strategies do not emit events directly

- **WHEN** a Vitest test scans every concrete strategy class file
- **THEN** no `.emit(` or `this.bus.` reference is present; only the base class references the event bus

### Requirement: Hybrid `Target` type supports both path and handle addressing

The engine SHALL define `type Target = { kind: "path"; path: string } | { kind: "handle"; handle: string }` in `packages/ipc-contracts`. Every method that addresses a filesystem location (`listDirectory`, `getMetadata`, `uploadFile`, `deleteFile`, `deleteDirectory`, `search` scope) SHALL accept `Target` as its location parameter. `FileEntry<T>` SHALL always carry both `path: string` and `handle: string` so any entry returned by a list call can be re-addressed by either mechanism. Internally, each concrete strategy SHALL maintain an LRU path↔handle cache. Cache invalidation SHALL be **internal to each mutating op** — the strategy evicts inline within the operation's success branch, before returning; NO bus event drives invalidation:

- On successful `uploadFile`: `doUploadFileImpl` populates the LRU directly inside its success branch.
- On successful `deleteFile`: `doDeleteFileImpl` evicts the deleted entry's path (path-form target) or handle (handle-form target) from the LRU inside its success branch.
- On successful `rename`: `doRenameImpl` evicts the old path from the LRU inside its success branch; for a directory rename it ALSO evicts every cached descendant under the old-path prefix. When an `overwrite` rename internally deletes a colliding sibling at the destination, that sibling's cached path is evicted too. Eviction is evict-only — the new path resolves fresh on next access.
- The `createFile` invalidation path is not relevant: `createFile` does not exist on the engine surface.

A strategy with no path cache (e.g., S3, whose keys are paths) satisfies this requirement vacuously: it has nothing to evict and a re-address always reaches the provider. Strategy constructors SHALL NOT subscribe to the engine bus to drive cache invalidation; eviction is performed inline by the mutating op, independent of the bus. The engine bus's `deleted` / `entry-renamed` emissions remain for consumer notification only.

#### Scenario: listDirectory accepts a path target

- **WHEN** a caller invokes `client.listDirectory({ kind: "path", path: "/photos/2024" })` against a client whose datasource has that folder
- **THEN** the method resolves with a non-empty `FileEntry<T>[]` whose entries each carry both a `path` field starting with `/photos/2024/` and a non-empty `handle` string

#### Scenario: listDirectory accepts a handle target

- **WHEN** a caller obtains a `FileEntry<T>` from a prior `listDirectory` call, then invokes `client.listDirectory({ kind: "handle", handle: entry.handle })` where `entry.kind === "folder"`
- **THEN** the method resolves with the children of that folder, and no path-resolution round-trip is issued to the provider (observable in a spy-wrapped strategy test)

#### Scenario: Handle cache is populated by upload success internally

- **WHEN** a strategy's `doUploadFileImpl` resolves successfully with an entry whose `path` was not previously in the LRU
- **THEN** the LRU contains `entry.path → entry.handle` after the call resolves; the engine bus observes ZERO `file-created` events for the upload

#### Scenario: Handle cache is invalidated by deletion

- **WHEN** a strategy successfully deletes an entry at a known cached path, then another operation addresses the same path
- **THEN** the strategy does NOT return the cached handle; the second operation re-resolves the path (observable by a spy on the provider's name-resolution API)

#### Scenario: Handle cache is invalidated by rename

- **WHEN** a strategy successfully renames a file from a known cached path `/old` to `/new`, then another operation addresses `/old`
- **THEN** the strategy does NOT return the stale cached handle for `/old` — the operation re-resolves (the provider reports `/old` no longer exists) — and addressing `/new` resolves to the renamed entry

#### Scenario: Directory rename invalidates cached descendants

- **WHEN** a strategy successfully renames a directory from `/foo` to `/bar` while descendants such as `/foo/a.txt` were cached in the LRU
- **THEN** subsequent addresses of `/foo` and of any cached `/foo/...` descendant do NOT return cached handles; each re-resolves against the provider

#### Scenario: Overwrite rename evicts the displaced sibling's cached path

- **WHEN** a strategy performs a `rename` with `conflictPolicy: "overwrite"` that internally deletes a colliding sibling at the destination path, and that sibling's path was cached
- **THEN** the displaced sibling's cached path entry is evicted; a subsequent address of that path re-resolves (no `deleted` bus event is required to drive this eviction)

#### Scenario: Path-cache eviction is internal, not bus-driven

- **WHEN** a strategy that maintains a path↔handle cache is constructed
- **THEN** it does NOT register a bus subscription to invalidate that cache; a `deleted` event delivered on the engine bus from an unrelated source does not, by itself, evict the strategy's cache — eviction occurs only inline within the strategy's own successful mutating op

#### Scenario: Every cached strategy honors the invalidation invariant (shared contract)

- **WHEN** the shared strategy-contract suite runs against a concrete strategy whose fixture declares `hasPathHandleCache: true`
- **THEN** after a successful `deleteFile` of a cached path the cache no longer holds that path, and after a successful `rename` the old path is evicted — so every present and future cached strategy is held to the invariant (a strategy whose fixture declares `hasPathHandleCache: false` satisfies it vacuously)

#### Scenario: Path ambiguity surfaces via providerMetadata, not a status-changed event

- **WHEN** a provider permits duplicate sibling names (e.g., Google Drive) and a `{kind: "path"}` `Target` resolves to more than one provider-side item under the same (parent, name) filter
- **THEN** the strategy selects the oldest hit (e.g., Drive orders by `createdTime asc`), populates the returned `FileEntry<T>.providerMetadata` with `ambiguous: true` and an `ambiguousSiblings` list containing the other items' handles, and emits NO `status-changed` (or any other) event for the ambiguity

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

The base SHALL expose a public `refreshCredentials(): Promise<AuthResult>` method that performs a single-flight credential refresh via the concrete strategy's `refreshTokenImpl()`. The base SHALL NOT auto-invoke `refreshCredentials()` around operations; callers invoke it explicitly (typically through the exported `withAuthRefresh` helper) after observing an `auth-expired` error. Concurrent calls to `refreshCredentials()` on the same client instance SHALL share a single refresh promise: only one `refreshTokenImpl()` call is issued, and all waiting callers resolve with the same refreshed credentials. The refreshed `AuthResult` SHALL be persisted via `CredentialStore.put` BEFORE the promise resolves. On a successful refresh, a single `token-refreshed` event SHALL be emitted. On refresh failure, `token-expired` and `authentication-failed` events SHALL be emitted and the rejection SHALL propagate to the caller (a `DatasourceError` whose `tag === "auth-expired"` when the underlying refresh did not itself produce a typed `DatasourceError`).

#### Scenario: Concurrent refreshCredentials calls trigger exactly one refresh

- **WHEN** 5 operations on the same client concurrently fail with `auth-expired` and each calls `client.refreshCredentials()` in response
- **THEN** `refreshTokenImpl` is invoked exactly once (observable via spy), exactly one `token-refreshed` event is emitted, and all 5 `refreshCredentials()` calls resolve with the same `AuthResult`

#### Scenario: Refresh is persisted before the promise resolves

- **WHEN** `refreshCredentials()` resolves successfully
- **THEN** `CredentialStore.put` has been awaited with the new `AuthResult` before the returned promise resolves (observable via ordering spy)

#### Scenario: Refresh failure emits both events and rejects

- **WHEN** `refreshTokenImpl` throws
- **THEN** `refreshCredentials()` rejects, exactly one `token-expired` event is emitted, exactly one `authentication-failed` event is emitted (carrying the full `SerializedDatasourceError`), and `CredentialStore.put` is NOT called with any new value

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

The `files:list` handler SHALL forward the request's optional `cursor` and `pageSize` fields to `client.listDirectory(target, { cursor, pageSize })`, and SHALL surface the engine's `nextCursor` on the response envelope. The `truncated: boolean` field on the response envelope SHALL be derived as `nextCursor !== null` and SHALL NOT be authoritative on its own.

#### Scenario: Handlers forward to the engine

- **WHEN** a Vitest test spies on `ClientFactory.create` and on a per-provider mock strategy, then invokes the `files:list` handler with a valid `datasourceId`, `path`, and an optional `{ cursor, pageSize }`
- **THEN** the factory is invoked exactly once for that datasource (or a cached instance is reused), the strategy's `listDirectory` is invoked exactly once with a `Target` of `{ kind: "path", path }` AND an options object whose `cursor` and `pageSize` match the request, and the handler's response conforms to `FilesListResponse` (including the new `nextCursor: string | null` field; `truncated === (nextCursor !== null)`)

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

### Requirement: `DatasourceErrorTag` gains `"cancelled"`

The `DatasourceErrorTag` union SHALL include the tag `"cancelled"`. A `DatasourceError<T>` tagged `"cancelled"` SHALL have `retryable: false`. The strategy's `doUploadFileImpl` SHALL throw this error when the upload terminates due to `options.signal` being aborted by the caller. Strategies' `normalizeError` SHALL NOT tag any provider-native exception `"cancelled"` — the tag is reserved for signal-driven cancellation paths.

#### Scenario: cancelled tag flows through fs-sync handler as terminal

- **WHEN** the fs-sync service handler awaits `client.uploadFile(...)` with an aborted `signal` and the strategy throws `DatasourceError { tag: "cancelled" }`
- **THEN** the handler emits `upload-cancelled` on `sync:event-stream` with `{ uploadJobId, bytesUploaded, bytesTotal, reason: "user" }`; the registry entry for `uploadJobId` is deleted; the handler's reply rejects with the cancelled error

#### Scenario: DatasourceErrorTag tripwire test updated

- **WHEN** the existing `DatasourceErrorTag` `toEqualTypeOf` assertion in `packages/ipc-contracts/src/__tests__/datasources-engine.test-d.ts` runs against the updated taxonomy
- **THEN** the asserted union enumerates the nine tags including `"cancelled"`; the cancellation source documented in the type's JSDoc reflects signal-driven cancel (no engine `cancelUpload` method)

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

### Requirement: Engine exports a `withAuthRefresh` retry helper

The engine SHALL export `withAuthRefresh<R>(client, op): Promise<R>` from `@ft5/fs-datasource-engine` as the default, replaceable one-shot refresh-then-retry policy. It SHALL run `op()`; if `op` rejects with a `DatasourceError` whose `tag === "auth-expired"`, it SHALL call `client.refreshCredentials()` and then retry `op()` exactly once. Any rejection whose tag is NOT `auth-expired` SHALL propagate WITHOUT a refresh. A second `auth-expired` thrown by the retry SHALL propagate unchanged (the helper does NOT refresh twice). The helper SHALL remain framework-agnostic — it SHALL NOT reference any specific caller (e.g., fs-sync). Callers MAY use it or implement their own retry policy against the public `refreshCredentials()` primitive.

#### Scenario: Refreshes once then succeeds

- **WHEN** `op` rejects with `DatasourceError { tag: "auth-expired" }` on its first call and resolves on its second
- **THEN** `client.refreshCredentials()` is called exactly once between the two `op` invocations, and `withAuthRefresh` resolves with the second call's result

#### Scenario: Second auth-expired propagates

- **WHEN** `op` rejects with `auth-expired` on both its first and its retry call
- **THEN** `client.refreshCredentials()` is called exactly once and `withAuthRefresh` rejects with the retry's `auth-expired` error (no second refresh is attempted)

#### Scenario: Non-auth-expired error is not refreshed

- **WHEN** `op` rejects with `DatasourceError { tag: "network-error" }`
- **THEN** `client.refreshCredentials()` is NOT called and the `network-error` propagates immediately without a retry

### Requirement: `listDirectory` exposes opaque-cursor pagination

`DatasourceClient<T>.listDirectory` SHALL accept an optional
`{ cursor?: string; pageSize?: number }` options parameter and SHALL
return `{ entries: DatasourceFileEntry<T>[]; nextCursor: string | null }`.
The cursor SHALL be opaque to the engine port — every concrete
strategy SHALL own its own native-token translation inside
`doListDirectoryImpl`. The engine MUST NOT inspect, normalize, or
introspect the cursor value.

When `cursor` is omitted, the strategy SHALL fetch the first
provider page. When `cursor` is provided, the strategy SHALL fetch
the page identified by that cursor. When `pageSize` is omitted, the
strategy SHALL use its prior provider default. When `pageSize` is
provided, the strategy SHALL clamp it to the provider's
documented `[min, max]` range before issuing the call.

The returned `nextCursor` SHALL be `null` when the provider response
indicates no further pages, and SHALL be the provider's native
continuation token (forwarded unchanged) otherwise.

#### Scenario: First-page call returns entries plus a cursor

- **WHEN** a caller invokes `client.listDirectory({ kind: "path", path: "/big" })` against a folder of 1500 entries on Google Drive with no `cursor` and no `pageSize`
- **THEN** the strategy issues one `files.list` call with `pageSize: 1000` and the call's `nextPageToken` populated; the response's `entries.length` is 1000; the response's `nextCursor` is the provider's `nextPageToken` value (a non-empty string); no second provider call is issued

#### Scenario: Next-page call uses the prior cursor

- **WHEN** a caller invokes `client.listDirectory({ kind: "path", path: "/big" }, { cursor: priorNextCursor })` immediately after a first-page call that returned `nextCursor: priorNextCursor`
- **THEN** the strategy issues one `files.list` call carrying that token in the provider-native parameter (`pageToken` for Drive, the URL `@odata.nextLink` for OneDrive, `ContinuationToken` for S3); the response's `entries` are the second page; the response's `nextCursor` is null when the provider indicates no more pages, otherwise the next provider continuation

#### Scenario: pageSize is forwarded and clamped per provider

- **WHEN** a caller invokes `client.listDirectory(target, { pageSize: 5000 })` against Google Drive
- **THEN** the strategy clamps `pageSize` to 1000 (Drive's `[1, 1000]` ceiling) and issues `files.list({..., pageSize: 1000})`; the response's `entries.length` is at most 1000

#### Scenario: pageSize default per provider when omitted

- **WHEN** a caller invokes `client.listDirectory(target)` without `pageSize`
- **THEN** the strategy uses its prior provider default — Drive 1000, OneDrive 200 (Graph default), S3 1000 — and the response's `entries.length` is at most that default

#### Scenario: S3 strategy returns one provider page per call (not auto-looped)

- **WHEN** a caller invokes `client.listDirectory(target)` against an S3 prefix of 2500 keys with no `cursor`
- **THEN** the strategy issues exactly one `ListObjectsV2` call (NOT a `do/while` loop); the response's `entries.length` is at most 1000 (S3's `MaxKeys` ceiling); the response's `nextCursor` is the `NextContinuationToken` value when `IsTruncated` is true

#### Scenario: OneDrive strategy validates `@odata.nextLink` URL prefix before re-issue

- **WHEN** a caller invokes `client.listDirectory(target, { cursor })` against OneDrive where `cursor` does NOT start with `https://graph.microsoft.com/v1.0/`
- **THEN** the strategy throws `DatasourceError { tag: "provider-error" }` carrying an invalid-cursor message, without issuing a network call (the engine has no `"other"` tag — that is wire-level only; a consumer's error mapping MAY collapse `provider-error` to its own generic tag)

#### Scenario: Stale cursor surfaces as `tag: "provider-error"`

- **WHEN** a caller invokes `client.listDirectory(target, { cursor: staleToken })` and the provider rejects the token (Drive 400 / S3 InvalidArgument / OneDrive 400)
- **THEN** the call rejects with `DatasourceError { tag: "provider-error", message: <provider message> }`; no `expired-cursor` tag is introduced (per design.md Decision 8). fs-sync's `normalizeFilesError` collapses this to the wire `tag: "other"` the renderer observes

