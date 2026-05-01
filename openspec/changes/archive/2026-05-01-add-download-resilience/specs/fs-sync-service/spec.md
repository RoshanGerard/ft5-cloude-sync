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

- `RangeMismatchError` — provider returned 206 Partial Content with `result.contentRange.start !== bytesWritten`.
- `IntegrityFailedError` — post-download provider hash comparison failed.

The handler SHALL preserve the partial file on disk for every other terminal cause, including `ByteCountMismatchError` (`bytesWritten ≠ contentLength` after pipe-drain), environmental budget exhaustion, wall-time ceiling, `auth-revoked`, and user cancellation. `unlink` failure (e.g., `EACCES`, `ENOENT`) SHALL be logged as a warning but SHALL NOT change the emitted terminal event — the user can clean up manually.

The disposition decision derives from the principle: the bytes are corrupt or unrecoverable, the partial cannot be auto-resumed, and leaving it on disk would mislead the user.

NOTE: `RangeNotHonoredError` is no longer in the terminal-disposition set per the iter-4 rewrite of Decision 3. Range-not-honored on a resume request now triggers a one-shot in-flight rewrite-from-0 (consuming one env-retry budget slot, unlinking the partial as part of the in-flight reset, restarting the cycle from byte 0 with `rangeUnsupported = true` for the rest of this download). The unlink at the rewrite trigger point is a non-terminal, in-flight cleanup — separate from the terminal-disposition path described in this requirement. See the dedicated requirement below ("`files:download` handler retries range-not-honored once via in-flight rewrite-from-0") for the rewrite-from-0 mechanics.

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

### Requirement: `files:download` handler retries range-not-honored once via in-flight rewrite-from-0

When a resume attempt within a `files:download` cycle (`bytesWritten > 0` AND a `Range: bytes=N-` header was sent) returns 200 OK without a `Content-Range` header (i.e., `result.contentRange === undefined`), the handler SHALL treat this as a recoverable failure on the first occurrence within this single `files:download` call. The handler SHALL:

1. Increment `consecutiveFailureCount` (consume one env-retry budget slot).
2. Apply env-retry budget guards: if `consecutiveFailureCount > CONSECUTIVE_FAIL_LIMIT`, raise `ExhaustedRetriesError("range-not-honored")`; if `now() - walltimeStartedAt > WALLTIME_CEILING_MS`, raise `WalltimeExceededError("range-not-honored")`.
3. Destroy the open response stream (it carries the full body the handler is about to discard).
4. Emit `download-retrying { downloadJobId, datasourceId, attempt: consecutiveFailureCount, limit: CONSECUTIVE_FAIL_LIMIT, waitMs: 0, engineCause: "range-not-honored" }`. `waitMs` SHALL be `0` — no sleep precedes the rewrite, since the failure is deterministic provider behavior (not a transient blip).
5. `await deps.fs.unlink(params.toPath).catch(() => {})` — drop the partial on disk. Failure (e.g., `EACCES`) SHALL be silent — the next `flags: "w"` open will truncate.
6. Set the closure-scoped `rangeUnsupported = true` flag, sticky for the remainder of THIS `files:download` call.
7. Reset `bytesWritten = 0`.
8. Continue the inner loop.

The handler SHALL gate the engine call's `rangeStart` parameter via:

```
const effectiveRangeStart = rangeUnsupported ? 0 : bytesWritten;
```

`effectiveRangeStart` SHALL be passed as the `DownloadOptions.rangeStart` field on EVERY `engine.downloadFile` call within the cycle. Once `rangeUnsupported = true`, no Range header is sent for subsequent attempts within this download — the strategy's existing `if (rangeStart > 0)` guard skips the Range header when `effectiveRangeStart === 0`. This invariant SHALL be preserved across env-retry sleeps and any subsequent partial-progress / failure within the same download.

If a subsequent failure-and-recovery cycle within the same download drains some bytes (`bytesWritten` grows again), and another mid-stream environmental failure fires, the env-retry sleep+continue path SHALL still use `effectiveRangeStart === 0` (the gate is sticky). The result: the same range-unsupported provider sees a fresh GET each time, mostly successful within one attempt for the typical case.

The `engineCause` value `"range-not-honored"` is a handler-side sentinel string, NOT an engine `DatasourceErrorTag`. The wire field is typed `string` (`download-retrying.engineCause`) so this is contract-compatible. Renderer code SHALL NOT branch on this value.

This requirement SHALL NOT affect the terminal-disposition path: range-not-honored is no longer a terminal cause under normal flow (the rewrite-from-0 path handles every first occurrence). If subsequent failures during the rewrite-from-0 phase exhaust the env-retry budget or the wall-time ceiling, terminal disposition follows the existing rules (env-budget-exhausted / walltime-exceeded keep the partial).

#### Scenario: Range-not-honored on resume triggers rewrite-from-0

- **WHEN** a `files:download` cycle drains 240MB then errors with `tag: "network-error", retryable: true`; the env-retry branch sleeps 1000ms; on the next attempt with `Range: bytes=251658240-`, the engine returns 200 OK without `contentRange`
- **THEN** the handler emits `download-retrying { downloadJobId, datasourceId, attempt: 2, limit: 5, waitMs: 0, engineCause: "range-not-honored" }`; `deps.fs.unlink(params.toPath)` is called; on the next `engine.downloadFile` invocation, `options.rangeStart === 0` (NOT `251658240`); subsequent attempts in this download all carry `rangeStart = 0`; the download eventually completes from byte 0 and emits `file-downloaded`

#### Scenario: Rewrite-from-0 consumes env-retry budget slots

- **WHEN** a download experiences five range-not-honored events in a row (across multiple wifi blips, each followed by a Range request that the server rejects with 200 OK), with no byte progress between them
- **THEN** the handler emits five `download-retrying` events with `attempt: 1..5` and `engineCause: "range-not-honored"`; the sixth occurrence emits `download-failed { tag: "exhausted-retries", message: "exhausted-retries: range-not-honored" }`; the partial file is preserved per the existing env-budget-exhaustion disposition

#### Scenario: Rewrite-from-0 with subsequent successful download

- **WHEN** a download triggers rewrite-from-0 once (range-not-honored on first resume), then completes cleanly from byte 0 within the env-retry budget
- **THEN** exactly one `download-retrying { engineCause: "range-not-honored", waitMs: 0 }` event fires; `deps.fs.unlink` is called once; the final `file-downloaded` event fires with the correct byte count; no `download-failed` event fires

#### Scenario: rangeUnsupported flag is sticky for the download's lifetime

- **WHEN** a download triggers rewrite-from-0, then experiences a network-error mid-stream during the byte-0 restart (after some bytes drained), and the env-retry sleep+continue path retries
- **THEN** the retry's `engine.downloadFile` call carries `rangeStart: 0` (NOT `bytesWritten`), even though `bytesWritten > 0` at this point — the `rangeUnsupported` flag overrides the bytes-written-based resume

### Requirement: `FilesErrorTag` includes `exhausted-retries`

The wire-level `FilesErrorTag` enumeration in `@ft5/ipc-contracts` SHALL include the value `"exhausted-retries"`. This tag SHALL be emitted exclusively by the `files:download` handler's environmental-retry exhaustion paths (consecutive-failure budget exhausted OR wall-time ceiling exceeded). Both exhaustion modes share the same tag; the discriminator (count vs wall-time) lives in the message field as `"exhausted-retries: <engineCause>"` or `"walltime-exceeded: <engineCause>"`.

The renderer's `download-failed` toast logic SHALL recognize `tag: "exhausted-retries"` and present the existing Retry affordance; the failure presentation SHALL include the message text so the user can read what kind of exhaustion occurred.

#### Scenario: Tag is exposed at the wire level

- **WHEN** TypeScript code imports `FilesErrorTag` from `@ft5/ipc-contracts`
- **THEN** `"exhausted-retries"` is one of the type's literal members; tools that exhaustively switch on `FilesErrorTag` see it as a required case

#### Scenario: Renderer treats the new tag like an existing failure

- **WHEN** the renderer receives `download-failed { downloadJobId, datasourceId, tag: "exhausted-retries", message: "exhausted-retries: network-error" }`
- **THEN** the failure toast renders with the existing failed-state appearance, the Retry button is enabled, and the toast text includes the message string verbatim

### Requirement: `files:download` handler prefetches resource size before the cycle loop

The `files:download` handler SHALL issue exactly one `client.getMetadata(target)` call BEFORE entering the cycle/attempt loop. The returned `FileMetadata.size` field (when defined and non-null) SHALL be captured into handler-scoped state (`prefetchedSize: number | null`) and used as the fallback value for `bytesTotal` on subsequent `downloading` IPC events whenever the engine response does NOT advertise a `Content-Length` header. The prefetch SHALL be wrapped with the handler's own `AbortController + setTimeout` (10-second budget) composed with the user-cancel signal, because the engine's `getMetadata(target: Target): Promise<FileMetadata<T>>` signature does not accept an `AbortSignal` parameter.

Failure semantics — ALL of the following set `prefetchedSize: null` and continue the download with bytes-only progress fallback (the renderer's existing rare-path behavior):

- The prefetch resolves with `metadata.size === undefined` (e.g. the resource is a Google Docs export — Drive does not store a fixed binary size for native Docs; or the resource is a folder).
- The prefetch rejects with any `DatasourceError` (network-error, auth-revoked, not-found, rate-limited, etc.). The download's own retry layers handle the same errors during the GET phase, so a transient prefetch failure SHALL NOT terminate the download.
- The prefetch times out (10 s budget elapsed without resolution). The handler aborts the prefetch via its wrapper controller.

User cancellation during the prefetch window (i.e. `sync:cancel-download` arrives before the cycle loop starts) SHALL short-circuit to the same terminal-cancel handler the rest of the flow uses: emit `download-cancelled { reason: "user", bytesDownloaded: 0, bytesTotal: prefetchedSize ?? null }` and return the cancel envelope. No `download-failed` event SHALL be emitted on user-cancel during prefetch.

The prefetched `size` value SHALL NOT be reused for the post-pipe integrity hash check (the existing post-pipe `client.getMetadata(target)` call at the success path remains a SEPARATE round-trip). Rationale: prefetch captures size at start-of-download for progress UI; post-pipe captures the resource's hash at end-of-download for byte-equivalence verification — semantically distinct purposes. Reusing the prefetched object's hash would silently miss the case where another client overwrote the resource on the provider during the download window.

The handler-scoped `prefetchedSize` SHALL persist across all retry cycles and rewrite-from-0 paths within the same `files:download` invocation. Subsequent attempts that re-issue `engine.downloadFile(...)` SHALL benefit from the same fallback without re-issuing the prefetch.

The registry's `DownloadJobEntry.contentLength` field SHALL be seeded with `prefetchedSize` immediately after a successful prefetch (before any `downloading` event arrives). Subsequent `downloading` events whose engine `total` is `null` SHALL NOT overwrite the registry's existing `contentLength` with `null`; the rule SHALL be "preserve existing contentLength when the new value is null." Engine-reported `total` (when non-null) takes priority — a resume cycle that picks up a newly-advertised `Content-Length` SHALL update `contentLength` accordingly.

#### Scenario: Drive media file without Content-Length surfaces percentage via metadata prefetch

- **WHEN** the handler runs for a Google Drive native MP4 (`?alt=media` does NOT advertise a `Content-Length` header), `client.getMetadata(target)` resolves with `metadata.size === 398458880` (380 MB), and the engine emits successive `downloading { loaded: 167_772_160, total: null }` events
- **THEN** the handler-scoped `prefetchedSize === 398458880`; each derived fs-sync `downloading` IPC event carries `bytesTotal: 398458880` (NOT null) and `progress: 42`; the registry's `DownloadJobEntry.contentLength` settles at `398458880` and is NOT overwritten by the null-total engine events

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

- **WHEN** the prefetch resolves with `size: 379_000_000` AND the engine's `downloading` events carry `total: 398_458_880` (e.g. Drive published an updated Content-Length on the GET that disagrees with stale metadata)
- **THEN** the handler emits `downloading { bytesTotal: 398_458_880 }` (engine value); the registry's `contentLength` settles at `398_458_880`; `prefetchedSize` is ignored at the wire layer when the engine has fresher data

#### Scenario: Doc-export with no metadata size falls back to bytes-only

- **WHEN** the handler runs for a Google Docs export and `client.getMetadata(target)` resolves with `metadata.size === undefined` (Drive does not publish a binary size for native Docs files), and the engine's GET likewise does not advertise `Content-Length`
- **THEN** `prefetchedSize: null`; subsequent `downloading` events carry `bytesTotal: null`; the renderer's bytes-only fallback engages

#### Scenario: Prefetched size is NOT reused for the post-pipe integrity hash

- **WHEN** the handler succeeds in prefetching `metadata.size` AND the download completes successfully
- **THEN** the post-pipe integrity check still issues a SEPARATE `client.getMetadata(target)` call to capture the resource's current hash (`md5Checksum` for Drive, `sha1Hash` / `sha256Hash` for OneDrive, etc.); the prefetched metadata object is NOT reused as `finalEntryForHash`; the integrity check sees the freshest provider hash, defending against mid-stream overwrites by other clients

## MODIFIED Requirements

### Requirement: Service handler emits `downloading` / terminal events on the IPC stream

The `files:download` handler SHALL emit consumer-domain events on the service's IPC event channel. These events are DERIVED, not relayed: fs-sync subscribes to the engine bus's four download lifecycle events (`downloading`, `file-downloaded`, `download-failed`, `download-cancelled` per the engine spec) and applies a business-logic transformation — minting a `downloadJobId`, throttling progress, running the integrity check post-pipe, applying retry policy, updating the DownloadRegistry — before emitting fs-sync's own desktop-facing events. The fs-sync wire shapes differ from the engine bus shapes: engine bus payloads are keyed by `(datasourceId, path)` and carry raw vendor facts; fs-sync payloads are keyed by `downloadJobId` and carry business-decoration metadata. fs-sync events are NOT a re-broadcast of engine events.

The fs-sync wire shapes:

- `downloading { downloadJobId, datasourceId, progress, path, bytesLoaded, bytesTotal }` — high-frequency progress; throttling is performed upstream at the engine-bus coalescer (1s OR 10-percentage-point window) before the handler emits to fs-sync's IPC bus. The `progress` field SHALL be the integer percentage when `bytesTotal !== null && bytesTotal > 0` (computed as `floor(bytesLoaded / bytesTotal * 100)`, clamped to `[0..100]`); the `progress` field SHALL be `0` when `bytesTotal === null` or `bytesTotal === 0`. The `bytesLoaded` field SHALL be the integer number of bytes drained from the engine response stream. The `bytesTotal` field SHALL be the **best-known total size of the resource**: the engine response's `contentLength` (the value of the `Content-Length` HTTP header parsed as an integer) when present, OR the metadata-derived `size` field captured by the handler's pre-cycle `client.getMetadata(target)` prefetch (see "Requirement: `files:download` handler prefetches resource size before the cycle loop" below), OR `null` when both sources are absent. Renderers SHALL prefer `(bytesLoaded, bytesTotal)` as the source of truth for display, falling back to a bytes-only progress format when `bytesTotal` is null (see file-explorer spec.md "Download toast renders combined percent+size when total is known, falls back to bytes-only when total is unknown").
- `download-retrying { downloadJobId, datasourceId, attempt, limit, waitMs, engineCause }` — emitted at the start of each environmental-retry sleep (NOT for the auth-expired Layer 2 branch). One event per retry attempt; not coalesced.
- `file-downloaded { downloadJobId, datasourceId, savedPath, bytes }` — terminal success.
- `download-failed { downloadJobId, datasourceId, tag, message }` — terminal failure.
- `download-cancelled { downloadJobId, datasourceId, bytesDownloaded, bytesTotal, reason }` — terminal cancel.

The handler invokes the engine's `onProgress` callback hook to drive the synchronous progress accounting (registry updates and the throttled `downloading` IPC emission). Terminal events emit exactly once per download. The handler treats engine bus subscription as the canonical source for cross-cutting download lifecycle observation; the synchronous callback is the low-overhead direct-caller path that mirrors the same byte-flow.

A client subscribed via `sync:subscribe-events` for a specific `datasourceId` SHALL receive only events for that datasource; subscriptions without a filter SHALL receive all events.

#### Scenario: Downloading progress streams to subscriber

- **WHEN** a client subscribes via `sync:subscribe-events { datasourceId: "ds-1" }` and a `files:download` is in flight for `ds-1` against a provider that returns `Content-Length: 398458880`
- **THEN** the client receives `downloading { downloadJobId, datasourceId: "ds-1", progress: <0..100>, path, bytesLoaded: <0..398458880>, bytesTotal: 398458880 }` events at the throttled rate; on terminal completion the client receives exactly one `file-downloaded { downloadJobId, savedPath, bytes }`

#### Scenario: Downloading progress with provider-omitted Content-Length surfaces null bytesTotal

- **WHEN** a client subscribes via `sync:subscribe-events { datasourceId: "ds-1" }` and a `files:download` is in flight for `ds-1` against a provider that returns no `Content-Length` header (e.g., chunked transfer encoding for large media)
- **THEN** the client receives `downloading { downloadJobId, datasourceId: "ds-1", progress: 0, path, bytesLoaded: <growing integer>, bytesTotal: null }` events at the throttled rate; the `progress` field stays `0` throughout (since total is unknown) but `bytesLoaded` increments toward the file's true size; on terminal completion the client receives exactly one `file-downloaded { downloadJobId, savedPath, bytes }`
