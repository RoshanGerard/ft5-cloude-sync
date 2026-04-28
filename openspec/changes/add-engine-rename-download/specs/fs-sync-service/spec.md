# fs-sync-service — Delta for `add-engine-rename-download`

## ADDED Requirements

### Requirement: `files:rename` and `files:download` RPC commands delegate to the engine

The service SHALL accept two new commands on its IPC channel:
`files:rename` and `files:download`. Both SHALL resolve the engine client
for the request's `datasourceId` via the existing `ClientFactory`
machinery (the same path used by `files:list`, `files:stat`,
`files:search`, `files:remove`).

`files:rename` accepts:

```typescript
{
  datasourceId: string;
  path: string;
  handle?: string;
  newName: string;
  conflictPolicy: "fail" | "overwrite" | "keep-both";
}
```

The handler forwards the call to `client.rename(target, newName,
conflictPolicy)`. The engine's strategy determines whether the target
is a file or directory within its own provider context (Drive/OneDrive
metadata, S3 `HeadObject` + `ListObjectsV2` introspection); the wire
contract carries no `kind` field. Response: `{ ok: true, value: {
entry: DatasourceFileEntry } } | { ok: false, error }`. Error tags
include the new `"conflict"` variant carrying `existingPath` per the
engine's new `DatasourceErrorTag.Conflict`.

`files:download` accepts:

```typescript
{
  datasourceId: string;
  path: string;
  handle?: string;
  toPath: string;  // required, absolute, validated at boundary
}
```

The handler MUST first validate `toPath` (see "toPath validation" requirement below). On success, the handler:

1. Mints a service-level `downloadJobId` (UUID) and creates an `AbortController` for the job. Inserts a registry entry.
2. Enters a retry loop. Initial iteration: `rangeStart = 0`. Each iteration calls `engine.downloadFile(target, { rangeStart, signal: abortController.signal, onProgress: <fires service-level downloading event> })`.
3. Validates the response: if `rangeStart > 0` and `contentRange === undefined` (provider ignored the Range header), throws a terminal `range-not-supported` error.
4. Validates: if `rangeStart > 0` and `contentRange.start !== rangeStart`, throws a terminal `range-mismatch` error.
5. Pipes the returned stream to `fs.createWriteStream(toPath, { flags: rangeStart === 0 ? "w" : "r+", start: rangeStart })`.
6. After the pipeline resolves, reads `fs.stat(toPath).size` to determine `bytesWritten`. If `bytesWritten === contentLength`, breaks out of the loop (success).
7. If the pipeline rejects with an auth-expired error mid-stream AND the loop attempt count is below `MAX_AUTH_RETRIES` (default 1), updates `rangeStart = bytesWritten` from the file size on disk and continues the loop. The next `engine.downloadFile` call goes through `withRefresh` afresh.
8. If the pipeline rejects with `abortController.signal.aborted`, emits `download-cancelled` and returns the cancel response.
9. If the pipeline rejects with any other error, emits `download-failed` and returns the error response.
10. After successful loop exit, performs an integrity check (compare hash of `toPath` against the provider's hash if available) and emits `file-downloaded { downloadJobId, savedPath: toPath, bytes }`. Replies `{ ok: true, value: { savedPath: toPath, bytes } }`. Removes the registry entry.

The `downloadJobId` SHALL be the canonical job key for cancel and progress correlation; clients reference it in `downloads:list-active`, in cancel commands, and in event subscriptions.

#### Scenario: Successful download streams from engine to disk

- **WHEN** a client sends `files:download { datasourceId: "ds-1", path: "/welcome.pdf", toPath: "/Users/alice/Downloads/ft5/welcome.pdf" }`
- **THEN** `toPath` validation passes; the handler mints `downloadJobId`, creates the registry entry, calls `engine.downloadFile(target, { rangeStart: 0, signal, onProgress })`; `engine.downloadFile` resolves with `{ stream, contentLength: N }`; the handler pipes the stream to `fs.createWriteStream(toPath, { flags: "w", start: 0 })`; on stream end the handler reads `fs.stat(toPath).size === N`; integrity check passes; the handler emits `file-downloaded { downloadJobId, savedPath, bytes: N }` and replies `{ ok: true, value: { savedPath, bytes: N } }`; the registry entry is removed

#### Scenario: Mid-stream auth-expired triggers handler-driven retry

- **WHEN** a `files:download` is in flight; after N bytes are written, the pipeline rejects with `tag: "auth-expired"`
- **THEN** the handler reads `fs.stat(toPath).size === N`; sets `rangeStart = N`; calls `engine.downloadFile(target, { rangeStart: N, signal, onProgress })` again; the engine's `withRefresh` wrapper detects the auth-expired credential and refreshes once before issuing the new GET; the GET returns 206 Partial Content with `Content-Range: bytes N-M/T`; the handler validates `contentRange.start === N`; pipes from byte N (using `flags: "r+", start: N`); on stream end `fs.stat(toPath).size === contentLength`; the loop exits with success

#### Scenario: Range-not-honored aborts with terminal error

- **WHEN** during a retry iteration, `engine.downloadFile(target, { rangeStart: N, … })` resolves with `contentRange === undefined` (provider ignored the Range header and returned 200 OK)
- **THEN** the handler does NOT pipe the stream; throws a terminal `range-not-supported` error; emits `download-failed { downloadJobId, tag: "other", message: "range not supported on this resource" }`; the partial file at `toPath` is left on disk; the registry entry is removed

#### Scenario: Cancel mid-stream

- **WHEN** the client invokes a cancel command (or the download orchestration emits a cancel) while the pipeline is in flight; the handler invokes `abortController.abort()`
- **THEN** the engine's downloaded stream rejects via the AbortSignal; the pipeline rejects with AbortError; the handler emits `download-cancelled { downloadJobId, bytesDownloaded, bytesTotal, reason: "user" }` exactly once; the partial file at `toPath` is NOT auto-deleted; the registry entry is removed; the response is `{ ok: false, error: { tag: "cancelled", message: "download cancelled" } }`

#### Scenario: Multi-cycle stable-network long download

- **WHEN** a `files:download` for a 5TB file is in flight against a provider with a 1-hour token lifetime; over 15 hours of streaming, the access token expires 15 distinct times
- **THEN** each token expiry surfaces as a mid-stream auth-expired error to the handler; on each error the handler retries with `rangeStart = <current bytes on disk>`; each retry call to `engine.downloadFile` goes through `withRefresh` which refreshes the credential once and issues a 206 Partial Content GET; the consumer's pipe-to-disk continues from the new `rangeStart`; the `MAX_AUTH_RETRIES` budget is per-cycle (one retry per auth-expired event), reset between cycles; total bytes written equals contentLength; the integrity check passes; the loop exits with success after the final cycle

#### Scenario: Rename file via the new RPC

- **WHEN** a client sends `files:rename { datasourceId: "ds-1", path: "/foo.pdf", newName: "bar.pdf", conflictPolicy: "fail" }`
- **THEN** the handler resolves the engine client for `ds-1`, calls `client.rename(target, "bar.pdf", "fail")`, the strategy determines via its provider context that the target is a file, performs the rename, and on success the handler replies `{ ok: true, value: { entry: { path: "/bar.pdf", name: "bar.pdf", … } } }`; the engine emits `entry-renamed` exactly once

#### Scenario: Rename directory on Drive

- **WHEN** a client sends `files:rename { datasourceId: "ds-drive", path: "/projects", newName: "archive", conflictPolicy: "fail" }` against a Drive folder
- **THEN** the handler calls `client.rename(target, "archive", "fail")`; the Drive strategy issues `files.update({fileId, requestBody: {name: "archive"}})` (uniform API for files and folders); on success the handler replies with the renamed entry

#### Scenario: Rename directory on S3 surfaces unsupported

- **WHEN** a client sends `files:rename { datasourceId: "ds-s3", path: "/backups", newName: "archive", conflictPolicy: "fail" }` against an S3 virtual folder
- **THEN** the handler calls `client.rename(target, "archive", "fail")`, the S3 strategy's introspection (`HeadObject` 404 + `ListObjectsV2` returns at least one key) determines the target is a folder, the strategy rejects with `DatasourceError { tag: "unsupported", message: "S3 folder rename is not supported in this version" }`, and the response is `{ ok: false, error: { tag: "other", message: "S3 folder rename is not supported in this version", retryable: false } }`


### Requirement: `toPath` validation at the service boundary

The `files:download` handler SHALL validate the renderer-supplied `toPath`
before opening any write stream. Validations:

1. `path.isAbsolute(toPath)` is true.
2. `path.normalize(toPath) === toPath` (no `..` segments after
   normalization).
3. The parent directory exists and is writable
   (`fs.access(parent, fs.constants.W_OK)` succeeds).
4. The path does not write inside the service's own data directory
   (`~/ft5/sync_app/`). Service-private paths are off-limits to
   download writes.

Validation failure SHALL produce `{ ok: false, error: { tag: "other",
message: "toPath validation: <which check failed>", retryable: false } }`
without opening any provider request.

#### Scenario: Relative toPath is rejected

- **WHEN** a client sends `files:download` with `toPath: "Downloads/welcome.pdf"`
- **THEN** the handler rejects with `tag: "other", message: "toPath validation: not absolute"`; no engine call is made

#### Scenario: Path traversal in toPath is rejected

- **WHEN** a client sends `files:download` with `toPath: "/Users/alice/Downloads/../../../etc/passwd"`
- **THEN** the handler normalizes the path, sees the result differs from the input (or sees `..` post-normalize is impossible because `path.normalize` would resolve), and rejects with `tag: "other", message: "toPath validation: contains traversal"`

#### Scenario: Write into service data dir is rejected

- **WHEN** a client sends `files:download` with `toPath: "$HOME/ft5/sync_app/credentials.json"`
- **THEN** the handler rejects with `tag: "other", message: "toPath validation: cannot write inside service data directory"`

### Requirement: In-memory `DownloadRegistry` tracks active downloads

The service SHALL maintain an in-memory `DownloadRegistry` at `services/fs-sync/src/downloads/registry.ts` with the shape `Map<downloadJobId, DownloadJob>` where:

```typescript
interface DownloadJob {
  downloadJobId: string;             // service-minted UUID
  datasourceId: string;
  sourcePath: string;
  targetPath: string;
  bytesDownloaded: number;
  contentLength: number | null;
  startedAt: number;                  // ms epoch
  abortController: AbortController;   // for cancel
}
```

The `files:download` handler SHALL `set` the entry on download start (when minting `downloadJobId`), update `bytesDownloaded` from the engine's `onProgress` callback (throttled per the same coalescing approach as upload), and `delete` the entry on terminal success / failure / cancellation.

The registry SHALL NOT persist to disk. Service crashes lose the registry; in-flight downloads orphan their partial files. Disk persistence (and the resulting service-crash recovery) is tracked in follow-up `migrate-download-registry-to-sqlite`.

#### Scenario: Registry tracks active download

- **WHEN** a `files:download` for `ds-1 / welcome.pdf → /downloads/welcome.pdf` is in flight at byte offset N
- **THEN** the registry contains exactly one entry keyed by the handler's `downloadJobId` with `bytesDownloaded: N`, `contentLength: <total>`, `targetPath: "/downloads/welcome.pdf"`, `sourcePath: "/welcome.pdf"`, `datasourceId: "ds-1"`, and an active `abortController`

#### Scenario: Registry releases on terminal success

- **WHEN** a `files:download` completes successfully (the handler emits `file-downloaded { downloadJobId }`)
- **THEN** the registry no longer contains the `downloadJobId` entry on the next read

#### Scenario: Registry releases on terminal cancel

- **WHEN** a `files:download` is cancelled mid-stream (the handler emits `download-cancelled { downloadJobId }`)
- **THEN** the registry no longer contains the `downloadJobId` entry on the next read

### Requirement: `downloads:list-active` RPC returns the registry snapshot

The service SHALL accept a new command `downloads:list-active` on its
IPC channel. Request shape: empty (`{}`). Response shape:

```typescript
{ ok: true, value: { jobs: DownloadJob[] } }
```

`jobs` is a stable snapshot of the current registry state at the
moment the command is handled. The handler SHALL NOT block on
in-flight events — it returns the current values atomically. Order
is by `startedAt` ascending (oldest first).

This command exists primarily for the desktop main process to query
on supervisor-connect (specifically, on the first connect of an app
session) and forward to the renderer for toast hydration. It is NOT
expected to be polled.

#### Scenario: Empty registry

- **WHEN** a client sends `downloads:list-active` with no downloads in flight
- **THEN** the response is `{ ok: true, value: { jobs: [] } }`

#### Scenario: Two in-flight downloads

- **WHEN** a client sends `downloads:list-active` with two downloads in flight
- **THEN** the response is `{ ok: true, value: { jobs: [<job-A>, <job-B>] } }` ordered by `startedAt` ascending; each job carries its full `DownloadJob` shape including the current `bytesDownloaded` at the moment of the snapshot

### Requirement: Service handler emits `downloading` / terminal events on the IPC stream

The `files:download` handler SHALL emit consumer-domain events on the service's IPC event channel. These events are DERIVED, not relayed: fs-sync subscribes to the engine bus's four download lifecycle events (`downloading`, `file-downloaded`, `download-failed`, `download-cancelled` per the engine spec) and applies a business-logic transformation — minting a `downloadJobId`, throttling progress, running the integrity check post-pipe, applying retry policy, updating the DownloadRegistry — before emitting fs-sync's own desktop-facing events. The fs-sync wire shapes differ from the engine bus shapes: engine bus payloads are keyed by `(datasourceId, path)` and carry raw vendor facts; fs-sync payloads are keyed by `downloadJobId` and carry business-decoration metadata. fs-sync events are NOT a re-broadcast of engine events.

The fs-sync wire shapes:

- `downloading { downloadJobId, datasourceId, progress, path }` — streaming-tagged, throttled per the same coalescing approach as `uploading`.
- `file-downloaded { downloadJobId, savedPath, bytes }` — terminal success.
- `download-failed { downloadJobId, tag, message }` — terminal failure.
- `download-cancelled { downloadJobId, bytesDownloaded, bytesTotal, reason }` — terminal cancel.

The handler invokes the engine's `onProgress` callback hook to drive the synchronous progress accounting (registry updates and the throttled `downloading` IPC emission). Terminal events emit exactly once per download. The handler treats engine bus subscription as the canonical source for cross-cutting download lifecycle observation; the synchronous callback is the low-overhead direct-caller path that mirrors the same byte-flow.

A client subscribed via `sync:subscribe-events` for a specific `datasourceId` SHALL receive only events for that datasource; subscriptions without a filter SHALL receive all events.

#### Scenario: Downloading progress streams to subscriber

- **WHEN** a client subscribes via `sync:subscribe-events { datasourceId: "ds-1" }` and a `files:download` is in flight for `ds-1`
- **THEN** the client receives `downloading { downloadJobId, progress: <0..100>, path }` events at the throttled rate; on terminal completion the client receives exactly one `file-downloaded { downloadJobId, savedPath, bytes }`

### Requirement: Service subscribes to engine bus events for download lifecycle

The fs-sync service SHALL subscribe to the engine bus's four download lifecycle events (`downloading`, `file-downloaded`, `download-failed`, `download-cancelled`) and treat that subscription as the canonical source for DownloadRegistry state transitions. The mapping from engine bus event to registry mutation is:

- `downloading { datasourceId, path, loaded, total }` → look up the `downloadJobId` for `(datasourceId, path)` in the registry; update the entry's `bytesDownloaded = loaded` and `contentLength = total` (subject to throttling).
- `file-downloaded { datasourceId, path, bytes }` → look up the `downloadJobId` for `(datasourceId, path)`; remove the registry entry; emit fs-sync's `file-downloaded { downloadJobId, savedPath, bytes }` after the integrity check (`savedPath` populated from the handler's pipe target — fs-sync owns it; the engine never writes to disk).
- `download-failed { datasourceId, path, error }` → look up the `downloadJobId` for `(datasourceId, path)`; remove the registry entry; emit fs-sync's `download-failed { downloadJobId, tag, message }` (or, when retry policy applies, retain the entry and dispatch a fresh `engine.downloadFile` call instead of emitting terminal).
- `download-cancelled { datasourceId, path, bytesDownloaded, bytesTotal }` → look up the `downloadJobId` for `(datasourceId, path)`; remove the registry entry; emit fs-sync's `download-cancelled { downloadJobId, bytesDownloaded, bytesTotal, reason }`.

The correlation key from engine bus events to fs-sync's job state SHALL be `(datasourceId, path) → downloadJobId`. fs-sync's in-memory registry SHALL maintain a reverse index from `(datasourceId, path)` to `downloadJobId` to make this lookup O(1). v1 enforces at most one in-flight download per `(datasourceId, path)`; a second `files:download` request whose `(datasourceId, path)` already exists in the registry SHALL be rejected with `{ ok: false, error: { tag: "other", message: "download already in progress for this entry", retryable: false } }` before any engine call is issued.

The handler's synchronous `options.onProgress` callback SHALL fire from the same byte-flow source as the engine bus emission; the handler MAY use the synchronous callback for low-overhead in-process accounting (registry update, throttled IPC emission) and use the bus subscription for cross-cutting observation (audit log, telemetry). Both paths converge on the same registry state.

#### Scenario: Engine `downloading` updates registry

- **WHEN** the engine bus emits `downloading { datasourceId: "ds-1", path: "/welcome.pdf", loaded: 524288, total: 1048576 }` and the registry contains a job entry for `(ds-1, /welcome.pdf)` with `downloadJobId: "job-A"`
- **THEN** the registry entry's `bytesDownloaded` updates to `524288` (subject to throttling) and `contentLength` updates to `1048576`

#### Scenario: Engine `file-downloaded` removes registry entry

- **WHEN** the engine bus emits `file-downloaded { datasourceId: "ds-1", path: "/welcome.pdf", bytes }` and the registry contains a job entry for `(ds-1, /welcome.pdf)` with `downloadJobId: "job-A"`
- **THEN** after the handler's integrity check resolves, the registry no longer contains `job-A`; fs-sync emits `file-downloaded { downloadJobId: "job-A", savedPath, bytes }` on the IPC event channel exactly once

#### Scenario: Engine `download-cancelled` removes registry entry

- **WHEN** the engine bus emits `download-cancelled { datasourceId: "ds-1", path: "/welcome.pdf", bytesDownloaded, bytesTotal }` and the registry contains a job entry for `(ds-1, /welcome.pdf)` with `downloadJobId: "job-A"`
- **THEN** the registry no longer contains `job-A`; fs-sync emits `download-cancelled { downloadJobId: "job-A", bytesDownloaded, bytesTotal, reason }` on the IPC event channel exactly once

#### Scenario: Concurrent download for the same `(datasourceId, path)` is rejected

- **WHEN** a `files:download { datasourceId: "ds-1", path: "/welcome.pdf", toPath: <…> }` is dispatched while the registry already contains an entry for `(ds-1, /welcome.pdf)`
- **THEN** the handler rejects the second request with `{ ok: false, error: { tag: "other", message: "download already in progress for this entry", retryable: false } }`; no `engine.downloadFile` call is issued for the second request; the first download's registry entry and event stream are unaffected

## MODIFIED Requirements

### Requirement: IPC command surface

The service SHALL accept and correctly respond to the following commands on
its IPC channel: `sync:enqueue-upload`, `sync:enqueue-mirror`,
`sync:list-jobs`, `sync:get-job`, `sync:cancel-job`, `sync:subscribe-events`,
`sync:unsubscribe-events`, `sync:set-retry-policy`, `sync:get-retry-policy`,
`sync:authenticate-start`, `sync:authenticate-complete`,
`sync:authenticate-cancel`, `sync:get-config`, `sync:set-config`,
`sync:delete-credentials`, `sync:get-status`, `files:list`, `files:stat`,
`files:search`, `files:remove`, `files:rename`, `files:download`,
`downloads:list-active`. The previous monolithic `sync:authenticate`
command SHALL NOT be present (per the prior change). Request and response
types for every command SHALL be declared in `@ft5/ipc-contracts/sync-service`
as discriminated unions, keyed by the `command` field. Any command frame
whose `command` is not in this enumerated set SHALL receive a response
with `ok: false, error.tag === 'unknown-command'`.

The new `files:rename` and `files:download` commands SHALL each accept
`{ datasourceId: string, … }` and resolve the engine client for that
`datasourceId` via the service's existing `ClientFactory`. The response
envelope SHALL be a discriminated union `{ ok: true, value: T } | { ok:
false, error: { tag: FilesErrorTag, message: string, retryable: boolean,
retryAfterMs?: number, existingPath?: string } }` where `FilesErrorTag` is
extended to include `Conflict` (the new tag carrying the optional
`existingPath` field).

`T` for `files:rename` is `{ entry: DatasourceFileEntry }`. `T` for
`files:download` is `{ savedPath: string, bytes: number }`. `T` for
`downloads:list-active` is `{ jobs: DownloadJob[] }`.

#### Scenario: New file commands are present

- **WHEN** a contract test imports the command-name enumeration from `@ft5/ipc-contracts/sync-service`
- **THEN** `"files:rename"`, `"files:download"`, and `"downloads:list-active"` are each present exactly once

#### Scenario: FilesErrorTag includes Conflict

- **WHEN** a contract test imports the `FilesErrorTag` constant
- **THEN** `Conflict: "conflict"` is among its members; the type derived from `(typeof FilesErrorTag)[keyof typeof FilesErrorTag]` includes the literal `"conflict"`
