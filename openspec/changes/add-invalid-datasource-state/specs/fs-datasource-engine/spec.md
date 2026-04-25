## MODIFIED Requirements

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
