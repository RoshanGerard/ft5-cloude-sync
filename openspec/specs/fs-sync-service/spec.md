# fs-sync-service

## Purpose

The `fs-sync-service` capability is the per-user background daemon that owns manual upload and one-way mirror-sync jobs for the `ft5-cloude-sync` desktop app. It runs independently of Electron (installed as a Scheduled Task on Windows, a LaunchAgent on macOS, or a `systemd --user` unit on Linux), so jobs continue after the app closes. It consumes `@ft5/fs-datasource-engine` for every provider call, persists jobs + a local-to-cloud sync snapshot in its own SQLite database at `$HOME/ft5/sync_app/sync.db`, exposes a newline-delimited JSON IPC surface over a named pipe (`\\.\pipe\ft5-sync` on Windows, `$HOME/ft5/sync_app/sync.sock` on Unix), enforces a global concurrency cap of 2 via a semaphore, applies a retry split (system-level network / rate-limit / auth-expired vs. user-configurable provider-error), and ships a plaintext `ConfigFileCredentialStore` with `0600` / user-ACL enforcement as its v1 `CredentialStore` binding. An input port (`MonitorEventSource`) is declared for a future `services/fs-monitor` change; in v1 the port is bound to a no-op and auto-sync commands are NOT exposed.
## Requirements
### Requirement: Service is a framework-agnostic, per-user Node.js daemon

The sync service SHALL live at `services/fs-sync/` as a pnpm workspace entry. It SHALL import only from `@ft5/ipc-contracts`, `@ft5/fs-datasource-engine`, Drizzle ORM (`drizzle-orm`, `better-sqlite3`), Node.js built-ins (`net`, `fs`, `fs/promises`, `crypto`, `path`, `dns/promises`, `os`, `child_process`), and its own internal modules. It SHALL NOT import from `electron`, `@electron/*`, any path under `apps/desktop/`, or any renderer-scoped specifier. The service SHALL run under the identity of the current OS user and SHALL NOT require elevated privileges (no Administrator on Windows, no root on macOS/Linux) to start, serve requests, or execute jobs.

#### Scenario: No Electron or desktop-app imports in the service

- **WHEN** a Vitest test grep-scans every `.ts` file under `services/fs-sync/src/`
- **THEN** no file contains an import specifier matching `electron`, `@electron/`, or any path starting with `apps/desktop/`

#### Scenario: Service starts without elevated privileges

- **WHEN** the service binary is launched in a CI container running as a non-root user with no sudoers entry
- **THEN** the service enters its main loop, opens its IPC listener, and serves a subsequent `sync:get-job` command for a nonexistent id with a `not-found` response

### Requirement: Data directory layout at `$HOME/ft5/sync_app`

The service SHALL create and use a data directory at `$HOME/ft5/sync_app/` (resolved via `os.homedir()`; on Windows this resolves to `%USERPROFILE%\ft5\sync_app\`). The directory SHALL contain the files `credentials.json`, `sync.db`, `service.pid`, `service.log`, and (on Unix prod only) `sync.sock`. The environment variable `FT5_SYNC_DATA_DIR`, when set, SHALL override the data directory root for the lifetime of the process. The service SHALL create any missing directories or files on first start, with directory mode `0700` on Unix and a user-only ACL on Windows.

#### Scenario: Data dir is created on first start

- **WHEN** the service starts with `$HOME/ft5/sync_app/` not present and `FT5_SYNC_DATA_DIR` unset
- **THEN** the directory is created with mode `0700`, and subsequent file writes inside it succeed

#### Scenario: `FT5_SYNC_DATA_DIR` override is honoured

- **WHEN** the service starts with `FT5_SYNC_DATA_DIR=/tmp/ft5-test-$RANDOM`
- **THEN** `credentials.json`, `sync.db`, and all runtime files are created under that directory; nothing is written to `$HOME/ft5/sync_app/`

### Requirement: Named-pipe JSON-line IPC transport

The service SHALL listen for client connections on a named-pipe path. In production mode the path SHALL be `\\.\pipe\ft5-sync` on Windows and `$HOME/ft5/sync_app/sync.sock` on Unix. In development mode the path SHALL be `\\.\pipe\ft5-sync-dev` on Windows and `$HOME/ft5/sync_app/sync-dev.sock` on Unix. The protocol SHALL be newline-delimited JSON frames; each frame is one of `Request { id, kind: "request", command, params }`, `Response { id, kind: "response", ok, result | error }`, or `Event { kind: "event", name, payload }`. The connection SHALL be bidirectional: the client writes requests; the server writes responses AND unsolicited event frames on the same stream. Request/response correlation SHALL use the `id` field. On Unix, the socket file SHALL be created with mode `0600`.

#### Scenario: Prod service listens on the production pipe

- **WHEN** the service starts without `--dev`
- **THEN** `net.connect('\\\\.\\pipe\\ft5-sync')` succeeds on Windows and `net.connect($HOME + '/ft5/sync_app/sync.sock')` succeeds on Unix

#### Scenario: Dev service listens on the dev pipe only

- **WHEN** the service starts with `--dev`
- **THEN** a client connecting to the prod pipe path receives `ECONNREFUSED` (or equivalent), and a client connecting to the dev pipe path succeeds

#### Scenario: Request / response correlation by id

- **WHEN** a client sends two `sync:list-jobs` requests concurrently with ids `"a"` and `"b"`
- **THEN** the client observes two response frames, each with a matching `id`, and responses MAY arrive in either order without being dropped or mis-routed

#### Scenario: Unix socket file permissions

- **WHEN** the service starts on Linux or macOS and creates `$HOME/ft5/sync_app/sync.sock`
- **THEN** `fs.stat` of the socket reports mode bits with no group or other access (`(stat.mode & 0o077) === 0`)

### Requirement: IPC command surface

The service SHALL accept and correctly respond to the following commands on
its IPC channel: `sync:enqueue-upload`, `sync:enqueue-mirror`,
`sync:list-jobs`, `sync:get-job`, `sync:cancel-job`, `sync:subscribe-events`,
`sync:unsubscribe-events`, `sync:set-retry-policy`, `sync:get-retry-policy`,
`sync:authenticate-start`, `sync:authenticate-complete`,
`sync:authenticate-cancel`, `sync:get-config`, `sync:set-config`,
`sync:delete-credentials`, `sync:get-status`, `files:list`, `files:stat`,
`files:search`, `files:remove`, `files:rename`, `files:download`,
`downloads:list-active`. The previous monolithic `sync:authenticate`
command SHALL NOT be present (per the prior change). Request and response
types for every command SHALL be declared in `@ft5/ipc-contracts/sync-service`
as discriminated unions, keyed by the `command` field. Any command frame
whose `command` is not in this enumerated set SHALL receive a response
with `ok: false, error.tag === 'unknown-command'`.

The new `files:rename` and `files:download` commands SHALL each accept
`{ datasourceId: string, … }` and resolve the engine client for that
`datasourceId` via the service's existing `ClientFactory`. The response
envelope SHALL be a discriminated union `{ ok: true, value: T } | { ok:
false, error: { tag: FilesErrorTag, message: string, retryable: boolean,
retryAfterMs?: number, existingPath?: string } }` where `FilesErrorTag` is
extended to include `Conflict` (the new tag carrying the optional
`existingPath` field).

`T` for `files:rename` is `{ entry: DatasourceFileEntry }`. `T` for
`files:download` is `{ savedPath: string, bytes: number }`. `T` for
`downloads:list-active` is `{ jobs: DownloadJob[] }`.

#### Scenario: New file commands are present

- **WHEN** a contract test imports the command-name enumeration from `@ft5/ipc-contracts/sync-service`
- **THEN** `"files:rename"`, `"files:download"`, and `"downloads:list-active"` are each present exactly once

#### Scenario: FilesErrorTag includes Conflict

- **WHEN** a contract test imports the `FilesErrorTag` constant
- **THEN** `Conflict: "conflict"` is among its members; the type derived from `(typeof FilesErrorTag)[keyof typeof FilesErrorTag]` includes the literal `"conflict"`

### Requirement: Single-instance guard via PID file

On startup, the service SHALL write its PID to `$HOME/ft5/sync_app/service.pid` (prod) or `service-dev.pid` (dev). If the PID file exists and references a currently-live process whose executable image name matches the service binary name, the new instance SHALL log the collision and exit with code `3`. If the referenced PID is not alive, OR it is alive but has a non-matching image name (stale reuse), the new instance SHALL overwrite the PID file and proceed normally.

#### Scenario: Second instance refuses to start

- **WHEN** the service is already running with PID 1234 recorded in `service.pid` (its process is alive), and a second invocation starts
- **THEN** the second process exits with code `3` within 500 ms and the first process continues serving requests

#### Scenario: Stale PID is overwritten

- **WHEN** `service.pid` references PID 1 (init, not the service) AND the service is invoked
- **THEN** the service overwrites the PID file with its own PID and proceeds to open the IPC listener

### Requirement: `ConfigFileCredentialStore` implements the engine's `CredentialStore` port

The service SHALL provide a class `ConfigFileCredentialStore` in `services/fs-sync/src/credential-store/config-file.ts` implementing the engine's `CredentialStore` interface exactly. Storage SHALL be plaintext JSON at `$HOME/ft5/sync_app/credentials.json` in the shape `{ "schemaVersion": 1, "credentials": { [datasourceId]: StoredCredentials } }`. Writes SHALL be atomic (write to a `credentials.json.tmp` sibling, then `fs.rename`). After every write on Unix, the file SHALL be `fchmod`-ed to `0600`. The store SHALL NOT depend on `electron` or `safeStorage`.

#### Scenario: Credentials round-trip through the store

- **WHEN** a test invokes `store.put("ds-1", { accessToken: "abc", refreshToken: "def" })` and then `store.get("ds-1")`
- **THEN** `get` resolves with an object structurally equal to the input; the on-disk file contains the literal strings `"abc"` and `"def"` (plaintext is expected)

#### Scenario: Atomic write survives a crash

- **WHEN** a test simulates a process crash between the temp-file write and the `rename`
- **THEN** on restart, `store.get` still returns the previous successfully-committed value; no `credentials.json.tmp` residue remains after a subsequent successful `put` (the subsequent `rename` cleans it up atomically)

#### Scenario: Delete removes the entry but keeps the file

- **WHEN** `store.delete("ds-1")` is called with two datasources `"ds-1"` and `"ds-2"` present
- **THEN** the file persists with `{ schemaVersion: 1, credentials: { "ds-2": ... } }`; a subsequent `store.get("ds-1")` resolves to `null`

### Requirement: Credential file refuses to operate when permissions widen (Unix)

On Unix, the `ConfigFileCredentialStore` SHALL `fs.stat` the credentials file before every `get` / `put` / `delete`. If the mode has any bit set in `0o077` (group or other access), the store SHALL NOT read or write, SHALL throw a `CredentialStorePermissionError`, and the service SHALL emit a `credential-store-permission-violation` event carrying the observed mode. On Windows, the analogous check SHALL compare the file's DACL against a canonical "current user only + SYSTEM only" descriptor; a mismatch SHALL produce the same refusal and event.

#### Scenario: Widened mode is refused on Unix

- **WHEN** a test creates `credentials.json` with mode `0o644`, then invokes `store.get("ds-1")`
- **THEN** the call rejects with `CredentialStorePermissionError`, no file content is read, and exactly one `credential-store-permission-violation` event is emitted with `payload.mode === "0o644"`

#### Scenario: Correct mode proceeds normally on Unix

- **WHEN** the credentials file exists with mode `0o600` and valid JSON content
- **THEN** `store.get("ds-1")` resolves with the stored value; no violation event is emitted

### Requirement: SQLite database schema and migrations

The service SHALL open a SQLite database at `$HOME/ft5/sync_app/sync.db` using `better-sqlite3`, with `journal_mode = WAL` and `synchronous = NORMAL`. Schema SHALL be defined via Drizzle ORM at `services/fs-sync/src/db/schema.ts` and SHALL include at least the tables `service_meta`, `jobs`, `sync_snapshot`, `retry_policies`. Migrations SHALL live under `services/fs-sync/drizzle/` and run forward-only on service start. The service SHALL run `PRAGMA integrity_check` on startup and, if the result is not `"ok"`, SHALL log a fatal error and exit with code `4`.

#### Scenario: Fresh database is initialized on first start

- **WHEN** the service starts against an empty `FT5_SYNC_DATA_DIR`
- **THEN** `sync.db` is created, all four core tables exist (verifiable via `sqlite_master`), and `service_meta` has exactly one row with `schemaVersion = 1`

#### Scenario: Integrity failure halts startup

- **WHEN** a test seeds `sync.db` with a deliberately-corrupted page, then invokes the service
- **THEN** the service exits with code `4` within 2 seconds, logs `"integrity-check-failed"`, and no IPC listener is opened

#### Scenario: Drizzle import is confined to the service's main tree

- **WHEN** a Vitest test grep-scans every `.ts` file under `services/fs-sync/src/` for `from "drizzle-orm"` or `from "better-sqlite3"`
- **THEN** matches exist only under `services/fs-sync/src/db/` and `services/fs-sync/src/main/`; no other subtree imports these modules

### Requirement: Jobs table state machine

The `jobs` table SHALL represent each job with a `status` column taking values from `'queued' | 'running' | 'waiting-network' | 'completed' | 'failed' | 'cancelled'`. Legal transitions SHALL be: `queued → running`; `queued → cancelled`; `running → waiting-network`; `running → completed`; `running → failed`; `running → cancelled`; `waiting-network → queued`; `waiting-network → cancelled`. Any illegal transition attempted by a service internal SHALL throw an `IllegalJobTransitionError` before any database write. Terminal statuses (`completed`, `failed`, `cancelled`) SHALL NOT transition further.

#### Scenario: Illegal transition is rejected

- **WHEN** a test calls the internal `JobRepository.transition(jobId, 'completed')` on a job currently in `queued` without an intervening `running` state
- **THEN** the call throws `IllegalJobTransitionError` and the row's `status` in the database is unchanged

#### Scenario: Cancel from queued terminates cleanly

- **WHEN** a job is in status `queued` and the client sends `sync:cancel-job` with that id
- **THEN** the job row transitions to `cancelled`, its `updatedAt` is refreshed, a `job-cancelled` event is emitted with the job id, and the response is `{ ok: true, result: { cancelled: true } }`

### Requirement: Global concurrency is capped at 2 via a semaphore

The `JobScheduler` SHALL own a single asynchronous semaphore initialized with 2 permits. Every job execution SHALL acquire a permit before the executor's first engine call and SHALL release the permit after the executor's final state write (whether that state is `completed`, `failed`, `cancelled`, or `waiting-network`). When more than 2 jobs are eligible for execution, the remaining jobs SHALL remain in `queued` status, their `status` not changing until a permit is available. The scheduler SHALL expose a construction-time option `allowParallel: boolean` defaulting to `true`; when `false`, the semaphore SHALL be initialized with 1 permit instead of 2.

#### Scenario: Third concurrent job waits for a permit

- **WHEN** three jobs are enqueued back-to-back and the first two executors each take 500 ms
- **THEN** at any instant during the first 500 ms, exactly two jobs are in `running` status in the database; the third is in `queued`; after one of the first two completes, the third transitions to `running`

#### Scenario: Sequential fallback enforces one at a time

- **WHEN** the scheduler is constructed with `allowParallel: false` and three jobs are enqueued
- **THEN** exactly one job is in `running` at any instant; the other two wait in `queued`

### Requirement: `UploadJobExecutor` performs a single-file upload via the engine

The service SHALL implement `UploadJobExecutor` conforming to `JobExecutor<'upload'>`. Given a job with `{ kind: 'upload', datasourceId, sourcePath, targetPath, conflictPolicy }`, the executor SHALL resolve the `DatasourceClient<T>` via the engine's `ClientFactory.create`, SHALL call `client.uploadFile({ kind: 'path', path: targetPath }, { path: sourcePath })`, SHALL translate the returned `FileEntry<T>` into a `job-result-upload` event payload, and SHALL NOT import any provider SDK directly. Progress events from the engine's bus SHALL be re-emitted on the service's own event stream as `job-progress` events.

#### Scenario: Upload succeeds and emits a result event

- **WHEN** a test enqueues an upload job against a `FakeDatasourceClient` that resolves `uploadFile` with a valid `FileEntry<"fake">`
- **THEN** the job transitions `queued → running → completed`, exactly one `job-started` event and exactly one `job-completed` event with the returned `FileEntry` are observed on the service's event stream

#### Scenario: Upload executor does not import provider SDKs

- **WHEN** a Vitest test grep-scans `services/fs-sync/src/` for `@aws-sdk/`, `googleapis`, or `@microsoft/microsoft-graph-client`
- **THEN** no match is found

### Requirement: `MirrorSyncJobExecutor` performs one-way mirror sync via snapshot diff

The service SHALL implement `MirrorSyncJobExecutor` conforming to `JobExecutor<'sync'>`. Given a job with `{ kind: 'sync', datasourceId, sourcePath, conflictPolicy }`, the executor SHALL: (a) enforce the source-health precondition (see separate requirement); (b) walk the local source tree, collecting `{ relPath, size, mtimeMs }` for each file, skipping symlinks that resolve outside the root and skipping entries matched by the configured ignore globs (defaults include `.DS_Store`, `Thumbs.db`, `.git/**`, `**/*.tmp`); (c) load the `sync_snapshot` rows for that `datasourceId`; (d) classify each file as `upload-new`, `upload-changed`, `skip`, or `delete-remote`; (e) invoke `client.uploadFile` or `client.deleteFile` accordingly; (f) update `sync_snapshot` on each success; (g) emit `sync-completed` with summary counts `{ uploaded, updated, deleted, skipped }` on terminal success.

#### Scenario: New file is uploaded and snapshotted

- **WHEN** a sync job runs against a source tree containing `a.txt` that is not present in `sync_snapshot`, and the fake client's `uploadFile` resolves
- **THEN** exactly one `uploadFile` call is made for `a.txt`, a new `sync_snapshot` row exists for `(datasourceId, 'a.txt')` with the post-upload `size`, `mtimeMs`, `sha256`, and `remoteHandle`, and the `sync-completed` event payload has `uploaded: 1, updated: 0, deleted: 0, skipped: 0`

#### Scenario: Unchanged file is skipped

- **WHEN** a sync job runs against a source containing `b.txt` whose `size` and `mtimeMs` match the existing `sync_snapshot` row exactly
- **THEN** no `uploadFile` call is made for `b.txt`, no `sha256` is computed, the snapshot row's `syncedAt` is updated, and the summary counts `skipped: 1`

#### Scenario: Changed mtime triggers hash then upload on hash mismatch

- **WHEN** a sync job runs against `c.txt` whose `(size, mtimeMs)` differs from the snapshot AND whose newly-computed `sha256` also differs
- **THEN** exactly one `sha256` is computed, exactly one `uploadFile` call is made, and the summary counts `updated: 1`

#### Scenario: Changed mtime with matching hash refreshes snapshot without upload

- **WHEN** a sync job runs against `d.txt` whose `(size, mtimeMs)` differs from the snapshot but whose newly-computed `sha256` equals the stored value
- **THEN** exactly one `sha256` is computed, no `uploadFile` call is made, the snapshot row's `mtimeMs` is updated to the new value, and the summary counts `skipped: 1`

#### Scenario: Locally-deleted file triggers remote delete

- **WHEN** a sync job runs against a source containing no file at path `e.txt`, and `sync_snapshot` has a row for `(datasourceId, 'e.txt')`
- **THEN** exactly one `deleteFile` call is made with the snapshot row's `remoteHandle` (or path fallback), the snapshot row is deleted after success, and the summary counts `deleted: 1`

### Requirement: Source-health precondition refuses to run against an unhealthy source

Before ANY remote mutation in a mirror-sync job, the `MirrorSyncJobExecutor` SHALL call `fs.stat(sourcePath)` and `fs.readdir(sourcePath)`. If either call throws (for any reason: `ENOENT`, `EACCES`, `EPERM`, `ENOTDIR`, or any other error), the executor SHALL transition the job to `failed` with `lastErrorTag === 'source-unavailable'`, emit a `source-unavailable` event carrying the original error message, and return immediately. ZERO remote API calls SHALL be issued in this branch. This requirement SHALL apply regardless of whether the `sync_snapshot` is populated — an unreachable source MUST NOT propagate deletions.

#### Scenario: Missing source root emits source-unavailable and makes no remote call

- **WHEN** a sync job is enqueued against `sourcePath = "/does/not/exist"` with a populated `sync_snapshot` containing 50 entries
- **THEN** the job transitions directly `queued → running → failed` without any `running → waiting-network` hop, exactly one `source-unavailable` event is emitted, the `DatasourceClient` spy records ZERO calls (no `uploadFile`, no `deleteFile`, no `listDirectory`), and no row in `sync_snapshot` is deleted

#### Scenario: Unreadable source (EACCES) is treated the same way

- **WHEN** a sync job runs against a source that exists but whose `readdir` throws `EACCES`
- **THEN** the job fails with `lastErrorTag === 'source-unavailable'` and zero remote calls are observed

### Requirement: Sync dedup rule rejects duplicate enqueues

On receiving a `sync:enqueue-mirror` request, the service SHALL execute within a single `BEGIN IMMEDIATE` SQLite transaction a query for any existing row in `jobs` with `kind = 'sync'`, the same `datasourceId`, the same `sourcePath`, AND `status IN ('queued', 'running', 'waiting-network')`. If a row exists, the service SHALL NOT INSERT a new job and SHALL return a response `{ ok: false, error: { tag: 'sync-already-running', existingJobId, datasourceId, sourcePath } }`. If no row exists, the service SHALL INSERT the new job within the same transaction and return `{ ok: true, result: { jobId } }`. This dedup rule SHALL NOT apply to `sync:enqueue-upload` — upload jobs MAY be enqueued concurrently without dedup.

#### Scenario: Second concurrent mirror enqueue is rejected

- **WHEN** a first `sync:enqueue-mirror` for `(datasourceId: "ds-1", sourcePath: "/home/u/pics")` has been accepted and the resulting job is in `queued` status, and a second identical request arrives
- **THEN** the second request's response has `ok: false, error.tag === 'sync-already-running', error.existingJobId === <first job id>`, and `SELECT COUNT(*) FROM jobs WHERE kind='sync' AND status NOT IN ('completed','failed','cancelled')` returns `1`

#### Scenario: Duplicate is allowed on a different sourcePath

- **WHEN** a first sync job for `(ds-1, /a)` is in `queued` and a second sync job for `(ds-1, /b)` is enqueued
- **THEN** both requests succeed, two distinct job ids are returned, and both rows coexist in `jobs`

#### Scenario: Upload jobs do not dedup

- **WHEN** two `sync:enqueue-upload` requests with identical `{ datasourceId, sourcePath, targetPath, conflictPolicy }` are sent back-to-back
- **THEN** both succeed, two distinct job ids are returned, and two rows exist in `jobs`

### Requirement: Per-job `conflictPolicy` is set at enqueue and the service never prompts

Every upload performed by the service — whether from a direct `sync:enqueue-upload` or from a mirror-sync's inner `upload-new` / `upload-changed` operation — SHALL respect a `conflictPolicy: 'overwrite' | 'duplicate' | 'skip'` value attached to its job. For direct uploads, the policy comes from the enqueue request; for mirror-sync inner operations, the policy comes from the parent sync job's `conflictPolicy` (which defaults to `'overwrite'` in a `sync:enqueue-mirror` request). The service SHALL NOT issue any IPC event asking the client for a mid-job conflict decision. When a conflict arises and policy is `'skip'`, the inner operation SHALL be a no-op, its per-file summary counted as `skipped`.

#### Scenario: Overwrite policy replaces the remote file

- **WHEN** an upload job with `conflictPolicy: 'overwrite'` targets an existing remote file
- **THEN** `uploadFile` is called with semantics that replace the remote contents (per the engine's contract), the job completes `completed`, and no "conflict-prompt" event is emitted anywhere

#### Scenario: Skip policy leaves remote intact

- **WHEN** an upload job with `conflictPolicy: 'skip'` targets an existing remote file and the engine reports the target already exists
- **THEN** no remote write occurs, the job completes `completed` with a `job-completed` payload noting `skipped: true`, and the local `sync_snapshot` (if this upload is part of a mirror sync) is updated to reflect the pre-existing remote entry

### Requirement: System-level retry for network / rate-limit / auth-expired

When a job execution throws a `DatasourceError` from the engine, the scheduler SHALL inspect `error.tag` and react as follows:

- `network-error`: transition the job to `waiting-network`, increment `attempt`, and arm the network probe (see separate requirement). On `network-available`, transition back to `queued`. This loop SHALL be unlimited (no `maxAttempts` from a user retry policy applies).
- `rate-limited`: wait for `error.retryAfterMs` (or, if absent, 5000 ms), then re-enter the queue for ONE retry attempt per rate-limit hit. A second consecutive `rate-limited` on the same attempt-count restarts the wait-and-retry.
- `auth-expired`: DO NOT intercept — the engine's `BaseDatasourceClient` already performs single-flight refresh. Propagate whatever the engine returns.

These behaviours SHALL NOT be modifiable by any user-supplied retry policy.

#### Scenario: Network error moves job to waiting-network

- **WHEN** a fake client's `uploadFile` throws `new DatasourceError({ tag: 'network-error', retryable: true })` on its first attempt
- **THEN** the job's `status` becomes `waiting-network`, its `attempt` is incremented by 1, no `job-failed` event is emitted, and no user retry-policy is consulted

#### Scenario: Rate-limited waits and retries once

- **WHEN** a fake client throws `DatasourceError { tag: 'rate-limited', retryAfterMs: 200 }` on its first call and succeeds on its second
- **THEN** the scheduler waits at least 200 ms before the retry, exactly two executor calls are made, the job completes `completed`, and no user retry policy is consulted

### Requirement: User-level retry policy for provider-error

When a job throws a `DatasourceError` whose `tag === 'provider-error'` AND whose `retryable === true`, the scheduler SHALL consult the user retry policy (per-datasource if set, otherwise global, otherwise defaults `{ maxAttempts: 3, backoffMs: 5000, backoffStrategy: 'exponential', maxAgeMs: 86_400_000 }`). If `attempt < maxAttempts` AND `Date.now() - createdAt < maxAgeMs`, the scheduler SHALL wait `backoff(attempt)` ms then retry; otherwise transition to `failed`. For `tag === 'provider-error'` AND `retryable === false`, and for the terminal tags `auth-revoked`, `not-found`, `conflict`, `unsupported`, the scheduler SHALL transition the job directly to `failed` without retry.

#### Scenario: Provider-error with retryable retries up to the limit

- **WHEN** a policy is set to `{ maxAttempts: 3, backoffMs: 100, backoffStrategy: 'fixed' }` and a fake client throws `DatasourceError { tag: 'provider-error', retryable: true }` on every call
- **THEN** exactly 3 executor calls occur, the backoff gaps approximate 100 ms each (tolerance ±50 ms), the job ends in `failed` with `lastErrorTag === 'provider-error'`, and a single `job-failed` event is emitted

#### Scenario: Auth-revoked fails immediately without retry

- **WHEN** a fake client throws `DatasourceError { tag: 'auth-revoked' }` once
- **THEN** exactly one executor call occurs, the job transitions directly to `failed`, and `job-failed` is emitted once

#### Scenario: `maxAgeMs` cuts off retries past the window

- **WHEN** a policy has `maxAgeMs: 1000`, a job has been retrying for 1500 ms, and the next `provider-error` would otherwise retry
- **THEN** the scheduler transitions the job to `failed` with `lastErrorMessage` referencing the expired age window, and no further executor call occurs

### Requirement: Network probe is a 30-second DNS probe, active only while jobs are waiting

The service SHALL run a single `NetworkProbe` component. The probe SHALL arm a 30-second interval timer IFF the count of jobs in `waiting-network` status is greater than zero, and SHALL clear the timer when the count returns to zero. Each tick SHALL attempt `dns.resolve` against a configurable well-known host (default: Cloudflare's `1.1.1.1` or `cloudflare.com` — documented choice deferred to implementation). On success, the probe SHALL transition EVERY `waiting-network` job to `queued` via a single SQL UPDATE and emit a `network-available` event. On failure, the probe SHALL log at `debug` level and take no further action until the next tick. The probe SHALL NOT require any native modules and SHALL NOT use OS network-change hooks.

#### Scenario: Probe idles when no jobs are waiting

- **WHEN** the service has zero jobs in `waiting-network` for 2 minutes
- **THEN** the probe's DNS resolver is invoked zero times in that window (verifiable via spy)

#### Scenario: Probe activates when a job enters waiting-network and deactivates when it leaves

- **WHEN** a job transitions `running → waiting-network`, then 90 seconds later the probe succeeds and the job transitions `waiting-network → queued`
- **THEN** exactly 3 DNS probes were attempted (at ~0, 30, 60 seconds from arm), exactly 1 `network-available` event was emitted, and after the transition no further probe attempts occur for the next 60 seconds

### Requirement: Full re-upload on network retry

When a job transitions `waiting-network → queued` and is subsequently executed, the `UploadJobExecutor` (and the `MirrorSyncJobExecutor`'s inner upload operations) SHALL call `client.uploadFile` starting from byte 0 of the source file. The service SHALL NOT attempt to resume a partial upload via provider session APIs. The `attempt` counter on the `jobs` row SHALL be incremented exactly once per transition from `waiting-network` back to a terminal status (success or failure).

#### Scenario: Retry after network restoration restarts the upload

- **WHEN** a fake client's first `uploadFile` fails with `network-error` at 50% progress, the job moves to `waiting-network`, the probe succeeds, and the retry invocation is observed
- **THEN** the retry invocation receives `{ path: sourcePath }` with no `startOffset` or `uploadId` parameter (since none exists in the signature), the fake client observes a full byte-range read from 0 to EOF, and the job eventually completes with total `attempt === 2`

### Requirement: Service consumes the engine only through `ClientFactory`

Every `DatasourceClient<T>` used by any executor SHALL be obtained by calling `ClientFactory.create(providerId, credentials, { bus, credentialStore })` from `@ft5/fs-datasource-engine`. No executor SHALL instantiate a concrete client class (`S3Client`, `OneDriveClient`, `GoogleDriveClient`) directly. No file under `services/fs-sync/src/` SHALL import from `@aws-sdk/client-s3`, `@microsoft/microsoft-graph-client`, or `googleapis`.

#### Scenario: Factory is the single entry point

- **WHEN** a test spies on `ClientFactory.create` and enqueues upload jobs against three different datasourceIds
- **THEN** `ClientFactory.create` is invoked for each unique datasourceId (cached across subsequent jobs for the same id is allowed), and no concrete client class's constructor is called directly in any test

#### Scenario: No provider SDKs in the service

- **WHEN** a Vitest test grep-scans every `.ts` file under `services/fs-sync/src/` for provider SDK specifiers
- **THEN** no match is found

### Requirement: `MonitorEventSource` input port with no-op default implementation

The service SHALL declare a `MonitorEventSource` interface in `services/fs-sync/src/ports/monitor.ts` with the methods `onChange(listener): () => void`, `onSnapshot(listener): () => void`, `start(): Promise<void>`, and `stop(): Promise<void>`. The service SHALL ship a `NoopMonitorEventSource` implementation whose `start` and `stop` resolve successfully and whose `onChange` / `onSnapshot` register listeners that are never invoked. The service's dependency container SHALL bind `MonitorEventSource` to `NoopMonitorEventSource` by default in v1. Commands `sync:enable-auto` and `sync:disable-auto` SHALL NOT be exposed in the IPC command surface in v1.

#### Scenario: Default monitor never fires events

- **WHEN** the service starts with the default `NoopMonitorEventSource`, a listener is registered via `onChange`, and an arbitrary local file is modified
- **THEN** the listener is never invoked (verifiable over a 5-second window), no sync job is auto-enqueued, and the service's `sync:get-status` reports `monitorConnected: false`

#### Scenario: Auto-sync commands are rejected in v1

- **WHEN** a client sends a request with `command: "sync:enable-auto"`
- **THEN** the response is `{ ok: false, error.tag: 'unknown-command' }`

### Requirement: Service crash recovery re-queues running jobs on startup

On service startup, AFTER migrations and integrity check but BEFORE the IPC listener is opened to new clients, the service SHALL scan `jobs` for rows with `status = 'running'`. For each such row, the service SHALL transition it back to `queued`, increment `attempt`, clear any `running`-only payload fields (e.g., transactionId), set `lastErrorTag = 'service-restart'`, and emit a `job-recovered` event on the next tick after the IPC listener opens. Rows in `waiting-network` SHALL be left untouched; they are picked up by the network probe if the count drives it to arm. Terminal-status rows SHALL NOT be modified.

#### Scenario: Running jobs are recovered to queued

- **WHEN** a test seeds `jobs` with two rows in `status = 'running'` and one row in `status = 'completed'` before starting the service
- **THEN** after startup, the two formerly-running rows have `status = 'queued'`, `attempt` incremented by 1 each, `lastErrorTag = 'service-restart'`; the `completed` row is unchanged; two `job-recovered` events are emitted once the IPC listener is accepting connections

### Requirement: Installer registers and deregisters the per-user service

The `apps/desktop` electron-builder configuration SHALL invoke platform-specific post-install and post-uninstall hooks that register or deregister the sync service as a per-user OS service:

- **Windows:** post-install runs `schtasks /Create /SC ONLOGON /TN "ft5-sync" /TR <servicePath> /RL LIMITED /F`; post-uninstall runs `schtasks /Delete /TN "ft5-sync" /F`. Both commands SHALL execute under the current user context and SHALL NOT require Administrator elevation.
- **macOS:** post-install writes `~/Library/LaunchAgents/tech.forti5.ft5-sync.plist` with `RunAtLoad=true` and `KeepAlive=true`, then runs `launchctl load ~/Library/LaunchAgents/tech.forti5.ft5-sync.plist`; post-uninstall runs `launchctl unload ...` and deletes the plist.
- **Linux:** post-install writes `~/.config/systemd/user/ft5-sync.service`, runs `systemctl --user enable --now ft5-sync.service`, and runs `loginctl enable-linger <user>`; post-uninstall runs `systemctl --user disable --now ft5-sync.service` and deletes the unit.

No third-party service-manager library SHALL be introduced; only OS-native CLIs SHALL be used.

#### Scenario: Windows install creates the scheduled task

- **WHEN** the installer post-install hook runs on Windows in a test container with the user in scope
- **THEN** `schtasks /Query /TN "ft5-sync"` returns exit code 0 and the task's "Run as user" field matches the current user; no UAC prompt occurred

#### Scenario: macOS install loads the launchd agent

- **WHEN** the installer post-install hook runs on macOS in a test VM
- **THEN** `launchctl list | grep tech.forti5.ft5-sync` finds a matching line, and the corresponding plist file exists at `~/Library/LaunchAgents/tech.forti5.ft5-sync.plist`

#### Scenario: Uninstall removes all traces

- **WHEN** the uninstall hook runs after a successful install on any supported OS
- **THEN** the per-OS query (`schtasks /Query`, `launchctl list`, `systemctl --user status`) reports no such entry, and the registration file (plist / unit) does not exist on disk

### Requirement: Dev mode uses distinct pipe, data dir, and PID file

When launched with `--dev`, the service SHALL (a) listen on the dev pipe path (see transport requirement), (b) use `FT5_SYNC_DATA_DIR=$HOME/ft5/sync_app/dev/` by default (overridable), (c) write its PID to `service-dev.pid`, (d) log at `debug` level to stderr in addition to `service.log`. A dev-mode service SHALL coexist with a prod-mode service on the same machine without interference: starting a dev service with a prod service already running SHALL succeed, and vice versa.

#### Scenario: Dev and prod services coexist

- **WHEN** a prod service is running (listening on the prod pipe, PID in `service.pid`), and a dev service is launched with `--dev`
- **THEN** the dev service starts successfully, listens on the dev pipe, writes `service-dev.pid`, and the prod service continues serving its existing connections without interruption

#### Scenario: Dev pipe is not reachable from prod clients

- **WHEN** a test client configured with the prod pipe path attempts to connect while only the dev service is running
- **THEN** the connect attempt returns `ENOENT` (Unix) or `ECONNREFUSED` (Windows), and no request is delivered to the dev service

### Requirement: Event subscription semantics

Clients SHALL subscribe to events by sending `sync:subscribe-events { filter? }` and unsubscribe by sending `sync:unsubscribe-events`. While subscribed, every service-side event emitted by the scheduler, executors, probe, or credential store SHALL be written as an `Event` frame on that client's connection. If a client disconnects without unsubscribing, the server SHALL clean up the subscription on connection close. Events SHALL NOT be buffered across disconnections — a newly-(re)connected client receives only events emitted after its subscription confirmation.

#### Scenario: Subscribed client receives job lifecycle events

- **WHEN** a client subscribes, then enqueues an upload that completes successfully
- **THEN** the client observes on its socket, in order, `Event { name: 'job-enqueued' }`, `Event { name: 'job-started' }`, `Event { name: 'job-completed' }` for that job id, and no other job's events leak onto its stream

#### Scenario: Unsubscribed client receives nothing

- **WHEN** a client connects, sends NO `sync:subscribe-events`, and an upload job completes
- **THEN** the client observes zero `Event` frames on its connection

#### Scenario: Disconnect cleans up subscription

- **WHEN** a subscribed client closes its socket, then a new job is enqueued
- **THEN** the server's internal subscription registry no longer lists the closed connection, no write is attempted to the dead socket, and no unhandled error is emitted by the server's `net` layer

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

### Requirement: `resolveClient` throws typed `invalid-datasource` for missing credentials

The service's `resolveClient` adapter (constructed in `services/fs-sync/src/main/bootstrap.ts`) SHALL be the single choke point that detects credential-presence misconfiguration. When `credentialStore.get(datasourceId)` resolves to `null`, `resolveClient` SHALL throw `new DatasourceError({ tag: "invalid-datasource", datasourceId, retryable: false, message: "Credentials are missing — reconnect this datasource" })`. The previous untyped `throw new Error("no credentials registered for datasourceId=…")` SHALL be replaced. Per-command `files:*` handlers SHALL NOT perform their own credential-presence checks — the per-command flow remains `try { client = await deps.resolveClient(...) } catch (err) { return { ok: false, error: normalizeFilesError(err) } }`, so the new typed error flows through the existing mapping automatically.

Executors that consume `resolveClient` (the upload executor, the mirror-sync executor) SHALL also see the typed error; their existing failure handling SHALL be exercised against the new tag in tests.

#### Scenario: Missing credential surfaces as DatasourceError, not generic Error

- **WHEN** a unit test stubs `credentialStore.get("ds-missing")` to return `null` and invokes `resolveClient("ds-missing")`
- **THEN** the call rejects with a `DatasourceError` instance (verifiable via `err instanceof DatasourceError && err.tag === "invalid-datasource"`); the message reads "Credentials are missing — reconnect this datasource"; `retryable` is `false`

#### Scenario: Per-command handlers stay thin and propagate the new tag

- **WHEN** a unit test wires the `files:list` handler with a `resolveClient` that throws the new typed error and dispatches a `files:list` request
- **THEN** the handler's existing `try/catch` invokes `normalizeFilesError`; the response is `{ ok: false, error: { tag: "invalid-datasource", message, retryable: false } }`; the handler source contains NO additional credential-presence check beyond the existing `await deps.resolveClient(...)` call

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

### Requirement: `files:rename` and `files:download` RPC commands delegate to the engine

The service SHALL accept two new commands on its IPC channel:
`files:rename` and `files:download`. Both SHALL resolve the engine client
for the request's `datasourceId` via the existing `ClientFactory`
machinery (the same path used by `files:list`, `files:stat`,
`files:search`, `files:remove`).

`files:rename` accepts:

```typescript
{
  datasourceId: string;
  path: string;
  handle?: string;
  newName: string;
  conflictPolicy: "fail" | "overwrite" | "keep-both";
}
```

The handler forwards the call to `client.rename(target, newName,
conflictPolicy)`. The engine's strategy determines whether the target
is a file or directory within its own provider context (Drive/OneDrive
metadata, S3 `HeadObject` + `ListObjectsV2` introspection); the wire
contract carries no `kind` field. Response: `{ ok: true, value: {
entry: DatasourceFileEntry } } | { ok: false, error }`. Error tags
include the new `"conflict"` variant carrying `existingPath` per the
engine's new `DatasourceErrorTag.Conflict`.

`files:download` accepts:

```typescript
{
  datasourceId: string;
  path: string;
  handle?: string;
  toPath: string;  // required, absolute, validated at boundary
}
```

The handler MUST first validate `toPath` (see "toPath validation" requirement below). On success, the handler:

1. Mints a service-level `downloadJobId` (UUID) and creates an `AbortController` for the job. Inserts a registry entry.
2. Enters a retry loop. Initial iteration: `rangeStart = 0`. Each iteration calls `engine.downloadFile(target, { rangeStart, signal: abortController.signal, onProgress: <fires service-level downloading event> })`.
3. Validates the response: if `rangeStart > 0` and `contentRange === undefined` (provider ignored the Range header), throws a terminal `range-not-supported` error.
4. Validates: if `rangeStart > 0` and `contentRange.start !== rangeStart`, throws a terminal `range-mismatch` error.
5. Pipes the returned stream to `fs.createWriteStream(toPath, { flags: rangeStart === 0 ? "w" : "r+", start: rangeStart })`.
6. After the pipeline resolves, reads `fs.stat(toPath).size` to determine `bytesWritten`. If `bytesWritten === contentLength`, breaks out of the loop (success).
7. If the pipeline rejects with an auth-expired error mid-stream AND the loop attempt count is below `MAX_AUTH_RETRIES` (default 1), updates `rangeStart = bytesWritten` from the file size on disk and continues the loop. The next `engine.downloadFile` call goes through `withRefresh` afresh.
8. If the pipeline rejects with `abortController.signal.aborted`, emits `download-cancelled` and returns the cancel response.
9. If the pipeline rejects with any other error, emits `download-failed` and returns the error response.
10. After successful loop exit, performs an integrity check (compare hash of `toPath` against the provider's hash if available) and emits `file-downloaded { downloadJobId, savedPath: toPath, bytes }`. Replies `{ ok: true, value: { savedPath: toPath, bytes } }`. Removes the registry entry.

The `downloadJobId` SHALL be the canonical job key for cancel and progress correlation; clients reference it in `downloads:list-active`, in cancel commands, and in event subscriptions.

#### Scenario: Successful download streams from engine to disk

- **WHEN** a client sends `files:download { datasourceId: "ds-1", path: "/welcome.pdf", toPath: "/Users/alice/Downloads/ft5/welcome.pdf" }`
- **THEN** `toPath` validation passes; the handler mints `downloadJobId`, creates the registry entry, calls `engine.downloadFile(target, { rangeStart: 0, signal, onProgress })`; `engine.downloadFile` resolves with `{ stream, contentLength: N }`; the handler pipes the stream to `fs.createWriteStream(toPath, { flags: "w", start: 0 })`; on stream end the handler reads `fs.stat(toPath).size === N`; integrity check passes; the handler emits `file-downloaded { downloadJobId, savedPath, bytes: N }` and replies `{ ok: true, value: { savedPath, bytes: N } }`; the registry entry is removed

#### Scenario: Mid-stream auth-expired triggers handler-driven retry

- **WHEN** a `files:download` is in flight; after N bytes are written, the pipeline rejects with `tag: "auth-expired"`
- **THEN** the handler reads `fs.stat(toPath).size === N`; sets `rangeStart = N`; calls `engine.downloadFile(target, { rangeStart: N, signal, onProgress })` again; the engine's `withRefresh` wrapper detects the auth-expired credential and refreshes once before issuing the new GET; the GET returns 206 Partial Content with `Content-Range: bytes N-M/T`; the handler validates `contentRange.start === N`; pipes from byte N (using `flags: "r+", start: N`); on stream end `fs.stat(toPath).size === contentLength`; the loop exits with success

#### Scenario: Range-not-honored aborts with terminal error

- **WHEN** during a retry iteration, `engine.downloadFile(target, { rangeStart: N, … })` resolves with `contentRange === undefined` (provider ignored the Range header and returned 200 OK)
- **THEN** the handler does NOT pipe the stream; throws a terminal `range-not-supported` error; emits `download-failed { downloadJobId, tag: "other", message: "range not supported on this resource" }`; the partial file at `toPath` is left on disk; the registry entry is removed

#### Scenario: Cancel mid-stream

- **WHEN** the client invokes a cancel command (or the download orchestration emits a cancel) while the pipeline is in flight; the handler invokes `abortController.abort()`
- **THEN** the engine's downloaded stream rejects via the AbortSignal; the pipeline rejects with AbortError; the handler emits `download-cancelled { downloadJobId, bytesDownloaded, bytesTotal, reason: "user" }` exactly once; the partial file at `toPath` is NOT auto-deleted; the registry entry is removed; the response is `{ ok: false, error: { tag: "cancelled", message: "download cancelled" } }`

#### Scenario: Multi-cycle stable-network long download

- **WHEN** a `files:download` for a 5TB file is in flight against a provider with a 1-hour token lifetime; over 15 hours of streaming, the access token expires 15 distinct times
- **THEN** each token expiry surfaces as a mid-stream auth-expired error to the handler; on each error the handler retries with `rangeStart = <current bytes on disk>`; each retry call to `engine.downloadFile` goes through `withRefresh` which refreshes the credential once and issues a 206 Partial Content GET; the consumer's pipe-to-disk continues from the new `rangeStart`; the `MAX_AUTH_RETRIES` budget is per-cycle (one retry per auth-expired event), reset between cycles; total bytes written equals contentLength; the integrity check passes; the loop exits with success after the final cycle

#### Scenario: Rename file via the new RPC

- **WHEN** a client sends `files:rename { datasourceId: "ds-1", path: "/foo.pdf", newName: "bar.pdf", conflictPolicy: "fail" }`
- **THEN** the handler resolves the engine client for `ds-1`, calls `client.rename(target, "bar.pdf", "fail")`, the strategy determines via its provider context that the target is a file, performs the rename, and on success the handler replies `{ ok: true, value: { entry: { path: "/bar.pdf", name: "bar.pdf", … } } }`; the engine emits `entry-renamed` exactly once

#### Scenario: Rename directory on Drive

- **WHEN** a client sends `files:rename { datasourceId: "ds-drive", path: "/projects", newName: "archive", conflictPolicy: "fail" }` against a Drive folder
- **THEN** the handler calls `client.rename(target, "archive", "fail")`; the Drive strategy issues `files.update({fileId, requestBody: {name: "archive"}})` (uniform API for files and folders); on success the handler replies with the renamed entry

#### Scenario: Rename directory on S3 surfaces unsupported

- **WHEN** a client sends `files:rename { datasourceId: "ds-s3", path: "/backups", newName: "archive", conflictPolicy: "fail" }` against an S3 virtual folder
- **THEN** the handler calls `client.rename(target, "archive", "fail")`, the S3 strategy's introspection (`HeadObject` 404 + `ListObjectsV2` returns at least one key) determines the target is a folder, the strategy rejects with `DatasourceError { tag: "unsupported", message: "S3 folder rename is not supported in this version" }`, and the response is `{ ok: false, error: { tag: "other", message: "S3 folder rename is not supported in this version", retryable: false } }`

### Requirement: `toPath` validation at the service boundary

The `files:download` handler SHALL validate the renderer-supplied `toPath`
before opening any write stream. Validations:

1. `path.isAbsolute(toPath)` is true.
2. `path.normalize(toPath) === toPath` (no `..` segments after
   normalization).
3. The parent directory exists and is writable
   (`fs.access(parent, fs.constants.W_OK)` succeeds).
4. The path does not write inside the service's own data directory
   (`~/ft5/sync_app/`). Service-private paths are off-limits to
   download writes.

Validation failure SHALL produce `{ ok: false, error: { tag: "other",
message: "toPath validation: <which check failed>", retryable: false } }`
without opening any provider request.

#### Scenario: Relative toPath is rejected

- **WHEN** a client sends `files:download` with `toPath: "Downloads/welcome.pdf"`
- **THEN** the handler rejects with `tag: "other", message: "toPath validation: not absolute"`; no engine call is made

#### Scenario: Path traversal in toPath is rejected

- **WHEN** a client sends `files:download` with `toPath: "/Users/alice/Downloads/../../../etc/passwd"`
- **THEN** the handler normalizes the path, sees the result differs from the input (or sees `..` post-normalize is impossible because `path.normalize` would resolve), and rejects with `tag: "other", message: "toPath validation: contains traversal"`

#### Scenario: Write into service data dir is rejected

- **WHEN** a client sends `files:download` with `toPath: "$HOME/ft5/sync_app/credentials.json"`
- **THEN** the handler rejects with `tag: "other", message: "toPath validation: cannot write inside service data directory"`

### Requirement: In-memory `DownloadRegistry` tracks active downloads

The service SHALL maintain an in-memory `DownloadRegistry` at `services/fs-sync/src/downloads/registry.ts` with the shape `Map<downloadJobId, DownloadJob>` where:

```typescript
interface DownloadJob {
  downloadJobId: string;             // service-minted UUID
  datasourceId: string;
  sourcePath: string;
  targetPath: string;
  bytesDownloaded: number;
  contentLength: number | null;
  startedAt: number;                  // ms epoch
  abortController: AbortController;   // for cancel
}
```

The `files:download` handler SHALL `set` the entry on download start (when minting `downloadJobId`), update `bytesDownloaded` from the engine's `onProgress` callback (throttled per the same coalescing approach as upload), and `delete` the entry on terminal success / failure / cancellation.

The registry SHALL NOT persist to disk. Service crashes lose the registry; in-flight downloads orphan their partial files. Disk persistence (and the resulting service-crash recovery) is tracked in follow-up `migrate-download-registry-to-sqlite`.

#### Scenario: Registry tracks active download

- **WHEN** a `files:download` for `ds-1 / welcome.pdf → /downloads/welcome.pdf` is in flight at byte offset N
- **THEN** the registry contains exactly one entry keyed by the handler's `downloadJobId` with `bytesDownloaded: N`, `contentLength: <total>`, `targetPath: "/downloads/welcome.pdf"`, `sourcePath: "/welcome.pdf"`, `datasourceId: "ds-1"`, and an active `abortController`

#### Scenario: Registry releases on terminal success

- **WHEN** a `files:download` completes successfully (the handler emits `file-downloaded { downloadJobId }`)
- **THEN** the registry no longer contains the `downloadJobId` entry on the next read

#### Scenario: Registry releases on terminal cancel

- **WHEN** a `files:download` is cancelled mid-stream (the handler emits `download-cancelled { downloadJobId }`)
- **THEN** the registry no longer contains the `downloadJobId` entry on the next read

### Requirement: `downloads:list-active` RPC returns the registry snapshot

The service SHALL accept a new command `downloads:list-active` on its
IPC channel. Request shape: empty (`{}`). Response shape:

```typescript
{ ok: true, value: { jobs: DownloadJob[] } }
```

`jobs` is a stable snapshot of the current registry state at the
moment the command is handled. The handler SHALL NOT block on
in-flight events — it returns the current values atomically. Order
is by `startedAt` ascending (oldest first).

This command exists primarily for the desktop main process to query
on supervisor-connect (specifically, on the first connect of an app
session) and forward to the renderer for toast hydration. It is NOT
expected to be polled.

#### Scenario: Empty registry

- **WHEN** a client sends `downloads:list-active` with no downloads in flight
- **THEN** the response is `{ ok: true, value: { jobs: [] } }`

#### Scenario: Two in-flight downloads

- **WHEN** a client sends `downloads:list-active` with two downloads in flight
- **THEN** the response is `{ ok: true, value: { jobs: [<job-A>, <job-B>] } }` ordered by `startedAt` ascending; each job carries its full `DownloadJob` shape including the current `bytesDownloaded` at the moment of the snapshot

### Requirement: Service handler emits `downloading` / terminal events on the IPC stream

The `files:download` handler SHALL emit consumer-domain events on the service's IPC event channel. These events are DERIVED, not relayed: fs-sync subscribes to the engine bus's four download lifecycle events (`downloading`, `file-downloaded`, `download-failed`, `download-cancelled` per the engine spec) and applies a business-logic transformation — minting a `downloadJobId`, throttling progress, running the integrity check post-pipe, applying retry policy, updating the DownloadRegistry — before emitting fs-sync's own desktop-facing events. The fs-sync wire shapes differ from the engine bus shapes: engine bus payloads are keyed by `(datasourceId, path)` and carry raw vendor facts; fs-sync payloads are keyed by `downloadJobId` and carry business-decoration metadata. fs-sync events are NOT a re-broadcast of engine events.

The fs-sync wire shapes:

- `downloading { downloadJobId, datasourceId, progress, path }` — streaming-tagged, throttled per the same coalescing approach as `uploading`.
- `file-downloaded { downloadJobId, savedPath, bytes }` — terminal success.
- `download-failed { downloadJobId, tag, message }` — terminal failure.
- `download-cancelled { downloadJobId, bytesDownloaded, bytesTotal, reason }` — terminal cancel.

The handler invokes the engine's `onProgress` callback hook to drive the synchronous progress accounting (registry updates and the throttled `downloading` IPC emission). Terminal events emit exactly once per download. The handler treats engine bus subscription as the canonical source for cross-cutting download lifecycle observation; the synchronous callback is the low-overhead direct-caller path that mirrors the same byte-flow.

A client subscribed via `sync:subscribe-events` for a specific `datasourceId` SHALL receive only events for that datasource; subscriptions without a filter SHALL receive all events.

#### Scenario: Downloading progress streams to subscriber

- **WHEN** a client subscribes via `sync:subscribe-events { datasourceId: "ds-1" }` and a `files:download` is in flight for `ds-1`
- **THEN** the client receives `downloading { downloadJobId, progress: <0..100>, path }` events at the throttled rate; on terminal completion the client receives exactly one `file-downloaded { downloadJobId, savedPath, bytes }`

### Requirement: Service subscribes to engine bus events for download lifecycle

The fs-sync service SHALL subscribe to the engine bus's four download lifecycle events (`downloading`, `file-downloaded`, `download-failed`, `download-cancelled`) and treat that subscription as the canonical source for DownloadRegistry state transitions. The mapping from engine bus event to registry mutation is:

- `downloading { datasourceId, path, loaded, total }` → look up the `downloadJobId` for `(datasourceId, path)` in the registry; update the entry's `bytesDownloaded = loaded` and `contentLength = total` (subject to throttling).
- `file-downloaded { datasourceId, path, bytes }` → look up the `downloadJobId` for `(datasourceId, path)`; remove the registry entry; emit fs-sync's `file-downloaded { downloadJobId, savedPath, bytes }` after the integrity check (`savedPath` populated from the handler's pipe target — fs-sync owns it; the engine never writes to disk).
- `download-failed` (engine bus payload IS `SerializedDatasourceError<T>` directly per the `authentication-failed` precedent — `tag`, `retryable`, `retryAfterMs`, `raw`, `message` live at the payload root; `datasourceId` lives on the envelope; `path` is NOT on this payload) → fs-sync's correlation back to the in-flight `downloadJobId` flows through the `files:download` handler's synchronous rejection path (the `engine.downloadFile(target)` Promise / its returned stream's `error` event), where the call site already holds the `(datasourceId, path)` context; the bus subscription on `download-failed` is used for cross-cutting observation. The handler emits fs-sync's `download-failed { downloadJobId, tag, message }` (or, when retry policy applies, retains the entry and dispatches a fresh `engine.downloadFile` call instead of emitting terminal).
- `download-cancelled { datasourceId, path, bytesDownloaded, bytesTotal }` → look up the `downloadJobId` for `(datasourceId, path)`; remove the registry entry; emit fs-sync's `download-cancelled { downloadJobId, bytesDownloaded, bytesTotal, reason }`.

The correlation key from engine bus events to fs-sync's job state SHALL be `(datasourceId, path) → downloadJobId`. fs-sync's in-memory registry SHALL maintain a reverse index from `(datasourceId, path)` to `downloadJobId` to make this lookup O(1). v1 enforces at most one in-flight download per `(datasourceId, path)`; a second `files:download` request whose `(datasourceId, path)` already exists in the registry SHALL be rejected with `{ ok: false, error: { tag: "other", message: "download already in progress for this entry", retryable: false } }` before any engine call is issued.

The handler's synchronous `options.onProgress` callback SHALL fire from the same byte-flow source as the engine bus emission; the handler MAY use the synchronous callback for low-overhead in-process accounting (registry update, throttled IPC emission) and use the bus subscription for cross-cutting observation (audit log, telemetry). Both paths converge on the same registry state.

#### Scenario: Engine `downloading` updates registry

- **WHEN** the engine bus emits `downloading { datasourceId: "ds-1", path: "/welcome.pdf", loaded: 524288, total: 1048576 }` and the registry contains a job entry for `(ds-1, /welcome.pdf)` with `downloadJobId: "job-A"`
- **THEN** the registry entry's `bytesDownloaded` updates to `524288` (subject to throttling) and `contentLength` updates to `1048576`

#### Scenario: Engine `file-downloaded` removes registry entry

- **WHEN** the engine bus emits `file-downloaded { datasourceId: "ds-1", path: "/welcome.pdf", bytes }` and the registry contains a job entry for `(ds-1, /welcome.pdf)` with `downloadJobId: "job-A"`
- **THEN** after the handler's integrity check resolves, the registry no longer contains `job-A`; fs-sync emits `file-downloaded { downloadJobId: "job-A", savedPath, bytes }` on the IPC event channel exactly once

#### Scenario: Engine `download-cancelled` removes registry entry

- **WHEN** the engine bus emits `download-cancelled { datasourceId: "ds-1", path: "/welcome.pdf", bytesDownloaded, bytesTotal }` and the registry contains a job entry for `(ds-1, /welcome.pdf)` with `downloadJobId: "job-A"`
- **THEN** the registry no longer contains `job-A`; fs-sync emits `download-cancelled { downloadJobId: "job-A", bytesDownloaded, bytesTotal, reason }` on the IPC event channel exactly once

#### Scenario: Concurrent download for the same `(datasourceId, path)` is rejected

- **WHEN** a `files:download { datasourceId: "ds-1", path: "/welcome.pdf", toPath: <…> }` is dispatched while the registry already contains an entry for `(ds-1, /welcome.pdf)`
- **THEN** the handler rejects the second request with `{ ok: false, error: { tag: "other", message: "download already in progress for this entry", retryable: false } }`; no `engine.downloadFile` call is issued for the second request; the first download's registry entry and event stream are unaffected

