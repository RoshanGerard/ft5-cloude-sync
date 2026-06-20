## MODIFIED Requirements

### Requirement: `MirrorSyncJobExecutor` performs one-way mirror sync via snapshot diff

The service SHALL implement `MirrorSyncJobExecutor` conforming to `JobExecutor<'sync'>`. Given a job with `{ kind: 'sync', datasourceId, sourcePath, conflictPolicy }`, the executor SHALL: (a) enforce the source-health precondition (see separate requirement); (b) walk the local source tree, collecting `{ relPath, size, mtimeMs }` for each file, skipping symlinks that resolve outside the root and skipping entries matched by the configured ignore globs (defaults include `.DS_Store`, `Thumbs.db`, `.git/**`, `**/*.tmp`); (c) load the `sync_snapshot` rows for that `datasourceId`; (d) classify each file as `upload-new`, `upload-changed`, `skip`, or `delete-remote`; (e) invoke `client.uploadFile` or `client.delete(target, "file")` accordingly; (f) update `sync_snapshot` on each success; (g) emit `sync-completed` with summary counts `{ uploaded, updated, deleted, skipped }` on terminal success.

#### Scenario: Locally-deleted file triggers remote delete

- **WHEN** a sync job runs against a source containing no file at path `e.txt`, and `sync_snapshot` has a row for `(datasourceId, 'e.txt')`
- **THEN** exactly one `delete` (file) call is made with the snapshot row's `remoteHandle` (or path fallback), the snapshot row is deleted after success, and the summary counts `deleted: 1`

### Requirement: Source-health precondition refuses to run against an unhealthy source

Before ANY remote mutation in a mirror-sync job, the `MirrorSyncJobExecutor` SHALL call `fs.stat(sourcePath)` and `fs.readdir(sourcePath)`. If either call throws (for any reason: `ENOENT`, `EACCES`, `EPERM`, `ENOTDIR`, or any other error), the executor SHALL transition the job to `failed` with `lastErrorTag === 'source-unavailable'`, emit a `source-unavailable` event carrying the original error message, and return immediately. ZERO remote API calls SHALL be issued in this branch. This requirement SHALL apply regardless of whether the `sync_snapshot` is populated — an unreachable source MUST NOT propagate deletions.

#### Scenario: Missing source root emits source-unavailable and makes no remote call

- **WHEN** a sync job is enqueued against `sourcePath = "/does/not/exist"` with a populated `sync_snapshot` containing 50 entries
- **THEN** the job transitions directly `queued → running → failed` without any `running → waiting-network` hop, exactly one `source-unavailable` event is emitted, the `DatasourceClient` spy records ZERO calls (no `uploadFile`, no `delete`, no `listDirectory`), and no row in `sync_snapshot` is deleted

### Requirement: System-level retry for network / rate-limit / auth-expired

When a job execution throws a `DatasourceError` from the engine, the scheduler SHALL inspect `error.tag` and react as follows:

- `network-error`: transition the job to `waiting-network`, increment `attempt`, and arm the network probe (see separate requirement). On `network-available`, transition back to `queued`. This loop SHALL be unlimited (no `maxAttempts` from a user retry policy applies).
- `rate-limited`: wait for `error.retryAfterMs` (or, if absent, 5000 ms), then re-enter the queue for ONE retry attempt per rate-limit hit. A second consecutive `rate-limited` on the same attempt-count restarts the wait-and-retry.
- `auth-expired`: the scheduler SHALL NOT intercept it with a retry. The engine no longer auto-refreshes on `auth-expired`; instead the `MirrorSyncJobExecutor` wraps each engine call (`uploadFile`, `delete`) in the engine's `withAuthRefresh(client, op)` helper, which calls `client.refreshCredentials()` and retries once BEFORE any error escapes the executor. An `auth-expired` that still reaches the scheduler is therefore a post-refresh dead token; the scheduler propagates it as terminal (no scheduler-level retry), consistent with the prior contract.

These behaviours SHALL NOT be modifiable by any user-supplied retry policy.

#### Scenario: Network error moves job to waiting-network

- **WHEN** a fake client's `uploadFile` throws `new DatasourceError({ tag: 'network-error', retryable: true })` on its first attempt
- **THEN** the job's `status` becomes `waiting-network`, its `attempt` is incremented by 1, no `job-failed` event is emitted, and no user retry-policy is consulted
