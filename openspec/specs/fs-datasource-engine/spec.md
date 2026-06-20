# fs-datasource-engine

## Purpose

The `fs-datasource-engine` capability is the shared, framework-agnostic main-process module that every datasource IPC handler calls into. It owns the public strategy interface (`DatasourceClient<T>`), the template base class that wraps every operation with event emission and single-flight token refresh, the factory and provider registry, the typed event bus with its streaming-throttle semantics, the credential-store port contract, the authentication-intent surface that keeps Electron UI out of the engine, and the normalized `DatasourceError` taxonomy. Concrete strategies for Amazon S3, OneDrive, and Google Drive conform to the interface; the engine lives at `packages/fs-datasource-engine` and imports only from `@ft5/ipc-contracts`, Node built-ins, and provider SDKs.
## Requirements
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

### Requirement: IPC handlers call into the engine, preserving contract shapes

All main-process IPC handlers under `apps/desktop/src/main/ipc/files/` and `apps/desktop/src/main/ipc/datasources/` SHALL call into the engine for their authoritative behaviour. The handlers SHALL NOT contain hard-coded fixture arrays, SHALL NOT import provider SDKs directly, and SHALL translate between the engine's `DatasourceClient` surface and the IPC contract types owned by `ipc-contracts` (`DatasourcesListResponse`, `FilesListResponse`, etc.). Contract shapes defined by `datasources-ui` and `ui-file-explorer` SHALL remain unchanged by this requirement — only handler bodies change.

The `files:list` handler SHALL forward the request's optional `cursor` and `pageSize` fields to `client.listDirectory(target, { cursor, pageSize })`, and SHALL surface the engine's `nextCursor` on the response envelope. The `truncated: boolean` field on the response envelope SHALL be derived as `nextCursor !== null` and SHALL NOT be authoritative on its own.

#### Scenario: Handlers forward to the engine

- **WHEN** a Vitest test spies on `ClientFactory.create` and on a per-provider mock strategy, then invokes the `files:list` handler with a valid `datasourceId`, `path`, and an optional `{ cursor, pageSize }`
- **THEN** the factory is invoked exactly once for that datasource (or a cached instance is reused), the strategy's `listDirectory` is invoked exactly once with a `Target` of `{ kind: "path", path }` AND an options object whose `cursor` and `pageSize` match the request, and the handler's response conforms to `FilesListResponse` (including the new `nextCursor: string | null` field; `truncated === (nextCursor !== null)`)

#### Scenario: No provider SDK imports in IPC handlers

- **WHEN** a grep test scans every file under `apps/desktop/src/main/ipc/`
- **THEN** no file imports from `googleapis`, `@microsoft/microsoft-graph-client`, or `@aws-sdk/client-s3`; these specifiers only appear inside `packages/fs-datasource-engine`

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

#### Scenario: Scope-insufficient rejection carries the auth-revoked tag on the thrown error

- **GIVEN** a `GoogleDriveClient` whose `meta.scope` is `drive.file`
- **WHEN** `status()` is called
- **THEN** it rejects with a `DatasourceError` whose `tag === "auth-revoked"` and whose `raw` is `{ kind: "scope-insufficient", requiredScope: "https://www.googleapis.com/auth/drive", actualScope: <verbatim meta.scope> }`; the engine emits no event (the structured discriminator is carried on the THROWN error, verified by the rejection scenarios above)

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

