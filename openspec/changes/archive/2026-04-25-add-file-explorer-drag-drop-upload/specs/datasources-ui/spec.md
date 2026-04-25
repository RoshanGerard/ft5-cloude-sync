## MODIFIED Requirements

### Requirement: Datasource IPC surface is the single data path

All datasource reads and mutations from the renderer SHALL go through the `window.api.datasources.*` surface. The renderer SHALL NOT import any provider SDK, any `fs`/`child_process`/`electron`/`drizzle-orm` specifier, or any module under `apps/desktop/src/main/` or `apps/desktop/src/preload/`. The main-process handlers route all list/add/remove/action requests through the persistent `DatasourceRegistry`; there is no feature-flagged "engine-backed vs fixture" dichotomy — the registry is the single source of truth. Long-running sync and upload work is owned by the `fs-sync-service` (see its capability), not by the in-process engine.

The surface SHALL expose: `list()`, `add(req)`, `remove(req)`, `action(req)` (unified pause / resume / sync-now), `pickFilesToUpload()` (opens the native OS file picker for the Upload dialog), and `onEvent(cb)`. Each call SHALL have a typed request/response (or callback) pair in `packages/ipc-contracts/src/datasources.ts`. Each call SHALL have an `ipcMain.handle` or event-forwarder implementation under `apps/desktop/src/main/ipc/datasources/`. Each call SHALL be bound in the preload via `contextBridge.exposeInMainWorld`. The previously-exposed `upload(req)` method SHALL NOT be present — it has been replaced by the in-app Upload dialog which uses `pickFilesToUpload()` and the separate `files.upload` IPC (see the `file-explorer` capability).

#### Scenario: Renderer has no direct SDK import

- **WHEN** `pnpm lint` runs
- **THEN** ESLint reports an error for any file under `apps/desktop/src/renderer/` that imports from `googleapis`, `@microsoft/microsoft-graph-client`, `@aws-sdk/client-s3`, or any other provider SDK package; a dedicated CI grep step SHALL back the ESLint rule

#### Scenario: Four-layer wiring per IPC method

- **WHEN** a new datasources IPC method is added
- **THEN** the build SHALL require all four layers (contract type, main handler, preload exposure, renderer call site) to be present; missing any one SHALL cause a TypeScript error or a failing contract test in `packages/ipc-contracts/src/__tests__/datasources.test-d.ts`

#### Scenario: onEvent is bound in preload and typed at the consumer

- **WHEN** a renderer module imports `window.api.datasources.onEvent` and passes a callback typed as `(e: DatasourceEvent) => void`
- **THEN** the call site compiles under `strict` mode, the returned value is a function `() => void`, and invoking the returned function unsubscribes the callback from further deliveries

#### Scenario: datasources.upload is absent from the surface

- **WHEN** a Vitest test inspects `window.api.datasources` at runtime and grep-scans the contract, preload, and main-handler trees
- **THEN** `upload` is NOT present on `window.api.datasources`; `DatasourcesUploadRequest` / `DatasourcesUploadResponse` types do NOT exist in `packages/ipc-contracts/src/datasources.ts`; no `ipcMain.handle` under `apps/desktop/src/main/ipc/datasources/` registers an `upload` channel

### Requirement: Upload action opens the in-app Upload dialog

The "Upload from local…" quick action on a datasource card SHALL open the in-app Upload dialog (see the `file-explorer` capability for the dialog's full specification). The dialog's default destination SHALL be the datasource root (`/`) when opened from the card (as there is no explorer context at the card level). The renderer SHALL NOT render or reference a `<input type="file">` element for this flow; inside the dialog, the "+ Add files…" affordance SHALL call `window.api.datasources.pickFilesToUpload()`, which in the main process opens a native OS file picker via `dialog.showOpenDialog` with `properties: ["openFile", "multiSelections"]` and returns `{ filePaths: string[]; canceled: boolean }`.

On dialog submission, uploads SHALL be dispatched via `window.api.files.upload` (see the `file-explorer` capability), which proxies to the `fs-sync-service`'s `sync:enqueue-upload` command. The desktop IPC handler for `files.upload` SHALL NOT invoke the engine's `uploadFile` directly in-process. Upload progress SHALL continue to flow to the renderer via the existing one-way IPC event channel `DATASOURCES_CHANNELS.uploadProgress`, scoped per-job to the `jobId` returned by `files.upload`.

Uploads SHALL survive desktop app quit. Closing the desktop window (or even `app.quit`) SHALL NOT cancel or stall the underlying service-side upload job. Progress events emitted by the service while the desktop is closed SHALL be accessible to a subsequent desktop session via the app-open `sync-state-seed` (see the `fs-sync-supervisor` capability).

#### Scenario: Quick action opens the Upload dialog rooted at the datasource root

- **WHEN** the user activates "Upload from local…" on a datasource card's quick-actions menu
- **THEN** the Upload dialog opens; the destination path is `/`; no native OS file picker opens until the user clicks "+ Add files…" inside the dialog

#### Scenario: Renderer contains no file input for the upload flow

- **WHEN** the Upload dialog is rendered and the user activates "+ Add files…"
- **THEN** no `<input type="file">` or web File API reference is present in the rendered DOM tree at any point; the file-picker UI is the OS-native `dialog.showOpenDialog` surface reached through `window.api.datasources.pickFilesToUpload`

#### Scenario: Upload progress events are typed and scoped per job

- **WHEN** an upload is dispatched via `window.api.files.upload` and returns `{ ok: true, value: { jobId: "job_x" } }`
- **THEN** the main process emits progress events on `DATASOURCES_CHANNELS.uploadProgress` keyed by a `transactionId` equal to `"job_x"`; the renderer subscribes only to events matching `"job_x"`; an emission for an unrelated jobId is ignored by the renderer

#### Scenario: Upload survives desktop quit

- **WHEN** a user triggers an upload of a 100 MB file against a rate-limited provider that takes 30+ seconds, then closes the desktop window after 2 seconds
- **THEN** the service-side job continues running; its `jobs` table row remains in `status = 'running'` (or `waiting-network` if the connection drops); a new desktop launch 40 seconds later sees `status = 'completed'` in the seed (or, if still running at relaunch, sees the live progress resume on the card)

#### Scenario: Main handler does not call engine.uploadFile directly

- **WHEN** a Vitest test grep-scans `apps/desktop/src/main/ipc/files/upload.ts` and `apps/desktop/src/main/ipc/datasources/` for `uploadFile` invocations or `engine.uploadFile`
- **THEN** no match is found; the only call the file-upload handler makes is to `syncClient.enqueueUpload` (or the equivalent wrapper under `apps/desktop/src/main/sync/`)

## REMOVED Requirements

### Requirement: Upload action uses the main-process file picker, never the renderer

**Reason:** Replaced by the in-app Upload dialog specified in the `file-explorer` capability. The old one-shot "quick action opens picker, uploads to datasource root" flow did not let the user pick the destination folder and conflicted with the drag-drop-to-current-folder behavior introduced by this change. The new surface (`datasources.pickFilesToUpload` for OS picker + `files.upload` for enqueue) cleanly separates picker from enqueue and lets the renderer own destination selection.

**Migration:** Callers of `window.api.datasources.upload({datasourceId})` SHALL be updated to open the Upload dialog instead. The dialog's default destination is `/` when opened from a datasource card (matching the old behavior's target path) and `currentPath` when opened from the file-explorer toolbar. Inside the dialog, `window.api.datasources.pickFilesToUpload()` replaces the main-process picker auto-open, and `window.api.files.upload({datasourceId, sourcePath, targetPath, conflictPolicy})` replaces the bundled enqueue-at-root behavior. `DATASOURCES_CHANNELS.uploadProgress` continues to deliver progress events keyed by `jobId` — no change to that channel.
