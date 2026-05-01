# Spec delta: file-explorer — toast UX during download retry

## ADDED Requirements

### Requirement: Download toast renders a steady "Reconnecting…" sub-status during environmental retry

The download Sonner toast SHALL retain its `Downloading <filename>` title throughout an environmental retry sleep. On receipt of a `download-retrying { attempt, limit, waitMs, engineCause }` IPC event, the toast subtext SHALL switch from the existing `<progress>% · <bytesDownloaded> / <bytesTotal>` format to `Reconnecting… (<attempt>/<limit>)`. The progress bar SHALL pause at the byte position last reported by `downloading`; it SHALL NOT rewind, animate, or pulse.

A small spinner glyph SHALL replace the percentage indicator in the subtext during the wait. The toast tooltip on hover SHALL expose the diagnostic context: `Last error: <engineCause>. Waiting <waitMs>ms before retry.`

When the next `downloading` event arrives (bytes flowing again), the subtext SHALL revert to the `<progress>% · <bytesDownloaded> / <bytesTotal>` format and the spinner glyph SHALL be replaced by the percentage. No transition animation between the two states is required.

The toast SHALL NOT change color, icon family, or visual prominence during retry. The intent is to minimize visual noise — most retries succeed within seconds, and a brief sub-status change is the correct level of signal for that frequency.

#### Scenario: Toast switches to Reconnecting sub-status on download-retrying

- **WHEN** a download toast is showing `62% · 240 MB / 380 MB` and a `download-retrying { downloadJobId: "job-A", datasourceId, attempt: 2, limit: 5, waitMs: 4000, engineCause: "network-error" }` event arrives
- **THEN** the toast subtext shows `Reconnecting… (2/5)` with a spinner glyph; the progress bar position remains at the same byte location; the title remains `Downloading <filename>`

#### Scenario: Toast snaps back to progress on next downloading event

- **WHEN** the toast is displaying `Reconnecting… (2/5)` and a `downloading { downloadJobId: "job-A", progress: 63 }` event arrives
- **THEN** the subtext immediately shows `63% · <bytes> / <total>` with the percentage indicator (no spinner glyph); the progress bar advances to the new position

#### Scenario: Toast tooltip exposes diagnostic context

- **WHEN** the toast is showing `Reconnecting… (2/5)` and the user hovers the toast
- **THEN** the tooltip shows `Last error: network-error. Waiting 4000ms before retry.` (or equivalent format) including both the `engineCause` and `waitMs`

#### Scenario: Toast does NOT change appearance for auth-expired retry

- **WHEN** an in-flight download experiences a mid-stream auth-expired and the handler's Layer 2 branch re-issues `engine.downloadFile` (no `download-retrying` event)
- **THEN** the toast appearance does NOT change to `Reconnecting…`; the progress bar pauses at the last position; on the next `downloading` event the toast resumes its normal progress display

### Requirement: Cancel during retry sleep terminates the download immediately

The toast's existing Cancel affordance SHALL remain functional during the `Reconnecting…` sub-status. Clicking Cancel during a retry sleep SHALL call `sync:cancel-download` as it does during normal download flow; the toast SHALL transition through the existing cancellation appearance and dismiss when `download-cancelled` arrives.

A user who clicks Cancel during a 4000ms retry sleep SHALL see the cancellation reflected in under 100ms — the toast SHALL NOT wait out the sleep before responding.

#### Scenario: Cancel during retry sleep dismisses toast within 100ms

- **WHEN** the toast is showing `Reconnecting… (2/5)` with `waitMs: 4000` and the user clicks the toast's Cancel button at 500ms into the sleep
- **THEN** within 100ms of the click, the toast transitions to the cancellation appearance; the next `download-cancelled { downloadJobId }` event arrives within 200ms of the click; the toast dismisses on the standard cancelled-toast schedule

### Requirement: App-launch hydration handles in-flight downloads in retry state

When the renderer hydrates active downloads on launch via `downloads:list-active`, the registry payload does NOT distinguish "currently sleeping in a retry" from "currently downloading bytes." The renderer SHALL hydrate every active job to the `downloading` toast state by default. The next IPC event for that job — either a `downloading` event (bytes flowing) or a `download-retrying` event (handler is mid-sleep) — SHALL drive the toast to the correct visible state.

This requirement preserves the architectural invariant that the registry is a stateless point-in-time snapshot; retry state is signaled exclusively by the event stream.

#### Scenario: Hydration to retrying toast on next download-retrying event

- **WHEN** the desktop app reopens during a service-side retry sleep, hydration via `downloads:list-active` returns `{ downloadJobId: "job-A", bytesDownloaded: 251_658_240, contentLength: 398_458_880, ... }`, and within 1 second a `download-retrying { downloadJobId: "job-A", attempt: 3, limit: 5, waitMs: 4000, engineCause: "network-error" }` event arrives
- **THEN** the toast initially renders the standard `Downloading <filename>… 63%` appearance from the hydration payload; on receipt of the `download-retrying` event the subtext switches to `Reconnecting… (3/5)` per the existing requirement

#### Scenario: Hydration to downloading toast on next downloading event

- **WHEN** hydration returns an entry and the next event arriving is `downloading { downloadJobId, progress: 64 }` (the retry sleep had just completed when the renderer connected)
- **THEN** the toast continues the standard `Downloading <filename>… 64%` appearance with no transition through `Reconnecting…`

### Requirement: Active download toast renders a Cancel action button

The active download toast (both `downloading` and `download-retrying` states) SHALL render a user-clickable Cancel action button via Sonner's built-in `action` option on `toast.loading`. The button SHALL be labelled `Cancel` (verbatim copy). The button SHALL NOT be rendered on terminal-state toasts: `file-downloaded` (success — uses its own dual-action layout), `download-failed` (uses Sonner's red error template with a Retry action), `download-cancelled` (toast is dismissed silently).

Clicking the Cancel button SHALL invoke `window.api.sync.cancelDownload({ downloadJobId })` (the renderer-facing preload bridge for the `sync:cancel-download` service command — the command itself was added by `add-engine-rename-download` §13.15-§13.16; the desktop main↔preload bridge for it is added by this change per design.md Decision 16). The toaster SHALL NOT pre-emptively dismiss the toast on click — the dismiss flows from the subsequent `download-cancelled` event arriving on the IPC bus, preserving the existing event-driven dismissal path.

The `downloadJobId` passed to `cancelDownload` SHALL be the same id the toaster's `tracker` correlates with this toast slot. For hydrated-from-disk toasts (no orchestrator pre-dispatch through `registerRetry`), the `downloadJobId` is taken from the `DownloadJobSummary.downloadJobId` field passed to `hydrateActiveDownloads`.

The Cancel button MAY be styled per Sonner's default action-button styling (no override). Visual placement (right-aligned within the toast row) follows Sonner's loading-template layout.

#### Scenario: Cancel button visible during downloading state

- **WHEN** a `downloading { downloadJobId: "job-A", progress: 42, ... }` event spawns or updates the toast for `job-A`
- **THEN** the toast renders with a Cancel action button (Sonner's `toast.loading` action slot); clicking the button calls `window.api.sync.cancelDownload({ downloadJobId: "job-A" })` exactly once; the toast remains visible until the subsequent `download-cancelled` event arrives

#### Scenario: Cancel button visible during retrying state

- **WHEN** a `download-retrying { downloadJobId: "job-A", attempt: 2, limit: 5, waitMs: 4000, engineCause: "network-error" }` event swaps the toast to retrying state
- **THEN** the toast continues to render the Cancel action button (Sonner's `toast.loading` action slot is preserved across same-id message-text swaps); clicking it during the retry sleep calls `window.api.sync.cancelDownload({ downloadJobId: "job-A" })` and the next `download-cancelled` event dismisses the toast

#### Scenario: Cancel button absent on terminal failure render

- **WHEN** a `download-failed { downloadJobId: "job-A", tag: "exhausted-retries", message: "..." }` event swaps the toast to failure state via `toast.error`
- **THEN** the rendered toast carries a Retry action (per existing failure UX), NOT a Cancel action; the toaster SHALL NOT call `cancelDownload` from within the failure-toast handler

### Requirement: Download toast falls back to bytes-only progress when total is unknown

The toast's progress message format SHALL switch behavior based on the `bytesTotal` field of the `downloading` event payload (per the modified `DownloadingPayload` wire shape, see fs-sync-service spec):

- When `bytesTotal !== null && bytesTotal > 0`: the existing percentage format `Downloading <basename> — <pct>%` where `pct = floor(bytesLoaded / bytesTotal * 100)`.
- When `bytesTotal === null || bytesTotal === 0`: the bytes-only format `Downloading <basename> — <X> MB` where `X = (bytesLoaded / 1_048_576).toFixed(1)`. When `bytesLoaded >= 1_073_741_824` (1 GB), the format scales to `<X> GB` with `X = (bytesLoaded / 1_073_741_824).toFixed(2)`.

The fallback SHALL apply uniformly across the spawn-toast, in-place update, and hydration-from-snapshot code paths. The retrying-state message format (`Downloading <basename> — Reconnecting (n/limit)`) is NOT affected by this requirement — retrying messages do not surface byte counts.

#### Scenario: Provider-no-Content-Length surfaces bytes-only

- **WHEN** the engine emits successive `downloading` events for `job-A` with `bytesLoaded: 5_242_880` (5 MB), `bytesLoaded: 31_457_280` (30 MB), `bytesLoaded: 104_857_600` (100 MB) and `bytesTotal: null` on each
- **THEN** the toast message text on each event update is `Downloading <basename> — 5.0 MB`, `Downloading <basename> — 30.0 MB`, `Downloading <basename> — 100.0 MB` respectively (NOT `0%`)

#### Scenario: Provider-with-Content-Length keeps percentage format

- **WHEN** the engine emits `downloading { progress: 42, bytesLoaded: 167_772_160, bytesTotal: 398_458_880 }`
- **THEN** the toast message text is `Downloading <basename> — 42%` (percentage format wins when total is non-null)

#### Scenario: Bytes count crosses 1 GB threshold

- **WHEN** the engine emits successive `downloading` events with `bytesLoaded: 1_073_741_824` (1 GB exactly) and `bytesLoaded: 1_610_612_736` (1.5 GB) and `bytesTotal: null`
- **THEN** the toast message text on each is `Downloading <basename> — 1.00 GB` and `Downloading <basename> — 1.50 GB` respectively (GB format with 2 decimal places)

#### Scenario: Hydration with null contentLength uses bytes-only

- **WHEN** `hydrateActiveDownloads` seeds an entry with `bytesDownloaded: 52_428_800` (50 MB) and `contentLength: null`
- **THEN** the toast spawned by hydration shows `Downloading <basename> — 50.0 MB` immediately (NOT `0%`)

### Requirement: Download failure toast is event-driven, single-sourced

The renderer SHALL emit user-visible `Download failed: <message>` toast UX from EXACTLY ONE code path: the `download-job-toast.ts` toaster's `download-failed` event handler. Other code paths in the renderer (notably the orchestrator dispatch caller in `file-explorer.tsx`) SHALL NOT emit a `Download failed: …` toast on `dispatchDownload` returning `{ ok: false, error: ... }` in its `.then(...)` branch — those failures, when post-job-creation, are already surfaced by the toaster via the `download-failed` IPC event.

The orchestrator dispatch caller's `.catch(...)` branch (for IPC-reject exceptions where no `download-failed` event reaches the bus) SHALL be retained — that path covers a categorically different failure mode (the IPC layer itself fails: disconnected service, malformed request envelope) and is the only signal the user has for that mode.

Pre-job validation failures (`toPath` rejected by `validateToPath`, concurrent-download rejection, `resolveClient` failure) return `{ ok: false, error }` from the handler WITHOUT emitting a `download-failed` IPC event. v1 accepts that these paths surface no user-visible toast — they are edge cases (path-traversal defense-in-depth, double-click guard, stale `datasourceId`) and console errors persist. A future change MAY re-introduce a guarded `.then` toast for these paths via a discriminator field on the response error envelope.

#### Scenario: In-flight failure produces exactly one toast

- **WHEN** a download for `job-A` is in flight and the handler emits `download-failed { downloadJobId: "job-A", tag: "other", message: "range not supported on this resource" }` (post-rewrite-from-0 failure path) AND the orchestrator's `dispatchDownload` Promise resolves to `{ ok: false, error: { tag: "other", message: "range not supported on this resource" } }`
- **THEN** EXACTLY ONE failure toast appears in the Sonner toaster: the one rendered by the toaster's `download-failed` handler with the Retry action; the orchestrator caller's `.then` branch SHALL NOT emit a second toast

#### Scenario: IPC-reject surfaces via .catch only

- **WHEN** the renderer invokes `window.api.files.download(...)` and the IPC layer itself rejects with an `Error("preload bridge unavailable")` (i.e., no IPC envelope is returned, no `download-failed` event reaches the bus)
- **THEN** the orchestrator caller's `.catch` branch emits exactly one toast `Download failed: preload bridge unavailable`; the toaster SHALL NOT render anything (no event arrived)
