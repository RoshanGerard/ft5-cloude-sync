# fs-sync-service

## ADDED Requirements

### Requirement: Service drives DownloadRegistry transitions from `onProgress` and the download outcome

The `files:download` handler SHALL drive `DownloadRegistry` state transitions from two in-process sources, NOT from any engine event bus (the engine has no event bus):

- **Progress** — the engine's synchronous `options.onProgress(loaded, total)` callback. On each tick the handler updates the in-flight entry's `bytesDownloaded = loaded` and `contentLength = total` (subject to the handler's 1s-OR-10%-delta throttle; see "In-memory `DownloadRegistry` tracks active downloads").
- **Terminal outcome** — the `engine.downloadFile` promise and the returned stream's lifecycle. A clean stream `end` (after the handler's integrity check) is success; a stream `error` / rejected promise is failure; an abort-signal-driven rejection is cancel. On any terminal outcome the handler removes the registry entry and emits the corresponding fs-sync event (`file-downloaded` / `download-failed` / `download-cancelled`) on the IPC stream.

The handler already holds the `downloadJobId` for the in-flight call in its own closure (it minted it), so progress and terminal correlation require no engine-event lookup. The registry SHALL maintain a reverse index from `(datasourceId, path)` to `downloadJobId`. v1 enforces at most one in-flight download per `(datasourceId, path)`; a second `files:download` request whose `(datasourceId, path)` already exists in the registry SHALL be rejected with `{ ok: false, error: { tag: "other", message: "download already in progress for this entry", retryable: false } }` before any engine call is issued.

#### Scenario: onProgress updates the registry

- **WHEN** the engine invokes `onProgress(524288, 1048576)` for the in-flight download whose registry entry is keyed `downloadJobId: "job-A"`
- **THEN** the entry's `bytesDownloaded` updates to `524288` (subject to the handler throttle) and `contentLength` updates to `1048576`

#### Scenario: Successful download outcome removes the registry entry

- **WHEN** `engine.downloadFile`'s returned stream ends cleanly and the handler's integrity check resolves for `downloadJobId: "job-A"`
- **THEN** the registry no longer contains `job-A`; fs-sync emits `file-downloaded { downloadJobId: "job-A", savedPath, bytes }` on the IPC event channel exactly once (`savedPath` is the handler's pipe target — fs-sync owns it; the engine never writes to disk)

#### Scenario: Cancelled download outcome removes the registry entry

- **WHEN** `engine.downloadFile` rejects via the abort signal for `downloadJobId: "job-A"`
- **THEN** the registry no longer contains `job-A`; fs-sync emits `download-cancelled { downloadJobId: "job-A", bytesDownloaded, bytesTotal, reason }` on the IPC event channel exactly once

#### Scenario: Concurrent download for the same `(datasourceId, path)` is rejected

- **WHEN** a `files:download { datasourceId: "ds-1", path: "/welcome.pdf", toPath: <…> }` is dispatched while the registry already contains an entry for `(ds-1, /welcome.pdf)`
- **THEN** the handler rejects the second request with `{ ok: false, error: { tag: "other", message: "download already in progress for this entry", retryable: false } }`; no `engine.downloadFile` call is issued for the second request; the first download's registry entry and event stream are unaffected

## MODIFIED Requirements

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

The `files:download` handler SHALL `set` the entry on download start (when minting `downloadJobId`), update `bytesDownloaded` from the engine's `onProgress` callback on **every** tick (so the cancel/failure terminal payloads and `downloads:list-active` read the latest count), and `delete` the entry on terminal success / failure / cancellation. The DERIVED `downloading` IPC event (see "Service handler emits `downloading` / terminal events on the IPC stream") is handler-throttled at 1 second OR 10% progress delta — the engine no longer provides an event-bus coalescer, so the handler owns this throttle — with the latest pending progress flushed before the terminal event so the final byte count is never dropped or reordered ahead of the terminal.

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

#### Scenario: Final progress flushes before the terminal event

- **WHEN** a `files:download` completes after several throttled `onProgress` ticks
- **THEN** the handler emits a final `downloading` reflecting the last byte count BEFORE it emits the terminal `file-downloaded` on `sync:event-stream`, and no `downloading` update is emitted after the terminal event

### Requirement: Service handler emits `downloading` / terminal events on the IPC stream

The `files:download` handler SHALL emit consumer-domain events on the service's IPC event channel. These events are DERIVED, not relayed: fs-sync drives them from the engine's `downloadFile` call — its `options.onProgress` callback for progress, and the call's promise resolution / rejection (and the returned stream's lifecycle) for the terminal outcome — and applies a business-logic transformation — minting a `downloadJobId`, throttling progress, running the integrity check post-pipe, applying retry policy, updating the DownloadRegistry — before emitting fs-sync's own desktop-facing events. The fs-sync wire shapes differ from the engine's raw progress facts: the engine's `onProgress` reports raw `(loaded, total)` byte counts keyed by `(datasourceId, path)`; fs-sync payloads are keyed by `downloadJobId` and carry business-decoration metadata. fs-sync events are NOT a re-broadcast of engine events.

The fs-sync wire shapes:

- `downloading { downloadJobId, datasourceId, progress, path, bytesLoaded, bytesTotal }` — high-frequency progress; throttling is performed by the handler itself (1 second OR 10% progress-delta window), because the engine no longer provides an event-bus coalescer; the latest pending progress update SHALL be flushed before the terminal event so the final byte count is never dropped or emitted after the terminal. The `progress` field SHALL be the integer percentage when `bytesTotal !== null && bytesTotal > 0` (computed as `floor(bytesLoaded / bytesTotal * 100)`, clamped to `[0..100]`); the `progress` field SHALL be `0` when `bytesTotal === null` or `bytesTotal === 0`. The `bytesLoaded` field SHALL be the integer number of bytes drained from the engine response stream. The `bytesTotal` field SHALL be the **best-known total size of the resource**: the engine response's `contentLength` (the value of the `Content-Length` HTTP header parsed as an integer) when present, OR the metadata-derived `size` field captured by the handler's pre-cycle `client.getMetadata(target)` prefetch (see "Requirement: `files:download` handler prefetches resource size before the cycle loop" below), OR `null` when both sources are absent. Renderers SHALL prefer `(bytesLoaded, bytesTotal)` as the source of truth for display, falling back to a bytes-only progress format when `bytesTotal` is null (see file-explorer spec.md "Download toast renders combined percent+size when total is known, falls back to bytes-only when total is unknown").
- `download-retrying { downloadJobId, datasourceId, attempt, limit, waitMs, engineCause }` — emitted at the start of each environmental-retry sleep (NOT for the auth-expired Layer 2 branch). One event per retry attempt; not coalesced.
- `file-downloaded { downloadJobId, datasourceId, savedPath, bytes }` — terminal success.
- `download-failed { downloadJobId, datasourceId, tag, message }` — terminal failure.
- `download-cancelled { downloadJobId, datasourceId, bytesDownloaded, bytesTotal, reason }` — terminal cancel.

The handler invokes the engine's `onProgress` callback hook to drive the synchronous progress accounting (registry updates and the handler-throttled `downloading` IPC emission). Terminal events emit exactly once per download. The handler treats the engine's `downloadFile` promise resolution / rejection (and the returned stream's lifecycle) as the canonical source for the terminal outcome; the synchronous `onProgress` callback is the low-overhead direct-caller path that drives the byte-flow accounting.

A client subscribed via `sync:subscribe-events` for a specific `datasourceId` SHALL receive only events for that datasource; subscriptions without a filter SHALL receive all events.

#### Scenario: Downloading progress streams to subscriber

- **WHEN** a client subscribes via `sync:subscribe-events { datasourceId: "ds-1" }` and a `files:download` is in flight for `ds-1` against a provider that returns `Content-Length: 398458880`
- **THEN** the client receives `downloading { downloadJobId, datasourceId: "ds-1", progress: <0..100>, path, bytesLoaded: <0..398458880>, bytesTotal: 398458880 }` events at the throttled rate; on terminal completion the client receives exactly one `file-downloaded { downloadJobId, savedPath, bytes }`

#### Scenario: Downloading progress with provider-omitted Content-Length surfaces null bytesTotal

- **WHEN** a client subscribes via `sync:subscribe-events { datasourceId: "ds-1" }` and a `files:download` is in flight for `ds-1` against a provider that returns no `Content-Length` header (e.g., chunked transfer encoding for large media)
- **THEN** the client receives `downloading { downloadJobId, datasourceId: "ds-1", progress: 0, path, bytesLoaded: <growing integer>, bytesTotal: null }` events at the throttled rate; the `progress` field stays `0` throughout (since total is unknown) but `bytesLoaded` increments toward the file's true size; on terminal completion the client receives exactly one `file-downloaded { downloadJobId, savedPath, bytes }`

### Requirement: Service emits `download-retrying` event during environmental retry sleeps

The fs-sync IPC bus SHALL emit a `download-retrying` event at the START of each environmental-retry sleep — after the budget and wall-time checks pass and before `sleepCancellable` is awaited. Every retry attempt emits exactly one `download-retrying` event; the event is NOT subject to coalescing or throttling at the fs-sync IPC layer (the fs-sync bus is uncoalesced; the handler's own progress throttle that bounds `downloading` does not apply to `download-retrying`). The payload shape:

```
{
  downloadJobId: string,
  datasourceId: string,
  attempt: number,                    // current consecutiveFailureCount, 1-indexed
  limit: number,                      // CONSECUTIVE_FAIL_LIMIT (always 5)
  waitMs: number,                     // chosen sleep duration in ms
  engineCause: DatasourceErrorTag,    // diagnostic-only — engine-side error tag verbatim
}
```

The `engineCause` field is a deliberate engine-taxonomy leak scoped to diagnostic decoration. Renderer code SHALL NOT branch behavior on its value and SHALL NOT show it directly to users without further translation.

The event SHALL NOT be emitted for the auth-expired Layer 2 branch. Layer 2's retry path is fast (no sleep) and the user does not need a separate "refreshing token" indicator; the existing `downloading` stream pauses naturally during the engine's `withRefresh` cycle.

A subscriber filtering by `datasourceId` via `sync:subscribe-events { datasourceId: "ds-X" }` SHALL receive `download-retrying` events only for downloads on `ds-X`.

#### Scenario: Subscriber receives `download-retrying` during retry sleep

- **WHEN** a client is subscribed via `sync:subscribe-events { datasourceId: "ds-1" }` and a `files:download` for `ds-1` enters environmental retry on attempt 2 with a chosen wait of 2000ms
- **THEN** the client receives one `download-retrying { downloadJobId, datasourceId: "ds-1", attempt: 2, limit: 5, waitMs: 2000, engineCause: "network-error" }` event before the next `downloading` or `download-failed` event

#### Scenario: Auth-expired retry does NOT emit `download-retrying`

- **WHEN** the engine stream errors mid-stream with `tag: "auth-expired"` and the handler's Layer 2 branch re-issues `engine.downloadFile` (which triggers `withRefresh` to obtain a fresh access token) and the next attempt drains the rest of the file
- **THEN** no `download-retrying` event is emitted at any point in the cycle; the subscriber sees only `downloading` events with a brief pause during the refresh

### Requirement: `files:download` handler prefetches resource size before the cycle loop

The `files:download` handler SHALL issue exactly one `client.getMetadata(target)` call BEFORE entering the cycle/attempt loop. The returned `FileMetadata.size` field (when defined and non-null) SHALL be captured into handler-scoped state (`prefetchedSize: number | null`) and used as the fallback value for `bytesTotal` on subsequent `downloading` IPC events whenever the engine response does NOT advertise a `Content-Length` header. The prefetch SHALL be wrapped with the handler's own `AbortController + setTimeout` (10-second budget) composed with the user-cancel signal, because the engine's `getMetadata(target: Target): Promise<FileMetadata<T>>` signature does not accept an `AbortSignal` parameter.

Failure semantics — ALL of the following set `prefetchedSize: null` and continue the download with bytes-only progress fallback (the renderer's existing rare-path behavior):

- The prefetch resolves with `metadata.size === undefined` (e.g. the resource is a Google Docs export — Drive does not store a fixed binary size for native Docs; or the resource is a folder).
- The prefetch rejects with any `DatasourceError` (network-error, auth-revoked, not-found, rate-limited, etc.). The download's own retry layers handle the same errors during the GET phase, so a transient prefetch failure SHALL NOT terminate the download.
- The prefetch times out (10 s budget elapsed without resolution). The handler aborts the prefetch via its wrapper controller.

User cancellation during the prefetch window (i.e. `sync:cancel-download` arrives before the cycle loop starts) SHALL short-circuit to the same terminal-cancel handler the rest of the flow uses: emit `download-cancelled { reason: "user", bytesDownloaded: 0, bytesTotal: prefetchedSize ?? null }` and return the cancel envelope. No `download-failed` event SHALL be emitted on user-cancel during prefetch.

The prefetched `size` value SHALL NOT be reused for the post-pipe integrity hash check (the existing post-pipe `client.getMetadata(target)` call at the success path remains a SEPARATE round-trip). Rationale: prefetch captures size at start-of-download for progress UI; post-pipe captures the resource's hash at end-of-download for byte-equivalence verification — semantically distinct purposes. Reusing the prefetched object's hash would silently miss the case where another client overwrote the resource on the provider during the download window.

The handler-scoped `prefetchedSize` SHALL persist across all retry cycles and rewrite-from-0 paths within the same `files:download` invocation. Subsequent attempts that re-issue `engine.downloadFile(...)` SHALL benefit from the same fallback without re-issuing the prefetch.

The registry's `DownloadJobEntry.contentLength` field SHALL be seeded with `prefetchedSize` immediately after a successful prefetch (before any `downloading` event arrives). Subsequent `onProgress` ticks whose `total` is `null` SHALL NOT overwrite the registry's existing `contentLength` with `null`; the rule SHALL be "preserve existing contentLength when the new value is null." An `onProgress`-reported `total` (when non-null) takes priority — a resume cycle that picks up a newly-advertised `Content-Length` SHALL update `contentLength` accordingly.

#### Scenario: Drive media file without Content-Length surfaces percentage via metadata prefetch

- **WHEN** the handler runs for a Google Drive native MP4 (`?alt=media` does NOT advertise a `Content-Length` header), `client.getMetadata(target)` resolves with `metadata.size === 398458880` (380 MB), and the engine reports successive `onProgress(loaded, total)` ticks with `total: null` (e.g. `loaded: 167_772_160`)
- **THEN** the handler-scoped `prefetchedSize === 398458880`; each derived fs-sync `downloading` IPC event carries `bytesTotal: 398458880` (NOT null) and `progress: 42`; the registry's `DownloadJobEntry.contentLength` settles at `398458880` and is NOT overwritten by the null-total `onProgress` ticks

#### Scenario: Prefetch rejects → download still completes with bytes-only progress

- **WHEN** the handler runs and `client.getMetadata(target)` rejects with `DatasourceError({ tag: "network-error" })` while the subsequent `engine.downloadFile(target, ...)` completes successfully (no `Content-Length` advertised by the GET either)
- **THEN** the handler emits a warning log line, sets `prefetchedSize: null`, proceeds with the download; `downloading` events carry `bytesTotal: null` throughout; the renderer's bytes-only fallback engages; the terminal `file-downloaded` event fires normally

#### Scenario: Prefetch times out → download still completes

- **WHEN** the handler runs and `client.getMetadata(target)` does not resolve within the 10-second budget (e.g. a hung socket) while the subsequent `engine.downloadFile(target, ...)` completes successfully
- **THEN** the handler aborts the prefetch via its wrapper `AbortController`, emits a warning log line, sets `prefetchedSize: null`, proceeds with the download; the terminal `file-downloaded` event fires normally

#### Scenario: User cancels during prefetch window

- **WHEN** the handler is awaiting the prefetch and `sync:cancel-download { downloadJobId }` is dispatched
- **THEN** the user-cancel signal aborts the prefetch wrapper; the handler emits exactly one `download-cancelled { downloadJobId, datasourceId, bytesDownloaded: 0, bytesTotal: null, reason: "user" }`; no cycle loop iteration runs; no `engine.downloadFile` call is ever issued; no `download-failed` event fires

#### Scenario: Engine-reported Content-Length takes priority over prefetched size

- **WHEN** the prefetch resolves with `size: 379_000_000` AND the engine's `onProgress` ticks carry `total: 398_458_880` (e.g. Drive published an updated Content-Length on the GET that disagrees with stale metadata)
- **THEN** the handler emits `downloading { bytesTotal: 398_458_880 }` (engine value); the registry's `contentLength` settles at `398_458_880`; `prefetchedSize` is ignored at the wire layer when the engine has fresher data

#### Scenario: Doc-export with no metadata size falls back to bytes-only

- **WHEN** the handler runs for a Google Docs export and `client.getMetadata(target)` resolves with `metadata.size === undefined` (Drive does not publish a binary size for native Docs files), and the engine's GET likewise does not advertise `Content-Length`
- **THEN** `prefetchedSize: null`; subsequent `downloading` events carry `bytesTotal: null`; the renderer's bytes-only fallback engages

#### Scenario: Prefetched size is NOT reused for the post-pipe integrity hash

- **WHEN** the handler succeeds in prefetching `metadata.size` AND the download completes successfully
- **THEN** the post-pipe integrity check still issues a SEPARATE `client.getMetadata(target)` call to capture the resource's current hash (`md5Checksum` for Drive, `sha1Hash` / `sha256Hash` for OneDrive, etc.); the prefetched metadata object is NOT reused as `finalEntryForHash`; the integrity check sees the freshest provider hash, defending against mid-stream overwrites by other clients

## REMOVED Requirements

### Requirement: Service subscribes to engine bus events for download lifecycle

**Reason**: the engine EventBus is removed; fs-sync no longer subscribes to engine events. `DownloadRegistry` state transitions are now driven by the handler's own `options.onProgress` callback (progress) and the `engine.downloadFile` promise resolution / rejection (terminal outcome).
**Migration**: replaced by ADDED Requirement "Service drives DownloadRegistry transitions from `onProgress` and the download outcome", which preserves the one-in-flight-per-`(datasourceId, path)` guard, the `(datasourceId, path) → downloadJobId` reverse index, and the `download already in progress for this entry` rejection envelope.
