## Context

`@ft5/fs-datasource-engine`, `apps/desktop`, and `services/fs-sync` each landed as a finished island over the last month (changes: `add-fs-datasource-engine`, `add-fs-sync-service`, `add-fs-engine-cancellation`, plus the renderer-side `ui-file-explorer` and `ui-ux-design`). Nothing to date has composed them into a running system.

Current shape:

```
                    ┌─────────────────────────────┐
                    │  @ft5/fs-datasource-engine  │  framework-agnostic lib
                    │   — strategies, factory,    │   ✓ done
                    │     bus, port interfaces    │
                    └────────────┬────────────────┘
                                 │
                   ┌─────────────┴──────────────┐
                   ▼                            ▼
     ┌────────────────────────┐     ┌──────────────────────────┐
     │  apps/desktop main     │     │  services/fs-sync         │
     │  ✓ engine wired        │     │  ✗ main/index.ts exits    │
     │  ✓ datasource IPC      │     │    after opening DB       │
     │  ✓ in-proc upload      │     │  ✓ all parts exist:       │
     │  ✗ no sync client      │     │    scheduler, ipc server, │
     │  ✗ no supervisor       │     │    commands, executors,   │
     │                        │     │    recovery, retry, etc.  │
     └────────────────────────┘     └──────────────────────────┘
```

The reader is a dev who's just read the proposal. The change must:

1. Complete the service's own bootstrap so it becomes a running daemon.
2. Build the desktop side of the pipe: transport client, supervisor, IPC proxy handlers, preload, renderer reflection.
3. Retire the in-process upload path entirely. "Any upload the user triggers via the desktop UI SHALL go through the service" is the invariant.
4. Retire desktop-local credential storage. Credentials live on the service side only. The engine port (`CredentialStore`) is unchanged; the engine's framework-agnostic charter is preserved.

## Goals / Non-Goals

**Goals**

- A user can launch the desktop app, add a datasource, upload a file, close the window, and have the upload finish in the background.
- A user who closes the app during a mirror-sync and re-opens the app sees the sync in progress on the datasource card (status = syncing, subsequent `sync-completed` event applied).
- A user who re-opens the app mid-upload sees the in-flight upload with its current progress bar.
- Fresh installs and in-repo dev both work. `pnpm dev` boots all three processes in one terminal.
- Zero Electron imports in the service; zero desktop-path imports in the service; engine stays framework-agnostic.

**Non-Goals (explicit)**

- Auto-sync commands (`sync:enable-auto` / `sync:disable-auto`) and the `fs-monitor` service. The `MonitorEventSource` port stays bound to `NoopMonitorEventSource`.
- The retry-after-backoff loop inside `Scheduler.applyOutcome` (the README-flagged gap). We wire through whatever the existing scheduler emits; the rate-limit path stays half-wired.
- Resumable uploads. Network retries continue to restart from byte 0.
- Installer end-to-end matrix. The installer registration path already exists; we are not extending its CI coverage.
- OS keyring migration for credentials. Plaintext `credentials.json` with `0600` / user-ACL stays.
- Any UI redesign. We surface existing service state on existing cards using existing components; we do not rethink the dashboard.

## Decisions

### Decision 1 — Credential ownership: service-exclusive (Option B)

**What.** The service's `ConfigFileCredentialStore` is the only concrete `CredentialStore` implementation in the repo. Desktop's `SqliteCredentialStore` is deleted along with its migration.

**Why.** The user confirmed this over two other options:

- *Option A* (move storage into the engine package) breaks `openspec/project.md`'s non-negotiable rule that `packages/fs-datasource-engine/` is framework-agnostic, and regresses desktop from safeStorage-encrypted storage to plaintext.
- *Option C* (keep both, sync across) is the most work and solves the least.

Option B is the only one consistent with *all* the user's locked decisions — uploads-via-service, Option-3 supervisor, service-outlives-app. With the service owning credentials, the duality the engine port was designed around ("multiple host processes implementing the same port") collapses to a single host: the service. The port interface stays as future-proofing for a non-Electron CLI or web host; in this change, it has exactly one implementor.

**How it lands.** The renderer's auth flow changes from "main calls `engine.authenticate` → writes to `SqliteCredentialStore`" to "main sends `sync:authenticate` → service runs `engine.authenticate` with its own `ConfigFileCredentialStore`." No app code other than the service touches `credentials.json`.

### Decision 2 — Supervisor model: connect-or-spawn-detached (Option 3)

**What.** On desktop startup, `startSupervisor()`:

1. Attempt `net.connect(pipePath)`. If it succeeds, hand the socket to the sync client. Done.
2. If the connect rejects with `ENOENT`/`ECONNREFUSED`, spawn the service as a *detached* child process (`child_process.spawn(…, { detached: true, stdio: 'ignore' })` followed by `unref()`).
3. Retry-connect with small backoff (25ms, 50ms, 100ms, 200ms, up to ~1s total) to allow the service to bind its listener. If all retries fail, surface a fatal error to the renderer ("sync service failed to start").
4. A race where two desktop processes spawn simultaneously is handled by the service's existing PID guard: the loser exits with code 3, the winner is already listening, and our retry-connect finds it.

**Why.** Option 3 is the only one compatible with "service outlives the app." Option 1 (installer-only) breaks dev ergonomics; Option 2 (child-process lifetime tied to desktop) breaks the "if app closes, sync continues" invariant by design. Option 3 piggybacks on the PID guard the `add-fs-sync-service` change already ships.

**What the supervisor does NOT do.** It does **NOT** kill the service on desktop quit. It does not maintain a reference to the spawned process (the detach + `unref` intentionally severs the handle). It does **NOT** forward stdio. The service writes to its own rotating `service.log` under `$HOME/ft5/sync_app/`.

**Path resolution.** In packaged builds, the service binary lives under `app.getAppPath()/resources/fs-sync/index.js` (electron-builder `extraResources` entry). In dev, it lives at `<repo>/services/fs-sync/dist/main/index.js`. Both are invoked via the bundled Node binary (`process.execPath` for Electron, but for the *service* we want a plain Node, NOT Electron's Node — so we locate the packaged Node in prod, and fall back to the dev host's Node in dev. Exact strategy: document in tasks; spike if ambiguous.)

### Decision 3 — Upload rerouting is a REPLACE, not an ADD

**What.** Delete `apps/desktop/src/main/ipc/datasources/upload.ts` (the handler that calls `engine.uploadFile` in-process) along with its progress-forwarding. Rewrite the renderer-facing `window.api.datasources.upload` so it still shows the main-process file picker but then enqueues a job on the service and relays `job-progress` events back.

**Why.** If we added the sync path alongside the existing path, we'd ship two codepaths that do the same thing with different behaviour on app quit. The whole point of this change is "uploads survive the window closing"; you cannot preserve that invariant if the direct path still exists.

**Shape of the replacement.**

```
renderer                  main (IPC handler)                  sync service
---------                 ---------------------                -----------
api.datasources           datasources:upload handler           sync:enqueue-upload
  .upload({ dsId })  ──▶  1. dialog.showOpenDialog        ──▶  returns { jobId }
                          2. syncClient.enqueueUpload(...)
                          3. return { transactionId: jobId }

api.datasources           event-bridge forwards the            emits job-progress
  .onUploadProgress  ◀──  service's job-progress events   ◀──  (throttled as before)
  ({ transactionId })     matching the transactionId
```

**Preserving the existing contract.** `DATASOURCES_CHANNELS.upload` and `DATASOURCES_CHANNELS.uploadProgress` stay in the contract, so the renderer's existing call sites compile without edits. Only the *handler* changes. (Rationale: datasources-ui's "upload quick action" requirement explicitly calls `window.api.datasources.upload`; the renderer doesn't need to know that the work moved to the service.)

**Progress-event translation.** The service emits `job-progress { jobId, sentBytes, totalBytes }`. The desktop IPC proxy maps `jobId → transactionId` and emits `DatasourcesUploadProgressEvent { transactionId, sentBytes, totalBytes, percent }` — the same shape the current renderer subscribes to. No renderer change needed.

### Decision 4 — Two distinct IPC contracts

**What.** The service's on-the-wire contract lives at `@ft5/ipc-contracts/sync-service` (already complete; frames, commands, events). We add a new `@ft5/ipc-contracts/sync-service-desktop` module containing the *renderer-facing* `window.api.sync.*` request/response types. The two contracts are related but distinct: the renderer contract is synchronous request/response over Electron IPC; the service contract is bidirectional frames over a pipe.

**Why.** Renderer call sites should not import types from a module that references `net.Socket` or a pipe path. Clear separation also means the renderer surface can diverge from the service wire format over time (e.g., adding optimistic UI shapes, renderer-side retry state) without forcing a service protocol bump.

**Translation rules.** The IPC proxy in main is responsible for mapping one to the other. Most calls are shape-preserving: `window.api.sync.listJobs(filter) → sync:list-jobs { filter }`. A few are enriched on the way back: `listJobs` responses gain a `derivedSyncingDatasourceIds: string[]` convenience field computed in main, so the renderer doesn't re-group jobs by datasource.

### Decision 5 — App-open reconciliation

**What.** Immediately after the sync-client connects (supervisor step "done"), main fires `sync:list-jobs { statuses: ['queued','running','waiting-network'] }` AND `sync:subscribe-events` on the same socket. The list-jobs response seeds the renderer's in-memory state; the event stream delivers subsequent deltas.

**Flow.**

```
t=0    supervisor connects/spawns
t=0    main: sync:subscribe-events (before list-jobs, to avoid gap)
t=0    main: sync:list-jobs { statuses: [running, queued, waiting-network] }
t+x    main receives list-jobs response. Renderer emits
         datasources:event (kind=sync-state-seed) with the in-progress set
t+y    any event that arrived in (t, t+x) is queued server-side via
         subscribe-events — there is no gap, because subscribe went out first
```

**Why subscribe first.** `sync:subscribe-events` is a single round-trip command whose effect is "from *now* forward, send me every event on this connection." Issuing it before list-jobs gives us a zero-gap seed: by the time list-jobs returns, any job whose state changed since the list query is represented on the event stream. Swapping the order introduces a race window between "snapshot taken" and "subscription armed."

**What the renderer does with it.** `DatasourceCard` already has a `status: 'idle' | 'syncing' | ...` field driven by datasource events. We add a derivation: `card.status === 'syncing'` if the card's `datasourceId` appears in any active-sync-job set from the seed or any subsequent `job-started / sync-completed / job-failed` stream. For uploads, we surface a per-card progress bar when there's at least one active upload job on that datasource.

### Decision 6 — Dev loop: single `pnpm dev` via pnpm parallel

**What.** Root `package.json` gains `"dev": "pnpm -r --parallel --filter=./apps/desktop --filter=./services/fs-sync run dev"` (or an equivalent orchestrator; the exact tool is a mechanical choice). The desktop's `dev` script stays as-is (`electron-vite dev` or whatever it currently does). The service's `dev` script becomes `node --enable-source-maps --watch dist/main/index.js --dev` (already defined). Dev mode uses the dev pipe (`\\.\pipe\ft5-sync-dev` / `sync-dev.sock`) and `$HOME/ft5/sync_app/dev/`.

**Why.** The user asked for a single command. pnpm's built-in parallel runner is already in the toolchain; adding `concurrently` would violate the CLAUDE.md rule about new dependencies without justification.

**Coordinated shutdown.** Ctrl-C on the parent pnpm terminal propagates SIGINT to both children. The service's existing SIGINT handler (already in `single-instance/pid-guard`) cleans up the PID file and pipe. Desktop's Electron process handles SIGINT via `app.quit`.

**Dev-mode supervisor hook.** The supervisor detects `--dev` mode via `process.env.NODE_ENV === 'development'` (or an Electron-specific check) and uses the dev pipe. In dev, we do **not** spawn the service from desktop — pnpm already started it. If `connect(devPipe)` fails, we show a clear error ("run `pnpm dev` to start the sync service") and exit rather than spawning a detached dev service, which would confuse the pnpm supervisor tree.

### Decision 7 — Sync-client resilience

**What.** The sync client handles exactly three non-happy-path conditions:

1. **Disconnect while alive** (service crashed or was restarted). Reconnect with the same list-jobs-then-subscribe handshake; in-flight requests receive a synthetic `service-disconnected` error and any upload-progress subscriptions the renderer holds are told the transaction's fate is unknown (emit one final progress event with `status: 'disconnected'` or similar).
2. **Request timeout** (service is up but not responding). Default 30s per request. On timeout, emit an internal error; the caller sees a failed promise.
3. **Malformed frame from server.** Log at error, drop the frame, do not dispatch to subscribers. This is treated as a programming error, not a user-visible one.

**What we're deliberately not doing.** We do not implement an offline queue — calls made while disconnected reject immediately. We do not implement renderer-side optimistic updates; the event stream is the source of truth.

### Decision 8 — Events bridged, not duplicated

**What.** Desktop main keeps the existing `createEventBridge(getEngine().bus)` call — the engine's in-process event bus is still useful for *non-upload* events emitted by direct main-process operations (auth intent completions from `window.api.datasources.action`, quota changes, etc.). The new sync-client event stream is a *second* source feeding the same `datasources:event` renderer channel.

**Merge rule.** Events from both sources fan out to the same renderer channel. The renderer doesn't need to know the origin. Overlap (e.g., `authenticated` event could be emitted by both when a renderer-initiated auth flow completes) is tolerable as long as the duplicate carries the same payload, which it does because both paths run `engine.authenticate` (desktop via in-proc engine, service via its own engine instance). In practice, we route *authentication* through the service too (Decision 1), so the overlap is narrow and not a real duplication.

### Decision 9 — Stale docs cleanup

**What.** `packages/fs-datasource-engine/src/index.ts:52-53` comments claim "three placeholder strategy stubs" that the strategies have long since replaced. Rewrite the comment block to describe the current state (three real strategies, each with contract tests). This is mechanical and carried in this change so it doesn't rot further.

### Decision 10 — Authenticate flow: two-step with server-side correlation

**Context.** The merged `add-fs-sync-service` wire contract defines a single-shot `sync:authenticate` command whose params include an `AuthIntent` — a discriminated union with *function fields* (`OAuthIntent.completeWith(code)`, `CredentialsFormIntent.submit(values)`). The contract was never exercised end-to-end: `services/fs-sync/` has no handler for `sync:authenticate` (only logger redaction at `services/fs-sync/src/observability/logger.ts:134`). Section 5 of this change discovered the flaw while wiring the desktop-side proxy: closures cannot cross a newline-delimited-JSON socket, and even if they could, the same problem recurs at the Electron preload boundary (structured-clone IPC silently drops function properties). The section-5 reviewer correctly flagged this as blocking the preload surface (section 6).

**What.** Split the authenticate wire command into two, bound by a server-side correlation id:

1. **`sync:authenticate-start`** — desktop requests an intent.
   - Params: `{ datasourceId: string; type: DatasourceType }`
   - Result: `{ correlationId: string; intent: SerializableAuthIntent }`
   - `SerializableAuthIntent` is a pure-data view of `AuthIntent` with the closures removed:
     - `{ kind: 'oauth'; authorizeUrl: string }`
     - `{ kind: 'credentials-form'; schema: CredentialsSchema }`
   - Service-side: run `engine.authenticate(datasourceId)` to get the live `AuthIntent`, store it in an in-memory map keyed by a freshly-minted correlation id, return the serialized descriptor. No disk state; on service restart all correlations are discarded.

2. **`sync:authenticate-complete`** — desktop posts the user's response.
   - Params: `{ correlationId: string; completion: SerializableAuthCompletion }`
   - `SerializableAuthCompletion` is a discriminated union:
     - `{ kind: 'oauth'; code: string }`
     - `{ kind: 'credentials-form'; values: Record<string, unknown> }`
   - Result: `{ authResult: AuthResult }`
   - Errors: `correlation-expired`, `correlation-kind-mismatch` (desktop sent a form completion for an oauth correlation), plus inherited `validation-error` and `authentication-failed`.
   - Service-side: look up the stashed `AuthIntent` by correlation id, dispatch on its kind, invoke `completeWith(code)` or `submit(values)` accordingly, remove the entry from the map whether the call succeeds or fails.

**Correlation store design.**
- `Map<string, { intent: AuthIntent; createdAt: number }>` scoped to the service process.
- Correlation ids are `crypto.randomUUID()`; short enough to log, unguessable enough that a rogue local actor can't forge them without having observed a legitimate `authenticate-start` response.
- TTL: **5 minutes**. Chosen to cover a realistic OAuth redirect round-trip (user opens provider, signs in, redirects back) without keeping stale intents around. A setTimeout per entry self-removes on expiry; `authenticate-complete` checks freshness defensively in case the timer is late under event-loop pressure.
- On service SIGINT/SIGTERM: the map evaporates with the process. Desktops holding a pending correlation id surface `correlation-expired` on the next complete call.
- Redaction: `services/fs-sync/src/observability/logger.ts` redacts both `sync:authenticate-start` (may contain datasourceId, benign but consistent) and `sync:authenticate-complete` (contains OAuth codes or form values — MUST redact) as `[redacted]`. Result redaction applies to `authenticate-complete` (carries `AuthResult.accessToken`).

**Renderer-facing surface.** The renderer never sees a closure. `window.api.sync.authenticateStart({ datasourceId, type })` returns `{ correlationId, intent }`; the renderer shows the OAuth URL or form based on `intent.kind`, collects the code or values, then calls `window.api.sync.authenticateComplete({ correlationId, completion })`. The correlation id is opaque to the renderer — it's a cursor.

**Impact on section 5.** The section-5 single-shot `authenticate` handler (`apps/desktop/src/main/ipc/sync/authenticate.ts`, commits `708e449` + `9ee5c1a`) becomes obsolete. Task 5.11/5.12 are superseded by new tasks 5.16/5.17. The old handler, its tests, and its registration line in `ipc/index.ts` are deleted in the same commit that introduces the replacement pair, so the suite never sees both shapes coexist. `SyncClient.authenticate` also splits into `authenticateStart` + `authenticateComplete` wrappers.

**Why not stash the closure in a renderer-side registry.** One of the alternatives considered: keep a single command, ship an opaque `intentId` to the renderer, have the renderer call back through the preload with `{ intentId, code }`, main-process dispatcher looks up a RENDERER-keyed closure. Rejected because the closure lives on the *service* side, not the main-process side — a main-side registry would still need a correlation with a service-side lookup, adding a second hop with no gain. The correlation store must live where the engine's `authenticate()` returned the closure: in the service process. Once that's given, the two-command shape falls out naturally.

**Why not keep the old contract and make the service-side handler re-derive the closures from the incoming serialized data.** Rejected because the engine's `authenticate()` is the only authoritative producer of intents — its internal state (e.g., a half-configured OAuth client, a datasource-specific signing key) is captured in the closure. Trying to recreate that closure from a wire-serializable descriptor would require duplicating a significant fraction of the engine on both sides of the wire.

**Service-side implementation is deferred to a follow-up change (Decision 11).** Wiring a real `engine.authenticate()` end-to-end proved to require more than "IPC contract + correlation store". Decision 11 records what was discovered and why the service-side handlers ship as stubs.

### Decision 11 — Service-side authenticate implementation: deferred to `implement-datasource-onboarding`

**Discovery during 5.A prep.** Drafting the service-side `authenticate-start` handler surfaced two architecture gaps not anticipated by the original proposal:

1. **No-creds client construction.** `ClientFactory.create(...)` requires a full `StoredCredentials`. Each strategy's factory calls `readCredsFromStored(...)` which throws on empty fields. You can't build a client with no creds to call `authenticate()` on.
2. **OAuth app config at `doAuthenticateImpl` time.** `googledrive-client.ts:636` and `onedrive-client.ts:466` read `this.creds.{clientId, redirectUri, tenantId, clientSecret}` when building `authorizeUrl` and when the `completeWith(code)` closure exchanges the code for tokens. OAuth *app* config (clientId, clientSecret, redirectUri) is different from OAuth *user* tokens — it exists before first-time auth, yet the engine sources it from `StoredCredentials.authResult.meta`. There is no service-level config file, no env-var source, no "add datasource" UI in the codebase that collects this data.

Fixing either gap properly requires touching the engine and adding a config sourcing story (env file, service-level key-value store, or a UI-collected intake flow). That is a standalone feature, not a wiring detail.

**What we ship in this change.** The `sync:authenticate-start` and `sync:authenticate-complete` handlers on the service return `{ ok: false, error: { tag: "not-implemented", message: "authenticate flow pending follow-up change" } }`. The correlation store (section 5.A.5/5.A.6) stands as built but goes unused by the stub handlers — it is dormant infrastructure, ready for the real handlers. The wire contract split, the `SyncClient.authenticateStart/authenticateComplete` wrappers, the desktop IPC handlers, and the preload surface in section 6 all ship with the final shape; they simply propagate a `not-implemented` error until the follow-up change lands.

**What we do NOT ship.** No engine changes to `factory.ts` or the three strategies. No OAuth-app-config sourcing mechanism. No "add datasource" UI.

**Follow-up change.** A future OpenSpec change (working name `implement-datasource-onboarding`) will cover:

1. Engine adjustment — likely the `createForAuth` path from the rejected option 2a here, with a pre-auth StoredCredentials shape that includes OAuth app config in `meta` but empty tokens.
2. A service-level config source for OAuth app config (candidates: a config file alongside `credentials.json`, or a new `sync:register-provider` command that stores per-provider OAuth app config in the service DB).
3. Service-side `authenticate-start` / `authenticate-complete` real handlers that use the correlation store.
4. Renderer "add datasource" UI that collects OAuth app config for OAuth providers and credentials-form fields for non-OAuth.
5. Remove the `not-implemented` error tag from the command error unions.

**Why this split works.** No existing caller invokes `authenticate` today — zero references to `client.authenticate()` in the renderer, preload, main, or service. The stubbed handlers are behaviorally identical to any real handler from the user's perspective: there is no user-facing path that exercises them. Once the onboarding UI exists, it will call the already-shipped `window.api.sync.authenticateStart/...Complete`; only the service handlers change from stub to real.

**Contract impact of the stub.** The `authenticate-start` and `authenticate-complete` command error unions both gain a `{ tag: "not-implemented"; message: string }` variant. The follow-up change removes that variant when the real implementation ships; consumers should handle it defensively as "the service does not yet support this operation" rather than as a domain error.

### Decision 12 — Supervisor lifecycle: reconnect policy + handle shape

**Context.** The supervisor shipped in section 4 resolves once with a `SyncClient` and has no reconnect machinery. Section 7's event-bridge needs to survive service crashes / restarts: on disconnect it must surface a `service-disconnected` event to the renderer, then reconnect, re-issue the subscribe+list-jobs handshake, and emit a `service-reconnected` event plus a fresh `sync-state-seed`. That requires a supervisor that is *alive* for the lifetime of the desktop app, not one-shot.

**What.** `startSupervisor(...)` changes its return shape from `Promise<SyncClient>` to `Promise<SupervisorHandle>`:

```ts
interface SupervisorHandle {
  /** The current connected client. Mutates across reconnects. */
  getClient(): SyncClient;
  /** Subscribe to reconnect events. `cb` receives the fresh client. */
  on(event: "reconnect", cb: (newClient: SyncClient) => void): () => void;
  /** Subscribe to disconnect events. `cb` receives no payload — detach-only signal. */
  on(event: "disconnect", cb: () => void): () => void;
  /** Stop reconnecting; detach from underlying client. Idempotent. */
  dispose(): void;
}
```

The handle wraps the existing per-connect logic in a loop driven by the underlying `SyncClient.on("disconnect", ...)` event. Callers that previously wrote `const client = await startSupervisor(...)` now write:

```ts
const handle = await startSupervisor(...);
setSyncClient(handle.getClient());
handle.on("reconnect", (c) => setSyncClient(c));
```

This is a breaking change for the ~5 call sites in `main/index.ts` and the four `supervisor.*.test.ts` files. Authorized in section 7's scope; no other callers exist.

**Why `(newClient) => void` and not `() => void`.** Pushing the client as the payload eliminates a whole bug class ("forgot to call `handle.getClient()` after the reconnect fired"). Two consumers care about reconnect today — the sync-client-holder and the event-bridge — and both want the new client in hand at callback time.

**Reconnect schedule.** On disconnect, retry `net.connect(pipePath)` on the same schedule as the initial spawn — `25/50/100/200/400ms` — then if still failing, switch to geometric backoff capped at **30 seconds** and retry **indefinitely**. Rationale: the service may restart at any point (OS reboot, upgrade, crash), and the renderer already surfaces a "disconnected" state via `service-disconnected` events, so there is no user benefit to giving up. The cap at 30s prevents runaway backoff.

In dev mode (service owned by pnpm), reconnect uses the SAME schedule — if the operator kills `pnpm dev` and restarts it, the supervisor reconnects automatically. We do NOT re-spawn the service in dev (same rule as initial connect).

**In-flight request handling across disconnect.** Inherited from the existing `SyncClient.handleDisconnect` (commits 3.5/3.6): all in-flight `request()` promises reject with `SyncDisconnectedError`, and new requests issued between disconnect and reconnect also reject synchronously. This is NOT new behavior; section 7 relies on it, and the `supervisor.reconnect.test.ts` test asserts the rejection happens but does not implement it.

**What the handle does NOT do.** The handle is a client-lifecycle manager, not a request router. It does not queue requests made during disconnect (design Decision 7 explicitly rules out an offline queue), does not retry failed requests, and does not proxy the `SyncClient` API. Callers read `handle.getClient()` at the site they need it — section 5's IPC handlers already do this via `sync-client-holder` — and live with the "rejected if disconnected" contract.

**Sync-client-holder contract under reconnect.** Section 5's IPC handlers call `getSyncClient()` at handler-invocation time (not at registration). A `setSyncClient(newClient)` call from the main-process reconnect subscriber therefore transparently swaps the client seen by subsequent handler calls. Section 7 must include a test that proves this — a handler registered at t=0, invoked at t=1 (pre-disconnect), invoked again at t=3 (post-reconnect) must see two different `SyncClient` instances.

### Decision 13 — Renderer card sync-state derivation

**Context.** Section 10 wires the datasource card to live job state from the service. The card already exposes a `summary.status` from `DatasourcesProvider` (engine-bus driven, `connected | syncing | paused | error`) and now needs to compose this with the sync-event stream from `window.api.sync.onEvent` (sync-state-seed + per-job lifecycle events). The task list says "union of engine-event state and sync-event state" without pinning precedence; subagents will diverge unless this is fixed in writing.

**What — store shape.** A new slice on the existing `DatasourcesProvider` reducer (no new context, no new state library — Decision 5 of the archived `ui-ux-design`):

```ts
interface JobsByDatasourceSlice {
  // datasourceId → list of in-flight jobs (running | queued | waiting-network)
  jobsByDatasource: Map<string, JobSummary[]>;
  // jobId → latest progress tick (for upload-kind jobs only)
  uploadProgressByJob: Map<string, { bytesUploaded: number; bytesTotal: number }>;
}
```

`jobsByDatasource` is fed by `window.api.sync.onEvent`:
- `sync-state-seed` → replace map with `groupBy(payload.jobs, j => j.datasourceId)`.
- `job-enqueued` / `job-started` / `job-progress` (status changes) → upsert into the datasource's bucket.
- `job-completed` / `job-failed` / `job-cancelled` → remove from the bucket. Bucket goes empty → delete the key.

`uploadProgressByJob` is fed by the **same `window.api.sync.onEvent` subscription** that drives `jobsByDatasource` — specifically, by `job-progress` events whose `jobId` belongs to a `kind === "upload"` job (looked up via `jobsByDatasource`). The wire payload's `bytesSent` / `totalBytes` map directly to `bytesUploaded` / `bytesTotal`. Single subscription source keeps the store coherent: the `jobsByDatasource` membership and the per-job byte tick come from the same stream, in the same order. On terminal job events (completed/failed/cancelled) the corresponding entry is also evicted to bound memory.

The legacy `DATASOURCES_CHANNELS.uploadProgress` channel (translated by the section-7 sync event-bridge) remains in place for `window.api.datasources.onUploadProgress` callers — section 10 does NOT consume it. This is intentional: the section-7 bridge translates one source of truth (the service's `job-progress`) into two renderer-visible surfaces, and section 10's new bar consumes the upstream surface to keep store-state and progress-state derived from a single `useEffect` subscription.

**What — display-state precedence.** Card status display is computed per-render:

```
displayStatus(summary, jobs) =
  if jobs.some(j => j.kind === "sync" && j.status === "running")     → "syncing"
  else if jobs.some(j => j.kind === "sync" && j.status === "waiting-network") → "waiting-network"
  else if jobs.some(j => j.kind === "sync" && j.status === "queued") → "syncing" (queued is visually identical)
  else summary.status   // engine-bus fallback
```

The sync-event state **wins** when it has any in-flight sync-kind job for that datasource; the engine-bus `summary.status` is the fallback for the steady states (`connected`, `paused`, `error`). Rationale: per Decision 5, sync-event state is what seeds on startup and represents the authoritative cross-process truth; the engine-bus `summary.status` is the legacy in-process signal that does not survive restarts. Upload-kind jobs do NOT change the card's status badge — they show as a separate progress bar (see below).

**What — progress bar visibility.** The Progress bar (10.3/10.4) renders if and only if `jobsByDatasource[id]` contains at least one `kind === "upload"` job whose status is `running | queued | waiting-network`. Bar value is computed from `uploadProgressByJob[activeUploadJobId]`: if `bytesTotal > 0` then `Math.round(bytesUploaded / bytesTotal * 100)`, else `0` (indeterminate state — bar renders at 0% until the first sized tick). Active job tiebreak rule (10.6): `startedAt desc`, then `jobId` lex desc. The bar unmounts naturally when the job is removed from `jobsByDatasource` (no explicit unmount logic needed; React reconciliation does it).

**Why the bar's terminal frame doesn't need a `status: "completed"` from the bridge.** The progress bar is conditionally rendered on the presence of an upload-kind job in `jobsByDatasource`. When `job-completed` arrives via the SyncEvent stream, the renderer removes the job from the map → the bar's `if (uploadJobs.length > 0)` guard becomes false → React unmounts. The `DATASOURCES_CHANNELS.uploadProgress` channel does NOT need to emit terminal `status` frames; the section-7 review's M-8A note (which proposed adding terminal frames) is therefore a no-op for section 10. M-8A stays a follow-up only if a future feature wants progress tracking *without* maintaining the jobs map (none today).

**Visual variant — waiting-network.** Section 10.7 needs a distinguishing visual when a job's status is `waiting-network`. Adopting the established status-colour language from the archived `ui-ux-design` Visual direction (`amber=syncing`, `zinc=paused`, `green=connected`, `red=error`), waiting-network maps to: **status pill stays the syncing variant** (default badge with the SyncingDot) but swaps the dot's `currentColor` from amber to **zinc** AND adds a small lucide `wifi-off` icon left of the status text. Rationale: zinc reads as "paused-but-recoverable" without claiming a new colour token; the icon makes the cause legible at a glance without a tooltip. Accessible name updates to `Status: waiting for network`. ARIA-live polite region announces the transition. Reduce-motion: SyncingDot's existing `animate-sync-pulse` / `animate-sync-ripple` continue per the OS / Motion-Safe rule (the ripple is a "still working in the background" cue even when the network is gone — appropriate signal that the job is alive).

**What is NOT in scope.** Per-job error-detail surfacing (10.7's `errorReason` already covers steady-state failure). Multi-datasource progress aggregation. Manual cancel-from-card (Decision 7 explicitly defers user cancel to a later UI change). All deferred follow-ups.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Spawning a detached Node process from Electron is platform-fiddly (execpath resolution, PATH issues on Windows). | Tasks include an early spike to verify the path-resolution strategy on all three OSes. Dev mode avoids the problem entirely by relying on pnpm to start the service. |
| Deleting `SqliteCredentialStore` + its migration regresses prior-installed users (their encrypted credentials are in `datasource_credentials`; service has no way to read them). | This is a one-way migration. Because no real users have shipped-software installs yet (pre-release monorepo), we accept data loss: existing dev databases lose their stored datasource credentials, and the user re-authenticates. Document explicitly in tasks + release notes when this ships. |
| Renderer's existing `onUploadProgress` listeners assume a specific event shape. | The IPC proxy translates `job-progress` → `DatasourcesUploadProgressEvent` with the existing shape — no renderer edit needed. Contract tests cover the mapping. |
| The service's bootstrap composition order (recovery → scheduler → ipc-server) has data-race implications if IPC accepts connections before recovery finishes. | The existing `fs-sync-service` spec already requires "BEFORE the IPC listener is opened to new clients" for recovery; we preserve that ordering in `main/index.ts`. |
| Single-`pnpm dev` turning off the service when desktop exits in dev is *desirable* (clean dev loop), but the same reflex in production would break the invariant. | The supervisor deliberately differs by mode: dev connects only (does not spawn); prod spawns detached and never kills. The modes are chosen by `--dev` / NODE_ENV. Test both paths. |
| Race at startup: desktop launches, service is starting but not listening; connect fails, desktop spawns a second service; second service exits code 3 when it hits the PID guard; desktop's retry-connect finds the first service. Expected flow, but easy to break if retry budget is wrong. | Lock retry budget to ~1s total across ~5 attempts with geometric backoff. Cover with an integration test that starts a slow-binding fake service. |
| Dual engine-bus and sync-stream delivery of `authenticated` events could cause renderer state flicker. | Authentication flows are routed through the service (Decision 1), so the engine bus in main won't emit duplicate `authenticated` events for datasource credentials. Only non-credential engine events (e.g., `status-changed`) flow through the bus. |
| `@ft5/ipc-contracts` grows. | Two clearly-named sub-paths (`sync-service` for the wire, `sync-service-desktop` for the renderer) keep import sites unambiguous. |

## Migration Plan

This change does not need a runtime migration strategy per se — it's a code-path swap, not a data swap. But it does need a **deployment ordering guarantee** for in-repo developers:

1. Branch lands with `SqliteCredentialStore` + `0001_datasource_credentials` migration **deleted**.
2. Any dev with an existing `ft5.db` under Electron's userData path will find that migration gone on next start. Drizzle's migration runner is forward-only; a missing migration file means the dev's DB shows a migration we don't know about. We need to either:
   - (a) Leave the migration file in place but delete the store & its callers. The table becomes unused but harmless. Slightly dishonest.
   - (b) Add a forward migration that drops the `datasource_credentials` table. Adds a line to the migration runner, deletes the table on next boot. Clean.

   Pick (b). It's ~5 lines of SQL and preserves the principle that the schema accurately reflects what's used.

3. Users of the pre-release codebase must re-authenticate every datasource after the update, because credentials have moved from `SqliteCredentialStore` (Electron-encrypted) to `ConfigFileCredentialStore` (service-side plaintext). Documented in release notes.

**Rollback.** If this change is reverted, the DROP TABLE migration stays applied (non-reversible in our forward-only runner). A rollback would need a new migration that re-creates the table empty. Acceptable risk: rollback is not a supported workflow for in-monorepo changes.

## Open Questions

None blocking implementation. Two items to verify during `/opsx:apply`:

- **Service execpath in packaged builds.** Do we ship a Node binary alongside the service, or do we run the service in Electron's Node? The service's charter forbids `electron` imports, but running under Electron's Node *binary* is not the same as importing Electron. Prefer a standalone Node binary via electron-builder's `extraResources`; fall back to Electron's bundled Node if binary size is a concern. Spike during task A2.
- **Exact IPC channel names for the renderer-facing sync surface.** The existing `DATASOURCES_CHANNELS` pattern is `datasources:list`, `datasources:add`, etc. Mirror it as `sync:list-jobs`, `sync:enqueue-upload`, etc. — same names as the service's wire protocol, but dispatched via Electron IPC. The proxy handler translates one to the other; the name reuse keeps grep-ability high and avoids a second vocabulary.
