# file-explorer

## Purpose

The `file-explorer` capability covers the renderer's per-datasource file browser: the `/datasources/explore?id=<datasourceId>` route reachable from each datasource card's "Explore" quick action, the navigation chrome (breadcrumb, back / forward / up, toolbar, status row), the six view modes (List, Details, Small Icons, Tiles, Medium Icons, Large Icons), the centralized `(kind, mimeFamily)` → lucide-react icon mapping, the right-click context menu, the toggleable Details pane with per-datasource persistence, selection and keyboard conventions, the async rename / delete / download pipeline with per-entry pending and error state, the provider-honest search affordance (S3 client-side scan; Drive and OneDrive deferred), the `window.api.files.*` IPC surface (`list`, `stat`, `search`, `rename`, `remove`, `download`) wired through all four layers, and the 300-entry directory ceiling enforced on mocked fixtures.
## Requirements
### Requirement: Explorer route is reached from the datasource card and scopes to a single datasource

The renderer SHALL expose a file-explorer route at the path `/datasources/explore` with the datasource id passed as the `id` query parameter. The route SHALL be reachable from the datasource card's quick-actions menu via a new "Explore" item. Each visit SHALL scope to exactly one datasource identified by the `id` query parameter, and SHALL maintain its own independent navigation history (back / forward / up) distinct from any other explorer session.

#### Scenario: Explore quick-action navigates to the explorer for that datasource

- **WHEN** the user opens a datasource card's quick-actions menu and activates the "Explore" item
- **THEN** the renderer navigates to `/datasources/explore?id=<datasourceId>` where `<datasourceId>` is that card's datasource id; the dashboard is replaced by the explorer view; the back affordance returns the user to the dashboard

#### Scenario: Each explorer visit has its own history stack

- **WHEN** the user navigates into subdirectories within an explorer, then opens a second datasource's explorer
- **THEN** the second explorer starts at its own root with an empty history stack; navigating back in the second explorer does NOT traverse the first explorer's history

#### Scenario: Explorer refuses to render without a valid id query parameter

- **WHEN** the explorer route receives an `id` query parameter that is absent or does not resolve to a known datasource (missing from the datasources list)
- **THEN** the explorer renders an error state with the message "Datasource not found" and a button to return to the dashboard; no file-list IPC call is issued

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

### Requirement: Six view modes — List, Details, Small Icons, Tiles, Medium Icons, Large Icons

The explorer's main pane SHALL render entries in one of six view modes: List, Details, Small Icons, Tiles, Medium Icons, Large Icons. The user SHALL be able to switch modes from the toolbar's View menu. The default mode SHALL be Details. Selection, keyboard navigation, sort order, and search results SHALL be preserved across mode switches.

#### Scenario: View-mode menu exposes all six options with the current one indicated

- **WHEN** the user opens the View menu in the toolbar
- **THEN** the menu contains six radio-style items — "List", "Details", "Small icons", "Tiles", "Medium icons", "Large icons" — with the currently-active mode marked as selected; selecting a different item switches the main pane's renderer component within one render

#### Scenario: Selection survives a mode switch

- **WHEN** the user selects two entries in Details mode, then switches to Medium Icons mode
- **THEN** the same two entries remain selected in Medium Icons mode; the status row's selection count is unchanged; focus is on one of the selected entries (last-focused in Details)

#### Scenario: Details mode renders the documented columns

- **WHEN** the main pane is in Details mode
- **THEN** each row renders columns in this order: icon, name, type, size (or empty for directories), modified timestamp; numeric columns use `tabular-nums`; column headers are keyboard-activatable and sort the list by that column

### Requirement: Entries render mime-family icons via a centralized mapping

Every entry SHALL render an icon selected from a centralized mapping that takes `(kind, mimeFamily)` and returns a lucide-react icon. Directory entries SHALL render the folder icon. File entries SHALL render the lucide file-family icon corresponding to the entry's `mimeFamily`. An unknown mime family SHALL render the generic file icon. No per-extension string parsing SHALL occur in the renderer.

#### Scenario: Directory entry renders the folder icon

- **WHEN** a `FileEntry` with `kind === "directory"` is rendered in any view mode
- **THEN** the entry's icon element matches the lucide `folder` glyph (or `folder-open` when the entry is currently being navigated into); no file-family icon is rendered for it

#### Scenario: File entry renders the icon matching its mimeFamily

- **WHEN** a `FileEntry` is rendered with `mimeFamily: "image"`
- **THEN** its icon matches the lucide `file-image` glyph; the same holds for `video` → `file-video`, `audio` → `file-audio`, `document` → `file-text`, `archive` → `file-archive`, `code` → `file-code`, `text` → `file-text`, and `unknown` → `file`

#### Scenario: No per-extension parsing in the renderer

- **WHEN** a Vitest test scans every `.ts` / `.tsx` file under `apps/desktop/src/renderer/src/features/file-explorer/`
- **THEN** no regex or string-manipulation expression is found that derives icon choice from an entry's extension or filename; icon selection is a pure function over `kind` and `mimeFamily`; the test fails if a file splits on `.` to pick an icon

### Requirement: Right-click context menu offers Open, Download, Rename, Delete, Copy path, Properties

Each entry SHALL respond to a right-click (or keyboard equivalent via Shift+F10 or the Menu key) by opening a context menu containing exactly these items in this order: Open, Download, Rename (disabled for directory entries in v1), Delete, Copy path, Properties. Each item SHALL be keyboard-reachable and SHALL have an accessible name. Closing the menu SHALL restore focus to the entry.

#### Scenario: Right-click on a file opens the full context menu

- **WHEN** the user right-clicks a file entry
- **THEN** the context menu opens with items "Open", "Download", "Rename", "Delete", "Copy path", "Properties" in that order; all items are enabled; pressing Escape closes the menu and returns focus to the entry

#### Scenario: Right-click on a directory disables Rename

- **WHEN** the user right-clicks a directory entry
- **THEN** the context menu opens with the same six items but "Rename" is disabled with an accessible "disabled" state; activating it does nothing; all other items are enabled

#### Scenario: Properties item opens the Properties modal, not the Details pane

- **WHEN** the user activates "Properties" in the context menu
- **THEN** a modal dialog opens with the entry's full metadata dossier (name, path, type, size, modified, created, provider metadata); the Details pane's open/closed state is unchanged; the modal is focus-trapped and can be dismissed via Escape or its close button

### Requirement: Details pane renders metadata for the current selection, independently of Properties modal

The explorer SHALL provide a right-side Details pane, toggleable from the toolbar, that renders a curated subset of metadata for the currently-selected entry (or a "N items selected" summary on multi-selection). The Details pane SHALL persist its open/closed state per-datasource across app restarts. The Details pane and the Properties modal SHALL read from the same metadata source and use the same field-renderer primitives, but the modal SHALL be permitted to show more fields than the pane.

#### Scenario: Details pane reflects selection changes

- **WHEN** the user selects a file entry while the Details pane is open
- **THEN** within one render the pane shows that entry's name, type, size, modified timestamp, path, and any available provider-metadata fields included in the pane's curated list

#### Scenario: Multi-selection shows a summary, not one entry's metadata

- **WHEN** more than one entry is selected and the Details pane is open
- **THEN** the pane renders a summary with the total selection count, the total combined size (for file entries; directories are excluded from the sum), and the common parent path; individual entry metadata is NOT shown

#### Scenario: Pane state persists across app restarts

- **WHEN** the user opens the Details pane and closes the app
- **THEN** a `localStorage` entry under a per-datasource key records the pane's open state; on the next launch's explorer mount for the same datasource, the pane opens in the same state without user interaction

### Requirement: Selection and keyboard navigation follow standard conventions

The explorer SHALL support click-select, shift-click range-select, and ctrl/cmd-click toggle-select across all view modes. Arrow keys SHALL move focus within the current view; Enter SHALL activate the focused entry (navigate into a directory, or open Properties for a file); Delete SHALL initiate delete of the selection; F2 SHALL initiate rename on the focused file. Ctrl/Cmd+A SHALL select all entries in the current view.

#### Scenario: Shift-click selects a range

- **WHEN** the user clicks entry A, then shift-clicks entry F (with B, C, D, E between them in the current sort order)
- **THEN** entries A through F inclusive are selected; the status row's selection count is 6

#### Scenario: Arrow keys move focus but do not change selection without a modifier

- **WHEN** entry C has focus and is selected, the user presses ArrowDown
- **THEN** focus moves to entry D; entry C remains selected; entry D does NOT become selected; pressing Shift+ArrowDown extends the selection to include D

#### Scenario: F2 starts rename on the focused file

- **WHEN** entry C (a file) has focus and the user presses F2
- **THEN** the entry's name element becomes an inline editable text input with the current name selected; committing the edit via Enter triggers the rename action; Escape aborts the edit without dispatching rename

### Requirement: Rename, delete, and download are async operations with per-entry pending and error state

Every rename and delete operation SHALL be represented in the store as a pending operation keyed by the affected entry id. The entry SHALL render in a visibly-pending state (dim opacity plus an inline pending glyph drawing from the permitted motion set) from the moment the user commits the action until the IPC call resolves. On success the UI SHALL reflect the final state (renamed entry, entry removed from list). On failure the UI SHALL revert to the pre-operation state and surface the reason both inline on the entry (icon + tooltip) and as a `sonner` toast. Delete SHALL require a confirmation dialog before dispatching the IPC call. Rename and Download SHALL be disabled for engine-backed datasources per the separate "Rename and Download affordances are disabled for engine-backed datasources" requirement; on synthetic mock datasources, rename SHALL remain available for file entries only and directory rename SHALL be disabled with a "Folder rename is not supported in this version" affordance. Bulk delete issues a single `window.api.files.remove` call with N paths; the service processes each path in parallel against the engine, and the response carries a per-path result envelope.

#### Scenario: Delete shows a confirmation dialog before dispatching

- **WHEN** the user activates Delete on a selection of N entries
- **THEN** a confirmation dialog opens with the message "Delete N items? This action cannot be undone." and buttons "Cancel" and "Delete"; "Delete" is the destructive-styled default; dispatching the IPC call does NOT occur unless "Delete" is pressed; Escape cancels

#### Scenario: Entry shows pending state during a rename on a mock datasource

- **WHEN** the user commits a rename on entry X of a synthetic mock datasource
- **THEN** entry X renders at `opacity-60` with an inline pulsing glyph (using `animate-sync-pulse` from the permitted motion set) and its name shows the new requested name; other entries are unchanged; X's quick-action affordances are disabled until the operation resolves

#### Scenario: Partial-failure bulk delete surfaces per-path result

- **WHEN** the user deletes 5 engine-backed entries and the response is `{ ok: true, results: [{ path: "a", handle: "ha", ok: true }, { path: "b", handle: "hb", ok: true }, { path: "c", handle: "hc", ok: true }, { path: "d", handle: "hd", ok: false, error: { tag: "other", message: "provider locked the file" } }, { path: "e", handle: "he", ok: false, error: { tag: "rate-limited", message: "too many requests" } }] }`
- **THEN** entries `a`, `b`, `c` are removed from the list; entries `d` and `e` are restored to their pre-operation state; `d` and `e` each show an inline error icon whose tooltip surfaces the per-path `message`; a single `sonner` toast announces "Deleted 3 of 5 items; 2 failed" and provides a "View details" affordance listing the failing paths and their reasons

#### Scenario: Multi-selection delete issues a single IPC call

- **WHEN** the user confirms delete on a selection of N engine-backed entries
- **THEN** the store issues exactly one `window.api.files.remove` call with the N paths in its request; not N separate calls; partial failure is surfaced per the previous scenario

#### Scenario: Directory rename is disabled in v1 on mock datasources

- **WHEN** the user attempts to rename a directory entry on a synthetic mock datasource (via F2, context menu, or any other path)
- **THEN** the action is refused with an inline message or tooltip "Folder rename is not supported in this version"; no IPC call is issued; the directory's state is unchanged

#### Scenario: Rename attempt on an engine-backed entry is a no-op

- **WHEN** the user attempts to rename any entry (file or directory) on an engine-backed datasource via F2, context menu, or the inline rename cell
- **THEN** the action SHALL be a no-op per the "Rename and Download affordances are disabled" requirement; the store's `editingId` SHALL NOT be set; no IPC call SHALL be dispatched

### Requirement: Search operates against the current folder via the engine, with provider-honest scope

The explorer toolbar SHALL expose a search affordance that, when activated, searches the current folder via `window.api.files.search({ datasourceId, query, path: <currentPath> })`. The main-process IPC handler SHALL forward the request to the `files:search` command on the `fs-sync-service`, which SHALL invoke the engine's `search(query, scope)` with `scope` set to the current path (folder-scoped). The engine MAY delegate to the provider's native search (Google Drive `name contains`, OneDrive `$search`, S3 client-side scan) and SHALL return a normalized entry list. When the provider-native search is truncated by its own limit, the engine SHALL indicate this in the envelope via `truncated: true` and the UI SHALL render "Showing first N results — more may exist" near the results.

#### Scenario: Search for a Google Drive folder returns engine results

- **WHEN** the user enters a search query against a Google Drive datasource while viewing `/my-drive/projects` and submits
- **THEN** the main-process handler issues `files:search` to the sync service with `{ datasourceId, query, path: "/my-drive/projects" }`; the sync service invokes the engine's `search(query, { kind: "path", path: "/my-drive/projects" })`; matching entries from `name contains` are rendered with each entry's parent path as a secondary line; if the response carries `truncated: true`, the UI renders "Showing first N results — more may exist"

#### Scenario: Search error surfaces the error state, not an empty result

- **WHEN** the search request rejects with `{ error: { tag: "auth-revoked" } }`
- **THEN** the search-results area renders the auth-revoked state component (same treatment as the list view), not an empty list; the search input remains populated

#### Scenario: Clearing the search restores the current folder view

- **WHEN** the user clears the search input or dismisses the search UI
- **THEN** the main pane reverts to showing the current folder's entries from before the search was initiated; selection that was in place before the search is restored; focus returns to the search-toggle control or the previously-focused entry

### Requirement: File operations use the `window.api.files.*` IPC surface with full four-layer wiring

All file-system reads and mutations from the renderer SHALL go through the `window.api.files.*` surface. The surface SHALL expose `list(req)`, `stat(req)`, `search(req)`, `rename(req)`, `remove(req)`, and `download(req)`. Each method SHALL have a typed request/response pair in `packages/ipc-contracts/src/files.ts`, an `ipcMain.handle` implementation under `apps/desktop/src/main/ipc/files/`, a preload binding via `contextBridge.exposeInMainWorld`, and at least one renderer call site. The `list`, `stat`, `search`, and `remove` handlers SHALL delegate to the `fs-sync-service` RPC commands `files:list` / `files:stat` / `files:search` / `files:remove`, which in turn delegate to the live engine. The `rename` and `download` handlers SHALL continue to delegate to `mock-fs` until the `add-engine-rename-download` change lands. The renderer SHALL NOT import any provider SDK, `fs`, `child_process`, `electron`, `drizzle-orm`, or any module under `apps/desktop/src/main/` or `apps/desktop/src/preload/`.

#### Scenario: All six methods are wired at all four layers

- **WHEN** a Vitest test inspects the project for the `files` IPC surface
- **THEN** each of `list`, `stat`, `search`, `rename`, `remove`, `download` has a declared contract type, a main-process handler file, a preload-exposed method on `window.api.files`, and at least one renderer call site; missing any layer SHALL cause the test to fail

#### Scenario: list / stat / search / remove round-trip through the sync service to the engine

- **WHEN** the renderer invokes `window.api.files.list({ datasourceId, path })` for an engine-backed datasource
- **THEN** the main-process handler sends `files:list` to the sync service via `SyncClient.request`; the sync service resolves the engine client for `datasourceId` and calls `client.listDirectory({ kind: "path", path })`; the result is serialized through the sync-service command envelope back to the renderer without any provider-SDK type leaking across the process boundary

#### Scenario: rename and download still round-trip through mock-fs

- **WHEN** the renderer (e.g., a synthetic mock datasource test page) invokes `window.api.files.rename` or `window.api.files.download`
- **THEN** the main-process handler delegates to `mock-fs` and returns structured-clone-safe data; no sync-service call is issued

#### Scenario: Renderer has no provider-SDK import in file-explorer code

- **WHEN** `pnpm lint` runs
- **THEN** ESLint reports an error for any file under `apps/desktop/src/renderer/src/features/file-explorer/` that imports from a provider SDK package (`googleapis`, `@microsoft/microsoft-graph-client`, `@aws-sdk/client-s3`) or from any `apps/desktop/src/main/` or `apps/desktop/src/preload/` path; the CI grep step backs the ESLint rule

### Requirement: Non-usable datasource states render as pattern-A full-replace treatments

When the datasource is not in a state that permits browsing — `disconnected`, `auth-revoked`, `invalid-datasource`, or `syncing` (initial sync in progress) — the entries area of the file explorer SHALL be replaced by a centered state component with a Lucide icon (40px), a 15px semibold headline, 13px body at `text-muted-foreground` (width-capped ~320px), and, for the actionable states, action buttons. Specifically: the `disconnected` state has a single primary `Retry` button; the `auth-revoked` state has a single primary `Reconnect` button; the new `invalid-datasource` state has a primary `Reconnect` button (constructive, neutral `bg-primary` styling) PLUS a secondary `Remove datasource` button (`variant="ghost" size="sm"` with `text-destructive`). The `syncing` state SHALL include a progress label (e.g., "~1,240 files · 32%") rendered in `text-blue-600` but no action button. The `connected-but-empty` state (the datasource is reachable, sync is complete, and the current folder contains zero entries) SHALL render the same pattern with neutral iconography (`FolderOpen`, `text-muted-foreground`) and no action button. The toolbar, breadcrumb, history buttons, and Details pane SHALL remain rendered above / beside the state area in every case.

#### Scenario: Disconnected state renders when list rejects with tag "disconnected"

- **WHEN** `window.api.files.list` rejects with `{ error: { tag: "disconnected", message: "Network unreachable", retryable: true } }` for the currently-viewed folder
- **THEN** the explorer renders a centered component with the `CloudOff` icon in `text-amber-600`, headline "Can't reach this datasource", body "Check your network or try again in a moment.", and an amber `Retry` button that re-dispatches the list when clicked; no file rows are rendered

#### Scenario: Auth-revoked state renders when list rejects with tag "auth-revoked"

- **WHEN** `window.api.files.list` rejects with `{ error: { tag: "auth-revoked", message: "Refresh token expired", retryable: false } }`
- **THEN** the explorer renders a centered component with the `KeyRound` icon in `text-amber-600`, headline "Sign in again to view files", body "Your session for this datasource expired or was revoked.", and an amber `Reconnect` button that routes to the datasource reconnect flow; no file rows are rendered

#### Scenario: Invalid-datasource state renders when list rejects with tag "invalid-datasource"

- **WHEN** `window.api.files.list` rejects with `{ error: { tag: "invalid-datasource", message: "Credentials are missing — reconnect this datasource", retryable: false } }`
- **THEN** the explorer renders a centered component with the `AlertTriangle` icon in `text-destructive` (red-600), headline "This datasource needs reconfiguring", body "Its connection details are missing or invalid. Sign in again or remove the datasource and add it back.", a primary neutral `Reconnect` button, and a secondary `Remove datasource` button with `variant="ghost" size="sm"` and `text-destructive` styling; no file rows are rendered; container element carries `data-testid="file-explorer-state-invalid-datasource"`, `role="alert"`, and `aria-live="polite"`

#### Scenario: Syncing state renders when datasources-store status is "syncing" before the first list response resolves

- **WHEN** the explorer mounts against a datasource whose status in the datasources store is `syncing`, and no prior list response has resolved for the current folder
- **THEN** the explorer renders a centered component with the `RefreshCw` icon spinning at 2.4s linear in `text-blue-600`, headline "Indexing your files…", body "This happens once on first connect. Files will appear as they're discovered."; no action button is rendered; the component includes `role="status"` and `aria-live="polite"`

#### Scenario: Connected-but-empty state renders when the list returns zero entries

- **WHEN** `window.api.files.list` resolves successfully with an empty `entries` array for the current folder, and the datasource status is `connected` or `paused`
- **THEN** the explorer renders a centered component with the `FolderOpen` icon in `text-muted-foreground`, headline "This folder is empty", body "Drop files on your datasource or upload from the sync service — they'll appear here.", and no action button

#### Scenario: State components meet WCAG AA color contrast and expose live regions

- **WHEN** any of the five state components renders
- **THEN** the primary text / icon against the component's background passes WCAG AA contrast (amber-600 on white meets 4.66:1; red-600 on white meets 4.83:1); the component carries `role="status"` (for syncing and connected-but-empty) or `role="alert"` (for disconnected, auth-revoked, and invalid-datasource) with `aria-live="polite"`; icons are marked `aria-hidden="true"`; the primary action button is focusable via keyboard and lands in the tab order immediately after the toolbar. The loading skeleton (separate requirement) is decorative, carries `aria-hidden="true"`, and is NOT a live region — the syncing state is the canonical loading cue for assistive technology

### Requirement: Loading renders skeleton rows matched to the active view mode

While `window.api.files.list` is in flight and no prior response has resolved for the current folder, the entries area SHALL render 6 greyed skeleton rows whose structural silhouette matches the active view mode (List / Details: icon rectangle + name rectangle + trailing metadata rectangle; Small Icons / Tiles: icon rectangle + wrapped-text rectangles; Medium / Large Icons: square image rectangle + name rectangle below). The skeleton rows SHALL NOT include a spinner or text. The skeleton root SHALL be marked `aria-hidden="true"`; since the silhouette conveys no textual information, narrating it would be noise for assistive-technology users. Live-region loading cues are reserved for the syncing state. Skeletons SHALL replace the empty-state and error-state components while loading.

#### Scenario: List mode shows 6 skeleton rows during load

- **WHEN** the user navigates into a folder and the list call has not yet resolved
- **THEN** the entries area renders 6 skeleton rows each with a 14x14px icon rectangle and a 110-220px name rectangle, no spinner and no "Loading…" text; the skeleton DOM is distinguished by `data-testid="file-explorer-skeleton"`

#### Scenario: Skeleton clears as soon as the list response resolves

- **WHEN** the list response resolves with entries (or rejects with a tagged error)
- **THEN** the skeleton is replaced by the entries list (or the appropriate state component) in the same render commit; no intermediate "blank" frame is observable

### Requirement: Engine response is authoritative over datasources-store status

When the datasources-store status and the response from the live engine conflict, the live engine response SHALL govern what the explorer displays. The store MAY be consulted to pick a predictive initial state before the first response resolves (e.g., `syncing` status → show the syncing skeleton optimistically) but once the response lands, the tag on that response determines the rendered state.

#### Scenario: Store says connected but list returns auth-revoked

- **WHEN** the datasources-store status for the current datasource is `connected` and `window.api.files.list` rejects with `{ error: { tag: "auth-revoked" } }`
- **THEN** the explorer renders the auth-revoked state immediately; a subsequent `status-changed` event from the store that updates the status to `error` SHALL NOT cause a visible flicker

#### Scenario: Store says syncing but list returns a populated folder

- **WHEN** the datasources-store status is `syncing` and `window.api.files.list` resolves with a non-empty entries array
- **THEN** the explorer renders the entries list, not the syncing state; the store's `syncing` value does not suppress live successful results

### Requirement: Rename and Download affordances are disabled for engine-backed datasources

When the datasource's `providerKind` is not `"mock"`, the Rename and Download affordances in the file-explorer UI SHALL render in a disabled state. The toolbar's Download button and the per-entry context menu's Download and Rename items SHALL carry `aria-disabled="true"` (not the HTML `disabled` attribute) so keyboard users can focus them to read the describing tooltip. The tooltip SHALL identify the deferred work by change name: "Rename is coming in a future release (see change add-engine-rename-download)" / "Download is coming in a future release (see change add-engine-rename-download)". The `window.api.files.rename` and `window.api.files.download` IPC surfaces SHALL remain reachable for any other caller in this change (they continue to delegate to the mock backend).

#### Scenario: Rename menu item is disabled for a Google Drive entry

- **WHEN** the user right-clicks a file entry from a Google Drive datasource and the context menu opens
- **THEN** the "Rename" item has `aria-disabled="true"`, is keyboard-focusable, and its tooltip reads "Rename is coming in a future release (see change add-engine-rename-download)"; activating it (click or Enter) SHALL be a no-op that does not dispatch an IPC call or change selection state

#### Scenario: Download button is disabled for an S3 entry

- **WHEN** the user selects a file from an Amazon S3 datasource and the toolbar Download button renders
- **THEN** the button has `aria-disabled="true"`, is focusable in the tab order, and its tooltip reads "Download is coming in a future release (see change add-engine-rename-download)"; activating it SHALL be a no-op

#### Scenario: Rename is enabled for a synthetic mock datasource

- **WHEN** the user right-clicks a file entry on a synthetic mock datasource (`providerKind === "mock"`)
- **THEN** the "Rename" item is enabled, carries no `aria-disabled` attribute, and activating it begins the inline rename flow exactly as today

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

### Requirement: Invalid-datasource Reconnect runs in-place via `startConsent` and refreshes on completion

The `<InvalidDatasourceState>` component's `Reconnect` button SHALL call `window.api.datasources.startConsent({ providerId, datasourceId })` directly, capture the returned `sessionId`, and subscribe to consent events scoped to that `sessionId` via the existing `useConsentSession(sessionId)` hook. While `sessionState.status === "pending"`, BOTH action buttons (Reconnect and Remove) SHALL be disabled and the Reconnect button's label SHALL swap to "Connecting…" (no animated spinner — `animate-spin` is forbidden in feature code by the `scripts/motion-budget.test.ts` guardrail per `ui-ux-design` Decision 10; the label-swap matches the existing `AuthErrorBanner` pattern). On `sessionState.status === "completed"`, the component SHALL invoke its parent's `onReconnectSucceeded` callback (which the file-explorer wires to `store.retryLoad()` so `useExplorerData` re-dispatches `files:list`); on a successful subsequent list, the explorer naturally transitions out of the `<InvalidDatasourceState>` arm. On `sessionState.status ∈ {"cancelled", "failed", "timeout"}`, both buttons SHALL re-enable and an inline error line ("Reconnect failed — please try again.") SHALL render below the buttons; the user MAY click Reconnect again to start a fresh session.

The component SHALL NOT route the user back to the dashboard at any point; the Reconnect lifecycle stays inside the file-explorer view.

The `providerId: string` value SHALL be threaded from the route layer (where `summary.providerId` is in scope) through a sibling `providerId?: string` prop on `<FileExplorer>` to the state component. When `providerId` is unavailable (e.g., a test renders the component in isolation without it), the Reconnect button SHALL be disabled with `aria-disabled="true"` and a tooltip "Provider information unavailable — return to the dashboard to reconnect"; this guards against attempting `startConsent` with a missing `providerId`.

#### Scenario: Reconnect button starts a scoped consent session and disables both buttons during pending

- **WHEN** a test renders `<InvalidDatasourceState providerId="google-drive" datasourceId="ds-1" ... />`, clicks the Reconnect button, and `window.api.datasources.startConsent` resolves with `{ sessionId: "sess-1" }`
- **THEN** `startConsent` is called exactly once with `{ providerId: "google-drive", datasourceId: "ds-1" }`, the `sessionId` is recorded, both Reconnect and Remove buttons report `disabled === true` (or `aria-disabled="true"`), and the Reconnect button's visible label swaps to "Connecting…"

#### Scenario: Successful consent triggers `onReconnectSucceeded` callback

- **WHEN** the consent session reaches `status === "completed"` (simulated via the `useConsentSession` mock)
- **THEN** the component's `onReconnectSucceeded()` prop is invoked exactly once; the parent (file-explorer) wires this to `store.retryLoad()`, which bumps `refetchToken` and triggers `useExplorerData` to re-dispatch `files:list`

#### Scenario: Cancelled / failed / timeout re-enables the buttons and shows an error line

- **WHEN** the consent session reaches `status === "cancelled"` (or `"failed"` / `"timeout"`)
- **THEN** both Reconnect and Remove buttons re-enable, the Reconnect button's label returns to "Reconnect", and an inline `<p>` element with text "Reconnect failed — please try again." is rendered below the buttons; clicking Reconnect again starts a fresh `startConsent` flow with a new `sessionId`

#### Scenario: Reconnect button is disabled when providerId is unavailable

- **WHEN** a test renders `<InvalidDatasourceState datasourceId="ds-1" ... />` without the `providerId` prop
- **THEN** the Reconnect button has `aria-disabled="true"`, its tooltip reads "Provider information unavailable — return to the dashboard to reconnect", and clicking it does NOT invoke `startConsent`

### Requirement: Invalid-datasource Remove flows through a shared confirm dialog

The `<InvalidDatasourceState>` component's `Remove datasource` button SHALL open a shared `<ConfirmRemoveDatasourceDialog>` (shadcn `Dialog`) before invoking `window.api.datasources.remove({ datasourceId })`. The dialog SHALL display the headline "Remove this datasource?" and body "This deletes the local registry entry; cloud files are not deleted." with a Cancel button and a destructive Remove button. The destructive Remove button SHALL be the focus target on dialog open, and pressing Escape SHALL cancel without removing.

On successful Remove (the IPC call resolves and a `datasource-removed` event arrives), the file-explorer route SHALL navigate back to `/` because the underlying datasource no longer exists; the `<InvalidDatasourceState>` component does NOT need explicit cleanup logic — the route unmounts the explorer.

The same `<ConfirmRemoveDatasourceDialog>` SHALL be reused by the dashboard card's invalid-datasource banner Remove button (per the `datasources-ui` capability spec) so destructive removal goes through one consistent confirm flow.

#### Scenario: Remove button opens the confirm dialog without invoking the IPC

- **WHEN** a test renders `<InvalidDatasourceState ... />` and clicks the "Remove datasource" button
- **THEN** the `<ConfirmRemoveDatasourceDialog>` opens (visible / `aria-hidden="false"`), `window.api.datasources.remove` has NOT been called yet, the destructive Remove button inside the dialog has focus, and pressing Escape closes the dialog without dispatching any IPC

#### Scenario: Confirming Remove dispatches the datasources.remove IPC

- **WHEN** the confirm dialog is open and the user clicks the destructive Remove button
- **THEN** `window.api.datasources.remove({ datasourceId })` is called exactly once with the component's `datasourceId` prop value; the dialog closes; subsequent navigation to `/` is driven by the route layer (out of scope for this component)

