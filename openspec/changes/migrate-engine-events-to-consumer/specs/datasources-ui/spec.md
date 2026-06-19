# datasources-ui

## REMOVED Requirements

### Requirement: Renderer subscribes to the datasource event stream

**Reason**: the engine EventBus and the `datasources:event` bridge are removed; `window.api.datasources.onEvent` has no production emitter or consumer.
**Migration**: the renderer consumes auth/status events via `window.api.sync.onEvent` and reconciles optimistic state from RPC responses + the sync event stream.

### Requirement: `datasources:event` IPC channel is the single event path

**Reason**: the channel and its preload bridge are removed along with the engine bus.
**Migration**: datasource-facing events flow via `SYNC_CHANNELS.event` (`window.api.sync.onEvent`); `DATASOURCES_CHANNELS.event` and `window.api.datasources.onEvent` are deleted.

## MODIFIED Requirements

### Requirement: Datasource IPC surface is the single data path

All datasource reads and mutations from the renderer SHALL go through the `window.api.datasources.*` and `window.api.sync.*` surfaces. The renderer SHALL NOT import any provider SDK, any `fs`/`child_process`/`electron`/`drizzle-orm` specifier, or any module under `apps/desktop/src/main/` or `apps/desktop/src/preload/`. The main-process handlers route list/add/remove/action requests through the persistent `DatasourceRegistry`; authenticate requests route through the service via `window.api.sync.authenticate{Start,Complete,Cancel}`. There is no feature-flagged "engine-backed vs fixture" dichotomy — the registry is the single source of truth for datasource membership, and the service is the single source of truth for credentials.

The `window.api.datasources.*` surface SHALL expose: `list()`, `add(req)`, `remove(req)`, `action(req)` (unified pause / resume / sync-now), and `pickFilesToUpload()`. The `startConsent(req)` and `cancelConsent(req)` methods SHALL NOT be present — they have been retired and replaced by the service-mediated `window.api.sync.authenticate{Start,Cancel}` surface. The `upload(req)` method SHALL also be absent (retired earlier — Upload dialog uses `pickFilesToUpload()` + `files.upload`).

The `window.api.sync.*` surface SHALL expose (in addition to the previously specified `enqueueUpload`, `enqueueMirror`, `listJobs`, `getJob`, `cancelJob`, `setRetryPolicy`, `getRetryPolicy`, `getStatus`, `subscribeEvents`, `unsubscribeEvents`, `onEvent`): `authenticateStart(req)`, `authenticateComplete(req)`, `authenticateCancel(req)`. Each call SHALL have a typed request/response pair in `packages/ipc-contracts/src/sync-service-desktop/`.

The `DatasourceEvent` discriminated union SHALL NOT carry consent-related variants any longer — the `consent-started`, `consent-completed`, `consent-cancelled`, `consent-failed`, and `consent-timeout` variants SHALL be removed. Authentication lifecycle events flow exclusively on the sync event stream as `auth-*` events (see the new "Renderer subscribes to the sync event stream for authenticate lifecycle" requirement).

#### Scenario: Renderer has no direct SDK import

- **WHEN** `pnpm lint` runs
- **THEN** ESLint reports an error for any file under `apps/desktop/src/renderer/` that imports from `googleapis`, `@microsoft/microsoft-graph-client`, `@aws-sdk/client-s3`, or any other provider SDK package; a dedicated CI grep step SHALL back the ESLint rule

#### Scenario: startConsent and cancelConsent are absent from the surface

- **WHEN** a Vitest test inspects `window.api.datasources` at runtime AND grep-scans the contract, preload, and main-handler trees
- **THEN** `startConsent` and `cancelConsent` are NOT present on `window.api.datasources`; `DatasourcesStartConsentRequest` / `DatasourcesStartConsentResponse` / `DatasourcesCancelConsentRequest` / `DatasourcesCancelConsentResponse` types do NOT exist in `packages/ipc-contracts/src/datasources.ts`; no `ipcMain.handle` under `apps/desktop/src/main/ipc/datasources/` registers a `start-consent` or `cancel-consent` channel; the existing `DATASOURCES_CHANNELS` constant in `packages/ipc-contracts/src/datasources.ts` no longer carries `startConsent` / `cancelConsent` keys

#### Scenario: authenticateStart, authenticateComplete, authenticateCancel are first-class on sync surface

- **WHEN** a type test imports `SyncAuthenticateStartRequest`, `SyncAuthenticateCompleteRequest`, `SyncAuthenticateCancelRequest` from `@ft5/ipc-contracts/sync-service-desktop`
- **THEN** all three types are present, the preload exposes the matching methods on `window.api.sync`, the renderer call sites compile under strict mode, and each method has a typed response

#### Scenario: Consent event variants are absent from DatasourceEvent

- **WHEN** a type test imports `DatasourceEvent` from `@ft5/ipc-contracts`
- **THEN** the union does NOT contain `consent-started`, `consent-completed`, `consent-cancelled`, `consent-failed`, or `consent-timeout` variants; a switch over `e.event` does NOT need to handle any consent-* arm

### Requirement: Datasource card reflects active sync and upload jobs

`DatasourceCard` SHALL derive display state from the sync-event stream (`window.api.sync.onEvent`) plus the initial `sync-state-seed`. The mapping SHALL be:

- **Active sync indicator.** If there is any job for this `datasourceId` with `kind === 'sync'` AND `status ∈ {running, queued, waiting-network}`, the card's `status` SHALL be `'syncing'` regardless of other engine-reported state (sync trumps idle for display purposes).
- **Active upload progress bar.** If there is at least one job with `kind === 'upload'` AND `status === 'running'` for this `datasourceId`, the card SHALL render a compact progress bar positioned below the card header. The bar SHALL track the progress of the most-recently-started upload (tiebreaker: `startedAt` descending, then `jobId` lexicographically). When the tracked job terminates, the bar SHALL switch to the next-newest active upload, or disappear if none remain.
- **Waiting-network badge.** If a job is in `status === 'waiting-network'` for this datasource, the card SHALL display a small badge or indicator distinguishing "waiting for network" from "queued" or "running." (Minimal visual — implementation may use an icon + tooltip rather than a full badge element, at designer discretion, as long as assistive tech can announce the state.)

These display rules SHALL be computed in a pure derivation from the renderer's in-memory job state; no additional IPC call SHALL be required per card render.

#### Scenario: Sync state trumps idle on card display

- **WHEN** a datasource's baseline summary state is `idle` AND the sync seed includes a running sync job for the same datasource
- **THEN** the card displays `status: 'syncing'` with the existing pulse animation (sync trumps idle for display)

#### Scenario: Upload progress bar tracks the most recent running upload

- **WHEN** two upload jobs for the same datasource start at `t=0` and `t=1 ms`, and both emit `job-progress` events independently
- **THEN** the card's progress bar displays the progress of the `t=1` upload exclusively; when that upload completes, the bar switches to the `t=0` upload; when both complete, the bar unmounts

#### Scenario: Waiting-network is visually distinct from running

- **WHEN** a sync job for a card's datasource transitions to `waiting-network`
- **THEN** the card's syncing indicator persists but gains a distinguishing visual (icon change, modified tooltip, or small badge) such that a user can differentiate "actively working" from "paused awaiting network"; the semantic change is announced via ARIA (e.g., `aria-live` region update or an `aria-label` change on the indicator)

#### Scenario: Seed event applies before live events

- **WHEN** a renderer mounts, a seed event arrives listing `jobs: [{ kind: 'sync', status: 'running', datasourceId: 'ds-1' }]`, and shortly after a `job-completed` live event arrives for the same job
- **THEN** the card for ds-1 briefly shows `syncing`, then transitions to `idle` (or whatever the engine-derived state says) within one frame of the live event; no display flicker in between

### Requirement: Renderer subscribes to the sync event stream for authenticate lifecycle

The renderer SHALL consume the `auth-*` event family via `window.api.sync.onEvent(callback): () => void` (the existing sync event subscription, also used for job-* events). The `useAuthSession(correlationId)` hook SHALL be the single point of consumption — it subscribes via `sync.onEvent`, filters events by `event.correlationId === correlationId`, and exposes a `{ status: "pending" | "completed" | "cancelled" | "failed" | "timeout", message?, datasourceId?, tag? }` shape to consuming components.

`useConsentSession` SHALL NOT be exported any longer — call sites migrate to `useAuthSession`.

#### Scenario: useAuthSession resolves to completed on matching auth-completed event

- **WHEN** a test mounts a component using `useAuthSession("corr-123")`, then the test fires `window.api.sync.onEvent`-delivered `auth-completed { correlationId: "corr-123", datasourceId: "ds-X", summary }`
- **THEN** the hook's returned status flips to `"completed"` with `datasourceId === "ds-X"` within one render

#### Scenario: useAuthSession ignores events for other correlationIds

- **WHEN** a test mounts a component using `useAuthSession("corr-123")`, then fires `auth-completed { correlationId: "corr-456", … }`
- **THEN** the hook's returned status remains `"pending"`; no state transition occurs

#### Scenario: useConsentSession is no longer exported

- **WHEN** a TypeScript build runs over the renderer code
- **THEN** no module exports a symbol named `useConsentSession`; existing import sites have been migrated to `useAuthSession`
