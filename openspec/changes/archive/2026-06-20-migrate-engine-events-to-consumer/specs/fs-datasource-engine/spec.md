# fs-datasource-engine

## REMOVED Requirements

### Requirement: Template base class wraps every operation with emission, refresh, and error normalization

**Reason**: The engine no longer emits events (the EventBus is removed); the base wraps operations with single-flight refresh coordination and error normalization only.
**Migration**: Replaced by ADDED "Template base class wraps every operation with refresh coordination and error normalization"; consumers observe outcomes via return values / thrown DatasourceError and download progress via options.onProgress.

### Requirement: Event schema is typed per provider via `PayloadMap`

**Reason**: The engine no longer defines or emits DatasourceEvent; the DatasourceEvent / PayloadMap / AnyDatasourceEvent / CanonicalEventPayloads types are removed from ipc-contracts.
**Migration**: Each consumer owns its own event taxonomy (the fs-sync service's sync:event-stream); no engine-level event schema remains.

### Requirement: Streaming events are throttled at 1 second OR 10% progress delta

**Reason**: The engine bus and its coalescer are removed; the engine emits no streaming events.
**Migration**: Download-progress throttling (1s OR 10% delta, flushed before the terminal) is owned by the fs-sync download handler, which consumes options.onProgress (see fs-sync-service spec).

### Requirement: Events bridge from engine to renderer via `datasources:event`

**Reason**: The engine EventBus is removed and the datasources:event bridge had no production emitter or consumer.
**Migration**: The renderer receives auth/status events via window.api.sync.onEvent and file state via RPC responses + its optimistic store; the datasources:event channel and window.api.datasources.onEvent are removed (see datasources-ui spec).

### Requirement: `entry-renamed` is the single normalized rename event

**Reason**: The engine bus is removed; rename emits no event.
**Migration**: Rename resolves with the new DatasourceFileEntry<T>; consumers observe success via the return value and failure via the thrown normalized DatasourceError.

### Requirement: Engine bus emits download lifecycle events

**Reason**: The engine bus is removed; downloadFile emits no events.
**Migration**: Download progress is observed via options.onProgress(loaded, total); terminal outcome via the downloadFile promise resolving (stream end) or rejecting (error/abort); the fs-sync handler emits the desktop-facing downloading/file-downloaded/download-failed/download-cancelled events on sync:event-stream (see fs-sync-service spec).

## ADDED Requirements

### Requirement: Template base class wraps every operation with refresh coordination and error normalization

The engine SHALL provide `abstract class BaseDatasourceClient<T extends DatasourceType>` that concrete strategies extend. The base SHALL wrap deleteFile, rename, downloadFile, uploadFile, status, testConnection, and the read operations so that it (a) calls `normalizeError(e)` to convert any raw exception to a typed `DatasourceError<T>` before throwing, and (b) returns the typed result on success. The base SHALL NOT emit any event and SHALL NOT define, hold, or inject an event bus. The base SHALL NOT auto-refresh credentials on `auth-expired`; a normalized `auth-expired` error surfaces to the caller unchanged. Token refresh is exposed as the public single-flight `refreshCredentials()` primitive (see Requirement: Token refresh is single-flight per datasource), invoked explicitly by callers (typically via the exported `withAuthRefresh` helper). Concrete strategies SHALL implement only the `protected abstract doX(...)` methods plus `refreshTokenImpl()` and `normalizeError(raw)`. Strategies SHALL NOT emit events and SHALL NOT reference an event bus.

#### Scenario: Base reports operation outcome via return value or thrown error

- **WHEN** a strategy's `doDeleteFileImpl` or `doRenameImpl` resolves or throws
- **THEN** the base returns the typed result (the deleted target, or the new `DatasourceFileEntry<T>`) on success, or throws the normalized `DatasourceError<T>` on failure — and no event is emitted (the engine has no event bus)

#### Scenario: downloadFile reports progress via onProgress only

- **WHEN** a strategy's `doDownloadFileImpl` produces bytes flowing through the returned Readable AND `options.onProgress` is provided
- **THEN** `onProgress(loaded, total)` fires as bytes flow; the engine emits no downloading / file-downloaded / download-failed / download-cancelled event

#### Scenario: Operations surface auth-expired without auto-retry

- **WHEN** any operation's `doXImpl` throws an error that `normalizeError` tags `auth-expired`
- **THEN** the base does NOT call `refreshTokenImpl`, does NOT retry, and the `auth-expired` `DatasourceError` propagates to the caller unchanged

#### Scenario: Strategies and base reference no event bus

- **WHEN** a Vitest/grep test scans every file under packages/fs-datasource-engine/src/
- **THEN** no `.emit(`, `this.bus`, `ctx.bus`, `EventBus`, or `createEventBus` reference is present anywhere

### Requirement: The engine defines no event bus; consumers own event emission

The engine SHALL NOT define, export, instantiate, or inject an EventBus. `EngineContext` SHALL be `{ credentialStore: CredentialStore }` with NO bus field. The engine package entry point SHALL NOT export `createEventBus`, `EventBus`, `EventBusOptions`, `Clock`, or `ClockTimer`; `@ft5/ipc-contracts` SHALL NOT export `DatasourceEvent`, `AnyDatasourceEvent`, `PayloadMap`, or `CanonicalEventPayloads`. Callers observe operation outcomes via return values and thrown normalized `DatasourceError`, and progress via `options.onProgress`. Each consumer emits its own domain events on its own pub/sub mechanism.

#### Scenario: No event-bus surface in the engine package

- **WHEN** a grep test scans packages/fs-datasource-engine/src
- **THEN** there is no `event-bus.ts` module, no `createEventBus` factory, and no `.emit(` call anywhere

#### Scenario: EngineContext carries no bus

- **WHEN** a typed test inspects the `EngineContext` type
- **THEN** it is exactly `{ credentialStore: CredentialStore }` with no `bus` member, and `ClientFactory.create` / `createForAuth` accept that shape

#### Scenario: Public exports drop the event types

- **WHEN** a typed test imports from `@ft5/fs-datasource-engine` and `@ft5/ipc-contracts`
- **THEN** no `EventBus` / `createEventBus` / `DatasourceEvent` / `AnyDatasourceEvent` / `PayloadMap` symbol is exported

## MODIFIED Requirements

### Requirement: Engine is a framework-agnostic workspace package

The FS Datasource Engine SHALL live at `packages/fs-datasource-engine` as a pnpm workspace package. It SHALL import types from `packages/ipc-contracts` and SHALL NOT import from `electron`, `apps/desktop/*`, or any renderer-scoped specifier. The engine SHALL expose exactly one entry point: the public `DatasourceClient<T>` interface, the `ClientFactory.create(...)` constructor, and port types (`CredentialStore`, `AuthIntent`). Implementations of those ports are supplied by the Electron host at wiring time.

#### Scenario: No Electron imports in the engine package

- **WHEN** a Vitest test grep-scans every `.ts` file under `packages/fs-datasource-engine/src/` for import specifiers
- **THEN** no file imports from `electron`, `@electron/*`, or any path under `apps/desktop/`; the only runtime imports are `@ft5/ipc-contracts`, Node built-ins, and provider SDK packages (`@aws-sdk/client-s3`, `@microsoft/microsoft-graph-client`, `googleapis`)

#### Scenario: Engine is consumed only by main-process IPC handlers

- **WHEN** a Vitest test scans every `.ts` / `.tsx` file under `apps/desktop/src/renderer/` and `apps/desktop/src/preload/`
- **THEN** no file imports from `@ft5/fs-datasource-engine`; only files under `apps/desktop/src/main/` (specifically the IPC handlers) import the engine

### Requirement: Public contract is the generic `DatasourceClient<T>` Strategy interface

The engine SHALL export a public interface `DatasourceClient<T extends DatasourceType>` with the methods `status`, `testConnection`, `authenticate`, `listDirectory`, `search`, `getMetadata`, `uploadFile`, `deleteFile`, `deleteDirectory`, `getQuota`, `rename`, and `downloadFile`. The methods `createFile` and `cancelUpload` are NOT present (deleted by this change). The type parameter `T` SHALL flow into every generic return payload (`FileEntry<T>`, `FileMetadata<T>`). Concrete implementations (`S3Client`, `OneDriveClient`, `GoogleDriveClient`) SHALL conform to this interface and SHALL be constructible only via the engine's factory — not via `new` directly by consumers.

#### Scenario: Every concrete client conforms to the shared interface

- **WHEN** a contract test in `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` enumerates every exported client class
- **THEN** each class is `assignable` to `DatasourceClient<its provider type>`, every method on the interface is present with the correct signature (no `createFile`, no `cancelUpload`), and a shared suite of scenarios (list, search, upload via signal-driven cancel, delete, error, rename, download with rangeStart, AbortSignal-driven download cancel) passes against each

#### Scenario: Consumers program to the interface, not the concrete class

- **WHEN** a Vitest test scans `apps/desktop/src/main/ipc/` and `services/fs-sync/src/commands/` for type annotations
- **THEN** handler call sites annotate the engine value as `DatasourceClient<DatasourceType>` (or a narrower union), not as `S3Client` / `OneDriveClient` / `GoogleDriveClient` directly

### Requirement: Hybrid `Target` type supports both path and handle addressing

The engine SHALL define `type Target = { kind: "path"; path: string } | { kind: "handle"; handle: string }` in `packages/ipc-contracts`. Every method that addresses a filesystem location (`listDirectory`, `getMetadata`, `uploadFile`, `deleteFile`, `deleteDirectory`, `search` scope) SHALL accept `Target` as its location parameter. `FileEntry<T>` SHALL always carry both `path: string` and `handle: string` so any entry returned by a list call can be re-addressed by either mechanism. Internally, each concrete strategy SHALL maintain an LRU path↔handle cache. Cache invalidation SHALL be **internal to each mutating op** — the strategy evicts inline within the operation's success branch, before returning; invalidation is purely inline (the engine has no event bus):

- On successful `uploadFile`: `doUploadFileImpl` populates the LRU directly inside its success branch.
- On successful `deleteFile`: `doDeleteFileImpl` evicts the deleted entry's path (path-form target) or handle (handle-form target) from the LRU inside its success branch.
- On successful `rename`: `doRenameImpl` evicts the old path from the LRU inside its success branch; for a directory rename it ALSO evicts every cached descendant under the old-path prefix. When an `overwrite` rename internally deletes a colliding sibling at the destination, that sibling's cached path is evicted too. Eviction is evict-only — the new path resolves fresh on next access.
- The `createFile` invalidation path is not relevant: `createFile` does not exist on the engine surface.

A strategy with no path cache (e.g., S3, whose keys are paths) satisfies this requirement vacuously: it has nothing to evict and a re-address always reaches the provider. Cache invalidation is performed inline by the mutating op; the engine has no event bus and no operation emits an event.

#### Scenario: listDirectory accepts a path target

- **WHEN** a caller invokes `client.listDirectory({ kind: "path", path: "/photos/2024" })` against a client whose datasource has that folder
- **THEN** the method resolves with a non-empty `FileEntry<T>[]` whose entries each carry both a `path` field starting with `/photos/2024/` and a non-empty `handle` string

#### Scenario: listDirectory accepts a handle target

- **WHEN** a caller obtains a `FileEntry<T>` from a prior `listDirectory` call, then invokes `client.listDirectory({ kind: "handle", handle: entry.handle })` where `entry.kind === "folder"`
- **THEN** the method resolves with the children of that folder, and no path-resolution round-trip is issued to the provider (observable in a spy-wrapped strategy test)

#### Scenario: Handle cache is populated by upload success internally

- **WHEN** a strategy's `doUploadFileImpl` resolves successfully with an entry whose `path` was not previously in the LRU
- **THEN** the LRU contains `entry.path → entry.handle` after the call resolves; no event is emitted (the engine has no event bus)

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
- **THEN** the displaced sibling's cached path entry is evicted; a subsequent address of that path re-resolves (eviction is inline; the engine has no event bus)

#### Scenario: Path-cache eviction is internal to the mutating op

- **WHEN** a strategy that maintains a path↔handle cache is constructed
- **THEN** it does NOT register any subscription to invalidate that cache (the engine has no event bus); eviction occurs only inline within the strategy's own successful mutating op

#### Scenario: Every cached strategy honors the invalidation invariant (shared contract)

- **WHEN** the shared strategy-contract suite runs against a concrete strategy whose fixture declares `hasPathHandleCache: true`
- **THEN** after a successful `deleteFile` of a cached path the cache no longer holds that path, and after a successful `rename` the old path is evicted — so every present and future cached strategy is held to the invariant (a strategy whose fixture declares `hasPathHandleCache: false` satisfies it vacuously)

#### Scenario: Path ambiguity surfaces via providerMetadata

- **WHEN** a provider permits duplicate sibling names (e.g., Google Drive) and a `{kind: "path"}` `Target` resolves to more than one provider-side item under the same (parent, name) filter
- **THEN** the strategy selects the oldest hit (e.g., Drive orders by `createdTime asc`), populates the returned `FileEntry<T>.providerMetadata` with `ambiguous: true` and an `ambiguousSiblings` list containing the other items' handles, and the ambiguity is carried only on the returned entry's `providerMetadata` — the engine emits no event

### Requirement: Authentication returns an `AuthIntent`; engine never opens UI

The `authenticate()` method SHALL return an `AuthIntent` discriminated union: `{ kind: "oauth"; authorizeUrl: string; completeWith(code: string): Promise<AuthResult> } | { kind: "credentials-form"; schema: CredentialsSchema; submit(values: Record<string, unknown>): Promise<AuthResult> }`. The engine SHALL NOT import `electron.shell`, SHALL NOT construct a `BrowserWindow`, and SHALL NOT open any URL or render any form. The host (Electron main) SHALL consume the intent, render the appropriate UI, and invoke `completeWith` or `submit` with the user-obtained value. On successful completion, the resolved `AuthResult` SHALL be persisted via `CredentialStore.put`; the engine emits no event.

#### Scenario: OAuth intent is host-completed

- **WHEN** a caller invokes `client.authenticate()` on a Google Drive client and receives `{ kind: "oauth", authorizeUrl, completeWith }`, then invokes `completeWith("mock-auth-code-12345")`
- **THEN** the promise resolves with an `AuthResult` containing access and refresh tokens, `CredentialStore.put` has been called exactly once with that result (the engine emits no event)

#### Scenario: Credentials-form intent is host-completed

- **WHEN** a caller invokes `client.authenticate()` on an S3 client and receives `{ kind: "credentials-form", schema: "aws-access-key", submit }`, then invokes `submit({ accessKeyId: "...", secretAccessKey: "..." })`
- **THEN** the promise resolves with an `AuthResult`, `CredentialStore.put` is called once (the engine emits no event)

#### Scenario: Engine never imports Electron shell or BrowserWindow

- **WHEN** a grep test scans `packages/fs-datasource-engine/src/` for `electron`, `BrowserWindow`, `shell.openExternal`
- **THEN** no match is found

### Requirement: Token refresh is single-flight per datasource

The base SHALL expose a public `refreshCredentials(): Promise<AuthResult>` method that performs a single-flight credential refresh via the concrete strategy's `refreshTokenImpl()`. The base SHALL NOT auto-invoke `refreshCredentials()` around operations; callers invoke it explicitly (typically through the exported `withAuthRefresh` helper) after observing an `auth-expired` error. Concurrent calls to `refreshCredentials()` on the same client instance SHALL share a single refresh promise: only one `refreshTokenImpl()` call is issued, and all waiting callers resolve with the same refreshed credentials. The refreshed `AuthResult` SHALL be persisted via `CredentialStore.put` BEFORE the promise resolves. On a successful refresh the refreshed `AuthResult` is persisted and the promise resolves; the engine emits no event. On refresh failure the rejection SHALL propagate to the caller (a `DatasourceError` whose `tag === "auth-expired"` when the underlying refresh did not itself produce a typed `DatasourceError`); the engine emits no event.

#### Scenario: Concurrent refreshCredentials calls trigger exactly one refresh

- **WHEN** 5 operations on the same client concurrently fail with `auth-expired` and each calls `client.refreshCredentials()` in response
- **THEN** `refreshTokenImpl` is invoked exactly once (observable via spy), and all 5 `refreshCredentials()` calls resolve with the same `AuthResult`

#### Scenario: Refresh is persisted before the promise resolves

- **WHEN** `refreshCredentials()` resolves successfully
- **THEN** `CredentialStore.put` has been awaited with the new `AuthResult` before the returned promise resolves (observable via ordering spy)

#### Scenario: Refresh failure rejects without persisting

- **WHEN** `refreshTokenImpl` throws
- **THEN** `refreshCredentials()` rejects with the normalized `DatasourceError`, and `CredentialStore.put` is NOT called with any new value (the engine emits no event)

### Requirement: `deleteDirectory` and unsupported `getQuota` throw `Unsupported`

`deleteDirectory(target: Target)` SHALL throw `DatasourceError` with `tag === "unsupported"` for every provider in this change regardless of the target. `getQuota()` SHALL throw the same when called on a client whose `providerDescriptor.capabilities.quota === false`. The thrown error's `raw` field MAY carry a human-readable reason (e.g., `"disabled-for-product-stability"` vs `"not-supported-by-provider"`) but the `tag` SHALL be identical in both cases.

#### Scenario: deleteDirectory always throws Unsupported

- **WHEN** any concrete client's `deleteDirectory({ kind: "path", path: "/anything" })` is invoked
- **THEN** the method throws a `DatasourceError` with `tag === "unsupported"` (the engine emits no event)

#### Scenario: getQuota throws Unsupported on S3

- **WHEN** `client.getQuota()` is invoked on an `S3Client`
- **THEN** the method throws a `DatasourceError` with `tag === "unsupported"` (the engine emits no event)

#### Scenario: getQuota succeeds on providers with quota

- **WHEN** `client.getQuota()` is invoked on a `GoogleDriveClient` with valid credentials
- **THEN** the method resolves with a `Quota` object carrying `used: number` and `quota: number`, both non-negative integers

### Requirement: Factory + Registry construct clients by provider id

The engine SHALL expose `ClientFactory.create(providerId: ProviderId, credentials: StoredCredentials, ctx: EngineContext): DatasourceClient<T>` where `EngineContext = { credentialStore: CredentialStore }`. A `ProviderRegistry` (internal to the engine) SHALL map each known `ProviderId` to the corresponding factory function.

`ClientFactory.create` SHALL throw `DatasourceError` with `tag === "invalid-datasource"` when EITHER (a) the supplied `providerId` is not present in the registry, OR (b) the supplied `credentials` value fails the per-provider shape validation declared by the registry entry (e.g., S3 credentials missing `accessKeyId`, Drive credentials missing `accessToken`). The thrown error's `retryable` SHALL be `false`; the `message` field SHALL identify which condition fired (e.g., `"unknown provider \"dropbox\""` vs `"google-drive credential is missing accessToken"`); `raw` MAY carry a structured detail object for diagnostics.

Adding a new provider SHALL require exactly (a) a new concrete strategy class, (b) a new registry entry, and (c) a credential-shape validator function on the registry entry — no other engine files change.

#### Scenario: Factory returns a configured client

- **WHEN** `ClientFactory.create("amazon-s3", creds, { credentialStore })` is called with valid S3 credentials
- **THEN** the returned value is an instance of `S3Client`, assignable to `DatasourceClient<"amazon-s3">`

#### Scenario: Unknown provider id throws InvalidDatasource

- **WHEN** `ClientFactory.create("dropbox" as ProviderId, creds, ctx)` is called (casting to satisfy the type)
- **THEN** the call throws a `DatasourceError` with `tag === "invalid-datasource"`, `retryable === false`, and a `message` that names the unknown provider id

#### Scenario: Wrong-shape credential throws InvalidDatasource

- **WHEN** `ClientFactory.create("google-drive", { accessKeyId: "AKIA…", secretAccessKey: "…" } as unknown as StoredCredentials, ctx)` is called (S3 credentials supplied for a Drive datasource — type-cast to bypass the compile-time guard)
- **THEN** the call throws a `DatasourceError` with `tag === "invalid-datasource"`, `retryable === false`, and a `message` that identifies the failing field (e.g., `"google-drive credential is missing accessToken"`); no client is constructed

### Requirement: Factory exposes `createForAuth` for no-credentials authenticate flows

The engine SHALL expose `ClientFactory.createForAuth(providerId: ProviderId, oauthAppConfig: OAuthAppConfig | null, ctx: EngineContext): DatasourceClient<T>` as a sibling to the existing `ClientFactory.create`. `OAuthAppConfig` SHALL be the typed shape `{ clientId: string; clientSecret: string; redirectUri: string }`. The new factory method exists exclusively for the case where the caller has no `StoredCredentials` yet — that is, the very first call to `engine.authenticate()` for a brand-new datasource — and SHALL NOT consult the credential store.

For OAuth-class providers (`google-drive`, `onedrive`), `oauthAppConfig` SHALL be required (non-null); the strategy SHALL receive it via a typed `PreAuthConfig` constructor slot distinct from `StoredCredentials.meta`. For credentials-form providers (`amazon-s3`), `oauthAppConfig` SHALL be `null`; the strategy SHALL be constructed with no credentials.

The strategy's `doAuthenticateImpl()` SHALL be reachable from a client constructed via `createForAuth` without the existing `readCredsFromStored` empty-field rejection. For OAuth providers, `doAuthenticateImpl()` SHALL read `clientId`, `clientSecret`, and `redirectUri` from the `PreAuthConfig` slot (NOT from `StoredCredentials.meta`) when constructing the authorize URL and the token-exchange request. For credentials-form providers, `doAuthenticateImpl()` SHALL return a `CredentialsFormIntent` whose `submit(values)` validates and persists the supplied values via the engine's existing `decorateIntent` pathway.

Adding a new provider type SHALL continue to require exactly the three touch points named under the existing factory requirement, with one additional concern: the registry entry SHALL declare whether the provider is OAuth-class or credentials-form-class so `createForAuth` can validate the `oauthAppConfig` argument.

#### Scenario: OAuth provider built via createForAuth produces a usable OAuthIntent

- **WHEN** `ClientFactory.createForAuth("google-drive", { clientId: "abc", clientSecret: "def", redirectUri: "http://127.0.0.1:55555/callback" }, { credentialStore })` is called and the returned client's `authenticate()` is invoked
- **THEN** the returned `AuthIntent` has `kind === "oauth"`; the `authorizeUrl` contains `client_id=abc` and `redirect_uri=http%3A%2F%2F127.0.0.1%3A55555%2Fcallback` and the PKCE `code_challenge` parameters; the `completeWith(code)` closure threads the same `code_verifier` and `clientSecret` into the token exchange; no read of `credentialStore` occurs during construction or during `authenticate()`

#### Scenario: Credentials-form provider built via createForAuth produces a CredentialsFormIntent

- **WHEN** `ClientFactory.createForAuth("amazon-s3", null, { credentialStore })` is called and the returned client's `authenticate()` is invoked
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

When `options.onProgress` is set, the strategy SHALL invoke it with `(loaded, total)` as bytes flow during the response stream's lifetime. `options.onProgress` is the sole progress channel; the engine emits no event.

#### Scenario: Every concrete strategy implements the new methods

- **WHEN** the contract test in `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` enumerates every exported client class
- **THEN** each class is `assignable` to `DatasourceClient<its provider type>` including the two new methods (`rename` and `downloadFile`), and the shared scenario suite passes for each (rename a file, rename a directory or surface Unsupported per provider, download a small file end-to-end including AbortSignal-driven cancel, downloadFile with rangeStart issues a 206 Partial Content request)

#### Scenario: S3 rename of a folder surfaces `Unsupported` via strategy introspection

- **WHEN** an S3 client receives a `rename(target, newName, conflictPolicy)` call where `target` resolves to a virtual folder (the strategy's `HeadObject(key)` returns 404 and `ListObjectsV2(Prefix=key+"/", MaxKeys=1)` returns at least one key)
- **THEN** the call rejects with `DatasourceError { tag: "unsupported", retryable: false }` and message "S3 folder rename is not supported in this version"; no `CopyObject` or `DeleteObject` is issued; no events are emitted

#### Scenario: S3 rename of a file proceeds via copy + delete

- **WHEN** an S3 client receives `rename(target, newName, "fail")` where `target` resolves to an object (`HeadObject(key)` returns 200) and the target name does not already exist (a `HeadObject` for the new key returns 404)
- **THEN** the strategy issues `CopyObject` followed by `DeleteObject`; the call resolves with the new entry (the engine emits no event)

#### Scenario: Directory rename with `conflictPolicy: "overwrite"` is refused

- **WHEN** any client receives `rename(target, newName, "overwrite")` and the target resolves to a directory (Drive `mimeType: "application/vnd.google-apps.folder"`, OneDrive `folder` facet, or S3 virtual prefix)
- **THEN** the call rejects with `DatasourceError { tag: "unsupported", retryable: false }` and message "directory rename with conflictPolicy 'overwrite' is not supported (would require recursive replacement)"; no rename API call is issued

### Requirement: Rename conflict surfaces `DatasourceError { tag: "conflict" }` when policy is "fail"

The `DatasourceErrorTag` taxonomy SHALL include a new member `Conflict =
"conflict"`. When `rename` is called with `conflictPolicy: "fail"` and
the target name collides with an existing remote sibling at the same
parent path, the call SHALL reject with
`DatasourceError { tag: "conflict", retryable: false, raw:
{ existingPath: string } }`.

When `conflictPolicy: "overwrite"`, the engine SHALL delete the colliding
sibling (via the existing `deleteFile` path) before performing the rename;
the operation SHALL resolve with the new entry; the internal delete of the
colliding sibling is not surfaced separately (the engine emits no event).

When `conflictPolicy: "keep-both"`, the engine SHALL append `-2` / `-3` /
… suffix and retry until success or until 99 attempts (then fail with
`tag: "provider-error", message: "exhausted keep-both attempts"`). The
engine `DatasourceErrorTag` taxonomy does not include `"other"`; the
service-side wire mapping at `services/fs-sync/src/commands/files-error-mapping`
collapses `provider-error` → `tag: "other"` before the renderer sees it.

#### Scenario: Rename to existing sibling with policy "fail"

- **WHEN** the user renames `foo.pdf` to `bar.pdf` and `bar.pdf` already exists at the same parent path, with `conflictPolicy: "fail"`
- **THEN** the call rejects with `DatasourceError { tag: "conflict", raw: { existingPath: "/parent/bar.pdf" } }`; no provider mutation occurs (the engine emits no event)

#### Scenario: Rename with policy "overwrite" replaces the colliding sibling

- **WHEN** the user renames `foo.pdf` to `bar.pdf`, `bar.pdf` exists, and `conflictPolicy: "overwrite"`
- **THEN** the engine deletes the existing `bar.pdf` first, then performs the rename; the call resolves with the new entry; the internal delete of the colliding sibling is not separately surfaced (the engine emits no event)

#### Scenario: Rename with policy "keep-both" auto-suffixes

- **WHEN** the user renames `foo.pdf` to `bar.pdf` and both `bar.pdf` and `bar-2.pdf` exist, with `conflictPolicy: "keep-both"`
- **THEN** the engine retries with `bar-2.pdf` (collides), then `bar-3.pdf` (succeeds); the call resolves with the new entry `{ path: "/parent/bar-3.pdf", … }` (the engine emits no event)

### Requirement: `uploadFile` is a one-shot stateless primitive

`BaseDatasourceClient.uploadFile(parent: Target, file: { path: string; name?: string; mimeType?: string }, options?: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void }): Promise<DatasourceFileEntry<T>>` SHALL be a one-shot wrapper around `withRefresh(() => doUploadFileImpl(parent, file, options))`. The base SHALL NOT mint a transaction-id, SHALL NOT maintain an `activeUploads` tracker map, SHALL NOT emit any event (the engine has no event bus), and SHALL NOT expose a `cancelUpload` method. Cancellation is consumer-driven via `options.signal`. Progress is consumer-observed via `options.onProgress`. The strategy returns the entry on success; rejections propagate as normalized `DatasourceError`.

The `withRefresh` wrapper is retained on `uploadFile` in this change. The follow-up `migrate-engine-retry-policy-to-consumer` covers retry-policy ownership; this change does not touch that wrapper.

#### Scenario: uploadFile resolves with the entry on success

- **WHEN** a caller invokes `client.uploadFile(parent, { path: "/local/x.txt" }, { onProgress })` against a strategy whose `doUploadFileImpl` resolves with a valid `DatasourceFileEntry<T>`
- **THEN** the call resolves with that entry; no event is emitted (the engine has no event bus); `onProgress` was invoked at least once during the upload with non-decreasing `loaded` values

#### Scenario: uploadFile rejects with the strategy's normalized error on failure

- **WHEN** a caller invokes `client.uploadFile(...)` and the strategy's `doUploadFileImpl` throws a raw provider exception
- **THEN** the wrapper invokes `normalizeError(raw)` and rejects with the resulting `DatasourceError<T>` (the engine emits no event)

#### Scenario: uploadFile single-flight refreshes once on auth-expired

- **WHEN** two concurrent `uploadFile` calls on the same datasource each receive a raw exception that `normalizeError` tags `"auth-expired"`
- **THEN** `refreshToken` is invoked exactly once, both calls await the same refresh promise, both retry their `doUploadFileImpl` after refresh resolves (the engine emits no event; `refreshCredentials` persists via `CredentialStore.put`)

### Requirement: Strategy LRU path-handle invalidation on upload completion is internal

Drive and OneDrive strategies maintain a path-handle LRU cache. After this migration, LRU population on successful upload SHALL be performed internally inside `doUploadFileImpl` (calling `this.pathHandleCache.set(entry.path, entry.handle)` directly before returning), NOT via any event bus. Strategy constructors register NO bus subscriptions (the engine has no event bus); deletion/rename eviction is performed inline within `doDeleteFileImpl` / `doRenameImpl` (see Requirement: Hybrid `Target` type supports both path and handle addressing).

#### Scenario: Drive LRU is populated by uploadFile success

- **WHEN** an upload to Google Drive resolves successfully and returns an entry whose `path` was not previously in the strategy's LRU
- **THEN** the LRU contains `entry.path → entry.handle` after the call resolves; no event is emitted (the engine has no event bus)

#### Scenario: OneDrive LRU is populated by uploadFile success

- **WHEN** an upload to OneDrive resolves successfully and returns an entry whose `path` was not previously in the strategy's LRU
- **THEN** the LRU contains `entry.path → entry.handle` after the call resolves; no event is emitted (the engine has no event bus)

#### Scenario: Drive LRU is invalidated inline by deleteFile

- **WHEN** `deleteFile` succeeds for a path present in the strategy's LRU
- **THEN** the strategy evicts that path's LRU entry inline within `doDeleteFileImpl` (there is no bus subscription; the engine has no event bus)

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

#### Scenario: Scope-insufficient rejection carries the auth-revoked tag on the thrown error

- **GIVEN** a `GoogleDriveClient` whose `meta.scope` is `drive.file`
- **WHEN** `status()` is called
- **THEN** it rejects with a `DatasourceError` whose `tag === "auth-revoked"` and whose `raw` is `{ kind: "scope-insufficient", requiredScope: "https://www.googleapis.com/auth/drive", actualScope: <verbatim meta.scope> }`; the engine emits no event (the structured discriminator is carried on the THROWN error, verified by the rejection scenarios above)
