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
