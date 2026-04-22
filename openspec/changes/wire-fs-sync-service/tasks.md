## 1. Renderer-facing IPC contracts (`@ft5/ipc-contracts/sync-service-desktop`)

- [x] 1.1 RED: add `packages/ipc-contracts/src/sync-service-desktop/requests.test-d.ts` asserting renderer-facing request / response types for `listJobs`, `getJob`, `enqueueUpload`, `enqueueMirror`, `cancelJob`, `authenticate`, `getStatus`, `getRetryPolicy`, `setRetryPolicy` — each keyed by a discriminant, each with a `Response` shape that carries `{ ok: true, result } | { ok: false, error }` OR a flat result type (pick one style; match the handler-return style used by `DATASOURCES_CHANNELS`); run the typecheck and confirm it fails
- [x] 1.2 GREEN: implement `packages/ipc-contracts/src/sync-service-desktop/requests.ts` with the declared types, re-exporting from an `index.ts`; wire the new subpath export into `packages/ipc-contracts/package.json` `"exports"`
- [x] 1.3 RED: `packages/ipc-contracts/src/sync-service-desktop/events.test-d.ts` — the renderer-observable `SyncEvent` union includes `sync-state-seed`, all nine service lifecycle events (`job-enqueued`, `job-started`, `job-progress`, `job-completed`, `job-failed`, `job-cancelled`, `job-recovered`, `sync-completed`, `source-unavailable`, `network-available`), and `service-disconnected` / `service-reconnected` synthetic events emitted by the desktop supervisor
- [x] 1.4 GREEN: implement `sync-service-desktop/events.ts`; re-use payload shapes from `@ft5/ipc-contracts/sync-service` via `export type { ... } from` so event payload definitions are NOT duplicated
- [x] 1.5 RED: `packages/ipc-contracts/src/sync-service-desktop/channels.test-d.ts` — declare `SYNC_CHANNELS = { listJobs, getJob, enqueueUpload, enqueueMirror, cancelJob, authenticate, getStatus, getRetryPolicy, setRetryPolicy, event } as const`; assert each value is a stable string literal (e.g., `"sync:list-jobs"`)
- [x] 1.6 GREEN: implement `sync-service-desktop/channels.ts`; re-export from the subpath barrel and from the top-level `@ft5/ipc-contracts` index
- [x] 1.7 Build `pnpm --filter @ft5/ipc-contracts build` cold (no Vitest cache); confirm the emitted `.d.ts` includes the new subpath; request code review before proceeding to consuming tasks

## 2. Service bootstrap composition (intra-service wiring — Problem A)

- [x] 2.1 RED: `services/fs-sync/src/main/bootstrap.test.ts` — boot against an in-memory data dir and assert the call order: `openDatabase → applyMigrations → integrity OK → acquirePidGuard → construct credential store → construct provider registry → construct client factory → construct scheduler → construct network probe → recoverRunningJobs → ipcServer.listen`; use spies or a deterministic event log to observe the order
- [x] 2.2 GREEN: refactor `services/fs-sync/src/main/index.ts` into `bootstrap.ts` (composable, returns a `Runtime` handle with `{ stop(): Promise<void> }`) plus a thin `index.ts` that calls `bootstrap()` and installs signal handlers; compose every existing module in the order above
- [ ] 2.3 RED: `services/fs-sync/src/main/signals.test.ts` — send SIGINT to a booted runtime; assert (a) listener stops accepting new connects within 100 ms, (b) an in-flight request still receives its response, (c) PID file is removed, (d) process is ready to exit 0 within 5 s
- [ ] 2.4 GREEN: implement `src/main/signals.ts` wiring SIGINT / SIGTERM to a graceful `Runtime.stop()` with a bounded grace period (default 5 s); ensure the scheduler pauses (existing parts) but allows running jobs to reach their next persisted state before shutdown completes
- [ ] 2.5 RED: `src/main/bootstrap.ipc-bind-failure.test.ts` — seed a PID-guard-holding parent test harness that releases immediately, then force `ipcServer.listen` to reject (e.g., permissions-locked pipe path); assert the runtime exits non-zero (code 5), releases the PID guard, and logs `"ipc-bind-failed"`
- [ ] 2.6 GREEN: wire `ipcServer.listen` failure to a finally-release PID + exit-5 path in `bootstrap.ts`
- [ ] 2.7 Smoke: run the service (`pnpm --filter @ft5/fs-sync-service start --dev`), connect with `nc -U $HOME/ft5/sync_app/dev/sync-dev.sock` (Unix) / a Windows named-pipe test client, send `{"id":"1","kind":"request","command":"sync:get-status","params":{}}\n`, verify a `{"ok":true,...}` response; record the manual steps in a smoke-test doc so CI can port later
- [ ] 2.8 Request code review: service is now a self-sufficient daemon — any critical issue here blocks all downstream tasks

## 3. Sync client (desktop transport)

- [ ] 3.1 RED: `apps/desktop/src/main/sync/framing.test.ts` — parser handles two frames split across chunks, rejects malformed JSON, caps single-frame size (reuse the service-side test cases to prove parity of behavior)
- [ ] 3.2 GREEN: implement `apps/desktop/src/main/sync/framing.ts` (a `Transform`-style codec; may be ported / shared with service's version via a copy or via a new `@ft5/sync-framing` shared module — pick copy for this change, shared-package is a follow-up)
- [ ] 3.3 RED: `apps/desktop/src/main/sync/client.request-response.test.ts` — client sends two requests with ids `a`/`b`, service stub replies in order `b` then `a`; both promises resolve with correct payloads; a third request with a 100 ms timeout rejects with `request-timeout`; a response with an unknown id is dropped silently
- [ ] 3.4 GREEN: implement `apps/desktop/src/main/sync/client.ts` (`class SyncClient`) — takes a connected `net.Socket`, owns the in-flight map, exposes typed methods per `SYNC_CHANNELS`
- [ ] 3.5 RED: `sync/client.disconnect.test.ts` — a disconnected socket rejects all in-flight requests with `service-disconnected`; a new request issued post-disconnect rejects the same way; a malformed event frame is dropped without dispatch
- [ ] 3.6 GREEN: implement the disconnect + cleanup path; emit a synthetic `service-disconnected` event to registered listeners; expose `client.isConnected` and `client.on('disconnect', ...)` hooks for the supervisor
- [ ] 3.7 RED: `sync/client.events.test.ts` — subscribed listeners receive every `Event` frame; unsubscribing stops delivery; multiple listeners coexist
- [ ] 3.8 GREEN: implement `client.onEvent(cb): () => void` with a simple set of callbacks fanned out per event
- [ ] 3.9 Request code review: client transport is the trust boundary between desktop and service; critical issues block supervisor work

## 4. Supervisor (Option 3)

- [ ] 4.1 Spike — `apps/desktop/src/main/sync/node-binary-resolver.spike.md`: document how we resolve the Node binary used to spawn the detached service on Windows, macOS, Linux, in both packaged (electron-builder `extraResources`) and unpacked (dev) modes. Include a 20-line reference implementation. Land the doc; implementation follows.
- [ ] 4.2 RED: `sync/supervisor.prod-connect.test.ts` — given a running fake service on the prod pipe, `startSupervisor({ mode: 'prod' })` resolves with a `SyncClient` without spawning; the test spies on `child_process.spawn` and asserts zero invocations
- [ ] 4.3 GREEN: implement `apps/desktop/src/main/sync/supervisor.ts` with the connect-first path
- [ ] 4.4 RED: `sync/supervisor.prod-spawn.test.ts` — no service running; supervisor spawns `child_process.spawn(nodeBinary, [servicePath], { detached: true, stdio: 'ignore' })`, calls `unref()`, retries connect on 25/50/100/200/400 ms, and resolves with a `SyncClient`; asserting that after resolving, the spawned child's handle has been unref'd (observable via `child.killed === false` + no parent waitpid)
- [ ] 4.5 GREEN: implement the spawn path with geometric backoff; surface a fatal error after 5 failed retry attempts; do NOT track or kill the spawned child during `app.quit`
- [ ] 4.6 RED: `sync/supervisor.dev-no-spawn.test.ts` — mode=dev, pipe unreachable; supervisor does NOT spawn, rejects start with a user-visible error message naming `pnpm dev`; test spies on `child_process.spawn` and asserts zero invocations
- [ ] 4.7 GREEN: add the dev-mode branch to `supervisor.ts`
- [ ] 4.8 RED: `sync/supervisor.race.test.ts` — two supervisors start in parallel against the same pipe, neither finds a service, both spawn; the service's PID guard ensures only one wins; both supervisors resolve with connected clients pointing at the winner
- [ ] 4.9 GREEN: ensure the retry-connect loop tolerates the loser's exit-3 without failing its own resolution
- [ ] 4.10 Wire `startSupervisor()` into `apps/desktop/src/main/index.ts` before `registerIpcHandlers(window)`; hold the resulting `SyncClient` on a module-scoped variable that IPC handlers in section 5 can import
- [ ] 4.11 Request code review: supervisor is the unique piece of new cross-process logic; critical issues require rework before section 5

## 5. Desktop main IPC handlers proxying to the service

- [ ] 5.1 RED: `apps/desktop/src/main/ipc/sync/list-jobs.test.ts` — handler calls `syncClient.listJobs(params)`, returns the result, and computes `derivedSyncingDatasourceIds` as the set of `datasourceId` where any returned job has `kind==='sync' && status ∈ ['running','queued','waiting-network']`
- [ ] 5.2 GREEN: implement `apps/desktop/src/main/ipc/sync/list-jobs.ts` registered against `SYNC_CHANNELS.listJobs`
- [ ] 5.3 RED: `ipc/sync/get-job.test.ts` — identity proxy to `syncClient.getJob`
- [ ] 5.4 GREEN: implement handler
- [ ] 5.5 RED: `ipc/sync/enqueue-upload.test.ts` — identity proxy; input validated against the `sync-service-desktop` request type; errors from the service surface as structured response fields, NOT thrown
- [ ] 5.6 GREEN: implement handler
- [ ] 5.7 RED: `ipc/sync/enqueue-mirror.test.ts` — identity proxy; `sync-already-running` error passes through as structured `{ error: {...} }` response
- [ ] 5.8 GREEN: implement handler
- [ ] 5.9 RED: `ipc/sync/cancel-job.test.ts` — identity proxy; `not-cancelable` error passes through as structured error
- [ ] 5.10 GREEN: implement handler
- [ ] 5.11 RED: `ipc/sync/authenticate.test.ts` — identity proxy; carries OAuth and credentials-form intents through to the service without storing any token on the desktop side
- [ ] 5.12 GREEN: implement handler; verify via grep that no `writeFileSync`, no `credentials.json`, no `encryptString`, no `safeStorage` references appear in the handler module
- [ ] 5.13 RED + GREEN: `ipc/sync/get-status.ts`, `get-retry-policy.ts`, `set-retry-policy.ts` — identity proxies
- [ ] 5.14 Register all handlers in `apps/desktop/src/main/ipc/index.ts` gated on the supervisor's `SyncClient` being available (i.e., handler throws a clear error if invoked before supervisor start)
- [ ] 5.15 Request code review: the IPC proxy surface is the renderer's contract; breaking changes here block renderer work

## 6. Preload `window.api.sync.*`

- [ ] 6.1 RED: `apps/desktop/src/preload/__tests__/sync-surface.test.ts` — given a fake `ipcRenderer`, the preload exposes `window.api.sync` with exactly the method set declared in `SYNC_CHANNELS`, each calling `ipcRenderer.invoke(channel, args)` and returning the typed response
- [ ] 6.2 GREEN: extend `apps/desktop/src/preload/index.ts` with the `sync: { ... }` block; add `onEvent(cb): () => void` wired to the renderer-facing event channel `SYNC_CHANNELS.event`
- [ ] 6.3 RED: `preload/__tests__/sync-surface.import-boundary.test.ts` — grep the preload source for imports from `@ft5/ipc-contracts/sync-service` (the wire subpath); the test fails if any such import exists
- [ ] 6.4 GREEN: confirm the preload imports only from `@ft5/ipc-contracts/sync-service-desktop` + `electron`
- [ ] 6.5 RED: `preload/__tests__/window-api.types.test-d.ts` — extend `apps/desktop/src/preload/window-api.d.ts` with the typed `sync` branch; type assertion that `window.api.sync.listJobs` has the expected return type
- [ ] 6.6 GREEN: update `window-api.d.ts`
- [ ] 6.7 Request code review

## 7. Event relay and app-open reconciliation

- [ ] 7.1 RED: `apps/desktop/src/main/sync/event-bridge.test.ts` — on supervisor start, the main process sends `sync:subscribe-events` followed by `sync:list-jobs` on the same connection, in that order (instrument outgoing frames); the list-jobs response is emitted to every `BrowserWindow` as a `SYNC_CHANNELS.event` payload with shape `{ kind: 'sync-state-seed', jobs }` filtered to `status ∈ ['running','queued','waiting-network']`
- [ ] 7.2 GREEN: implement `apps/desktop/src/main/sync/event-bridge.ts` handling the subscribe-then-list handshake and the seed emission; register the bridge once per supervisor lifetime (singleton)
- [ ] 7.3 RED: `sync/event-bridge.fanout.test.ts` — three `BrowserWindow` instances receive the same event exactly once each; events for an already-closed window are not sent (no crash)
- [ ] 7.4 GREEN: implement per-window registration / deregistration (mirror the existing `createEventBridge` pattern at `apps/desktop/src/main/ipc/datasources/event-bridge.ts`)
- [ ] 7.5 RED: `sync/event-bridge.reconnect.test.ts` — simulate a service disconnect / reconnect; the bridge re-issues subscribe + list-jobs and emits a second `sync-state-seed`; in-flight renderer IPC calls see `service-disconnected` rejections
- [ ] 7.6 GREEN: implement the reconnect loop; expose an `on('reconnect', ...)` hook from the supervisor for the bridge to consume
- [ ] 7.7 RED: `sync/event-bridge.upload-progress-translation.test.ts` — a service `job-progress { kind: 'upload', jobId, sentBytes, totalBytes }` is translated to a `DatasourcesUploadProgressEvent { transactionId: jobId, sentBytes, totalBytes, percent: floor(sent/total*100) }` and emitted on the existing `DATASOURCES_CHANNELS.uploadProgress` channel
- [ ] 7.8 GREEN: implement the translation in the event bridge
- [ ] 7.9 Wire `createSyncEventBridge(syncClient, windowRegistry)` into `apps/desktop/src/main/index.ts` after supervisor start; pair it with the existing engine-bus event bridge (both feed the renderer; see design Decision 8)
- [ ] 7.10 Request code review

## 8. Upload rerouting: replace the in-process path

- [ ] 8.1 RED: `apps/desktop/src/main/ipc/datasources/upload.test.ts` (replacement) — the handler (a) opens a file picker via `dialog.showOpenDialog`, (b) calls `syncClient.enqueueUpload(...)` with the selected path, (c) returns `{ transactionId: jobId }`; the test asserts zero calls to `engine.uploadFile`, zero imports of `@ft5/fs-datasource-engine` in the handler module, and the existing renderer call signature is unchanged
- [ ] 8.2 GREEN: rewrite `apps/desktop/src/main/ipc/datasources/upload.ts` to proxy to the service; delete any previously-present in-process upload code
- [ ] 8.3 RED: `ipc/datasources/upload.existing-renderer-compat.test.ts` — render the existing renderer upload call site against a main-process mock; the `onUploadProgress(transactionId, cb)` subscriber receives translated progress events; no renderer-side edit is required
- [ ] 8.4 GREEN: confirm backward-compat; if any renderer call site needs a tweak to accept the new `transactionId` format, edit the one renderer file, NOT more
- [ ] 8.5 Delete `apps/desktop/src/main/datasources/` in-process upload executor if one exists as a standalone (or confirm it was removed with upload.ts); verify via `pnpm --filter @ft5/desktop build` that the main bundle compiles without dangling imports
- [ ] 8.6 Request code review

## 9. Credential removal (delete desktop-side store + migration drop)

- [ ] 9.1 Delete `apps/desktop/src/main/datasources/sqlite-credential-store.ts` and its test file
- [ ] 9.2 Delete `apps/desktop/src/main/credential-store.test.ts` if it exists (or remove the `SqliteCredentialStore` portions)
- [ ] 9.3 RED: `apps/desktop/src/main/db/migrations.test.ts` (extend) — assert that a DB containing the `datasource_credentials` table drops that table after applying migrations up to `0002_drop_datasource_credentials`; a DB that never had the table is unaffected
- [ ] 9.4 GREEN: add `apps/desktop/src/main/db/migrations/0002_drop_datasource_credentials.ts` with SQL `DROP TABLE IF EXISTS datasource_credentials`; remove the `0001_datasource_credentials` entry from `DEFAULT_MIGRATIONS` only AFTER verifying the migration runner tolerates the absent earlier file (migrations are forward-only and tracked by id — confirm the existing runner's semantics in `openspec/specs/fs-datasource-engine/spec.md` or the migrations module itself)
- [ ] 9.5 Update `apps/desktop/src/main/datasources/engine.ts` (the process-wide singleton factory) to remove the `credentialStore` wiring that constructed `SqliteCredentialStore`; the engine in the desktop main process now operates without a local credential store (uses the engine's `CredentialStore` port only when explicitly passed, which nothing in desktop does post-change)
- [ ] 9.6 Grep `apps/desktop/src/` for `SqliteCredentialStore`, `safeStorage` (except in places unrelated to credentials, e.g., clipboard if any), and `datasource_credentials` — confirm zero matches
- [ ] 9.7 RED: `apps/desktop/src/renderer/__tests__/no-credential-artifacts.test.ts` — grep the renderer source for the symbols listed in the datasources-ui spec (`safeStorage`, `SqliteCredentialStore`, `CredentialStore`, `encryptString`, `decryptString`, `credentials.json`, `datasource_credentials`); zero matches
- [ ] 9.8 GREEN: this is a verification test — if it fails, fix the source, not the test
- [ ] 9.9 Request code review: credential removal is architecturally load-bearing; a critical issue here (e.g., an overlooked credential path) blocks release

## 10. Renderer — datasource card reflects live job state

- [ ] 10.1 RED: `apps/desktop/src/renderer/src/features/datasources/__tests__/card-sync-state.test.tsx` — mount `DatasourceCard` with a prop / store slice representing a seed including `{ kind: 'sync', status: 'running', datasourceId: 'ds-1' }`; assert `status: 'syncing'` pulse animation is present; assert a live `job-completed` event for the same jobId flips the card to idle within one frame
- [ ] 10.2 GREEN: wire a renderer-side store (or extend the existing datasources store) with a `jobsByDatasourceId` map fed by `window.api.sync.onEvent`; compute the card's display state from the union of engine-event state and sync-event state; per design Decision 5, sync-event state is what seeds on startup
- [ ] 10.3 RED: `card-upload-progress.test.tsx` — on `job-started { kind: 'upload', jobId: 'j-1', datasourceId: 'ds-2' }` followed by four `job-progress` events at 25/50/75/100%, the card renders a `<Progress>` at the correct value each tick; on `job-completed`, the bar unmounts within one animation frame
- [ ] 10.4 GREEN: implement the per-card progress bar derived from the jobs store; position below the card header; use the shadcn `progress` primitive already in the repo
- [ ] 10.5 RED: `card-multiple-uploads.test.tsx` — two upload jobs start for the same datasource 1 ms apart; the bar tracks the newer one; when it completes, the bar switches to the older one; when both complete, the bar unmounts
- [ ] 10.6 GREEN: tiebreak by `startedAt` desc then `jobId` lex
- [ ] 10.7 RED: `card-waiting-network.test.tsx` — a job transitions to `waiting-network`; the card's indicator gains a distinguishing visual (icon change OR tooltip change OR small badge) and the change is announced via ARIA (`aria-live`, `aria-label` change, or similar)
- [ ] 10.8 GREEN: implement the waiting-network visual distinction; ensure light and dark themes both contrast AA; ensure reduced-motion honors `prefers-reduced-motion`
- [ ] 10.9 Smoke: start `pnpm dev`, add a real datasource, trigger an upload of a ~50 MB file, observe the card's progress bar fill in real-time; close the app mid-upload, reopen, confirm the bar resumes
- [ ] 10.10 Request code review (include screenshot evidence of sync/waiting/upload states in both themes per CLAUDE.md UI rules)

## 11. Single-`pnpm dev` orchestration

- [ ] 11.1 RED: write a smoke-test bash script `scripts/smoke/dev-orchestration.sh` (or `.ps1`) that: runs `pnpm dev` for 10 s, asserts the dev PID file exists, asserts a `nc -U` (or Windows equivalent) against the dev pipe succeeds with a `get-status` response, then sends SIGINT and asserts both child processes exit within 5 s and the PID file is removed; mark the script as the acceptance criterion for this task
- [ ] 11.2 GREEN: add the root `"dev"` script in the top-level `package.json` using `pnpm -r --parallel --filter ./apps/desktop --filter ./services/fs-sync run dev` (or equivalent); confirm no new dependency is introduced
- [ ] 11.3 Update `apps/desktop`'s `dev` script and `services/fs-sync`'s existing `dev:sync-service` script to match the names invoked by the parallel runner; keep the existing `dev:sync-service` alias callable independently
- [ ] 11.4 Verify the supervisor's dev-mode branch correctly detects `NODE_ENV=development` (or the Electron equivalent) and uses the dev pipe; adjust if the env var plumbing through `pnpm -r --parallel` mangles it
- [ ] 11.5 Smoke: run the smoke script locally on Windows + macOS + Linux (or on the two platforms the team can reach today; document the gap for the third)
- [ ] 11.6 Request code review

## 12. Stale docs cleanup

- [ ] 12.1 Edit `packages/fs-datasource-engine/src/index.ts:52-53` — rewrite the comment block describing the factory to reflect that three real strategies ship (S3: 780 LOC, OneDrive: 1054 LOC, Google Drive: 1334 LOC) with contract tests, and that the factory's integrity validation still applies on any new registration
- [ ] 12.2 Add (if absent) a short paragraph to `services/fs-sync/README.md`'s "Known limitations" noting that the supervisor in desktop is now the canonical startup path; installer registration is still supported (phase-22) but not required for local development
- [ ] 12.3 Grep the repo for any other comments / docs referencing "Phase 5 scaffold", "phase-5 stub", or "placeholder strategy stubs" — fix or remove
- [ ] 12.4 Request code review (may be bundled with section 13 if scope is small)

## 13. Integration verification + release prep

- [ ] 13.1 Run the full test suite at the repo root (`pnpm -w test`) — typecheck, vitest, contract tests; confirm zero failures
- [ ] 13.2 Run `pnpm -w lint` — confirm zero errors
- [ ] 13.3 Run `pnpm -w build` cold — confirm all packages compile; confirm no stale `dist/` causes a phantom pass (delete `dist/` dirs across the monorepo if needed)
- [ ] 13.4 End-to-end smoke in a packaged build context: `pnpm -w build && pnpm --filter @ft5/desktop exec electron-builder --dir` (unpacked app), launch the resulting binary, add a datasource, upload a file, close the app, confirm via the service's log that the upload completed after the app exit
- [ ] 13.5 Open a draft pull request against master titled `feat: wire fs-sync-service into desktop app`; body links the OpenSpec change and summarizes the BREAKING changes (upload rerouting, credential ownership)
- [ ] 13.6 Run `openspec validate wire-fs-sync-service --strict` and confirm zero issues
- [ ] 13.7 Update release notes to call out: (a) existing dev databases will lose stored datasource credentials (re-auth required), (b) the desktop app now requires the fs-sync service binary to be resolvable (in dev via `pnpm dev`, in prod via installer-registered service), (c) upload jobs now persist across app restarts
- [ ] 13.8 Archive the change in the feature branch per CLAUDE.md rule ("Archive in the worktree branch *before* merging. Never merge an unarchived change"): `openspec archive wire-fs-sync-service`
- [ ] 13.9 Merge the PR; verify the spec archive lands on master under `openspec/changes/archive/<date>-wire-fs-sync-service/`
