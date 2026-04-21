## Context

The `ft5-cloude-sync` product is an Electron desktop app that lets a user mirror a local folder to one of several cloud datasources (Google Drive, OneDrive, S3). Two prior architectural decisions frame this change:

1. **`@ft5/fs-datasource-engine`** (in-flight on the `feature/add-fs-datasource-engine` branch; Phases 1–2 already committed) is a framework-agnostic workspace package that owns every provider SDK call, event emission, error normalization, and single-flight token refresh. It exposes a `DatasourceClient<T>` strategy interface, a `BaseDatasourceClient<T>` template, an `EventBus`, and an abstract `CredentialStore` port. It does NOT import Electron. It has one Electron-specific implementation of the `CredentialStore` port (`SqliteCredentialStore`, using `safeStorage`) that lives in `apps/desktop/src/main/`.

2. **`services/fs-monitor`** is declared in `openspec/project.md` as a Node.js background service whose role is to watch the local filesystem for changes and trigger sync jobs. Its implementation is a future change; `openspec/project.md` already locks in its location, runtime, and intent.

The gap this change fills: there is no **executor** for sync/upload jobs that survives the desktop app's lifecycle. Running uploads inside Electron's main process means they die when the user closes the app. Running them inside `services/fs-monitor` would conflate "detect change" with "perform work." This change introduces a dedicated third peer — `services/fs-sync` — responsible for job machinery (queue, scheduler, retry, persistence) and engine invocation. It is designed to be independently restartable, crash-recoverable, and callable both manually (by the desktop app) and, eventually, automatically (by `services/fs-monitor`).

### Current state

- Engine package exists at `packages/fs-datasource-engine/` on the feature branch; its public types live in `@ft5/ipc-contracts`.
- Desktop app's IPC handlers currently return mocked fixtures for file operations; the engine integration is underway in the engine's own change.
- `services/fs-monitor/` does not yet exist as code, but its name, runtime, and role are already locked in `openspec/project.md`.
- The app's SQLite database lives under Electron's `userData` directory and is owned exclusively by the desktop app's main process.

### Constraints

- `openspec/project.md` pins stack: Node.js 24.14.1 LTS, TypeScript 6.0.3 strict, SQLite via Drizzle ORM, Vitest, pnpm. The sync service must conform.
- `openspec/project.md` rule: "Drizzle imports are allowed only under `apps/desktop/src/main/`. CI greps for violations." This change extends the allowlist to include `services/fs-sync/src/` (and, by the project.md's own description, `services/fs-monitor/src/`).
- Electron security defaults (context isolation, sandbox, etc.) are non-negotiable but don't apply here — the service is not Electron.
- "Never add a dependency without justifying it in `design.md`" (CLAUDE.md).
- The engine's spec forbids plaintext credential fallback for `SqliteCredentialStore`. That rule does not transitively forbid a DIFFERENT `CredentialStore` implementation from using plaintext, but the product-level downgrade is real and must be documented.
- The service must run without administrator privileges (per-user deployment).
- No new native modules that require platform-specific build toolchains beyond what `better-sqlite3` already demands.

## Goals / Non-Goals

**Goals:**

- Ship a per-user background service that accepts manual upload and manual one-way mirror-sync jobs from the desktop app via a named-pipe IPC, executes them against `@ft5/fs-datasource-engine`, persists them to SQLite, and keeps running after the app closes.
- Enforce a deterministic, predictable job lifecycle with global concurrency 2, FIFO queueing, per-job conflict policy, and crash-recoverable state.
- Honour the engine's `DatasourceError` taxonomy with a retry policy split between non-configurable system retries (network / rate-limit / auth-expired) and configurable user retries (provider-error only).
- Implement snapshot-driven one-way mirror sync with safe deletion propagation that refuses to delete remote state when the local source is unhealthy.
- Provide a no-op `MonitorEventSource` input port so the future `services/fs-monitor` change can wire auto-sync without re-architecting the service.
- Reuse the engine's `CredentialStore` port interface verbatim with a new `ConfigFileCredentialStore` implementation. The port contract does not change.
- Make the service installable as a per-user OS service on production and runnable as a detached Node process in development, with no overlap between the two deployments.

**Non-Goals:**

- Implementing `services/fs-monitor` or any real file-system watcher. The `MonitorEventSource` port exists and is covered by a no-op impl; auto-sync commands are NOT exposed.
- Desktop-app integration (issuing commands, subscribing to events, rendering job status). The IPC surface is specified; wiring it into the renderer/main is a separate change.
- Resumable uploads via provider session APIs. On network retry, the service re-uploads from byte 0.
- OS-keyring credential storage. Credentials are plaintext JSON in v1 with strict file permissions; keyring migration is a future change.
- System-wide (multi-user) service deployment. This service is strictly per-user.
- A secondary copy of the desktop app's SQLite database. The service owns `sync.db` entirely; the app owns its own DB entirely.
- Mass-delete safety thresholds. Per user instruction, no such threshold is enforced.
- Bidirectional sync, cloud-to-local sync, scheduled sync. Only manual upload and manual one-way mirror sync are in scope.
- Exposing the engine's `deleteDirectory` method (engine spec has it throw `Unsupported`). The sync service honours that and does NOT attempt directory deletes as a single provider call — deletes during mirror sync are issued file-by-file.

## Decisions

### D1. Process model: per-user OS service, no Electron

**Decision.** `services/fs-sync` is a Node.js TypeScript daemon installed as a per-user OS service: Windows Scheduled Task with "At log on" trigger, macOS `LaunchAgent` at `~/Library/LaunchAgents/tech.forti5.ft5-sync.plist`, Linux `systemd --user` unit at `~/.config/systemd/user/ft5-sync.service`. Never runs as `LocalSystem` / `root`.

**Why this over alternatives.**

- **Electron utility process / hidden main (B).** Dies when the app is killed from the tray or by task manager. Fails the requirement "completes when app closed."
- **Detached Node child of the app (C).** Survives app close, but loses autostart on reboot and needs a custom discovery mechanism. Per-user OS service is barely more complex and gives autostart for free.
- **System-wide OS service (D, system scope).** Would need to impersonate the user to read the user's home directory or watch their files — an OS-dependent complexity bomb with no payoff for a personal sync tool.

**Consequences.** No `electron` imports anywhere in `services/fs-sync/`. No `safeStorage`. Credentials must be stored outside Electron. Install/uninstall hooks are OS-specific but use only OS-native CLIs (`schtasks`, `launchctl`, `systemctl --user`) — no third-party service-manager library dependency.

### D2. IPC transport: named pipes + JSON-line, one bidirectional connection per client

**Decision.** Server listens on a platform-neutral pipe path:

- Windows: `\\.\pipe\ft5-sync` (prod), `\\.\pipe\ft5-sync-dev` (dev)
- Unix: `$HOME/ft5/sync_app/sync.sock` (prod), `$HOME/ft5/sync_app/sync-dev.sock` (dev)

Protocol: newline-delimited JSON frames. Each frame is either a `Request`, a `Response`, or an `Event`:

```
Request  { id: string, kind: "request",  command: string, params: unknown }
Response { id: string, kind: "response", ok: true,  result: unknown }
         | { id: string, kind: "response", ok: false, error: { tag, message, details? } }
Event    {                kind: "event",    name: string, payload: unknown }
```

The `id` correlates a request with its response. Events are unsolicited and carry no `id`. A single socket connection is bidirectional: the client writes requests; the server writes responses and events on the same stream.

**Why this over alternatives.**

- **HTTP on 127.0.0.1 with port-file.** Needs TLS or the listen port leaks to anything on `localhost`; requires a port-discovery dance. Pipes don't have either problem — OS-level access control is implicit via filesystem permissions (Unix) or the pipe ACL (Windows).
- **gRPC / Protobuf.** Overkill for a local single-client transport; heavy codegen; complicates debuggability. JSON lines are trivial to tap with `nc` / `tail` in dev.
- **Electron `ipcMain`.** Can't work — the service isn't Electron.

**Consequences.** `net.createServer({ path })` handles both OSes uniformly. On Unix the socket file is created with mode `0600`. On Windows the pipe is created with a user-only security descriptor. No dependency on any IPC library.

### D3. Contract package placement: extend `@ft5/ipc-contracts`

**Decision.** Add sync-service contract types to `@ft5/ipc-contracts` rather than create a new `@ft5/sync-service-contracts` package. The engine's datasource contract types already live there; the service's command/event types are the same architectural tier (cross-process contracts) and belong in the same package.

**Why this over a new package.** Splitting contracts into two packages forces both processes to pin the same version of both packages to avoid drift. A single package with a `/sync-service` subpath export keeps the dependency graph flat.

**Consequences.** `packages/ipc-contracts/` gains a `src/sync-service/` subtree. Public API is re-exported under `@ft5/ipc-contracts/sync-service`. No existing exports change shape.

### D4. Credential storage: `ConfigFileCredentialStore`, plaintext JSON, strict file mode, refusal-to-operate if widened

**Decision.** Implement the engine's `CredentialStore` port with a `ConfigFileCredentialStore` that reads/writes `$HOME/ft5/sync_app/credentials.json`. File format:

```json
{
  "schemaVersion": 1,
  "credentials": {
    "<datasourceId>": { /* StoredCredentials */ }
  }
}
```

Writes are atomic: write-to-temp then `fs.rename`. On Unix, after every write the file is `fchmod(0o600)`-ed. On Windows, the file is created with a security descriptor granting only the current user full control, via `fs.open` + platform-specific ACL (`icacls` shell-out in the installer; the service refuses to widen permissions but does not set them itself beyond creation).

On every `get`, the store calls `fs.stat` and refuses to operate if:
- Unix: the file's mode has any bit set beyond `0600` (owner read/write only). Refusal emits a `credential-store-permission-violation` event.
- Windows: the file ACL grants any non-owner SID beyond `NT AUTHORITY\SYSTEM`.

**Why plaintext.** The user has explicitly deprioritized encrypted-at-rest storage for v1 ("let's use config file to store the credentials for now, and let's not depend on safeStorage"). The service is not Electron so `safeStorage` is unavailable; using `keytar` or a native keyring introduces a native build dependency and per-OS complexity that is explicitly deferred.

**Why refusal-to-operate over silent repair.** A widened-permissions file is a red flag (the user or another process is trying to access credentials). Refusing fails loudly; repairing masks intrusion.

**Migration path documented.** A future change will swap `ConfigFileCredentialStore` for a `KeyringCredentialStore` using `keytar`-equivalent bindings. The port interface does not change; only the binding wiring in `services/fs-sync/src/container.ts` changes. Existing plaintext credentials will be one-time migrated on service start after the keyring impl lands and then the plaintext file will be deleted.

**Consequences.** A plaintext credentials file on disk is a known vulnerability. Per-user service identity means the file is not readable by other OS users on a shared machine, which is the primary threat model for a personal sync tool. This is documented in the `Risks / Trade-offs` section.

### D5. Data directory layout

```
$HOME/ft5/sync_app/
├── credentials.json          (D4)
├── sync.db                   (D6)
├── sync.sock                 (Unix prod — D2)
├── sync-dev.sock             (Unix dev — D2)
├── service.log               (rotating, 5 files × 5 MB)
└── service.pid               (pid of running service, for reentrancy check)
```

On Windows the `.sock` files are replaced by named pipes (no filesystem entry). All other files are identical paths.

On dev, an environment variable `FT5_SYNC_DATA_DIR` can override the data dir root so CI and local tests can use a fresh directory per run without touching the user's production dir.

### D6. Database: SQLite via Drizzle, service-owned, separate from the app's DB

**Decision.** One SQLite file at `$HOME/ft5/sync_app/sync.db`, owned entirely by the service. Drizzle schema lives at `services/fs-sync/src/db/schema.ts`. Migrations shipped in `services/fs-sync/drizzle/`. `journal_mode = WAL` for crash durability. `synchronous = NORMAL` (WAL makes NORMAL safe for our workload).

Core tables:

```
service_meta      schemaVersion, installedAt, serviceUuid

jobs              id (uuid), kind ('upload'|'sync'), datasourceId,
                  sourcePath, targetPath?, conflictPolicy,
                  status ('queued'|'running'|'waiting-network'|'completed'|'failed'|'cancelled'),
                  attempt, lastErrorTag?, lastErrorMessage?,
                  retryPolicyJson?, createdAt, updatedAt, payloadJson

sync_snapshot     datasourceId, relPath, size, mtimeMs, sha256?,
                  remoteHandle, remoteEtag?, syncedAt
                  PRIMARY KEY (datasourceId, relPath)

retry_policies    scope ('global'|'datasource'), datasourceId?,
                  maxAttempts, backoffMs, backoffStrategy ('exponential'|'fixed'),
                  maxAgeMs?
                  PRIMARY KEY (scope, datasourceId)
```

**Why a separate file.** Two processes (desktop app and sync service) writing to the same SQLite file with WAL is supported but fragile (lock contention, `-wal` / `-shm` file ownership, process-crash cleanup). A separate file fully owned by the service sidesteps the problem. The desktop app never opens `sync.db`; all access is via IPC. The service never opens the app's DB.

**Why Drizzle over raw SQL.** `openspec/project.md` pins Drizzle. Consistency across the codebase outweighs the minor convenience of raw `better-sqlite3` statements.

### D7. Concurrency: global semaphore of 2, sequential-fallback switch

**Decision.** A single `JobScheduler` instance with an `asyncSemaphore(2)`-style cap. Execution is Promise-based (no `worker_threads`). Each running job awaits a semaphore slot before invoking the engine.

A constructor-time boolean `allowParallel` permits dropping to `asyncSemaphore(1)` (strict sequential) if operational experience shows parallel-2 is unreliable (e.g., SQLite contention on heavy writes). Default is `allowParallel: true`.

**Why not `worker_threads`.** The workload is I/O-bound (HTTP to cloud providers; SQLite writes). Worker threads don't help and add serialization overhead on the job-state structure. If future CPU-bound work emerges (client-side hashing of very large files) we can push that into a narrow worker.

**Why global, not per-datasource.** Product requirement: "Global rate limit to 2 jobs at a time." Per-datasource cap is strictly weaker; the global cap is the stronger constraint that dominates.

### D8. Job model: Strategy/Command, persisted as rows, executor dispatch by `kind`

**Decision.** A single `Job` entity (persisted in `jobs` table) with a `kind` discriminator. Two concrete executors:

```
interface JobExecutor<K extends Job['kind']> {
  readonly kind: K;
  execute(job: JobOfKind<K>, ctx: ExecutorCtx): Promise<JobResult>;
}

class UploadJobExecutor      implements JobExecutor<'upload'>
class MirrorSyncJobExecutor  implements JobExecutor<'sync'>
```

`ExecutorCtx` carries the `DatasourceClient<T>` (resolved via the engine's `ClientFactory`), the event emitter, the snapshot repository, an `AbortSignal`, and a `progress(delta)` callback. Executors don't know about persistence — they mutate state by calling repository methods on the ctx.

**Why Strategy + Command.** A single `Job` row format serializes cleanly. A dispatcher `executors[job.kind]` is trivially extensible for future kinds (download, scheduled-sync) without touching the scheduler or persistence.

**Why not polymorphic job classes.** Persisting class instances forces a custom serializer. Row + dispatcher is cleaner and better aligns with Drizzle's row model.

### D9. Mirror sync algorithm: snapshot-driven diff, source-health precondition, delete-by-file

**Algorithm** (for one `MirrorSyncJobExecutor.execute` invocation):

1. **Source-health precondition.** `fs.stat(sourceRoot)`. If it fails (ENOENT / EACCES / EPERM / ENOTDIR) OR the path is a broken symlink OR `fs.readdir(sourceRoot)` throws, emit `source-unavailable`, set job status to `failed` with tag `source-unavailable`, return immediately. **No remote mutations occur.** This is the single fuse that prevents "mounted drive disappeared → remote got wiped."
2. **Walk the local source tree.** Iterate with a depth-bounded async generator (ignore symlinks that escape the root; ignore hidden files matching a configurable glob set — defaults: `.DS_Store`, `Thumbs.db`, `.git/**`, `**/*.tmp`). Collect `{ relPath, size, mtimeMs }` for each file.
3. **Open snapshot.** `SELECT * FROM sync_snapshot WHERE datasourceId = ?`. Build a map keyed by `relPath`.
4. **Diff.**
   - Files present locally and absent from snapshot → **upload**.
   - Files present in both where `(size, mtimeMs)` differs → compute `sha256` of the local file; if it differs from `snapshot.sha256`, **upload**. Otherwise just refresh the snapshot's `mtimeMs`.
   - Files present in snapshot and absent locally → **remote delete**, then snapshot delete.
5. **Enqueue intra-job operations.** Each upload/delete is an inner call into the engine's `DatasourceClient<T>.uploadFile` or `deleteFile`. Per-file operations respect the job's `conflictPolicy` for uploads.
6. **Progress events.** Streaming `sync-progress` events throttled by the engine's own 1-second / 10% rule.
7. **Terminal event.** `sync-completed` with a summary: `{ uploaded, updated, deleted, skipped }`.

**Why `(size, mtime)` first then `sha256`.** Hashing every file every sync is expensive for large trees. `(size, mtime)` is a cheap heuristic; mismatch triggers the authoritative hash. Changing a file while preserving size and mtime is rare outside deliberate adversarial behaviour.

**Why delete-by-file, not `deleteDirectory`.** The engine's spec has `deleteDirectory` throw `Unsupported`. We delete files individually; provider-side empty directories persist (which all three providers tolerate).

**Why no mass-delete threshold.** Per user instruction. The source-health precondition is the primary safety mechanism.

### D10. Dedup rule: per `(datasourceId, sourcePath)`, fires only for `sync` jobs

**Decision.** On `sync:enqueue-mirror`, before INSERTing the job, query:

```
SELECT id FROM jobs
WHERE kind = 'sync'
  AND datasourceId = ?
  AND sourcePath = ?
  AND status IN ('queued', 'running', 'waiting-network')
LIMIT 1;
```

If a row exists, reject the request with a `SyncAlreadyRunningError` response carrying `{ existingJobId, datasourceId, sourcePath }`. Otherwise, INSERT and respond with the new job id. The query + INSERT runs inside a single SQLite transaction using `BEGIN IMMEDIATE` so two concurrent enqueues cannot race through the check.

**Why include `waiting-network`.** A job that's waiting for the network to return is still "in flight" from the user's perspective; creating a duplicate when it's waiting would serialize two full mirror passes back-to-back.

**Why only `sync`, not `upload`.** A user may legitimately upload the same file twice (with conflict policy `'duplicate'` they want both copies). Uploads are discrete commands; sync is stateful.

### D11. Conflict resolution: per-job policy, decided at enqueue, never prompts

**Decision.** `conflictPolicy: 'overwrite' | 'duplicate' | 'skip'` is a required field on `sync:enqueue-upload`. The default in the `sync:enqueue-mirror` command is `'overwrite'` (mirror semantics). The service NEVER prompts the user mid-job. Any conflict event observed by the engine is resolved by the stored policy.

**Why.** The service runs when the app is closed; there's no UI to prompt. Making the policy a per-job input moves the decision into the app's UX layer, which is where it belongs.

### D12. Retry split

| Engine `DatasourceError.tag` | System retry (non-configurable) | User retry (configurable) | Terminal |
|---|---|---|---|
| `network-error` | ✓ → `waiting-network`, infinite retries gated on probe | ✗ | ✗ |
| `rate-limited` | ✓ → honour `retryAfterMs`, single retry per hit | ✗ | ✗ |
| `auth-expired` | ✓ → engine's own single-flight refresh | ✗ | ✗ |
| `provider-error` | ✗ | ✓ if `retryable === true` | ✓ if `retryable === false` |
| `auth-revoked` | ✗ | ✗ | ✓ |
| `not-found` | ✗ | ✗ | ✓ |
| `conflict` | ✗ | ✗ | ✓ |
| `unsupported` | ✗ | ✗ | ✓ |

The `sync:set-retry-policy` command accepts:

```
{ scope: 'global' | 'datasource', datasourceId?: string,
  maxAttempts: number (1..20), backoffMs: number (≥ 1000),
  backoffStrategy: 'fixed' | 'exponential', maxAgeMs?: number }
```

A per-datasource policy overrides the global policy. If no policy is set, defaults are `{ maxAttempts: 3, backoffMs: 5000, backoffStrategy: 'exponential', maxAgeMs: 86_400_000 }`.

**Why respect `retryable` from the engine.** The engine already classifies errors as retryable or not based on provider knowledge. Duplicating that classification in the service would drift; we consume it directly.

### D13. Network probe: single 30s DNS probe, only active when jobs are waiting

**Decision.** A `NetworkProbe` class:

- Starts idle. No timer set.
- On `waiting-network.count` transitioning 0 → >0, arms a `setInterval(30_000)` running `dns.resolve('cloudflare.com')` (configurable).
- On success, emits a `network-available` event internally; scheduler reacts by transitioning all `waiting-network` jobs to `queued` via an atomic UPDATE.
- On `waiting-network.count` transitioning to 0, clears the interval.

30 seconds is a balance: fast enough to feel responsive when the user's network returns, slow enough to not saturate a truly offline machine with retries. Probe target is a reliable anycast DNS (Cloudflare's or Google's public DNS) — configurable so enterprise environments behind restrictive egress can point at their own.

**Why not OS network-change hooks.** `node-netwatch` and equivalents are native modules with flaky cross-platform support. An error-driven probe is portable, simple, and "good enough" for a 30s-granularity response.

### D14. Full re-upload on network retry (no resumable sessions)

**Decision.** When a retry resumes a job that failed mid-upload, the executor calls `DatasourceClient.uploadFile` from byte 0 again. Any partial data already sent to the provider is abandoned (the provider will garbage-collect it via its own retention policy for incomplete multipart uploads, which is already a built-in behaviour on all three providers).

**Why.** The engine's current `uploadFile` signature does not expose session-resume. Adding it would be a substantial engine-side change (new `startResumableUpload` / `continueUpload` / `finalizeUpload` methods, new session persistence). That is a separate future change. In v1, the user waste is bounded by the 2 GB upload that gets re-started; in practice the retry policy usually only triggers network-error retries, which tend to involve uploads that barely started.

### D15. `MonitorEventSource` input port + no-op impl

**Decision.** Declare:

```
interface MonitorEventSource {
  onChange(listener: (e: MonitorChangeEvent) => void): () => void;
  onSnapshot(listener: (e: MonitorSnapshotEvent) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type MonitorChangeEvent =
  | { kind: 'file-created';  datasourceId: string; relPath: string }
  | { kind: 'file-modified'; datasourceId: string; relPath: string }
  | { kind: 'file-deleted';  datasourceId: string; relPath: string }
  | { kind: 'source-appeared';    datasourceId: string }
  | { kind: 'source-disappeared'; datasourceId: string };
```

Ship a `NoopMonitorEventSource` that `start()`s successfully and never emits. The dependency container injects `NoopMonitorEventSource` in v1. The auto-sync command surface (`sync:enable-auto` / `sync:disable-auto`) is NOT exposed over IPC in v1.

**Why declare the port now.** Defining the interface in this change forces the service's architecture to stay pluggable. The follow-up `services/fs-monitor` change will supply a real impl; no changes to the scheduler, jobs, or diff algorithm are needed at that time.

### D16. Install/uninstall hooks per OS

| OS | Register | Deregister | Auto-start trigger |
|---|---|---|---|
| Windows | `schtasks /Create /SC ONLOGON /TN "ft5-sync" /TR "<path>\fs-sync.exe" /RL LIMITED` | `schtasks /Delete /TN "ft5-sync" /F` | At current-user logon |
| macOS | Write `~/Library/LaunchAgents/tech.forti5.ft5-sync.plist` with `RunAtLoad=true` + `KeepAlive=true`; `launchctl load` it | `launchctl unload`; delete the plist | `launchd` on user login |
| Linux | Write `~/.config/systemd/user/ft5-sync.service`; `systemctl --user enable --now ft5-sync.service`; `loginctl enable-linger <user>` so it survives logout | `systemctl --user disable --now`; delete the unit | `systemd --user` on graphical session start |

These are invoked from electron-builder's `afterInstall` / `afterUninstall` hooks. No third-party library. All three commands are present by default on their respective OSes in the supported versions.

**Linger note.** On Linux, by default `systemd --user` tears down when the user logs out. `loginctl enable-linger` keeps the user bus alive across logouts, which is what we want for "syncs after you close the app." This requires no admin privilege.

### D17. Dev mode: detached Node spawn, distinct pipe + data dir

**Decision.** `pnpm dev:sync-service` runs `node --enable-source-maps dist/services/fs-sync/main.js --dev`. The `--dev` flag:

- Switches the pipe name to `\\.\pipe\ft5-sync-dev` / `sync-dev.sock`.
- Sets `FT5_SYNC_DATA_DIR = $HOME/ft5/sync_app/dev/`.
- Enables verbose logging to stderr.

The desktop app's dev build connects to the dev pipe (controlled by the same `--dev` flag or an env var). This keeps the developer's production-registered service untouched while iterating.

### D18. Service crash recovery

**Decision.** On startup:

1. Read `jobs` table.
2. Any row with `status = 'running'` is a job the service was executing when it died. Policy: transition to `queued`, increment `attempt`, clear `running`-specific payload. This re-runs the job from scratch (full re-upload for uploads, full rescan for sync). Emit `job-recovered` event.
3. Any row with `status = 'waiting-network'` is left alone; the probe picks it up if armed, or the next error will re-arm it.
4. Any row with terminal status (`completed`, `failed`, `cancelled`) is left alone.

**Why re-run from scratch.** See D14. If resumable uploads land, this policy will be revisited.

### D19. Process of one: PID check

**Decision.** On startup, the service writes its PID to `$HOME/ft5/sync_app/service.pid`. If a previous `service.pid` exists and the PID is still alive (OS check), the new instance exits with code `3` (`already-running`). This prevents two installed services or a dev + prod service from running simultaneously for the same user.

The dev-mode service uses a separate `service-dev.pid` so dev and prod don't collide.

### D20. Observability

Single log file at `$HOME/ft5/sync_app/service.log`, rotating at 5 MB × 5 files (a minimal rolling writer — no new dependency). Log entries are JSON lines: `{ ts, level, msg, jobId?, datasourceId?, tag? }`. Every IPC command and response is logged at `debug`. Every job state transition is logged at `info`. Every error is logged at `error` with the full `DatasourceError.tag` + stack.

## Risks / Trade-offs

- **[R1] Plaintext credentials on disk.** → Mitigation: per-user service identity (not readable by other OS users); `0600` / user-ACL enforcement; refusal-to-operate on widened permissions; documented migration path to OS keyring. Accepted as a deliberate v1 tradeoff per user direction. Product-level security posture will be formally revisited in the keyring migration change.
- **[R2] Mirror-sync blast radius without mass-delete threshold.** A bug that causes the local walker to under-report files could delete files from the cloud. → Mitigation: the source-health precondition refuses to run against an unreachable source; unit tests cover "source returns empty but was populated at snapshot time" as a distinct scenario that MUST NOT propagate deletes (test asserts zero remote calls). Operationally, the scheduler logs a "would-delete N files" line at `warn` level for every mirror run so a post-mortem has evidence.
- **[R3] Full re-upload on retry is wasteful for large files.** → Mitigation: accepted tradeoff; documented as follow-up in the engine's backlog. Users on metered connections will feel this; the config exposes a per-datasource `maxAttempts: 1` so the user can opt out of retries for wasteful cases.
- **[R4] Named-pipe access control on Windows.** A service running as the current user creates pipes with a security descriptor that permits that user. Another process running as the same user could connect. → Mitigation: this is the same trust boundary as the credentials file. Threat-modelling same-user processes is out of scope; users are trusted within their own OS account.
- **[R5] SQLite corruption on crash.** → Mitigation: WAL mode; atomic schema migrations; on startup, a PRAGMA integrity_check that refuses to start if it fails (forces a manual repair path rather than silently corrupting sync state). Migration tests cover upgrade + rollback.
- **[R6] Linux without `systemd --user` (some minimal distros).** → Mitigation: installer detects absence, falls back to writing a `~/.config/autostart/ft5-sync.desktop` entry and spawning via XDG autostart; flags the fallback in the log. Out of scope to support every init system; systemd covers the vast majority of desktop Linux.
- **[R7] Dev/prod collision.** A developer with the prod service installed who runs `pnpm dev:sync-service` must not silently have their app talk to the prod service. → Mitigation: separate pipe names (D17) and separate PID files (D19). The dev pipe path is intentionally different so no accidental connection is possible.
- **[R8] PID check false-positive after unclean shutdown.** A stale `service.pid` pointing at a now-recycled PID could misreport "already running." → Mitigation: verify not just that a PID exists, but that its process image matches the expected binary name (`process.platform`-specific check). On mismatch, overwrite the pid file and proceed.
- **[R9] Clock skew between service and provider.** `mtime`-based diff assumes monotonic wall clock. → Mitigation: diff falls back to `sha256` on any mismatch, so even with skewed mtimes the hash is authoritative. The `(size, mtime)` check is only a cheap accelerator, not a correctness guarantee.
- **[R10] Credential file read races between service and app.** Both the service and (future) desktop app write `credentials.json`. → Mitigation: atomic write (write-temp + rename) on both sides. Add a schema-version guard so a future field addition doesn't crash the older consumer. Future keyring migration eliminates this shared-file concern.

## Migration Plan

This change introduces a new service from scratch; there is no existing sync-service to migrate from. The migration is install-only:

1. Land this change on a feature branch; run the full test suite.
2. Pin `@ft5/fs-datasource-engine` as a workspace dep (engine change must be merged first, or this change merges alongside it).
3. Build and sign the desktop installer including the service binary.
4. The installer runs the per-OS `afterInstall` hook (D16) to register the service.
5. On first service start, the `service_meta` table is created and `schemaVersion = 1` is recorded.
6. No data migration: `sync.db` starts empty; `credentials.json` is created lazily on the first successful `sync:authenticate` command.

Rollback: the uninstaller runs the `afterUninstall` hook (D16) to deregister the service; optionally the user removes `$HOME/ft5/sync_app/` manually to drop queued jobs and cached credentials. No provider-side cleanup is required (no persistent sessions are created).

## Open Questions

All significant questions were closed during exploration. Remaining minor items for the implementation phase (to be resolved with subagent approval rather than blocking the proposal):

- Exact Windows ACL-set-on-create incantation: can Node's `fs.open` + `fs.fchmod` equivalents on Win32 reach the right SD, or do we need a post-install `icacls` shell-out? Deferred to the implementation task for the credential store.
- Log rotation library or hand-rolled? `pino` has rotation built in but adds a dep; hand-rolled is 30 lines of code. Leaning hand-rolled to keep the dep count down. Revisit at task implementation time.
- DNS probe target selection: single fixed host vs round-robin across two? Leaning single (simpler; a probe that fails because one DNS resolver is down is not the right signal). Confirm at implementation time.
