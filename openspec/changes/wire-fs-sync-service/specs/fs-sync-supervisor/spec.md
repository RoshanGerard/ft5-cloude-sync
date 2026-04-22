## ADDED Requirements

### Requirement: Desktop supervisor connects-or-spawns the sync service

The desktop main process SHALL, during `bootstrap()`, start a `SyncSupervisor` that obtains a connected `SyncClient` to the fs-sync service before the renderer window loads. The supervisor SHALL:

1. Attempt `net.connect` to the production pipe (`\\.\pipe\ft5-sync` on Windows, `$HOME/ft5/sync_app/sync.sock` on Unix) in prod, or to the dev pipe (`\\.\pipe\ft5-sync-dev` / `sync-dev.sock`) in dev.
2. If the connect succeeds, use the resulting socket.
3. If the connect rejects with `ENOENT` or `ECONNREFUSED` in **prod mode only**, spawn the service as a detached child process via `child_process.spawn(nodeBinary, [servicePath], { detached: true, stdio: 'ignore' })`, then call `child.unref()` so the service outlives the desktop process.
4. After a spawn, retry-connect up to 5 times with geometric backoff (25 / 50 / 100 / 200 / 400 ms). If all retries fail, reject supervisor start with a fatal error surfaced to the renderer.
5. In **dev mode**, do NOT spawn. If the connect fails, surface a clear error message directing the developer to run `pnpm dev` (which starts the service in parallel).

The supervisor SHALL NOT retain any OS-level reference to the spawned child after `unref()`. The supervisor SHALL NOT kill, signal, or wait on the service during `app.quit` / `before-quit` / `will-quit`.

#### Scenario: Prod supervisor connects to an already-running service

- **WHEN** the service is already running with a live PID guard on `service.pid` and the desktop process starts
- **THEN** `net.connect` succeeds on the first attempt, no child process is spawned, and the supervisor yields a ready `SyncClient` within 100 ms of `app.whenReady`

#### Scenario: Prod supervisor spawns a detached service when none is running

- **WHEN** `service.pid` does not exist and the pipe is unreachable, and the desktop process starts in prod mode
- **THEN** the supervisor spawns the service with `detached: true, stdio: 'ignore'`, calls `unref()` on the child, retry-connects within ~1 s, and yields a ready `SyncClient`; killing the desktop process SHALL leave the spawned service alive and still listening on the pipe

#### Scenario: Dev supervisor refuses to spawn

- **WHEN** the desktop starts in dev mode (NODE_ENV=development or --dev flag) and the dev pipe is unreachable
- **THEN** the supervisor does NOT spawn a service, surfaces a user-visible error stating "sync service not running — run `pnpm dev` to start all processes", and desktop exits with a non-zero code (or shows a blocking error window, implementation choice)

#### Scenario: Concurrent desktop starts lose to the PID guard

- **WHEN** two desktop processes start in rapid succession, neither finds a live service, and both attempt to spawn
- **THEN** one spawned service wins the PID guard and begins listening; the other spawned service exits with code 3 within 500 ms; both desktop processes' retry-connect loops find the winning service and proceed normally

### Requirement: Sync client speaks the service's wire protocol

The desktop main process SHALL implement a `SyncClient` that frames requests, matches responses by id, and streams events. The client SHALL use newline-delimited JSON over the socket returned by the supervisor. The client SHALL:

- Assign a unique `id` (UUID or monotonically-increasing counter) to every outgoing `Request` frame.
- Maintain an in-memory map `id → Deferred<Response>` and resolve/reject it when the matching `Response` frame arrives.
- Reject outstanding requests with a synthetic `service-disconnected` error if the socket closes before the response arrives.
- Enforce a 30 s default per-request timeout (configurable per call) that rejects with `request-timeout`.
- Dispatch every `Event` frame to every registered event listener; malformed frames (JSON parse error, missing `kind`) SHALL be logged and dropped without being dispatched.

The client SHALL NOT retry failed requests transparently. Reconnection after a mid-session disconnect SHALL trigger the same handshake the supervisor uses on first connect (subscribe-events, list-jobs seed), but in-flight renderer calls SHALL still see the synthetic `service-disconnected` error rather than being silently re-issued.

#### Scenario: Responses match by id even when out of order

- **WHEN** the client sends two requests with ids `a` and `b`, and the service responds in order `b` then `a`
- **THEN** both promises resolve with the correct payload for their id, and no response is mis-routed

#### Scenario: Disconnect rejects all in-flight requests

- **WHEN** the client has 3 requests in flight (ids `a`, `b`, `c`) and the service crashes, closing the socket
- **THEN** all 3 promises reject with an error whose `.tag === 'service-disconnected'`, and any new request initiated before reconnect also rejects with `service-disconnected`

#### Scenario: Request timeout rejects after threshold

- **WHEN** the client issues a request with a 100 ms timeout and the service does not respond within that window
- **THEN** the promise rejects with an error whose `.tag === 'request-timeout'`, and a subsequent late response carrying the same id is dropped without side-effects

#### Scenario: Malformed event frame is dropped

- **WHEN** the service emits a line of invalid JSON on the event stream
- **THEN** the client logs at error level, does NOT invoke any event listener for that line, and continues processing subsequent well-formed frames normally

### Requirement: Renderer-facing `window.api.sync.*` surface

The preload SHALL expose `window.api.sync` with typed methods that mirror the service's command set, excluding auto-sync commands. The exposed surface SHALL include at minimum:

- `listJobs(filter?: { statuses?: JobStatus[]; datasourceId?: string }): Promise<{ jobs: JobSummary[] }>`
- `getJob(jobId: string): Promise<{ job: JobSummary | null }>`
- `enqueueUpload(params): Promise<{ jobId: string }>`
- `enqueueMirror(params): Promise<{ jobId: string } | { error: SyncAlreadyRunningError }>`
- `cancelJob(jobId: string): Promise<{ cancelled: boolean } | { error: NotCancelableError }>`
- `authenticate(params): Promise<AuthResult>`
- `getStatus(): Promise<{ version: string; serviceUuid: string; runningJobs: number; queuedJobs: number; waitingNetworkJobs: number }>`
- `getRetryPolicy(scope): Promise<RetryPolicy>`
- `setRetryPolicy(scope, policy): Promise<void>`
- `onEvent(callback: (event: ServiceEvent) => void): () => void`

Request/response types SHALL live in a new module under `packages/ipc-contracts/src/sync-service-desktop/` (separate from the on-the-wire `sync-service` module) so renderer code does NOT import wire-format symbols (e.g., `Frame`, `RequestFrame`). The preload SHALL NOT import from `@ft5/ipc-contracts/sync-service` (the wire contract); ONLY from `@ft5/ipc-contracts/sync-service-desktop` plus `electron`.

#### Scenario: Preload exposes sync methods under window.api.sync

- **WHEN** the renderer at runtime inspects `Object.keys(window.api.sync)`
- **THEN** the result contains exactly `listJobs`, `getJob`, `enqueueUpload`, `enqueueMirror`, `cancelJob`, `authenticate`, `getStatus`, `getRetryPolicy`, `setRetryPolicy`, `onEvent` (order-insensitive; no auto-sync entries)

#### Scenario: Preload does not import wire-format types

- **WHEN** a Vitest test grep-scans `apps/desktop/src/preload/` for imports from `@ft5/ipc-contracts/sync-service`
- **THEN** no match is found; matches for `@ft5/ipc-contracts/sync-service-desktop` are allowed

#### Scenario: Four-layer wiring per sync method

- **WHEN** a new sync IPC method is added to the renderer surface
- **THEN** the build requires all four layers (contract type in `sync-service-desktop`, main handler under `apps/desktop/src/main/ipc/sync/`, preload `contextBridge` exposure, renderer call site) to be present; missing any one SHALL cause a TypeScript error or a failing contract test

### Requirement: Main-process IPC proxy translates renderer calls to service commands

The desktop main process SHALL register `ipcMain.handle` handlers under `apps/desktop/src/main/ipc/sync/` for every `window.api.sync.*` method. Each handler SHALL:

1. Validate its input against the `sync-service-desktop` contract.
2. Call the corresponding `SyncClient` method.
3. Translate the service response into the `sync-service-desktop` response type (for most calls this is the identity; for `listJobs` the handler SHALL also compute a `derivedSyncingDatasourceIds: string[]` field by grouping returned jobs by `datasourceId` filtered to `kind === 'sync' && status IN ('running', 'queued', 'waiting-network')`).
4. Forward any structured service-side error (e.g., `sync-already-running`, `not-found`) as part of the typed response shape, NOT by throwing at the IPC boundary.

The handler module SHALL NOT import `@ft5/fs-datasource-engine` directly — all provider work goes through the service. The handler module MAY import the renderer-facing contract and the `SyncClient`.

#### Scenario: listJobs response is enriched with derived syncing set

- **WHEN** a renderer calls `window.api.sync.listJobs` and the service returns 3 jobs: [{ kind: 'sync', status: 'running', datasourceId: 'ds-1' }, { kind: 'upload', status: 'running', datasourceId: 'ds-1' }, { kind: 'sync', status: 'completed', datasourceId: 'ds-2' }]
- **THEN** the renderer receives `jobs` with those 3 entries AND `derivedSyncingDatasourceIds: ['ds-1']` (exactly — `ds-2` is excluded because its sync is completed)

#### Scenario: Structured errors pass through without throwing

- **WHEN** a renderer calls `window.api.sync.enqueueMirror` for a datasource+path that already has an in-flight sync
- **THEN** the handler does NOT throw at the IPC boundary; the renderer receives a resolved promise with `{ error: { tag: 'sync-already-running', existingJobId } }` shape

### Requirement: Service events are relayed to the renderer

The main process SHALL, as part of supervisor startup, call `SyncClient.subscribeEvents()` once per process lifetime (singleton subscription). Every `Event` frame received SHALL be forwarded to every registered `BrowserWindow` via an IPC channel `sync:event` (distinct from the existing `datasources:event` channel). The renderer's `window.api.sync.onEvent(cb)` SHALL register a listener on that channel.

In addition, `job-progress` events whose `payload.kind === 'upload'` SHALL be translated into `DatasourcesUploadProgressEvent` shapes and emitted on the existing `DATASOURCES_CHANNELS.uploadProgress` channel, preserving backward compatibility with the renderer's existing upload-progress subscribers. The translation SHALL map `jobId → transactionId` (they are the same value) and compute `percent` as `Math.floor(sentBytes / totalBytes * 100)` when both fields are present.

#### Scenario: Subscribe is issued exactly once per process

- **WHEN** main process startup completes and N (N ≥ 1) renderer windows open
- **THEN** exactly one `sync:subscribe-events` command has been sent to the service, not N; the single subscription's events are fanned out to every window

#### Scenario: Upload progress flows on the legacy channel

- **WHEN** a renderer initiates an upload via `window.api.datasources.upload` and the service emits `job-progress` events for that job
- **THEN** the renderer's existing `api.datasources.onUploadProgress(transactionId, cb)` subscriber receives events matching the transaction id, each with `sentBytes`, `totalBytes`, and a computed `percent` field

#### Scenario: Event relay survives renderer reload

- **WHEN** a renderer window reloads (Cmd-R / F5) mid-session while a job is running
- **THEN** the subscription to the service is NOT re-issued; the renderer's next `window.api.sync.onEvent(cb)` call receives the resumed event stream without gap or duplication; service-side subscription state is unchanged

### Requirement: App-open reconciliation seeds renderer with in-progress jobs

Immediately after the supervisor yields a connected `SyncClient`, main SHALL issue — in order — `sync:subscribe-events` then `sync:list-jobs { statuses: ['running', 'queued', 'waiting-network'] }`. The list-jobs response SHALL be delivered to the renderer via a new IPC event `sync:event` with a synthetic payload `{ kind: 'sync-state-seed', jobs: JobSummary[] }`. This seed SHALL arrive before the renderer renders the dashboard (or, if the renderer has already mounted, arrives as a normal event).

Subscribe-events SHALL be sent BEFORE list-jobs on the same connection, so no event emitted between the snapshot and the subscription is lost.

The seed event SHALL be emitted exactly once per supervisor connection. Reconnect after a service crash SHALL produce a new seed event so the renderer can reconcile its local state against the post-crash reality.

#### Scenario: Subscribe precedes list-jobs on the wire

- **WHEN** a test instruments the `SyncClient` to record the outgoing frame order after connect
- **THEN** the first frame is `sync:subscribe-events`, and `sync:list-jobs` follows as the second frame (on the same TCP/pipe connection); no other frame appears before either

#### Scenario: Seed includes only in-progress jobs

- **WHEN** the service has 10 jobs total: 2 running, 1 queued, 1 waiting-network, 4 completed, 2 failed
- **THEN** the `sync-state-seed` event the renderer receives carries exactly 4 jobs (running + queued + waiting-network), with no completed or failed entries

#### Scenario: Reconnect produces a fresh seed

- **WHEN** a service crashes after the initial seed, restarts, and the supervisor reconnects automatically
- **THEN** the renderer receives a second `sync-state-seed` event with the post-restart job list; the renderer's existing state for jobs that disappeared between the two seeds SHALL be reconciled (definition of reconcile = stale job ids are marked as unknown/terminal locally)

### Requirement: Datasource cards reflect live service job state

The renderer's `DatasourceCard` SHALL compute its `status` and upload-progress display from a combination of: (a) the existing engine-event stream on `datasources:event`, and (b) the new sync-event stream including the `sync-state-seed`. Specifically:

- If the card's `datasourceId` appears in any job with `kind === 'sync' && status ∈ {running, queued, waiting-network}`, the card's `status` SHALL be `'syncing'`.
- If the card's `datasourceId` has any job with `kind === 'upload' && status === 'running'`, the card SHALL render a compact progress bar showing aggregate progress (by default the progress of the single most-recently-started upload; when multiple are running, the card SHALL pick one deterministically — e.g., by `startedAt` descending).
- When a sync job transitions to `completed` or `failed`, the card SHALL drop its `syncing` status unless another sync remains active for the datasource.
- When an upload job transitions to a terminal state, the card SHALL hide its progress bar unless another upload remains active.

The card SHALL NOT initiate any sync-service request itself. All data comes through `window.api.*` surfaces.

#### Scenario: Card shows syncing when a mirror sync is running

- **WHEN** the seed event reports a running sync job for `datasourceId: 'ds-1'`, and the `DatasourceCard` for ds-1 is rendered
- **THEN** the card displays its "syncing" status indicator (existing pulse animation) and the status label reads `"Syncing…"` or equivalent

#### Scenario: Card shows upload progress bar during an upload

- **WHEN** a `job-started` event with `{ kind: 'upload', datasourceId: 'ds-2', jobId: 'j-1' }` arrives, followed by `job-progress` events with increasing `sentBytes`
- **THEN** the card for ds-2 renders a progress bar; the bar's filled percentage updates with each progress event; on the corresponding `job-completed`, the bar disappears within one animation frame

#### Scenario: Multiple concurrent uploads pick one to display

- **WHEN** two upload jobs start for the same datasource, with `startedAt` 1 ms apart
- **THEN** the card shows a single progress bar bound to the more recently started job; when that job completes, the bar switches to tracking the remaining job; when both complete, the bar disappears

#### Scenario: Reload reconciles card state

- **WHEN** a renderer reload occurs mid-sync and the renderer receives a fresh seed listing the ongoing sync
- **THEN** the card immediately (within one paint) shows the syncing status, without waiting for the next live event

### Requirement: Single `pnpm dev` orchestrates desktop + service

The root `package.json` SHALL define a `dev` script that starts — in parallel, in the same terminal — the Electron desktop app in dev mode and the fs-sync service in `--dev` mode. SIGINT on the parent process SHALL propagate to both children, and both SHALL shut down cleanly (service releases its PID guard, desktop closes its windows and exits). The script SHALL NOT require installing any new runtime dependencies beyond what is already in `package.json`.

The service's existing `dev:sync-service` script SHALL remain callable independently for developers who want to run only the service (e.g., to debug service behaviour against an installed prod desktop).

#### Scenario: pnpm dev starts both processes

- **WHEN** a developer runs `pnpm dev` at the repo root
- **THEN** stdout interleaves logs from both children with distinct prefixes; the desktop window loads successfully; the service's `service-dev.pid` file is created; a subsequent `pnpm --filter @ft5/fs-sync-service test:smoke` against the dev pipe succeeds

#### Scenario: Ctrl-C exits cleanly

- **WHEN** the developer presses Ctrl-C in the `pnpm dev` terminal
- **THEN** the service's PID file is removed within 2 seconds, the dev pipe is no longer accepting connections, the Electron window closes, and the parent pnpm process exits with code 0 (or 130, the POSIX SIGINT convention)

#### Scenario: No new runtime dependency is introduced

- **WHEN** the PR diff is inspected
- **THEN** no `dependencies` or `devDependencies` block in the root `package.json` gains a new entry attributable to the dev orchestration (pnpm's built-in `-r --parallel` is used, not `concurrently` / `npm-run-all` / similar)
