## MODIFIED Requirements

### Requirement: IPC command surface

The service SHALL accept and correctly respond to the following commands on its IPC channel: `sync:enqueue-upload`, `sync:enqueue-mirror`, `sync:list-jobs`, `sync:get-job`, `sync:cancel-job`, `sync:subscribe-events`, `sync:unsubscribe-events`, `sync:set-retry-policy`, `sync:get-retry-policy`, `sync:authenticate-start`, `sync:authenticate-complete`, `sync:authenticate-cancel`, `sync:get-config`, `sync:set-config`, `sync:delete-credentials`, `sync:get-status`, `files:list`, `files:stat`, `files:search`, `files:remove`. The previous monolithic `sync:authenticate` command SHALL NOT be present — it has been split into the three-command shape above per the "service is the canonical authenticate entry point" requirement. Request and response types for every command SHALL be declared in `@ft5/ipc-contracts/sync-service` as discriminated unions, keyed by the `command` field. Any command frame whose `command` is not in this enumerated set SHALL receive a response with `ok: false, error.tag === 'unknown-command'`.

The four `files:*` commands SHALL each accept `{ datasourceId: string, … }` and resolve the engine client for that `datasourceId` via the service's existing `ClientFactory`. The response envelope SHALL be a discriminated union `{ ok: true, value: T } | { ok: false, error: { tag: FilesErrorTag, message: string, retryable: boolean, retryAfterMs?: number } }` where `FilesErrorTag` is exposed as an `as const` object with a derived type (matching the codebase convention for `FILES_CHANNELS` / `DATASOURCES_CHANNELS`):

```typescript
export const FilesErrorTag = {
  AuthRevoked: "auth-revoked",
  Disconnected: "disconnected",
  RateLimited: "rate-limited",
  Other: "other",
  InvalidDatasource: "invalid-datasource",
} as const;
export type FilesErrorTag =
  (typeof FilesErrorTag)[keyof typeof FilesErrorTag];
```

`T` is unchanged from the prior version of this requirement (`files:list` → `{ entries; truncated }`, `files:stat` → `{ entry }`, `files:search` → `{ entries; truncated }`, `files:remove` → `{ results: […] }`). The `normalizeFilesError` helper's mapping is unchanged.

#### Scenario: Unknown command is rejected

- **WHEN** a client sends a request with `command: "sync:fly-to-mars"`
- **THEN** it receives a response with `ok: false` and `error.tag === 'unknown-command'`

#### Scenario: Old `sync:authenticate` is no longer accepted

- **WHEN** a client sends a request with `command: "sync:authenticate"` (the retired single-command shape)
- **THEN** the response is `{ ok: false, error: { tag: "unknown-command" } }` — the same error any unrecognized command would receive

#### Scenario: New three-command authenticate split is present

- **WHEN** a contract test imports the command-name enumeration from `@ft5/ipc-contracts/sync-service`
- **THEN** `"sync:authenticate-start"`, `"sync:authenticate-complete"`, and `"sync:authenticate-cancel"` are each present exactly once, and `"sync:authenticate"` (the retired name) is absent

#### Scenario: New config commands are present

- **WHEN** a contract test imports the command-name enumeration from `@ft5/ipc-contracts/sync-service`
- **THEN** `"sync:get-config"` and `"sync:set-config"` are each present exactly once

### Requirement: `sync:authenticate` is the canonical credential-writing entry point

The service SHALL accept the three-command authenticate split as the only path that writes to `ConfigFileCredentialStore`. No other component in the repository SHALL write to the credential store outside of (a) these three handlers and (b) the engine's `BaseDatasourceClient` single-flight refresh path (which already writes through the injected `CredentialStore`). Desktop main SHALL NOT have a local credential store.

`sync:authenticate-start` accepts `{ providerId: ProviderId, datasourceId?: string }` and responds with `{ ok: true, result: { correlationId: string, kind: "oauth" } } | { ok: true, result: { correlationId: string, kind: "credentials-form", formSchema } } | { ok: false, error }`. The handler SHALL:
1. Read the per-provider OAuth app config (for OAuth-class providers) via `ServiceConfigStore.getOAuthAppConfig(providerId)`. On `ServiceConfigMissingError`, respond `{ ok: false, error: { tag: "service-config-missing", path, providerId } }`.
2. Construct the engine client via `factory.createForAuth(providerId, oauthAppConfig | null, ctx)`.
3. Call `client.authenticate()` to obtain the live `AuthIntent`.
4. Stash the intent in `AuthCorrelationStore` and obtain a `correlationId`.
5. For `intent.kind === "oauth"`: hand off to `OAuthLoopbackBroker.start({ correlationId, providerId, datasourceId, intent })` which binds the loopback, builds the final authorize URL with state + PKCE, and emits `oauth-open-url` carrying the URL. Respond `{ ok: true, result: { correlationId, kind: "oauth" } }`.
6. For `intent.kind === "credentials-form"`: extract the form schema and respond `{ ok: true, result: { correlationId, kind: "credentials-form", formSchema } }`.
7. Emit `auth-initiated` with `{ correlationId, providerId, datasourceId? }`.

`sync:authenticate-complete` accepts `{ correlationId: string, completion: { kind: "credentials-form", values } }` (the `kind: "oauth"` completion arrives from the loopback callback inside the service, not from the renderer). The handler SHALL:
1. Consume the correlation via `AuthCorrelationStore.consume(correlationId)`. On miss, respond `{ ok: false, error: { tag: "correlation-expired", correlationId } }`.
2. Validate `intent.kind === completion.kind`. On mismatch, respond `{ ok: false, error: { tag: "intent-kind-mismatch", expected, actual } }`.
3. For credentials-form: invoke `intent.submit(completion.values)`. The engine's `decorateIntent` writes the resulting `AuthResult` via `credentialStore.put(datasourceId, …)`.
4. Construct a `DatasourceSummary` and emit `credential-persisted { correlationId, datasourceId, summary }` AND `auth-completed { correlationId, datasourceId, summary }`.

`sync:authenticate-cancel` accepts `{ correlationId: string }` and idempotently:
1. Consumes the correlation if present (`AuthCorrelationStore.consume`).
2. Calls `OAuthLoopbackBroker.cancel({ correlationId })` if a loopback session exists for it (idempotent no-op otherwise).
3. Emits `auth-cancelled { correlationId }` exactly once per active correlation. A second cancel for the same `correlationId` SHALL be a no-op (no event, no error).

The OAuth-class loopback callback path (inside the service) drives the OAuth completion without a renderer round-trip: on a valid `/callback` HTTP request, the broker invokes `intent.completeWith(code)`, the engine's `decorateIntent` writes credentials, and the broker emits `credential-persisted` + `auth-completed` events identical in shape to the credentials-form path.

#### Scenario: OAuth start returns kind=oauth and emits oauth-open-url

- **WHEN** a client sends `sync:authenticate-start { providerId: "google-drive" }` with the service config populated for Google Drive
- **THEN** the response is `{ ok: true, result: { correlationId: <uuid>, kind: "oauth" } }`; the next event on the stream is `auth-initiated`; the next event after that is `oauth-open-url` carrying `{ correlationId, authorizeUrl }`; the loopback HTTP server is bound on `127.0.0.1:<port>`; `factory.createForAuth("google-drive", oauthAppConfig, ctx)` was invoked exactly once

#### Scenario: OAuth completion writes credentials via the loopback and emits credential-persisted

- **WHEN** a test simulates a valid GET to the loopback `/callback?code=valid-code&state=<correct-state>` for an active OAuth correlation
- **THEN** the broker invokes `intent.completeWith("valid-code")` exactly once; `credentialStore.put(datasourceId, AuthResult)` is invoked exactly once; the next two events on the stream are `credential-persisted { correlationId, datasourceId, summary }` and `auth-completed { correlationId, datasourceId, summary }`; the loopback server is closed; the correlation is consumed

#### Scenario: Credentials-form completion writes credentials via the request/response handler

- **WHEN** a client sends `sync:authenticate-start { providerId: "amazon-s3" }`, gets a `correlationId`, and then sends `sync:authenticate-complete { correlationId, completion: { kind: "credentials-form", values: { accessKeyId, secretAccessKey, region } } }`
- **THEN** the response is `{ ok: true, result: { datasourceId, summary } }`; `intent.submit(values)` was invoked exactly once; `credentialStore.put(datasourceId, AuthResult)` was invoked exactly once; the next two events on the stream are `credential-persisted` and `auth-completed`

#### Scenario: Service-config-missing on OAuth start

- **WHEN** a client sends `sync:authenticate-start { providerId: "google-drive" }` and `~/ft5/sync_app/config.json` does not exist (or has empty `clientId`)
- **THEN** the response is `{ ok: false, error: { tag: "service-config-missing", path: <abs path>, providerId: "google-drive" } }`; no engine client is constructed; no event is emitted; no loopback server is bound

#### Scenario: Cancel is idempotent and emits exactly once per active correlation

- **WHEN** a client sends `sync:authenticate-cancel { correlationId }` twice in succession for an active OAuth correlation
- **THEN** the first cancel emits `auth-cancelled { correlationId }` exactly once and closes the loopback server; the second cancel returns `{ ok: true, result: { cancelled: false } }` (already-cancelled), emits NO event, and does NOT throw

#### Scenario: Correlation expired returns the typed error

- **WHEN** a client sends `sync:authenticate-complete { correlationId, completion }` 6 minutes after `sync:authenticate-start` returned the correlation (default TTL is 5 minutes)
- **THEN** the response is `{ ok: false, error: { tag: "correlation-expired", correlationId } }`; no `credentialStore.put` call occurs; no `auth-completed` event is emitted

#### Scenario: No other writer to credentials.json

- **WHEN** a Vitest test grep-scans every `.ts` file under `services/fs-sync/src/` and `apps/desktop/src/` for calls to `ConfigFileCredentialStore.prototype.put` or equivalent
- **THEN** the only call sites are inside (a) the three authenticate handlers (or modules they call: the loopback broker + the credentials-form complete path), (b) the engine's `BaseDatasourceClient` refresh path (invoked via the injected store), and (c) the `sync:delete-credentials` deletion path; NO match exists under `apps/desktop/src/`

### Requirement: Service bootstrap composes the full runtime

The service's `main/index.ts` SHALL, after migrations + integrity check + PID guard acquisition and BEFORE opening the IPC listener to new clients, construct and start the full runtime: credential store → service config store → provider registry → client factory → job repository → scheduler (with concurrency semaphore) → network probe → OAuth loopback broker (registered against the auth correlation store and the engine bus) → recovery (running-jobs re-queue) → IPC server. The IPC server SHALL bind only after every prior step returns without error.

The service SHALL register SIGINT and SIGTERM handlers that, on signal:

1. Stop accepting new connections on the IPC listener.
2. Allow in-flight requests to complete with a bounded grace period (default 5 s).
3. Pause the scheduler (jobs in `running` SHALL be allowed to reach their next persisted state — `completed`, `failed`, `waiting-network` — before shutdown proceeds).
4. Cancel all active OAuth loopback sessions (the broker's `dispose()` closes every pending HTTP server and clears every timer).
5. Close the IPC server, close the DB, release the PID guard, and exit cleanly with code 0.

The service SHALL remain in its run-loop indefinitely until a signal or fatal internal error arrives. "Fatal internal error" SHALL include: IPC listener bind failure after PID-guard acquisition, unrecoverable DB error (e.g., `SQLITE_IOERR`), uncaught exception in the top-level runtime (logged + exit 1).

#### Scenario: Service runs a full request after bootstrap

- **WHEN** the service starts fresh (no existing data dir) with `--dev`
- **THEN** within 3 seconds a client can connect to the dev pipe, send `sync:get-status`, and receive `{ ok: true, result: { ..., runningJobs: 0, queuedJobs: 0 } }`; the PID file exists; `service.log` has lines tagged `bootstrap-complete`

#### Scenario: Bootstrap order is observable

- **WHEN** a test wraps each bootstrap stage in a spy and boots the service
- **THEN** the observed call order is: open DB → run migrations → integrity check → acquire PID guard → construct credential store → construct service config store → construct provider registry → construct client factory → construct scheduler + probe → construct OAuth loopback broker → run `recoverRunningJobs` → bind IPC listener; the IPC listener's bind SHALL be the LAST observable side-effect before the service enters its idle wait

#### Scenario: SIGINT cancels active OAuth sessions before exit

- **WHEN** the service has one active OAuth correlation (loopback bound, browser tab waiting) and receives SIGINT
- **THEN** before the process exits, the loopback HTTP server is closed (its socket is no longer listening); the `auth-cancelled` event is emitted for the correlation OR no event is emitted (acceptable both ways since the listener tear-down happens during shutdown); the PID file is removed; the process exits with code 0 within 5 seconds

#### Scenario: SIGINT shuts down cleanly

- **WHEN** the service is running with one in-flight `sync:list-jobs` request and receives SIGINT
- **THEN** the list-jobs response is written to the client, the listener stops accepting new connects within 100 ms, the PID file is removed, and the process exits with code 0 within 5 seconds

#### Scenario: IPC bind failure after PID acquisition is fatal

- **WHEN** the PID guard is acquired but binding the IPC listener fails (e.g., pipe path unwritable)
- **THEN** the service logs a fatal error, releases the PID guard, and exits with a non-zero code (specific code = 5); a subsequent invocation SHALL not see a stale PID file

## ADDED Requirements

### Requirement: `OAuthLoopbackBroker` hosts a per-correlation loopback HTTP listener inside the service

The service SHALL own an `OAuthLoopbackBroker` module under `services/fs-sync/src/oauth/`. The broker SHALL be constructed in `bootstrap.ts` (after the auth correlation store and before IPC bind) and SHALL expose at least `start({correlationId, providerId, datasourceId?, intent})`, `cancel({correlationId})`, and `dispose()`.

`broker.start(...)` SHALL: (1) generate CSRF `state` (32 random bytes base64url); (2) create an HTTP server via `http.createServer()` and bind it to `127.0.0.1` on port `0`, letting the OS pick the port; (3) compute the redirect URI as `http://127.0.0.1:<port>/callback` and verify that the intent's authorize URL was constructed with the same redirect URI (the engine's `createForAuth` path threads it through `PreAuthConfig`); (4) append `&state=<state>` to the authorize URL; (5) start a 5-minute timeout timer (300_000 ms); (6) emit `oauth-open-url { correlationId, authorizeUrl }` on the engine bus; (7) store a pending-session record keyed by `correlationId` in an in-memory `Map`.

The loopback HTTP handler SHALL accept exactly one request at `GET /callback` per pending session. On match it SHALL: (a) verify `state` against the pending-session record's `state` (strict equality; reject otherwise with `auth-failed { correlationId, tag: "auth-revoked" }`); (b) respond `200 OK` with a minimal HTML page reading "You can close this tab and return to the app"; (c) invoke `intent.completeWith(code)` (engine-side threads the verifier into the token exchange); (d) on resolution, emit `credential-persisted { correlationId, datasourceId, summary }` followed by `auth-completed { correlationId, datasourceId, summary }`; on rejection, emit `auth-failed { correlationId, tag, message }`; (e) close the HTTP server, clear the 5-minute timer, delete the pending-session record.

`broker.cancel({correlationId})` SHALL close the HTTP server for that session, clear the timer, delete the pending-session record, and emit `auth-cancelled { correlationId }`. The method is idempotent — cancelling a session that is already terminated SHALL be a no-op.

On timer expiry, the broker SHALL close the HTTP server, clear the pending-session record, and emit `auth-timeout { correlationId }`. The timer SHALL be cancelled on every other terminal path.

The broker SHALL NEVER write to `ConfigFileCredentialStore` directly — the engine's `decorateIntent` (consumed via `intent.completeWith`) is the only writer.

#### Scenario: Loopback binding returns an ephemeral port

- **WHEN** a unit test calls `broker.start(...)` with a stubbed engine bus and a pre-built test intent
- **THEN** the pending-session record carries a port in the range 1024–65535, the loopback HTTP listener is actually listening on `127.0.0.1:<port>` (as verified by a subsequent HTTP request from the same test), and the emitted `oauth-open-url` event's `authorizeUrl` parameter decodes to a URL whose `redirect_uri` query parameter is `http://127.0.0.1:<port>/callback`

#### Scenario: State mismatch rejects the callback and emits auth-failed

- **WHEN** a test simulates a GET to `/callback?code=fake-code&state=ATTACKER_STATE` against an active session whose stored `state` is `LEGITIMATE_STATE`
- **THEN** the handler does NOT invoke `completeWith`; the HTTP response is a 400-class status with an error message; the next event on the stream is `auth-failed { correlationId, tag: "auth-revoked" }`; the pending session is cleared

#### Scenario: Valid callback drives credential persistence and emits the two terminal events

- **WHEN** a test simulates a GET to `/callback?code=valid-code&state=<correct-state>` and the engine's mock token endpoint returns tokens
- **THEN** `completeWith("valid-code")` is invoked exactly once; the engine's `decorateIntent` calls `credentialStore.put(datasourceId, AuthResult)` exactly once; the next events on the stream in order are `credential-persisted { correlationId, datasourceId, summary }` and `auth-completed { correlationId, datasourceId, summary }`; the loopback server is closed

#### Scenario: 5-minute timeout fires when the user does not consent

- **WHEN** a test uses Vitest fake timers, calls `broker.start(...)`, and advances the clock by 300_001 ms without any callback hit
- **THEN** the next event on the stream is `auth-timeout { correlationId }`, the loopback server for that session is closed, the pending-session record is gone, and no further events fire for that `correlationId`

#### Scenario: Cancel closes listener and emits auth-cancelled

- **WHEN** a test calls `broker.cancel({correlationId})` on an active session
- **THEN** subsequent HTTP requests to `http://127.0.0.1:<port>/callback` fail with `ECONNREFUSED`, the next event on the stream is `auth-cancelled { correlationId }`, and a second `cancel` on the same `correlationId` is a no-op

#### Scenario: Dispose tears down all active sessions

- **WHEN** the broker has three active sessions and `broker.dispose()` is called
- **THEN** all three HTTP servers are closed; all three timers are cleared; the pending-session map is empty; subsequent `start(...)` / `cancel(...)` calls are no-ops or throw documented errors

### Requirement: `ServiceConfigStore` reads `~/ft5/sync_app/config.json` for OAuth app config

The service SHALL own a `ServiceConfigStore` module under `services/fs-sync/src/config/`. The store SHALL be constructed at bootstrap and SHALL be the single point of truth for per-provider OAuth app configuration during the service's process lifetime.

The store SHALL read from `<dataDir>/config.json` (where `dataDir` is the same directory that contains `credentials.json`). The schema SHALL be:

```json
{
  "schemaVersion": 1,
  "providers": {
    "<providerId>": { "clientId": "<string>", "clientSecret": "<string>" }
  }
}
```

`getOAuthAppConfig(providerId): OAuthAppConfig` SHALL:
- Return `{ clientId, clientSecret, redirectUri }` for the requested provider when the file exists, parses successfully, and the provider entry has non-empty `clientId` and `clientSecret`. The `redirectUri` field is computed by the broker at session-start time, NOT stored in the file.
- Throw `ServiceConfigMissingError` (a typed error class with `path` and `providerId` fields) when (a) the file is absent, OR (b) the file exists but cannot be parsed, OR (c) the file parses but does not contain an entry for `providerId`, OR (d) the provider entry's `clientId` or `clientSecret` is the empty string.

The store SHALL NEVER auto-create the config file. The repo SHALL ship a committed template at `services/fs-sync/config.example.json` containing the provider keys (`google-drive`, `onedrive`) with empty values.

A `getRaw()` method SHALL return the parsed file content for the `sync:get-config` handler. A `setRaw(next)` method SHALL atomically write the file (write-to-tmp + rename) with mode 0o600 on Unix, mirroring the existing `ConfigFileCredentialStore` pattern.

#### Scenario: getOAuthAppConfig returns the populated entry

- **WHEN** the file exists with `providers["google-drive"] = { clientId: "abc", clientSecret: "def" }` and a test calls `store.getOAuthAppConfig("google-drive")` (with a redirectUri-injecting closure)
- **THEN** the call resolves with `{ clientId: "abc", clientSecret: "def", redirectUri: <the-injected-uri> }`

#### Scenario: getOAuthAppConfig throws ServiceConfigMissingError when file is absent

- **WHEN** `<dataDir>/config.json` does not exist and a test calls `store.getOAuthAppConfig("google-drive")`
- **THEN** the call throws `ServiceConfigMissingError` whose `path` is the absolute resolved file path and `providerId` is `"google-drive"`

#### Scenario: getOAuthAppConfig throws when entry has empty clientId

- **WHEN** the file exists with `providers["google-drive"] = { clientId: "", clientSecret: "def" }` and a test calls `store.getOAuthAppConfig("google-drive")`
- **THEN** the call throws `ServiceConfigMissingError`; the error's `providerId` is `"google-drive"`

#### Scenario: getRaw + setRaw round-trip

- **WHEN** a test calls `store.setRaw({ schemaVersion: 1, providers: { "google-drive": { clientId: "x", clientSecret: "y" } } })` and then `store.getRaw()`
- **THEN** the round-tripped value matches; the file at `<dataDir>/config.json` exists with mode 0o600 on Unix; a subsequent `store.getOAuthAppConfig("google-drive")` (with redirectUri injection) succeeds

#### Scenario: Committed template exists and parses

- **WHEN** a test reads `services/fs-sync/config.example.json` from the repo
- **THEN** the file is valid JSON; the parsed object has `schemaVersion === 1` and a `providers` object with at least `google-drive` and `onedrive` keys; both keys have empty-string `clientId` and `clientSecret` values

### Requirement: `service-config-missing` is the canonical error tag for absent or incomplete OAuth app config

The service's authenticate-start handler SHALL surface `ServiceConfigMissingError` as the wire error `{ tag: "service-config-missing", path: string, providerId: string }`. The tag SHALL be a member of the `SyncAuthenticateStartErrorTag` discriminated union exported from `@ft5/ipc-contracts/sync-service`. The tag SHALL NOT appear on the credentials-form path (S3, custom) — those providers do not consult the OAuth app config.

The renderer's `oauth-form` failure-state rendering SHALL recognize the tag and surface user-facing copy that includes the absolute file `path` and a pointer to the per-provider OAuth registration section in `README.md`.

#### Scenario: Tag is exposed by the contract

- **WHEN** a contract type test imports `SyncAuthenticateStartErrorTag` from `@ft5/ipc-contracts/sync-service`
- **THEN** the union contains `"service-config-missing"`; the corresponding error shape includes `path: string` and `providerId: string`

#### Scenario: OAuth start returns the typed error when config is incomplete

- **WHEN** the service's authenticate-start handler is invoked with `providerId: "google-drive"` and `ServiceConfigStore.getOAuthAppConfig` throws `ServiceConfigMissingError`
- **THEN** the response is `{ ok: false, error: { tag: "service-config-missing", path: <absolute>, providerId: "google-drive" } }`

#### Scenario: Credentials-form path does not surface the tag

- **WHEN** a test invokes the authenticate-start handler with `providerId: "amazon-s3"` and the config file is empty
- **THEN** the handler does NOT call `ServiceConfigStore.getOAuthAppConfig`; the response is `{ ok: true, result: { correlationId, kind: "credentials-form", formSchema } }`

### Requirement: `sync:get-config` and `sync:set-config` expose the service config to the desktop

The service SHALL accept `sync:get-config` (no parameters) and respond with `{ ok: true, result: { config: ServiceConfig } }` where `ServiceConfig` is the parsed file content (or a default empty shape when the file does not exist). The service SHALL accept `sync:set-config { config: ServiceConfig }` and atomically write the file. Both handlers SHALL preserve the `schemaVersion: 1` invariant.

The renderer SHALL NOT call these commands in this change — they exist for a future settings UI. Test coverage SHALL prove the round-trip from a desktop test client.

#### Scenario: get-config returns the empty shape when file is absent

- **WHEN** the service starts with no `<dataDir>/config.json` and a client sends `sync:get-config`
- **THEN** the response is `{ ok: true, result: { config: { schemaVersion: 1, providers: {} } } }`

#### Scenario: set-config writes the file atomically and round-trips through get-config

- **WHEN** a client sends `sync:set-config { config: { schemaVersion: 1, providers: { "google-drive": { clientId: "X", clientSecret: "Y" } } } }` and then `sync:get-config`
- **THEN** the second response carries the exact same content; the file at `<dataDir>/config.json` has mode 0o600 on Unix; a subsequent `sync:authenticate-start { providerId: "google-drive" }` no longer returns `service-config-missing`

### Requirement: `sync:delete-credentials` removes the per-user credential entry

The service SHALL accept `sync:delete-credentials { datasourceId: string }` and respond with `{ ok: true, result: { deleted: boolean } }` (where `deleted` is `true` when an entry existed and was removed, `false` when no entry existed). The handler SHALL invoke `ConfigFileCredentialStore.delete(datasourceId)` and SHALL NOT touch any other state. The desktop's `datasources:remove` IPC handler SHALL call this command after the local registry row is deleted, so credentials and registry rows are consistently cleaned up during the registry-stays-in-desktop transition state.

The handler SHALL log a structured warning (`bridge-credential-delete-failed` with `datasourceId` and `errorMessage`) on `credentialStore.delete` rejection but SHALL still return a non-throwing response — the renderer-visible flow is best-effort cleanup, not a strict guarantee.

#### Scenario: Delete returns true when an entry exists

- **WHEN** the credential store has an entry for `ds-X` and a client sends `sync:delete-credentials { datasourceId: "ds-X" }`
- **THEN** the response is `{ ok: true, result: { deleted: true } }`; a subsequent `credentialStore.get("ds-X")` resolves to `null`

#### Scenario: Delete returns false when no entry exists

- **WHEN** the credential store has no entry for `ds-Y` and a client sends `sync:delete-credentials { datasourceId: "ds-Y" }`
- **THEN** the response is `{ ok: true, result: { deleted: false } }`; the credential store is unchanged

### Requirement: Service event stream carries the `auth-*` event taxonomy

The service event stream (delivered to subscribed clients via `SYNC_CHANNELS.event` per the `fs-sync-supervisor` capability) SHALL emit the following events with the listed payload shapes:

| Event | Payload | Producer |
|---|---|---|
| `auth-initiated` | `{ correlationId: string, providerId: ProviderId, datasourceId?: string }` | `sync:authenticate-start` |
| `auth-completed` | `{ correlationId: string, datasourceId: string, summary: DatasourceSummary }` | OAuth loopback callback / credentials-form complete handler |
| `auth-cancelled` | `{ correlationId: string }` | `sync:authenticate-cancel`; OAuth loopback timer (only when cancel was the trigger) |
| `auth-failed` | `{ correlationId: string, tag: AuthFailedTag, message?: string }` | OAuth loopback (state mismatch, completeWith reject); engine errors during `submit` |
| `auth-timeout` | `{ correlationId: string }` | OAuth loopback 5-minute timer |
| `oauth-open-url` | `{ correlationId: string, authorizeUrl: string }` | `sync:authenticate-start` (oauth kind only) |
| `credential-persisted` | `{ correlationId: string, datasourceId: string, summary: DatasourceSummary }` | OAuth loopback callback / credentials-form complete handler |

`auth-completed` and `credential-persisted` SHALL fire as a pair (both, in either order) at every successful authenticate completion. Their distinct identities exist so the desktop event-bridge can filter `oauth-open-url` and `credential-persisted` out of the renderer-bound forward (they are bridge-only) while still letting the renderer consume `auth-completed`.

The event union type SHALL be exported from `@ft5/ipc-contracts/sync-service` as a discriminated union keyed by `event` with the corresponding payload field at the top level (consistent with the existing job-* events).

#### Scenario: All seven events are present in the contract

- **WHEN** a contract type test imports the `SyncEvent` union from `@ft5/ipc-contracts/sync-service`
- **THEN** every event name in the table above is a member of the union; payloads narrow correctly under `switch (e.event)` in TypeScript

#### Scenario: auth-completed and credential-persisted fire together on OAuth success

- **WHEN** a test runs an end-to-end OAuth completion against an active session
- **THEN** both `auth-completed` and `credential-persisted` events are emitted exactly once each for the same `correlationId` and `datasourceId`; their relative order is unspecified

#### Scenario: Bridge-only events are filtered before renderer forward

- **WHEN** a desktop event-bridge test subscribes to `oauth-open-url` and `credential-persisted` AND has a renderer-window subscriber registered
- **THEN** the bridge's renderer-forward path forwards every `auth-*` event but does NOT forward `oauth-open-url` or `credential-persisted`; the bridge-internal path consumes both bridge-only events for `shell.openExternal` and `registry.add` respectively

### Requirement: Development builds may bypass authenticate via `FT5_DEV_CREDENTIALS` (service-side)

When the service process starts with `process.env.FT5_DEV_CREDENTIALS === "1"`, the OAuth loopback broker SHALL log a single warning line (`⚠ FT5_DEV_CREDENTIALS active — browser consent bypassed`) on first `start(...)` call within the process, and subsequent `start(...)` calls for OAuth-class providers SHALL: (a) read `<dataDir>/dev-credentials.json` via the existing `ConfigFileCredentialStore` shape; (b) skip HTTP server binding and `oauth-open-url` emission; (c) emit `auth-completed` and `credential-persisted` synchronously (next tick) using the file-derived credentials; (d) NOT bind a loopback listener, NOT generate state, NOT emit `oauth-open-url`. In packaged production builds the env var SHALL NEVER be set — the service installer SHALL NOT propagate it into the service's runtime environment.

#### Scenario: Dev override short-circuits the browser flow

- **WHEN** a test starts the service with `FT5_DEV_CREDENTIALS=1`, a valid `dev-credentials.json` in the fixture data dir, and a stubbed loopback HTTP-server constructor
- **THEN** a `sync:authenticate-start { providerId: "google-drive" }` resolves; no HTTP server is bound; no `oauth-open-url` event is emitted; the next events on the stream are `auth-completed` and `credential-persisted` (carrying a synthetic correlationId) within one tick

#### Scenario: Production service does not propagate the env var

- **WHEN** a smoke test inspects the packaged service binary's embedded env / startup logs
- **THEN** `FT5_DEV_CREDENTIALS` is not in the packaged process env; the warning line is NOT printed on production startup

#### Scenario: Startup warning fires once when dev override is active

- **WHEN** the service starts with `FT5_DEV_CREDENTIALS=1` and three `sync:authenticate-start` calls run in sequence
- **THEN** exactly one log line matching `/FT5_DEV_CREDENTIALS active/` is emitted across the lifetime of the broker; no further warnings fire on subsequent `start(...)` calls
