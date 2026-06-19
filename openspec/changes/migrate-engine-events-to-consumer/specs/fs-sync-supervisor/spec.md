# fs-sync-supervisor

## MODIFIED Requirements

### Requirement: Service events are relayed to the renderer

The main process SHALL, as part of supervisor startup, call `SyncClient.subscribeEvents()` once per process lifetime (singleton subscription). Every `Event` frame received SHALL be forwarded to every registered `BrowserWindow` via an IPC channel `sync:event`. The renderer's `window.api.sync.onEvent(cb)` SHALL register a listener on that channel.

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

### Requirement: Datasource cards reflect live service job state

The renderer's `DatasourceCard` SHALL compute its `status` and upload-progress display from the new sync-event stream including the `sync-state-seed`. Specifically:

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
