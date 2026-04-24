## MODIFIED Requirements

### Requirement: Upload action uses the main-process file picker, never the renderer

The "Upload from local…" quick action SHALL call `window.api.datasources.upload({ datasourceId })`, which in the main process opens a native OS file picker via `dialog.showOpenDialog`. The renderer SHALL NOT render or reference a `<input type="file">` element for this flow.

The main-process handler SHALL enqueue the selected file as an upload job on the fs-sync service via `sync:enqueue-upload`; it SHALL NOT invoke the engine's `uploadFile` directly in-process. The returned `jobId` SHALL serve as the `transactionId` returned to the renderer. Upload progress SHALL be delivered from main to renderer via the existing one-way IPC event channel `DATASOURCES_CHANNELS.uploadProgress`, scoped to the upload transaction id; the underlying source SHALL be service-emitted `job-progress` events, translated into the existing `DatasourcesUploadProgressEvent` shape. The renderer SHALL NOT need to know whether the upload is service-backed; the existing call sites SHALL continue to compile and function without edit.

Uploads SHALL survive desktop app quit. Closing the desktop window (or even `app.quit`) SHALL NOT cancel or stall the underlying service-side upload job. Progress events emitted by the service while the desktop is closed SHALL be accessible to a subsequent desktop session via the app-open `sync-state-seed` (see the `fs-sync-supervisor` capability).

#### Scenario: Renderer contains no file input for the upload flow

- **WHEN** the upload quick action is invoked
- **THEN** no `<input type="file">` or web File API reference is present in the rendered DOM tree, and the file-picker UI is the OS-native `dialog.showOpenDialog` surface

#### Scenario: Upload progress events are typed and scoped per transaction

- **WHEN** an upload is initiated
- **THEN** the main process emits progress events on `DATASOURCES_CHANNELS.uploadProgress` keyed by a `transactionId` equal to the service's `jobId`; the renderer subscribes only to events matching that id; an emission for an unrelated id is ignored by the renderer

#### Scenario: Upload survives desktop quit

- **WHEN** a user triggers an upload of a 100 MB file against a rate-limited provider that takes 30+ seconds, then closes the desktop window after 2 seconds
- **THEN** the service-side job continues running; its `jobs` table row remains in `status = 'running'` (or `waiting-network` if the connection drops); a new desktop launch 40 seconds later sees `status = 'completed'` in the seed (or, if still running at relaunch, sees the live progress resume on the card)

#### Scenario: Main handler does not call engine.uploadFile directly

- **WHEN** a Vitest test grep-scans `apps/desktop/src/main/ipc/datasources/` for `uploadFile` invocations or `engine.uploadFile`
- **THEN** no match is found; the only call the handler makes for upload is to the `SyncClient.enqueueUpload` helper (or the equivalent wrapper in the `sync/` subdirectory)

### Requirement: Datasource IPC surface is the single data path

All datasource reads and mutations from the renderer SHALL go through the `window.api.datasources.*` surface. The renderer SHALL NOT import any provider SDK, any `fs`/`child_process`/`electron`/`drizzle-orm` specifier, or any module under `apps/desktop/src/main/` or `apps/desktop/src/preload/`. The main-process handlers route all list/add/remove/action requests through the persistent `DatasourceRegistry`; there is no feature-flagged "engine-backed vs fixture" dichotomy — the registry is the single source of truth. Long-running sync and upload work is owned by the `fs-sync-service` (see its capability), not by the in-process engine.

The surface SHALL expose: `list()`, `add(req)`, `remove(req)`, `action(req)` (unified pause / resume / sync-now), `upload(req)`, and `onEvent(cb)`. Each call SHALL have a typed request/response (or callback) pair in `packages/ipc-contracts/src/datasources.ts`. Each call SHALL have an `ipcMain.handle` or event-forwarder implementation under `apps/desktop/src/main/ipc/datasources/`. Each call SHALL be bound in the preload via `contextBridge.exposeInMainWorld`.

#### Scenario: Renderer has no direct SDK import

- **WHEN** `pnpm lint` runs
- **THEN** ESLint reports an error for any file under `apps/desktop/src/renderer/` that imports from `googleapis`, `@microsoft/microsoft-graph-client`, `@aws-sdk/client-s3`, or any other provider SDK package; a dedicated CI grep step SHALL back the ESLint rule

#### Scenario: Four-layer wiring per IPC method

- **WHEN** a new datasources IPC method is added
- **THEN** the build SHALL require all four layers (contract type, main handler, preload exposure, renderer call site) to be present; missing any one SHALL cause a TypeScript error or a failing contract test in `packages/ipc-contracts/src/__tests__/datasources.test-d.ts`

#### Scenario: onEvent is bound in preload and typed at the consumer

- **WHEN** a renderer module imports `window.api.datasources.onEvent` and passes a callback typed as `(e: DatasourceEvent) => void`
- **THEN** the call site compiles under `strict` mode, the returned value is a function `() => void`, and invoking the returned function unsubscribes the callback from further deliveries

## ADDED Requirements

### Requirement: Datasource card reflects active sync and upload jobs

`DatasourceCard` SHALL derive display state from the union of (a) the existing datasource-event stream and (b) the new sync-event stream (`window.api.sync.onEvent`) plus the initial `sync-state-seed`. The mapping SHALL be:

- **Active sync indicator.** If there is any job for this `datasourceId` with `kind === 'sync'` AND `status ∈ {running, queued, waiting-network}`, the card's `status` SHALL be `'syncing'` regardless of other engine-reported state (sync trumps idle for display purposes).
- **Active upload progress bar.** If there is at least one job with `kind === 'upload'` AND `status === 'running'` for this `datasourceId`, the card SHALL render a compact progress bar positioned below the card header. The bar SHALL track the progress of the most-recently-started upload (tiebreaker: `startedAt` descending, then `jobId` lexicographically). When the tracked job terminates, the bar SHALL switch to the next-newest active upload, or disappear if none remain.
- **Waiting-network badge.** If a job is in `status === 'waiting-network'` for this datasource, the card SHALL display a small badge or indicator distinguishing "waiting for network" from "queued" or "running." (Minimal visual — implementation may use an icon + tooltip rather than a full badge element, at designer discretion, as long as assistive tech can announce the state.)

These display rules SHALL be computed in a pure derivation from the renderer's in-memory job state; no additional IPC call SHALL be required per card render.

#### Scenario: Sync state trumps idle on card display

- **WHEN** the engine reports a datasource as `idle` on `datasources:event` AND the sync seed includes a running sync job for the same datasource
- **THEN** the card displays `status: 'syncing'` with the existing pulse animation; toggling the ordering of the two event arrivals does not affect the final rendered state

#### Scenario: Upload progress bar tracks the most recent running upload

- **WHEN** two upload jobs for the same datasource start at `t=0` and `t=1 ms`, and both emit `job-progress` events independently
- **THEN** the card's progress bar displays the progress of the `t=1` upload exclusively; when that upload completes, the bar switches to the `t=0` upload; when both complete, the bar unmounts

#### Scenario: Waiting-network is visually distinct from running

- **WHEN** a sync job for a card's datasource transitions to `waiting-network`
- **THEN** the card's syncing indicator persists but gains a distinguishing visual (icon change, modified tooltip, or small badge) such that a user can differentiate "actively working" from "paused awaiting network"; the semantic change is announced via ARIA (e.g., `aria-live` region update or an `aria-label` change on the indicator)

#### Scenario: Seed event applies before live events

- **WHEN** a renderer mounts, a seed event arrives listing `jobs: [{ kind: 'sync', status: 'running', datasourceId: 'ds-1' }]`, and shortly after a `job-completed` live event arrives for the same job
- **THEN** the card for ds-1 briefly shows `syncing`, then transitions to `idle` (or whatever the engine-derived state says) within one frame of the live event; no display flicker in between

### Requirement: Renderer stores zero credential material

The renderer SHALL NOT, at any point, receive, cache, or persist credential material for any datasource. Credential intents that require user input (e.g., the OAuth browser-window flow, the credentials-form dialog for S3) SHALL be mediated by the main process: the renderer sends the user's intent to main, main forwards to the service via `window.api.sync.authenticate`, and the service's `ConfigFileCredentialStore` is the ultimate sink. The renderer SHALL receive only a success / failure boolean (plus a sanitized `AuthResult` that does NOT include token strings in payloads crossing the contextBridge for *persistence*; transient display of connection confirmation is permitted).

Any renderer module that previously imported `SqliteCredentialStore` directly (there should be none, per existing boundary rules, but verified here) SHALL fail to compile after this change because the symbol is deleted.

#### Scenario: Renderer has no credential storage API

- **WHEN** a Vitest test grep-scans `apps/desktop/src/renderer/` for the symbols `safeStorage`, `SqliteCredentialStore`, `CredentialStore`, `encryptString`, `decryptString`, `credentials.json`, `datasource_credentials`
- **THEN** no match is found except possibly in TSDoc comments explicitly marking them as unavailable

#### Scenario: Renderer auth flow routes through service

- **WHEN** a user initiates authentication for a new Google Drive datasource from the renderer
- **THEN** the renderer's call path is `window.api.sync.authenticate(...)` ONLY; no `window.api.datasources.authenticate` exists on the preload; the OAuth browser window (if opened) is launched by the main process via `shell.openExternal`, and the completion code is returned through main → service, never stored in renderer memory beyond the single transaction
