# fs-datasource-engine spec delta — migrate-engine-retry-policy-to-consumer

## MODIFIED Requirements

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

## ADDED Requirements

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
