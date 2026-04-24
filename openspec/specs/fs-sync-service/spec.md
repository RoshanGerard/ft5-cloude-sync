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

The service SHALL accept and correctly respond to the following commands on its IPC channel: `sync:enqueue-upload`, `sync:enqueue-mirror`, `sync:list-jobs`, `sync:get-job`, `sync:cancel-job`, `sync:subscribe-events`, `sync:unsubscribe-events`, `sync:set-retry-policy`, `sync:get-retry-policy`, `sync:authenticate`, `sync:get-status`. Request and response types for every command SHALL be declared in `@ft5/ipc-contracts/sync-service` as discriminated unions, keyed by the `command` field. Any command frame whose `command` is not in this enumerated set SHALL receive a response with `ok: false, error.tag === 'unknown-command'`.

#### Scenario: Unknown command is rejected

- **WHEN** a client sends a request with `command: "sync:fly-to-mars"`
- **THEN** it receives a response with `ok: false` and `error.tag === 'unknown-command'`

#### Scenario: `sync:get-status` succeeds with no prior activity

- **WHEN** a client connects to a freshly started service and sends `sync:get-status` with empty params
- **THEN** the response carries `{ ok: true, result: { version, serviceUuid, runningJobs: 0, queuedJobs: 0, waitingNetworkJobs: 0, monitorConnected: false } }`

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
