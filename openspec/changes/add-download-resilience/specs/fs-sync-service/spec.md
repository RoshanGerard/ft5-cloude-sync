# Spec delta: fs-sync-service — download resilience

## ADDED Requirements

### Requirement: `files:download` handler retries mid-stream environmental failures within a per-cycle budget

The `files:download` handler SHALL retry mid-stream failures whose normalized engine error tag is `network-error`, `rate-limited`, or `provider-error` AND whose `retryable` flag is `true`. Other tags — including `auth-revoked`, `not-found`, `conflict`, `unsupported`, `cancelled`, `invalid-datasource`, and any `provider-error` whose `retryable` flag is `false` — SHALL terminate immediately. `auth-expired` retains its existing handler-side slot (`MAX_AUTH_RETRIES_PER_CYCLE = 1`) and SHALL NOT be folded into the environmental retry budget.

The retry budget is two-dimensional:

- A consecutive-failure counter, hard-capped at `CONSECUTIVE_FAIL_LIMIT = 5`. The counter increments on every retried environmental failure that drained zero new bytes since the prior attempt and resets to zero whenever the next attempt drains at least one new byte (`bytesWrittenAfter > bytesWrittenBefore`). Sixth consecutive failure SHALL emit `download-failed { tag: "exhausted-retries", message: "exhausted-retries: <engineCause>" }`.
- A wall-time ceiling, captured at the first `engine.downloadFile` call, hard-capped at `WALLTIME_CEILING_MS = 30 * 60 * 1000`. Any retry whose computed sleep would push the elapsed wall time past the ceiling SHALL emit `download-failed { tag: "exhausted-retries", message: "walltime-exceeded: <engineCause>" }` instead of sleeping.

The wait between a failure and the next retry SHALL be `max(err.retryAfterMs ?? 0, expBackoff(consecutiveFailureCount))` where `expBackoff(n) = min(1000 * 2^(n-1), 30000)`. The wait SHALL be cancellable via the handler's existing `AbortController` — a cancel during sleep SHALL resolve the sleep immediately and emit `download-cancelled` rather than the next retry.

#### Scenario: Network drop mid-stream recovers transparently

- **WHEN** the engine stream errors with `DatasourceError { tag: "network-error", retryable: true }` after 240MB of a 380MB file have drained, and the next `engine.downloadFile { rangeStart: 240MB }` call succeeds and the pipe drains the remaining bytes
- **THEN** the handler emits one `download-retrying { downloadJobId, datasourceId, attempt: 1, limit: 5, waitMs: 1000, engineCause: "network-error" }` before sleeping; on success the handler emits `file-downloaded { downloadJobId, savedPath, bytes: <fullsize> }` and the registry entry is removed; no `download-failed` event fires

#### Scenario: Five consecutive environmental failures exhaust the budget

- **WHEN** `engine.downloadFile` errors with `DatasourceError { tag: "network-error", retryable: true }` five times in a row, with zero bytes drained between each attempt
- **THEN** the handler emits `download-retrying` events with `attempt: 1, 2, 3, 4, 5` then emits exactly one `download-failed { downloadJobId, datasourceId, tag: "exhausted-retries", message: "exhausted-retries: network-error" }`; the registry entry is removed; the partial file is preserved on disk

#### Scenario: Successful byte progress resets the consecutive counter

- **WHEN** a sequence of attempts: failure (attempt 1) → success drains 50MB → failure (next attempt) → success drains the rest
- **THEN** the second failure emits `download-retrying { attempt: 1 }` (NOT `attempt: 2`) because the intervening byte progress reset the counter; the download completes successfully

#### Scenario: Wall-time ceiling supersedes count budget

- **WHEN** environmental failures arrive sparsely over 28 minutes such that `consecutiveFailureCount = 3` at minute 28, and the next failure's chosen `waitMs` would push the elapsed time past 30 minutes
- **THEN** the handler emits `download-failed { downloadJobId, datasourceId, tag: "exhausted-retries", message: "walltime-exceeded: <engineCause>" }` without sleeping; the registry entry is removed; the partial file is preserved on disk

#### Scenario: Rate-limited error honors `retryAfterMs`

- **WHEN** `engine.downloadFile` errors with `DatasourceError { tag: "rate-limited", retryable: true, retryAfterMs: 5000 }` at the moment when `expBackoff(1) = 1000`
- **THEN** the handler's `download-retrying` event payload carries `waitMs: 5000` (not `1000`); the handler sleeps the full 5000ms before retrying

#### Scenario: Cancel during retry sleep terminates immediately

- **WHEN** the handler is sleeping during an environmental retry and `sync:cancel-download { downloadJobId }` is dispatched
- **THEN** the sleep resolves immediately on the abort signal; the handler emits exactly one `download-cancelled { downloadJobId, bytesDownloaded, bytesTotal, reason: "user" }`; no further `download-retrying` events fire; the partial file is preserved on disk

#### Scenario: Non-retryable tag bypasses the environmental budget

- **WHEN** `engine.downloadFile` errors with `DatasourceError { tag: "auth-revoked", retryable: false }` mid-stream
- **THEN** the handler emits `download-failed { downloadJobId, datasourceId, tag: "auth-revoked", message }` immediately; no `download-retrying` events fire; no sleep is taken; the partial file is preserved on disk

### Requirement: Service emits `download-retrying` event during environmental retry sleeps

The fs-sync IPC bus SHALL emit a `download-retrying` event at the START of each environmental-retry sleep — after the budget and wall-time checks pass and before `sleepCancellable` is awaited. Every retry attempt emits exactly one `download-retrying` event; the event is NOT subject to coalescing or throttling at the fs-sync IPC layer (the fs-sync bus is uncoalesced; the engine-bus coalescer that throttles `downloading` does not apply to fs-sync IPC emissions). The payload shape:

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

### Requirement: Terminal failure disposition deletes the partial file when bytes are corrupt-and-not-recoverable

The handler SHALL `unlink` the partial file at `params.toPath` BEFORE emitting `download-failed` when the terminal cause is one of:

- `RangeNotHonoredError` — provider returned 200 OK on a `Range: bytes=N-` request (`bytesWritten > 0` and `result.contentRange === undefined`).
- `RangeMismatchError` — provider returned 206 Partial Content with `result.contentRange.start !== bytesWritten`.
- `IntegrityFailedError` — post-download provider hash comparison failed.

The handler SHALL preserve the partial file on disk for every other terminal cause, including `ByteCountMismatchError` (`bytesWritten ≠ contentLength` after pipe-drain), environmental budget exhaustion, wall-time ceiling, `auth-revoked`, and user cancellation. `unlink` failure (e.g., `EACCES`, `ENOENT`) SHALL be logged as a warning but SHALL NOT change the emitted terminal event — the user can clean up manually.

The disposition decision derives from the principle: the bytes are corrupt or unrecoverable, the partial cannot be auto-resumed, and leaving it on disk would mislead the user.

#### Scenario: Range-not-honored on resume deletes the partial

- **WHEN** a `files:download` cycle drains 240MB then errors; on the next attempt with `Range: bytes=251658240-`, the engine returns a 200 OK without `contentRange`
- **THEN** the handler `unlink`s the file at `params.toPath` and emits `download-failed { downloadJobId, datasourceId, tag: "other", message: "range not supported on this resource" }`; the file no longer exists at `params.toPath`

#### Scenario: Range-mismatch deletes the partial

- **WHEN** a resume attempt with `Range: bytes=240000000-` returns 206 Partial Content with `contentRange.start = 100000000`
- **THEN** the handler `unlink`s the file at `params.toPath` and emits `download-failed { downloadJobId, datasourceId, tag: "other", message: "range mismatch on this resource" }`; the file no longer exists at `params.toPath`

#### Scenario: Integrity-failed deletes the partial

- **WHEN** the pipe drains cleanly, the post-download local hash computes successfully, and the local digest does not match the provider-advertised `md5Checksum` / `sha256Hash` / etc.
- **THEN** the handler `unlink`s the file at `params.toPath` and emits `download-failed { downloadJobId, datasourceId, tag: "other", message: "integrity check failed" }`

#### Scenario: Byte-count-mismatch keeps the partial

- **WHEN** the pipe drains cleanly but `bytesWritten = 999_999_999` while the provider's `contentLength = 1_000_000_000`
- **THEN** the handler emits `download-failed { downloadJobId, datasourceId, tag: "other", message: "byte count mismatch" }`; the file at `params.toPath` is preserved (not unlinked)

#### Scenario: Exhausted-retries keeps the partial

- **WHEN** environmental retries exhaust at attempt 6 with 240MB on disk
- **THEN** the handler emits `download-failed { downloadJobId, datasourceId, tag: "exhausted-retries", message: "exhausted-retries: <engineCause>" }`; the file at `params.toPath` is preserved

#### Scenario: User-cancelled keeps the partial

- **WHEN** the user cancels a download mid-stream at 240MB
- **THEN** the handler emits `download-cancelled { downloadJobId, bytesDownloaded, bytesTotal, reason: "user" }`; the file at `params.toPath` is preserved

#### Scenario: `unlink` failure is non-fatal

- **WHEN** disposition rules call for the partial to be deleted but `unlink` rejects with `EACCES`
- **THEN** the handler logs a warning containing the rejection reason but emits the same `download-failed` event with the cause-appropriate `tag` and `message`; the file remains on disk

### Requirement: `FilesErrorTag` includes `exhausted-retries`

The wire-level `FilesErrorTag` enumeration in `@ft5/ipc-contracts` SHALL include the value `"exhausted-retries"`. This tag SHALL be emitted exclusively by the `files:download` handler's environmental-retry exhaustion paths (consecutive-failure budget exhausted OR wall-time ceiling exceeded). Both exhaustion modes share the same tag; the discriminator (count vs wall-time) lives in the message field as `"exhausted-retries: <engineCause>"` or `"walltime-exceeded: <engineCause>"`.

The renderer's `download-failed` toast logic SHALL recognize `tag: "exhausted-retries"` and present the existing Retry affordance; the failure presentation SHALL include the message text so the user can read what kind of exhaustion occurred.

#### Scenario: Tag is exposed at the wire level

- **WHEN** TypeScript code imports `FilesErrorTag` from `@ft5/ipc-contracts`
- **THEN** `"exhausted-retries"` is one of the type's literal members; tools that exhaustively switch on `FilesErrorTag` see it as a required case

#### Scenario: Renderer treats the new tag like an existing failure

- **WHEN** the renderer receives `download-failed { downloadJobId, datasourceId, tag: "exhausted-retries", message: "exhausted-retries: network-error" }`
- **THEN** the failure toast renders with the existing failed-state appearance, the Retry button is enabled, and the toast text includes the message string verbatim

## MODIFIED Requirements

### Requirement: Service handler emits `downloading` / terminal events on the IPC stream

The `files:download` handler SHALL emit consumer-domain events on the service's IPC event channel. These events are DERIVED, not relayed: fs-sync subscribes to the engine bus's four download lifecycle events (`downloading`, `file-downloaded`, `download-failed`, `download-cancelled` per the engine spec) and applies a business-logic transformation — minting a `downloadJobId`, throttling progress, running the integrity check post-pipe, applying retry policy, updating the DownloadRegistry — before emitting fs-sync's own desktop-facing events. The fs-sync wire shapes differ from the engine bus shapes: engine bus payloads are keyed by `(datasourceId, path)` and carry raw vendor facts; fs-sync payloads are keyed by `downloadJobId` and carry business-decoration metadata. fs-sync events are NOT a re-broadcast of engine events.

The fs-sync wire shapes:

- `downloading { downloadJobId, datasourceId, progress, path }` — high-frequency progress; throttling is performed upstream at the engine-bus coalescer (1s OR 10-percentage-point window) before the handler emits to fs-sync's IPC bus.
- `download-retrying { downloadJobId, datasourceId, attempt, limit, waitMs, engineCause }` — emitted at the start of each environmental-retry sleep (NOT for the auth-expired Layer 2 branch). One event per retry attempt; not coalesced.
- `file-downloaded { downloadJobId, datasourceId, savedPath, bytes }` — terminal success.
- `download-failed { downloadJobId, datasourceId, tag, message }` — terminal failure.
- `download-cancelled { downloadJobId, datasourceId, bytesDownloaded, bytesTotal, reason }` — terminal cancel.

The handler invokes the engine's `onProgress` callback hook to drive the synchronous progress accounting (registry updates and the throttled `downloading` IPC emission). Terminal events emit exactly once per download. The handler treats engine bus subscription as the canonical source for cross-cutting download lifecycle observation; the synchronous callback is the low-overhead direct-caller path that mirrors the same byte-flow.

A client subscribed via `sync:subscribe-events` for a specific `datasourceId` SHALL receive only events for that datasource; subscriptions without a filter SHALL receive all events.

#### Scenario: Downloading progress streams to subscriber

- **WHEN** a client subscribes via `sync:subscribe-events { datasourceId: "ds-1" }` and a `files:download` is in flight for `ds-1`
- **THEN** the client receives `downloading { downloadJobId, progress: <0..100>, path }` events at the throttled rate; on terminal completion the client receives exactly one `file-downloaded { downloadJobId, savedPath, bytes }`
