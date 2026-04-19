## ADDED Requirements

### Requirement: Renderer subscribes to the datasource event stream

The renderer SHALL expose a typed subscription surface `window.api.datasources.onEvent(callback): () => void` that delivers every engine-emitted `DatasourceEvent<T, K>` to the callback. The callback parameter SHALL be generically typed so TypeScript narrowing via `switch (e.datasourceType)` and `switch (e.event)` works at the consumer call site without manual casts. The returned function SHALL unsubscribe the callback. The subscription SHALL be available after the preload `contextBridge.exposeInMainWorld` runs and before the first React render.

#### Scenario: onEvent delivers typed events

- **WHEN** a renderer test subscribes via `window.api.datasources.onEvent(cb)` and the main process emits a `file-created` event for an `amazon-s3` datasource
- **THEN** `cb` is invoked once with an event whose `datasourceType === "amazon-s3"` and whose `payload` type narrows (under `switch`) to S3's `file-created` payload shape

#### Scenario: Unsubscribe stops delivery

- **WHEN** a renderer test obtains an unsubscribe function from `onEvent` and calls it
- **THEN** subsequent main-process emissions do not invoke the callback

#### Scenario: Dashboard store reconciles optimistic state with events

- **WHEN** a user triggers an upload via a card quick-action, the optimistic-UI path marks the card as `status === "syncing"`, and the main process later emits `file-created` for that datasource
- **THEN** the store transitions the card's status to `"connected"` (or whichever terminal status the engine reports), within one animation frame of the event being delivered

### Requirement: `datasources:event` IPC channel is the single event path

The main process SHALL forward engine events to the renderer over a one-way IPC channel constant `DATASOURCES_CHANNELS.event === "datasources:event"` defined in `packages/ipc-contracts`. The renderer SHALL NOT receive datasource event data through any other channel (including `datasources:upload:progress`, which remains scoped to the legacy upload progress event only during the transition window). The preload SHALL expose exactly one entry point (`window.api.datasources.onEvent`) for this channel; renderers SHALL NOT reach for `ipcRenderer` directly.

#### Scenario: Channel constant is defined in the shared contract

- **WHEN** a test imports `DATASOURCES_CHANNELS` from `@ft5/ipc-contracts`
- **THEN** the object contains `event: "datasources:event"`; the main-process forwarder and the preload both reference this constant rather than string-literal duplicates

#### Scenario: Renderer never accesses ipcRenderer directly for events

- **WHEN** a Vitest test scans every `.ts` / `.tsx` file under `apps/desktop/src/renderer/`
- **THEN** no file imports `ipcRenderer` from `electron`; event subscription is always via `window.api.datasources.onEvent`

## MODIFIED Requirements

### Requirement: Datasource IPC surface is the single data path

All datasource reads and mutations from the renderer SHALL go through the `window.api.datasources.*` surface. The renderer SHALL NOT import any provider SDK, any `fs`/`child_process`/`electron`/`drizzle-orm` specifier, or any module under `apps/desktop/src/main/` or `apps/desktop/src/preload/`. This requirement is enforced independently of whether the main-process handlers route through the FS Datasource Engine (engine-backed) or through a legacy fixture path (during the transition window — see migration note in `openspec/changes/add-fs-datasource-engine/design.md`).

The surface SHALL expose: `list()`, `add(req)`, `remove(req)`, `action(req)` (unified pause / resume / sync-now), `upload(req)`, and `onEvent(cb)`. Each call SHALL have a typed request/response (or callback) pair in `packages/ipc-contracts/src/datasources.ts`. Each call SHALL have an `ipcMain.handle` or event-forwarder implementation under `apps/desktop/src/main/ipc/datasources/`. Each call SHALL be bound in the preload via `contextBridge.exposeInMainWorld`.

#### Scenario: Renderer has no direct SDK import

- **WHEN** `pnpm lint` runs
- **THEN** ESLint reports an error for any file under `apps/desktop/src/renderer/` that imports from `googleapis`, `@microsoft/microsoft-graph-client`, `@aws-sdk/client-s3`, or any other provider SDK package; a dedicated CI grep step SHALL back the ESLint rule

#### Scenario: Four-layer wiring per IPC method

- **WHEN** a new datasources IPC method is added
- **THEN** the build SHALL require all four layers (contract type, main handler, preload exposure, renderer call site) to be present; missing any one SHALL cause a TypeScript error or a failing contract test in `packages/ipc-contracts/src/__tests__/datasources.test-d.ts`

#### Scenario: Engine-backed list returns real provider data when flag is on

- **WHEN** the runtime feature flag `DATASOURCE_ENGINE_LIVE === true` and `window.api.datasources.list()` is called for an environment with registered provider credentials
- **THEN** the main-process handler SHALL construct per-datasource clients via `ClientFactory.create`, aggregate their `status()` / quota / last-sync information into `DatasourceSummary` values, and return them; the renderer SHALL receive that payload with all fields typed per the contract

#### Scenario: Fixture path remains the fallback during transition

- **WHEN** the runtime feature flag `DATASOURCE_ENGINE_LIVE` is unset or `false`
- **THEN** the main-process handler SHALL return the legacy hard-coded array of `DatasourceSummary` values (structured-clone-safe), identical in shape to the engine-backed response; the renderer SHALL NOT be able to distinguish which path served the response by shape alone

#### Scenario: onEvent is bound in preload and typed at the consumer

- **WHEN** a renderer module imports `window.api.datasources.onEvent` and passes a callback typed as `(e: DatasourceEvent) => void`
- **THEN** the call site compiles under `strict` mode, the returned value is a function `() => void`, and invoking the returned function unsubscribes the callback from further deliveries
