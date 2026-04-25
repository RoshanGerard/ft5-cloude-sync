## MODIFIED Requirements

### Requirement: Explorer chrome — breadcrumb, back / forward / up, toolbar, status row

The explorer SHALL render a navigation bar below the window title bar containing: Back, Forward, and Up-one-level buttons, plus a clickable breadcrumb trail showing every path segment from the datasource root to the current folder. The explorer SHALL also render a toolbar with controls for Upload (opens the Upload dialog), Delete (selection), Sort, Search, View mode, and Details-pane toggle. The explorer SHALL render a status row at the bottom showing the current item count and selection count.

#### Scenario: Breadcrumb renders the full path with segment-level navigation

- **WHEN** the current path is `/projects/docs/2026`
- **THEN** the breadcrumb renders four keyboard-focusable segments ("root" → "projects" → "docs" → "2026") separated by `›` chevrons at `text-muted-foreground`; clicking or pressing Enter on any segment navigates to that path

#### Scenario: Back, Forward, and Up operate on the explorer's history stack

- **WHEN** the user navigates root → `projects` → `docs`, then clicks Back
- **THEN** the explorer navigates to `projects`; clicking Back again navigates to root; clicking Forward from root navigates to `projects`; clicking Up from `/projects/docs` navigates to `/projects`; Back and Forward buttons are disabled at the ends of the stack

#### Scenario: Status row reflects item and selection counts

- **WHEN** the current folder contains 12 entries and the user has 3 selected
- **THEN** the status row renders the text "12 items · 3 selected" with digits in a `tabular-nums` element; the text updates within one render when selection or contents change; the status is exposed via `aria-live="polite"`

#### Scenario: Toolbar controls are all keyboard reachable and accessibly named

- **WHEN** the user tabs through the toolbar
- **THEN** each control (Upload, Delete, Sort, Search, View mode, Details toggle) receives focus with a visible focus ring; each has an accessible name regardless of whether the visible label is icon-only; each can be activated via Enter or Space

#### Scenario: Upload toolbar button is present and opens the Upload dialog

- **WHEN** the user activates the Upload toolbar button (click, Enter, or Space) while viewing `/projects/2026` on a connected datasource
- **THEN** the Upload dialog opens with the destination pre-selected to `/projects/2026`; the Files-to-upload list is empty; clicking "+ Add files…" opens the native OS picker via `window.api.datasources.pickFilesToUpload`

## ADDED Requirements

### Requirement: Drag-dropped files upload to the currently-viewed folder

Dragging one or more files from the OS file manager over the file-explorer pane SHALL activate an amber full-pane drop overlay. Dropping those files SHALL dispatch one `window.api.files.upload` call per file with `targetPath` equal to `<currentPath>/<basename>` (so each file lands in the folder the user is currently viewing), and `conflictPolicy` resolved per-file by the conflict-resolution dialog before dispatch. Multi-file drops SHALL dispatch in parallel — one `sync:enqueue-upload` job per file — with each dispatch producing its own Sonner toast subscribed to `DATASOURCES_CHANNELS.uploadProgress` for the returned `jobId`.

The drop zone SHALL cover the entire file-explorer pane — toolbar, breadcrumb, entries area, status row — so that a user who misses the entries area does not have their drop silently ignored. Dragover events whose `dataTransfer.types` does NOT include `"Files"` (e.g., text or URL drags) SHALL NOT activate the overlay.

Folder drags (detected via `DataTransferItem.webkitGetAsEntry()` resolving to a `FileSystemDirectoryEntry`) SHALL NOT be uploaded. Instead, the drop SHALL show a single Sonner toast "Folder upload is coming soon — drop individual files for now", no matter how many folders are in the batch. Files in a mixed files + folders drop SHALL still upload; only the folders are skipped.

The renderer SHALL NOT dispatch any upload against the datasource's `providerKind` directly; all uploads flow through `files.upload`, which routes to `syncClient.enqueueUpload` regardless of backend (engine-backed or mock).

#### Scenario: Dragover over the explorer pane activates the drop overlay

- **WHEN** the user drags one or more OS files over the file-explorer pane while viewing `/projects/2026` on a connected datasource
- **THEN** within one render the explorer shows an amber dashed-border overlay over the entire pane; the overlay contains a centered 40px Lucide `Upload` icon in `text-amber-600`, a 15px/600 headline "Drop to upload here", and a 13px/400 subtext "→ /projects/2026"; the entries area behind the overlay renders at `opacity-35`

#### Scenario: Drop dispatches one files.upload per file in parallel

- **WHEN** the user drops 3 files with names `a.pdf`, `b.xlsx`, `c.png` on the explorer while viewing `/projects/2026`, none of which collide with existing entries
- **THEN** the renderer dispatches exactly 3 parallel `window.api.files.upload` calls with `targetPath` values `/projects/2026/a.pdf`, `/projects/2026/b.xlsx`, `/projects/2026/c.png`; each call's returned `jobId` spawns a Sonner toast subscribed to `DATASOURCES_CHANNELS.uploadProgress`; the overlay disappears within one render of the drop

#### Scenario: Dragover of non-file data does not activate the overlay

- **WHEN** the user drags selected text (not files) from another window over the explorer pane
- **THEN** the explorer's dragover handler sees `dataTransfer.types` containing `"text/plain"` but not `"Files"`; the overlay does NOT activate; no visual change occurs

#### Scenario: Folder drop rejects with a single informational toast

- **WHEN** the user drops two OS folders (with any number of files inside them) on the explorer pane
- **THEN** the renderer inspects each dropped item via `DataTransferItem.webkitGetAsEntry()`, finds both are directories, and shows exactly one Sonner toast "Folder upload is coming soon — drop individual files for now"; zero `files.upload` calls are dispatched; no overlay remains after the drop

#### Scenario: Mixed file + folder drop uploads the files and skips the folders

- **WHEN** the user drops 2 files and 1 folder on the explorer pane
- **THEN** the 2 files are uploaded per the drop dispatch rule above; the folder is skipped silently (the aggregate toast from the folder-only scenario does not appear when at least one file was also accepted); zero folder-content files are enumerated or dispatched

### Requirement: Drop is disabled when the datasource cannot accept uploads

When the datasource status is `disconnected`, `auth-revoked`, or `syncing` (initial indexing pass not yet complete), drag-drop SHALL be disabled. Dragover SHALL render a **neutral-palette** blocked overlay (not the amber drop-active overlay); drop SHALL be a no-op (no `files.upload` calls dispatched, no toast). The blocked overlay SHALL expose the specific reason via a state-specific icon and headline so the user understands why the drop is not accepted.

The Upload button in the file-explorer toolbar SHALL similarly render with `aria-disabled="true"` (not the HTML `disabled` attribute) in these three states, keyboard-focusable with a tooltip naming the reason.

#### Scenario: Disconnected datasource blocks drag-drop with a neutral overlay

- **WHEN** the user drags a file over the explorer pane while the datasource status is `disconnected`
- **THEN** the overlay renders with `border-muted-foreground` dashed border (no tint), the Lucide `CloudOff` icon in `text-muted-foreground`, headline "Can't upload right now", and body "This datasource is disconnected"; no action button is rendered; releasing the mouse dispatches zero `files.upload` calls

#### Scenario: Auth-revoked datasource blocks drag-drop

- **WHEN** the user drags a file over the explorer pane while the datasource status is `auth-revoked`
- **THEN** the blocked overlay renders with the `KeyRound` icon in `text-muted-foreground` and body "This datasource needs you to sign in again"; drop is a no-op

#### Scenario: Syncing datasource blocks drag-drop

- **WHEN** the user drags a file over the explorer pane while the datasource status is `syncing`
- **THEN** the blocked overlay renders with the `RefreshCw` icon (spinning at 2.4s linear) in `text-muted-foreground` and body "This datasource is still indexing — try again in a moment"; drop is a no-op

#### Scenario: Upload toolbar button is disabled in non-usable states

- **WHEN** the datasource status is `disconnected`, `auth-revoked`, or `syncing`
- **THEN** the Upload toolbar button renders with `aria-disabled="true"`, remains keyboard-focusable (so screen readers can read the tooltip), and its tooltip names the state-specific reason; activating the button (click or Enter) is a no-op and does NOT open the Upload dialog

### Requirement: Upload dialog — in-app file + destination picker

The Upload dialog SHALL be a modal (shadcn `<Dialog>`) with a "Files to upload" section and a "Destination folder" section, opened by (a) the datasource card's "Upload from local…" quick-action, or (b) the file-explorer toolbar's Upload button. The dialog SHALL default its destination to the file-explorer's `currentPath` when opened from the toolbar, and to `/` (datasource root) when opened from the dashboard card. The dialog's primary action button SHALL read "Upload N files → /destination/path" (with N and path interpolated live) and SHALL be disabled while the Files list is empty.

The Files section SHALL display each selected file with its Lucide icon (from the existing `(kind, mimeFamily)` → icon mapping), basename, size, and an `X` remove affordance. A "+ Add files…" row at the bottom of the list SHALL call `window.api.datasources.pickFilesToUpload()`, which opens the native OS file picker with `properties: ["openFile", "multiSelections"]` and returns `{filePaths: string[], canceled: boolean}`. Returned paths SHALL be appended to the existing list (not replacing it), so the user can add files from multiple picker sessions before uploading.

The Destination folder section SHALL render a breadcrumb at its top matching the style of the main file-explorer's breadcrumb, followed by a list of directory rows scrollable to ~140px max height. The directory list SHALL be populated by `window.api.files.list({datasourceId, path})` for the current destination path, filtered client-side to entries with `kind === "directory"`. A synthesized `.. (parent)` row SHALL appear at the top when the current destination path is not `/`.

The currently-displayed folder (as shown in the breadcrumb) SHALL BE the destination — there is no separate "row selection" distinct from "current folder", matching the convention of OS "Save As" / folder-picker dialogs. Single-click or Enter on a directory row SHALL navigate INTO that directory: the destination path updates, the breadcrumb updates, the list re-fetches. Single-click or Enter on the `.. (parent)` row SHALL navigate UP one level. Single-click or Enter on a breadcrumb segment SHALL navigate to that segment. The destination footer SHALL read `→ <currentDestinationPath>` at all times, and the primary submit button SHALL read `Upload N files → <currentDestinationPath>`.

Clicking Upload SHALL trigger preflight `files.stat` checks for each file's target path, resolve conflicts via the conflict-resolution dialog, dispatch N parallel `files.upload` calls, and close the Upload dialog. Closing the Upload dialog via "Cancel" or Escape SHALL discard the Files list and navigation state; reopening the dialog starts fresh.

The renderer SHALL NOT render a `<input type="file">` element in this flow; the OS-native picker is the only file-selection surface.

#### Scenario: Upload dialog opens from the datasource card with root as the default destination

- **WHEN** the user opens a datasource card's quick-actions menu and activates "Upload from local…"
- **THEN** the Upload dialog opens; the Destination folder section's current path is `/`; the destination footer reads "→ /"; the primary button is disabled (no files selected); the Files list is empty with the "+ Add files…" row visible

#### Scenario: Upload dialog opens from the file-explorer toolbar with currentPath as the default destination

- **WHEN** the user activates the Upload toolbar button while viewing `/projects/2026`
- **THEN** the Upload dialog opens; the Destination folder section's current path is `/projects/2026`; the destination footer reads "→ /projects/2026"

#### Scenario: Add files uses the native OS picker, not an input element

- **WHEN** the user clicks "+ Add files…" inside the Upload dialog
- **THEN** the renderer calls `window.api.datasources.pickFilesToUpload()`; the main process invokes `dialog.showOpenDialog` with `properties: ["openFile", "multiSelections"]`; returned file paths are appended to the Files list; no `<input type="file">` is present anywhere in the rendered DOM tree at any point during the flow

#### Scenario: Destination tree shows only directories

- **WHEN** the user opens the Upload dialog and the destination path is `/`, and `window.api.files.list({datasourceId, path: "/"})` resolves with a mix of 3 directories and 5 files
- **THEN** the Destination folder section renders 3 rows — one per directory entry — each with a `Folder` Lucide icon; the 5 file entries are NOT rendered; no file entry is keyboard-focusable in the destination list

#### Scenario: Single-click on a directory row navigates into it and updates the destination

- **WHEN** the user single-clicks a directory row labeled `drafts` while the destination path is `/projects/2026`
- **THEN** the destination path becomes `/projects/2026/drafts`; the Destination folder list re-fetches via `window.api.files.list({datasourceId, path: "/projects/2026/drafts"})`; the breadcrumb reads `root › projects › 2026 › drafts`; the footer reads "→ /projects/2026/drafts"; the primary button label updates to "Upload N files → /projects/2026/drafts"

#### Scenario: The parent-row and breadcrumb navigate up without a separate selection concept

- **WHEN** the user is at destination path `/projects/2026/drafts` and clicks the `.. (parent)` row
- **THEN** the destination path becomes `/projects/2026`; the list re-fetches for that path; the breadcrumb truncates the trailing segment; clicking the `projects` breadcrumb segment from any depth jumps directly to `/projects` with a re-fetch; no "selected row" indicator appears in the directory list at any point — the current displayed folder IS the destination

#### Scenario: Submit dispatches N parallel files.upload calls and closes the dialog

- **WHEN** the user has 3 files selected with destination `/projects/2026`, none of which collide, and clicks "Upload 3 files → /projects/2026"
- **THEN** the renderer dispatches 3 parallel `window.api.files.upload` calls (one per file with `targetPath = /projects/2026/<basename>`); the Upload dialog closes within one render of the dispatch; 3 Sonner toasts appear, one per returned `jobId`

#### Scenario: Primary button is disabled when the Files list is empty

- **WHEN** the Upload dialog is open with zero files selected
- **THEN** the primary button has `disabled` attribute, is NOT activatable by click / Enter / Space, and its label reads "Upload 0 files → …"; "+ Add files…" remains enabled as the path to add files

### Requirement: Preflight conflict resolution before dispatching uploads

Before dispatching any `files.upload` call for a drag-drop batch or an Upload dialog submission, the renderer SHALL call `window.api.files.stat({datasourceId, path: <targetPath>})` for each file's intended target. Any stat that resolves successfully indicates the target already exists → that file is a conflict. The renderer SHALL open the conflict-resolution dialog and walk each conflict serially, presenting three options per conflict: Overwrite (conflictPolicy = `"overwrite"`), Keep both (conflictPolicy = `"duplicate"`), Skip this file (do not dispatch). A single "Apply this choice to the remaining N conflicts" checkbox SHALL be available; checking it applies the current choice to every subsequent conflict in the batch without showing further prompts.

Preflight stat failures with tag `auth-revoked`, `disconnected`, or `other` SHALL abort the entire batch with a single red Sonner toast naming the failure; no files SHALL be dispatched. Preflight stat rejection with tag `not-found` SHALL be treated as "no conflict" (the happy path) and that file SHALL proceed to dispatch without conflict prompting.

"Cancel all" in the conflict-resolution dialog SHALL abort the entire batch with zero dispatches; the Upload dialog (if the batch originated there) SHALL remain open with its state preserved so the user can adjust the selection.

#### Scenario: No conflicts skips the conflict dialog entirely

- **WHEN** the user drops 3 files onto `/projects/2026`, none of which collide with existing entries (all three `files.stat` calls reject with `not-found`)
- **THEN** the conflict-resolution dialog does NOT appear; 3 `files.upload` calls dispatch in parallel within one render

#### Scenario: Serial conflict walk with per-file choice

- **WHEN** the user drops 3 files onto `/projects/2026` and 2 of them (`a.pdf` and `b.xlsx`) already exist at the target path; the "Apply to remaining" checkbox is not checked
- **THEN** the conflict-resolution dialog opens for `a.pdf` first; the user picks "Overwrite"; the dialog advances to `b.xlsx`; the user picks "Skip this file"; `a.pdf` dispatches with `conflictPolicy: "overwrite"`; `b.xlsx` does NOT dispatch; the third file (`c.png`, no conflict) dispatches with `conflictPolicy` defaulting to `"overwrite"` (per Decision: no-conflict files use overwrite policy as the no-op default)

#### Scenario: Apply-to-remaining shortcuts further prompts

- **WHEN** the user has 3 conflicts; on the first prompt they pick "Keep both" and check "Apply this choice to the remaining 2 conflicts"
- **THEN** the conflict-resolution dialog closes after the first response; all 3 conflicting files dispatch with `conflictPolicy: "duplicate"`

#### Scenario: Preflight stat failure aborts the whole batch

- **WHEN** the user drops 3 files and the first `files.stat` call rejects with `{ error: { tag: "auth-revoked", … } }`
- **THEN** the conflict-resolution dialog does NOT open; zero `files.upload` calls dispatch; a single red Sonner toast appears with the reason "Sign in again to upload files"; the remaining 2 `files.stat` calls may or may not have dispatched (the renderer does NOT wait for them before aborting)

#### Scenario: Cancel all preserves the Upload dialog state

- **WHEN** the user submits the Upload dialog with 3 files / `/dest`, 2 of which conflict; on the first conflict prompt they click "Cancel all"
- **THEN** zero `files.upload` calls dispatch; the conflict-resolution dialog closes; the Upload dialog remains open with the same 3 files and destination `/dest` intact, ready for re-submission

### Requirement: `files.upload` IPC is wired across all four layers

`window.api.files.upload` SHALL be a typed IPC surface with the request shape `{ datasourceId: string; sourcePath: string; targetPath: string; conflictPolicy: "overwrite" | "duplicate" | "skip" }` and response shape `{ ok: true; value: { jobId: string } } | { ok: false; error: { tag: "auth-revoked" | "disconnected" | "rate-limited" | "other"; message: string; retryable: boolean } }`. The surface SHALL have a typed contract in `packages/ipc-contracts/src/files.ts`, a main-process `ipcMain.handle` implementation under `apps/desktop/src/main/ipc/files/upload.ts` that proxies to `syncClient.enqueueUpload`, a preload binding via `contextBridge.exposeInMainWorld`, and renderer call sites in both `drop-zone.tsx` (via `use-upload-orchestrator`) and `upload-dialog.tsx` (same hook).

The main-process handler SHALL NOT open any file picker, SHALL NOT derive `targetPath` from the source path, SHALL NOT instantiate an engine, and SHALL NOT import from any provider SDK. It SHALL be a thin proxy: decode request → call `syncClient.enqueueUpload({datasourceId, sourcePath, targetPath, conflictPolicy})` → return the envelope.

#### Scenario: Four-layer wiring test passes for files.upload

- **WHEN** a Vitest test inspects the project for the `files.upload` IPC surface
- **THEN** it finds a declared contract type in `packages/ipc-contracts/src/files.ts`, a main-process handler file at `apps/desktop/src/main/ipc/files/upload.ts`, a preload-exposed method on `window.api.files.upload`, and at least one renderer call site; missing any layer SHALL cause the test to fail

#### Scenario: Main-process handler is a thin sync-service proxy

- **WHEN** a Vitest test grep-scans `apps/desktop/src/main/ipc/files/upload.ts` for direct engine / provider-SDK / `dialog.showOpenDialog` references
- **THEN** no match is found; the only significant outbound call is to `syncClient.enqueueUpload`; `targetPath` is forwarded verbatim from the request (never reconstructed from `sourcePath`)

#### Scenario: Renderer receives the jobId from the upload response

- **WHEN** the renderer dispatches `files.upload({datasourceId, sourcePath: "/tmp/a.pdf", targetPath: "/projects/a.pdf", conflictPolicy: "overwrite"})` and the handler resolves with `{ ok: true, value: { jobId: "job_abc123" } }`
- **THEN** the renderer opens a Sonner toast keyed by `"job_abc123"` that subscribes to `DATASOURCES_CHANNELS.uploadProgress` and displays per-job progress until the job reaches terminal status

### Requirement: Upload progress and failures surface via per-job Sonner toasts

Every successfully-enqueued upload (one toast per `jobId` returned by `files.upload`) SHALL produce a Sonner toast that subscribes to `DATASOURCES_CHANNELS.uploadProgress` for that job id. The toast SHALL display the file's basename, a progress bar (0–100%), and the current byte rate when available from the progress event. On terminal success the toast SHALL flip to a "✓ Uploaded <basename>" state and auto-dismiss after 4 seconds. On terminal failure the toast SHALL flip to a red error state with the failure message and a "Retry" action that re-dispatches the same `files.upload` call with the same parameters.

#### Scenario: Per-job toast follows a successful upload to completion

- **WHEN** `files.upload` resolves with `jobId: "job_x"`, progress events arrive at 25% / 50% / 100%, followed by a terminal `completed` status event
- **THEN** the Sonner toast updates its progress bar on each event; on `completed` it renders "✓ Uploaded <basename>" for 4 seconds, then dismisses; no lingering toast remains

#### Scenario: Terminal failure shows Retry

- **WHEN** `files.upload` resolves with `jobId: "job_y"` and the job later emits a terminal failure event with `{ tag: "rate-limited", message: "Too many requests" }`
- **THEN** the toast flips to a red state with the body "Upload failed: Too many requests" and a "Retry" button; clicking Retry re-dispatches `files.upload` with the original `{datasourceId, sourcePath, targetPath, conflictPolicy}`; the original toast is replaced by a new toast bound to the new `jobId`

#### Scenario: One failure does not block the other files in a batch

- **WHEN** the user drops 5 files, `files.upload` dispatches 5 jobs, and 1 terminal-fails while 4 succeed
- **THEN** 4 green success toasts appear and auto-dismiss; 1 red failure toast remains with a Retry action; no aggregate "3 of 5 failed" summary toast appears; each file has exactly one toast at any time
