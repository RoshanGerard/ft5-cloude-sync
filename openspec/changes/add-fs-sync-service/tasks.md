## 1. Package scaffold and workspace wiring

- [x] 1.1 Create `services/fs-sync/` with `package.json` (`name: "@ft5/fs-sync-service"`, `private: true`, `type: "module"`), `tsconfig.json` extending the repo base with strict TS, and an empty `src/` tree; add the new workspace to `pnpm-workspace.yaml`
- [x] 1.2 Add runtime deps (`drizzle-orm`, `better-sqlite3`) and dev deps (`@types/better-sqlite3`, `vitest`, `@ft5/ipc-contracts` via workspace, `@ft5/fs-datasource-engine` via workspace); verify `pnpm install` resolves without network pulls for workspace deps
- [x] 1.3 Add a `vitest.config.ts` for the service with `environment: 'node'`, test glob covering `src/**/*.test.ts` and `src/**/*.test-d.ts`, and the `typecheck: { enabled: true }` block matching the engine package's config
- [x] 1.4 Add `services/fs-sync/src/main/index.ts` stub that logs `"fs-sync-service starting"` and exits 0; verify `pnpm --filter @ft5/fs-sync-service build` succeeds
- [x] 1.5 Extend the Drizzle import grep allowlist / CI rule to permit `services/fs-sync/src/db/` and `services/fs-sync/src/main/`; update the rule's test so it FAILS if a file elsewhere in the service imports Drizzle, and PASSES with a seeded import under `db/`

## 2. IPC contracts — sync-service subtree in `@ft5/ipc-contracts`

- [x] 2.1 RED: add `packages/ipc-contracts/src/sync-service/frames.test-d.ts` asserting `Request`, `Response`, `Event` discriminated unions with exact field shapes; run `pnpm -w test --run frames.test-d` and confirm typecheck failure
- [x] 2.2 GREEN: implement `packages/ipc-contracts/src/sync-service/frames.ts` exporting `Request`, `Response`, `Event`, `ErrorShape` types; re-export from `packages/ipc-contracts/src/index.ts` under `sync-service` subpath
- [x] 2.3 RED: add `commands.test-d.ts` asserting every command in the spec (`sync:enqueue-upload`, `sync:enqueue-mirror`, `sync:list-jobs`, `sync:get-job`, `sync:cancel-job`, `sync:subscribe-events`, `sync:unsubscribe-events`, `sync:set-retry-policy`, `sync:get-retry-policy`, `sync:authenticate`, `sync:get-status`) has matching request params and response result shapes as a discriminated union keyed by `command`
- [x] 2.4 GREEN: implement `commands.ts` with the full discriminated union; export `CommandName`, `CommandRequest<N>`, `CommandResult<N>`, `CommandError<N>`
- [x] 2.5 RED: add `events.test-d.ts` asserting every event name emitted by the service (`job-enqueued`, `job-started`, `job-progress`, `job-completed`, `job-failed`, `job-cancelled`, `job-recovered`, `sync-completed`, `source-unavailable`, `network-available`, `credential-store-permission-violation`) with its payload shape
- [x] 2.6 GREEN: implement `events.ts` with the `ServiceEvent` discriminated union and re-export
- [x] 2.7 RED: add `errors.test-d.ts` asserting `SyncAlreadyRunningError` shape `{ tag: 'sync-already-running', existingJobId, datasourceId, sourcePath }` and `unknown-command` shape
- [x] 2.8 GREEN: implement `errors.ts` with typed error shapes
- [x] 2.9 Verify the new contract surface compiles from a cold `tsc --ignoreConfig` invocation (bypass any stale Vitest cache per the engine Phase 1 lesson)

## 3. Data directory layout and single-instance guard

- [x] 3.1 RED: `src/env/paths.test.ts` — `resolveDataDir()` returns `$HOME/ft5/sync_app` by default, honours `FT5_SYNC_DATA_DIR`, and produces dev-variant paths under `--dev`
- [x] 3.2 GREEN: implement `src/env/paths.ts` exporting `resolveDataDir({ dev })`, `resolveCredentialsPath`, `resolveDbPath`, `resolveSocketPath`, `resolvePidPath`, `resolveLogPath`
- [x] 3.3 RED: `src/env/ensure-dir.test.ts` — creates the dir on first call with mode `0700` on Unix (`(stat.mode & 0o777) === 0o700`) and user-only ACL stub on Windows (spy on `icacls`)
- [x] 3.4 GREEN: implement `src/env/ensure-dir.ts` using `fs.mkdir` + `fs.chmod` on Unix and an `icacls` shell-out path on Windows
- [x] 3.5 RED: `src/single-instance/pid-guard.test.ts` — fresh PID file gets written; live-matching PID causes `acquire()` to throw `AlreadyRunningError`; stale PID (non-matching image name) gets overwritten and `acquire()` succeeds
- [x] 3.6 GREEN: implement `src/single-instance/pid-guard.ts` with platform-specific live-check (`process.kill(pid, 0)` plus `ps`/`tasklist` name match)
- [x] 3.7 Wire `pid-guard.acquire()` into `src/main/index.ts` before any other startup work; stub exit with code `3` on collision

## 4. `ConfigFileCredentialStore`

- [x] 4.1 RED: `src/credential-store/config-file.test.ts` — `put` + `get` round-trips plaintext; the on-disk file contains the literal token strings; schema is `{ schemaVersion: 1, credentials: {...} }`
- [x] 4.2 GREEN: implement `src/credential-store/config-file.ts` with `get`, `put`, `delete`; atomic write via `write-temp + rename`; Unix `fchmod(0o600)` after write
- [x] 4.3 RED: `config-file.permissions.test.ts` (Unix-gated) — file with mode `0o644` causes `get` to throw `CredentialStorePermissionError` and emit `credential-store-permission-violation` with the observed mode; file with `0o600` proceeds normally
- [x] 4.4 GREEN: implement the `fs.stat` pre-check in every method and wire a permission-violation emitter onto an internal event bus
- [x] 4.5 RED: `config-file.atomic-crash.test.ts` — simulate crash between temp write and rename; verify the previously-committed value is still readable and the tmp file is cleaned up on the next successful write
- [x] 4.6 GREEN: confirm atomic-write pattern; add tmp-file cleanup on startup (unlink any leftover `credentials.json.tmp`)
- [x] 4.7 Verify `ConfigFileCredentialStore` is assignable to the engine's `CredentialStore` interface via a type-level assertion in `config-file.test-d.ts`

## 5. SQLite database: schema, migrations, integrity

- [x] 5.1 RED: `src/db/schema.test-d.ts` — type-level assertion that Drizzle schema exports match the contract (table names, column names, nullability)
- [x] 5.2 GREEN: write `src/db/schema.ts` with `serviceMeta`, `jobs`, `syncSnapshot`, `retryPolicies` table definitions using Drizzle's SQLite builders
- [x] 5.3 RED: `src/db/migrations.test.ts` — a fresh empty DB file after `applyMigrations()` has all four tables (checked via `sqlite_master`), `service_meta` has one row with `schemaVersion = 1`, and running `applyMigrations` a second time is idempotent
- [x] 5.4 GREEN: author initial migration SQL under `services/fs-sync/drizzle/0001_initial.sql`; implement `src/db/migrations.ts` using Drizzle's `migrate()` helper
- [x] 5.5 RED: `src/db/integrity.test.ts` — seeded corrupted DB causes `openDatabase()` to reject with an error whose code/tag is `integrity-check-failed`
- [x] 5.6 GREEN: implement `src/db/open.ts` that opens with `journal_mode=WAL`, `synchronous=NORMAL`, runs `PRAGMA integrity_check`, and rejects on failure
- [x] 5.7 Wire integrity failure to service exit code `4` in `src/main/index.ts`

## 6. Job repository and state machine

- [x] 6.1 RED: `src/jobs/repository.test.ts` — `insert`, `getById`, `listByStatus`, `transition` all round-trip through SQLite; `transition` validates legal edges
- [x] 6.2 GREEN: implement `src/jobs/repository.ts` (the DAO — pure Drizzle queries, no business logic)
- [x] 6.3 RED: `src/jobs/state-machine.test.ts` — every legal transition listed in the spec succeeds; every illegal transition throws `IllegalJobTransitionError` before any DB write
- [x] 6.4 GREEN: implement `src/jobs/state-machine.ts` with an explicit adjacency map and a `transition(from, to)` guard
- [x] 6.5 RED: `src/jobs/dedup.test.ts` — concurrent `enqueueMirror` for the same `(datasourceId, sourcePath)` with one already in `queued` returns `SyncAlreadyRunningError`; different sourcePath succeeds; upload enqueues do not dedup
- [x] 6.6 GREEN: implement `src/jobs/enqueue.ts` with `BEGIN IMMEDIATE` transaction wrapping the dedup query and INSERT

## 7. IPC transport: named-pipe server and framing

- [x] 7.1 RED: `src/ipc/framing.test.ts` — the line-delimited JSON codec parses a stream of two frames split across arbitrary chunk boundaries, rejects malformed JSON with a `parse-error` response, and caps single-frame size to prevent DoS
- [x] 7.2 GREEN: implement `src/ipc/framing.ts` as a Transform that buffers until newline, emits parsed frames, and hard-caps frame size (e.g., 10 MB)
- [x] 7.3 RED: `src/ipc/server.test.ts` — opening the server on a temp pipe path allows a client to connect, send a request, and receive a response correlated by id; closing the server rejects new connections
- [x] 7.4 GREEN: implement `src/ipc/server.ts` using `net.createServer({ allowHalfOpen: false })` with pipe path selection from `resolveSocketPath`; set Unix socket mode `0600` post-listen
- [x] 7.5 RED: `ipc/server.concurrent-requests.test.ts` — two concurrent requests on the same connection with ids `"a"` and `"b"` are independently correlated; responses may arrive in either order
- [x] 7.6 GREEN: ensure the per-connection dispatch is async-safe and does not serialize requests internally
- [x] 7.7 RED: `ipc/server.unknown-command.test.ts` — a request with an unrecognized `command` receives `{ ok: false, error.tag: 'unknown-command' }`
- [x] 7.8 GREEN: implement the central dispatcher with an exhaustive switch keyed on `CommandName`; default branch returns `unknown-command`

## 8. Command handlers (happy paths, no scheduler yet)

- [x] 8.1 RED: `src/commands/get-status.test.ts` — handler returns `{ version, serviceUuid, runningJobs: 0, queuedJobs: 0, waitingNetworkJobs: 0, monitorConnected: false }` on a fresh DB
- [x] 8.2 GREEN: implement `src/commands/get-status.ts`
- [x] 8.3 RED: `src/commands/enqueue-upload.test.ts` — handler validates params, calls `JobRepository.insert`, returns `{ jobId }`, and emits `job-enqueued`
- [x] 8.4 GREEN: implement `src/commands/enqueue-upload.ts`
- [x] 8.5 RED: `src/commands/enqueue-mirror.test.ts` — handler applies the dedup guard, returns `SyncAlreadyRunningError` or `{ jobId }` as appropriate, emits `job-enqueued` on success only
- [x] 8.6 GREEN: implement `src/commands/enqueue-mirror.ts`
- [x] 8.7 RED: `src/commands/list-jobs.test.ts` + `src/commands/get-job.test.ts` — correct row(s) returned; unknown id returns `{ ok: false, error.tag: 'not-found' }`
- [x] 8.8 GREEN: implement both handlers
- [x] 8.9 RED: `src/commands/cancel-job.test.ts` — cancel from `queued` transitions to `cancelled` and emits `job-cancelled`; cancel from terminal status returns `{ ok: false, error.tag: 'not-cancelable' }`
- [x] 8.10 GREEN: implement `src/commands/cancel-job.ts`

## 9. Job scheduler and global semaphore

- [x] 9.1 RED: `src/scheduler/semaphore.test.ts` — a 2-permit semaphore allows exactly 2 concurrent `acquire`s; a 3rd waits; release order is FIFO
- [x] 9.2 GREEN: implement `src/scheduler/semaphore.ts` (hand-rolled, no new dep)
- [x] 9.3 RED: `src/scheduler/scheduler.test.ts` — enqueue 3 jobs against a fake-client that delays 500 ms; at 200 ms exactly 2 rows are in `running`; after 600 ms the 3rd has started
- [x] 9.4 GREEN: implement `src/scheduler/scheduler.ts` (poll `queued` rows, acquire semaphore, transition to `running`, invoke executor, handle outcome)
- [x] 9.5 RED: `scheduler.sequential-fallback.test.ts` — constructed with `{ allowParallel: false }`, only 1 job runs at a time
- [x] 9.6 GREEN: parameterize the semaphore's permit count from the scheduler options
- [x] 9.7 RED: `scheduler.cancel-during-run.test.ts` — cancelling a `running` job aborts the executor via `AbortSignal` and transitions to `cancelled`
- [x] 9.8 GREEN: thread an `AbortController` through `ExecutorCtx`; wire `cancel-job` to call `abort()`

## 10. `UploadJobExecutor`

- [x] 10.1 RED: `src/executors/upload.test.ts` — enqueue + execute against a `FakeDatasourceClient`; assert `queued → running → completed`, `uploadFile` called once with `Target { kind: 'path' }` and the source path, and `job-completed` event carries the returned `FileEntry`
- [x] 10.2 GREEN: implement `src/executors/upload.ts`; wire in `src/container.ts` so the scheduler dispatches by `job.kind`
- [x] 10.3 RED: `upload.conflict-skip.test.ts` — when fake reports "already exists" and policy is `skip`, executor completes with `skipped: true`
- [x] 10.4 GREEN: thread `conflictPolicy` into the upload params and handle the `skip` branch
- [x] 10.5 RED: `upload.no-sdk-imports.test.ts` — grep test that `services/fs-sync/src/` contains no `@aws-sdk/client-s3`, `@microsoft/microsoft-graph-client`, or `googleapis` imports
- [x] 10.6 GREEN: confirm executor resolves `DatasourceClient<T>` only via `ClientFactory.create`

## 11. `MirrorSyncJobExecutor` — source-health, walker, diff

- [x] 11.1 RED: `src/executors/source-health.test.ts` — missing source, EACCES, ENOTDIR, and broken symlink all cause `failed` with tag `source-unavailable` and zero remote calls, even when `sync_snapshot` has 50 entries
- [x] 11.2 GREEN: implement `src/executors/source-health.ts` with `fs.stat + fs.readdir` precondition; emit `source-unavailable`
- [x] 11.3 RED: `src/executors/local-walker.test.ts` — walks a fixture tree in a tmp dir, skips symlinks escaping root, skips `.DS_Store` / `Thumbs.db` / `.git/**` / `*.tmp`, returns `{ relPath, size, mtimeMs }` for each file
- [x] 11.4 GREEN: implement `src/executors/local-walker.ts` using `fs.promises.opendir` for streaming traversal
- [x] 11.5 RED: `src/executors/diff.test.ts` — given a fixture walk + snapshot, classify each file as `upload-new`, `upload-changed`, `skip`, or `delete-remote`; mtime changed but hash matches → `skip`
- [x] 11.6 GREEN: implement `src/executors/diff.ts` with the spec's algorithm (size+mtime cheap check, then sha256 for tie-break)
- [x] 11.7 RED: `src/executors/hasher.test.ts` — streaming sha256 of a 10 MB fixture matches the reference hash without loading the whole file into memory
- [x] 11.8 GREEN: implement `src/executors/hasher.ts` using `crypto.createHash('sha256').pipe` from `fs.createReadStream`
- [x] 11.9 RED: `src/executors/mirror-sync.test.ts` — end-to-end sync job produces `sync-completed { uploaded, updated, deleted, skipped }` counts matching a fixture; fake client's `uploadFile`/`deleteFile` are called exactly as classified
- [x] 11.10 GREEN: implement `src/executors/mirror-sync.ts` composing source-health + walker + snapshot-load + diff + per-file ops + summary
- [x] 11.11 RED: `mirror-sync.snapshot-update.test.ts` — after a successful sync, `sync_snapshot` rows match the post-state exactly (no stale rows, no missing rows)
- [x] 11.12 GREEN: wire snapshot writes into the per-file success path

## 12. Network probe and system-level retries

- [ ] 12.1 RED: `src/retry/network-probe.test.ts` — probe is idle while `waiting-network.count === 0` (spy reports zero `dns.resolve` calls over 2 minutes with fake timers); arms on 0→>0; disarms on →0
- [ ] 12.2 GREEN: implement `src/retry/network-probe.ts` with `setInterval`-based arming and a watcher on the repository's `waiting-network` count
- [ ] 12.3 RED: `network-probe.success.test.ts` — probe success transitions every `waiting-network` row to `queued` in a single UPDATE and emits exactly one `network-available` event
- [ ] 12.4 GREEN: implement the success path
- [ ] 12.5 RED: `src/retry/system-retry.test.ts` — `network-error` → `waiting-network`, unlimited attempts gated on probe; `rate-limited` → wait `retryAfterMs` then retry once; `auth-expired` is NOT intercepted (engine handles it)
- [ ] 12.6 GREEN: implement `src/retry/system-retry.ts`; wire into the scheduler's error-handling branch

## 13. User-level retry policy

- [ ] 13.1 RED: `src/commands/set-retry-policy.test.ts` + `get-retry-policy.test.ts` — store and retrieve per-scope policies; per-datasource overrides global; defaults apply when nothing set
- [ ] 13.2 GREEN: implement both handlers and `src/retry/policy-store.ts`
- [ ] 13.3 RED: `src/retry/user-retry.test.ts` — `provider-error` with `retryable: true` retries up to `maxAttempts` with the configured backoff; `retryable: false` fails immediately; other terminal tags (`auth-revoked`, `not-found`, `conflict`, `unsupported`) fail immediately
- [ ] 13.4 GREEN: implement `src/retry/user-retry.ts`; wire into the scheduler after `system-retry` has declined the error
- [ ] 13.5 RED: `user-retry.max-age.test.ts` — a job past its `maxAgeMs` fails on the next `provider-error` regardless of `attempt < maxAttempts`
- [ ] 13.6 GREEN: add the age check to `user-retry.ts`

## 14. Full re-upload on network retry

- [ ] 14.1 RED: `src/executors/upload.resume-after-network.test.ts` — after a `network-error` at 50% progress and probe-success, the retry invocation reads the source file from byte 0 to EOF and passes no `startOffset`/`uploadId` parameter
- [ ] 14.2 GREEN: confirm the upload executor builds its params identically on every attempt; add a comment in the code pointing to the resumable-upload follow-up

## 15. `MonitorEventSource` port and no-op implementation

- [ ] 15.1 RED: `src/ports/monitor.test-d.ts` — the `MonitorEventSource` interface has `onChange`, `onSnapshot`, `start`, `stop`; `MonitorChangeEvent` is a discriminated union of the spec's five variants
- [ ] 15.2 GREEN: implement `src/ports/monitor.ts`
- [ ] 15.3 RED: `src/ports/noop-monitor.test.ts` — `start` resolves, `stop` resolves, registered listeners are never invoked over a 2-second window with local file activity, `sync:get-status` reports `monitorConnected: false`
- [ ] 15.4 GREEN: implement `src/ports/noop-monitor.ts`
- [ ] 15.5 RED: `commands.no-auto-sync.test.ts` — sending `sync:enable-auto` to the dispatcher returns `unknown-command`
- [ ] 15.6 GREEN: confirm the command enum does not include `sync:enable-auto` / `sync:disable-auto` in v1

## 16. Event subscription fan-out

- [ ] 16.1 RED: `src/ipc/subscriptions.test.ts` — after `sync:subscribe-events`, the client receives events written to its socket; after `sync:unsubscribe-events`, no more events arrive; closing the connection cleans up the subscription registry
- [ ] 16.2 GREEN: implement `src/ipc/subscriptions.ts` — maintains `Set<Connection>` keyed on the internal event bus; wires the bus to the per-connection writer
- [ ] 16.3 RED: `subscriptions.isolated-per-client.test.ts` — two clients: one subscribed, one not; only the subscribed client receives the emitted events
- [ ] 16.4 GREEN: confirm per-connection dispatch does not leak
- [ ] 16.5 RED: `subscriptions.disconnect-no-throw.test.ts` — closing a subscribed client's socket mid-emission does not surface `EPIPE` / `ECONNRESET` as an uncaught error
- [ ] 16.6 GREEN: wrap writes in try/catch and remove the dead connection on any write error

## 17. Crash recovery on startup

- [ ] 17.1 RED: `src/startup/recovery.test.ts` — seeded DB with 2 `running` rows + 1 `completed` row → after startup, the two are `queued` with `attempt++` and `lastErrorTag = 'service-restart'`; the `completed` row is unchanged; two `job-recovered` events fire once the IPC listener accepts connections
- [ ] 17.2 GREEN: implement `src/startup/recovery.ts`; call it after migrations and integrity check, before opening the IPC listener
- [ ] 17.3 RED: `recovery.waiting-network-untouched.test.ts` — rows in `waiting-network` are NOT modified by recovery
- [ ] 17.4 GREEN: confirm recovery's WHERE clause is exactly `status = 'running'`

## 18. Dev mode

- [ ] 18.1 RED: `src/main/dev-mode.test.ts` — launching with `--dev` selects the dev pipe path, dev data dir (`$HOME/ft5/sync_app/dev/`), and dev PID file (`service-dev.pid`); launching without `--dev` uses prod paths
- [ ] 18.2 GREEN: implement the `--dev` argv parse in `src/main/index.ts`; propagate a `dev: boolean` flag through `resolveDataDir`, `resolveSocketPath`, `resolvePidPath`
- [ ] 18.3 RED: `dev-mode.coexist.test.ts` — starting a dev service with a prod service already running succeeds; both serve their respective pipes concurrently
- [ ] 18.4 GREEN: confirm the two PID files and two pipe paths are fully independent
- [ ] 18.5 Add `pnpm dev:sync-service` root script that runs `node --enable-source-maps services/fs-sync/dist/main.js --dev`; verify it launches cleanly on each supported OS in CI

## 19. Install and uninstall hooks

- [ ] 19.1 RED: `installer/windows/register.test.ts` (Win-gated in CI) — hook registers a Scheduled Task `"ft5-sync"` with `/SC ONLOGON` and `/RL LIMITED`; task's "Run as user" matches the current user; no UAC prompt needed
- [ ] 19.2 GREEN: implement `services/fs-sync/installer/windows/register.ps1` + `unregister.ps1` using `schtasks`; wire them into `apps/desktop`'s electron-builder `afterInstall` / `afterUninstall` hooks on Win
- [ ] 19.3 RED: `installer/macos/register.test.ts` (macOS-gated) — hook writes the plist and `launchctl list` finds `tech.forti5.ft5-sync`
- [ ] 19.4 GREEN: implement `services/fs-sync/installer/macos/register.sh` + `unregister.sh`; wire into electron-builder
- [ ] 19.5 RED: `installer/linux/register.test.ts` (Linux-gated) — hook writes `~/.config/systemd/user/ft5-sync.service`, runs `systemctl --user enable --now`, and `loginctl show-user` reports `Linger=yes`
- [ ] 19.6 GREEN: implement `services/fs-sync/installer/linux/register.sh` + `unregister.sh`; fall back to `~/.config/autostart/ft5-sync.desktop` when `systemd --user` is unavailable (log the fallback)
- [ ] 19.7 RED: `installer.uninstall.test.ts` (all platforms) — after uninstall, the per-OS query reports no entry and the registration file is gone
- [ ] 19.8 GREEN: confirm unregister scripts are idempotent (no error if already removed)

## 20. Observability and logging

- [ ] 20.1 RED: `src/observability/logger.test.ts` — logger emits JSON lines with `{ ts, level, msg, ... }`; rotation happens at 5 MB × 5 files; level gating respects `LOG_LEVEL` env
- [ ] 20.2 GREEN: implement `src/observability/logger.ts` (hand-rolled rotation, no new dep)
- [ ] 20.3 RED: `observability.ipc-audit.test.ts` — every incoming command logs at `debug` with the command name (params redacted for `sync:authenticate`), every response logs with `ok` + elapsed time
- [ ] 20.4 GREEN: add the audit middleware to the command dispatcher
- [ ] 20.5 RED: `observability.transitions.test.ts` — every job state transition logs at `info` with `{ jobId, from, to, attempt }`
- [ ] 20.6 GREEN: wire the logger into the state machine's transition callback

## 21. Integration and end-to-end tests

- [ ] 21.1 Write an integration test `test/integration/end-to-end-upload.test.ts`: spin the service up against a fake datasource registered in the engine's `ClientFactory`, open an IPC client, enqueue upload, observe `job-enqueued → job-started → job-completed`, confirm the row is `completed`
- [ ] 21.2 Write `test/integration/end-to-end-mirror.test.ts`: seed a fixture tree, enqueue mirror, observe `sync-completed` with correct counts, verify snapshot rows match the tree; then delete a local file, re-enqueue, verify remote delete propagates and snapshot row disappears
- [ ] 21.3 Write `test/integration/dedup.test.ts`: enqueue two concurrent mirror jobs for the same `(datasourceId, sourcePath)`, assert second returns `SyncAlreadyRunningError` with the first job's id
- [ ] 21.4 Write `test/integration/network-retry.test.ts`: stub fake client to throw `network-error` for 3 iterations then succeed; stub network probe to succeed on 2nd tick; assert job completes, `waiting-network` state is observed, and `job-completed` fires
- [ ] 21.5 Write `test/integration/crash-recovery.test.ts`: start service, enqueue a long-running job, kill the service mid-execution (`process.kill`), restart, assert the formerly-running job is `queued` with `attempt = 2` and `job-recovered` event fires on restart
- [ ] 21.6 Write `test/integration/source-unavailable.test.ts`: enqueue mirror against a nonexistent path with a populated snapshot, assert zero remote calls and `source-unavailable` event

## 22. Verification and polish

- [ ] 22.1 Run `pnpm -w lint` and `pnpm -w typecheck` across the entire repo; fix any drift introduced in `@ft5/ipc-contracts` consumers (should be none, since all additions are subpath-scoped)
- [ ] 22.2 Run `pnpm -w test --run` — full suite passes
- [ ] 22.3 Run `openspec validate add-fs-sync-service --strict` — passes
- [ ] 22.4 Manually walk through the service on one of each supported OS in a VM: install → enqueue upload via a hand-crafted IPC client → observe completion → uninstall → confirm no residual files beyond the user's data dir
- [ ] 22.5 Update `services/fs-sync/README.md` with the IPC surface, the data-dir layout, the dev-mode command, and the known-limitation on plaintext credentials with a pointer to the migration follow-up
- [ ] 22.6 Update root `README.md` section on services to list `services/fs-sync` alongside `services/fs-monitor`
- [ ] 22.7 Run `superpowers:finishing-a-development-branch` to decide merge/PR/archive; archive the change in the worktree before merging
