## ADDED Requirements

### Requirement: Service bootstrap composes the full runtime

The service's `main/index.ts` SHALL, after migrations + integrity check + PID guard acquisition and BEFORE opening the IPC listener to new clients, construct and start the full runtime: credential store → provider registry → client factory → job repository → scheduler (with concurrency semaphore) → network probe → recovery (running-jobs re-queue) → IPC server. The IPC server SHALL bind only after every prior step returns without error.

The service SHALL register SIGINT and SIGTERM handlers that, on signal:

1. Stop accepting new connections on the IPC listener.
2. Allow in-flight requests to complete with a bounded grace period (default 5 s).
3. Pause the scheduler (jobs in `running` SHALL be allowed to reach their next persisted state — `completed`, `failed`, `waiting-network` — before shutdown proceeds).
4. Close the IPC server, close the DB, release the PID guard, and exit cleanly with code 0.

The service SHALL remain in its run-loop indefinitely until a signal or fatal internal error arrives. "Fatal internal error" SHALL include: IPC listener bind failure after PID-guard acquisition, unrecoverable DB error (e.g., `SQLITE_IOERR`), uncaught exception in the top-level runtime (logged + exit 1).

#### Scenario: Service runs a full request after bootstrap

- **WHEN** the service starts fresh (no existing data dir) with `--dev`
- **THEN** within 3 seconds a client can connect to the dev pipe, send `sync:get-status`, and receive `{ ok: true, result: { ..., runningJobs: 0, queuedJobs: 0 } }`; the PID file exists; `service.log` has lines tagged `bootstrap-complete`

#### Scenario: Bootstrap order is observable

- **WHEN** a test wraps each bootstrap stage in a spy and boots the service
- **THEN** the observed call order is: open DB → run migrations → integrity check → acquire PID guard → construct credential store → construct scheduler + probe → run `recoverRunningJobs` → bind IPC listener; the IPC listener's bind SHALL be the LAST observable side-effect before the service enters its idle wait

#### Scenario: SIGINT shuts down cleanly

- **WHEN** the service is running with one in-flight `sync:list-jobs` request and receives SIGINT
- **THEN** the list-jobs response is written to the client, the listener stops accepting new connects within 100 ms, the PID file is removed, and the process exits with code 0 within 5 seconds

#### Scenario: IPC bind failure after PID acquisition is fatal

- **WHEN** the PID guard is acquired but binding the IPC listener fails (e.g., pipe path unwritable)
- **THEN** the service logs a fatal error, releases the PID guard, and exits with a non-zero code (specific code = 5); a subsequent invocation SHALL not see a stale PID file

### Requirement: `sync:authenticate` is the canonical credential-writing entry point

The service SHALL accept `sync:authenticate` requests carrying a provider id and credential intent payload. The handler SHALL resolve a `DatasourceClient<T>` via `ClientFactory.create`, invoke `client.authenticate()`, drive any required intent completion (OAuth URL exchange, credentials-form submission) via the request/response payload, and — on success — persist the resulting `AuthResult` to the service's `ConfigFileCredentialStore`. On success the handler SHALL respond `{ ok: true, result: AuthResult }`; on failure it SHALL respond `{ ok: false, error: DatasourceErrorShape }` preserving the engine's error tag.

No other component in the repository SHALL write to `ConfigFileCredentialStore` outside of `sync:authenticate` and the engine's `BaseDatasourceClient` single-flight refresh path (which already writes through the injected `CredentialStore`). Desktop main SHALL NOT have a local credential store.

#### Scenario: OAuth flow round-trips through the service

- **WHEN** a desktop client sends `sync:authenticate { providerId: 'google-drive', intent: { kind: 'begin' } }` and the service returns `{ ok: true, result: { kind: 'oauth', authorizeUrl, pendingId } }`, then the desktop client sends `sync:authenticate { providerId: 'google-drive', intent: { kind: 'complete', pendingId, code: 'auth-code' } }`
- **THEN** the service drives the OAuth exchange via the Google Drive strategy, persists the resulting tokens to `credentials.json`, and responds `{ ok: true, result: AuthResult }`; a subsequent `sync:enqueue-upload` for that datasource finds valid credentials

#### Scenario: Credentials-form flow persists on submit

- **WHEN** a desktop client sends `sync:authenticate` for an `amazon-s3` datasource with a `credentials-form` intent carrying `{ accessKeyId, secretAccessKey }`
- **THEN** the service invokes the S3 strategy's `authenticate`, persists the credentials, and responds with the populated `AuthResult`; `credentials.json` now contains an entry keyed by that `datasourceId` with plaintext strings matching the submitted values (plaintext is expected per the existing `ConfigFileCredentialStore` requirement)

#### Scenario: Authentication failure surfaces the engine error

- **WHEN** the provider strategy's `authenticate` throws `DatasourceError { tag: 'auth-revoked' }`
- **THEN** the service responds `{ ok: false, error: { tag: 'auth-revoked', retryable: false, ... } }`, the credential store is NOT written (no partial entry), and no `authenticated` event is emitted

#### Scenario: No other writer to credentials.json

- **WHEN** a Vitest test grep-scans every `.ts` file under `services/fs-sync/src/` and `apps/desktop/src/` for calls to `ConfigFileCredentialStore.prototype.put` or equivalent
- **THEN** the only call sites are inside (a) the `sync:authenticate` handler and (b) the engine's `BaseDatasourceClient` refresh path (invoked via the injected store), and NO match exists under `apps/desktop/src/`
