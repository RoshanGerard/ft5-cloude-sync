# file-explorer

## ADDED Requirements

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

The explorer SHALL render a navigation bar below the window title bar containing: Back, Forward, and Up-one-level buttons, plus a clickable breadcrumb trail showing every path segment from the datasource root to the current folder. The explorer SHALL also render a toolbar with controls for Delete (selection), Sort, Search, View mode, and Details-pane toggle. The explorer SHALL render a status row at the bottom showing the current item count and selection count.

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
- **THEN** each control (Delete, Sort, Search, View mode, Details toggle) receives focus with a visible focus ring; each has an accessible name regardless of whether the visible label is icon-only; each can be activated via Enter or Space

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

Every rename and delete operation SHALL be represented in the store as a pending operation keyed by the affected entry id. The entry SHALL render in a visibly-pending state (dim opacity plus an inline pending glyph drawing from the permitted motion set) from the moment the user commits the action until the IPC call resolves. On success the UI SHALL reflect the final state (renamed entry, entry removed from list). On failure the UI SHALL revert to the pre-operation state and surface the reason both inline on the entry (icon + tooltip) and as a `sonner` toast. Delete SHALL require a confirmation dialog before dispatching the IPC call. Rename SHALL be available for file entries only in this change; directory rename SHALL be disabled with a "Folder rename is not supported in this version" affordance.

#### Scenario: Delete shows a confirmation dialog before dispatching

- **WHEN** the user activates Delete on a selection of N entries
- **THEN** a confirmation dialog opens with the message "Delete N items? This action cannot be undone." and buttons "Cancel" and "Delete"; "Delete" is the destructive-styled default; dispatching the IPC call does NOT occur unless "Delete" is pressed; Escape cancels

#### Scenario: Entry shows pending state during a rename

- **WHEN** the user commits a rename on entry X
- **THEN** entry X renders at `opacity-60` with an inline pulsing glyph (using `animate-sync-pulse` from the permitted motion set) and its name shows the new requested name; other entries are unchanged; X's quick-action affordances are disabled until the operation resolves

#### Scenario: Failed delete reverts and surfaces the reason

- **WHEN** the user deletes 3 entries and the handler returns `{ removed: ["a", "b"], failed: [{ path: "c", reason: "provider locked the file" }] }`
- **THEN** entries `a` and `b` are removed from the list; entry `c` is restored to its pre-operation state with an inline error icon whose tooltip reads "provider locked the file"; a `sonner` toast announces "Deleted 2 of 3 items; 1 failed" and provides a "View details" affordance to inspect the failure

#### Scenario: Multi-selection delete issues a single IPC call

- **WHEN** the user confirms delete on a selection of N entries
- **THEN** the store issues exactly one `window.api.files.remove` call with the N paths in its request; not N separate calls; partial failure is surfaced per the previous scenario

#### Scenario: Directory rename is disabled in v1

- **WHEN** the user attempts to rename a directory entry (via F2, context menu, or any other path)
- **THEN** the action is refused with an inline message or tooltip "Folder rename is not supported in this version"; no IPC call is issued; the directory's state is unchanged

### Requirement: Search operates across the datasource from root with provider-honest limits

The explorer toolbar SHALL expose a search affordance that, when activated, searches the entire datasource from its root. The search request SHALL be dispatched via `window.api.files.search({ datasourceId, query, path: "/" })`. The response SHALL include a `truncated` boolean that the UI SHALL surface when `true`. For Amazon S3 datasources in this change, the handler SHALL perform a client-side paginated scan and return matching entries. For Google Drive and OneDrive datasources in this change, the handler SHALL return an empty result with `truncated: true` and a metadata flag indicating native search is deferred, and the UI SHALL render a clear "Native search for this provider is not available yet" message alongside the results.

#### Scenario: Search for an S3 datasource returns scan results

- **WHEN** the user enters a search query against an S3 datasource and submits
- **THEN** the UI renders the matching entries from the scan with each entry's parent path shown as a secondary line; activating an entry opens its parent folder with the entry focused; if the scan hit its ceiling the UI renders "Showing first N results — scan truncated" near the results

#### Scenario: Search for Drive or OneDrive shows the deferred-work state

- **WHEN** the user enters a search query against a Google Drive or OneDrive datasource and submits
- **THEN** the UI renders an empty result area with the message "Native search for Google Drive is not available yet" (or "for OneDrive"); the search input remains populated; the message links to the follow-up-work docs

#### Scenario: Clearing the search restores the current folder view

- **WHEN** the user clears the search input or dismisses the search UI
- **THEN** the main pane reverts to showing the current folder's entries from before the search was initiated; selection that was in place before the search is restored; focus returns to the search-toggle control or the previously-focused entry

### Requirement: File operations use the `window.api.files.*` IPC surface with full four-layer wiring

All file-system reads and mutations from the renderer SHALL go through the `window.api.files.*` surface. The surface SHALL expose `list(req)`, `stat(req)`, `search(req)`, `rename(req)`, `remove(req)`, and `download(req)`. Each method SHALL have a typed request/response pair in `packages/ipc-contracts/src/files.ts`, an `ipcMain.handle` implementation under `apps/desktop/src/main/ipc/files/`, a preload binding via `contextBridge.exposeInMainWorld`, and at least one renderer call site. The renderer SHALL NOT import any provider SDK, `fs`, `child_process`, `electron`, `drizzle-orm`, or any module under `apps/desktop/src/main/` or `apps/desktop/src/preload/`.

#### Scenario: All six methods are wired at all four layers

- **WHEN** a Vitest test inspects the project for the `files` IPC surface
- **THEN** each of `list`, `stat`, `search`, `rename`, `remove`, `download` has a declared contract type, a main-process handler file, a preload-exposed method on `window.api.files`, and at least one renderer call site; missing any layer SHALL cause the test to fail

#### Scenario: Mocked data round-trips through IPC for all methods

- **WHEN** the renderer invokes any `window.api.files.*` method during this change's lifetime
- **THEN** the main-process handler returns structured-clone-safe data from the in-memory mock file system; the renderer receives the payload typed per the contract; no value's type crosses the boundary as `any`

#### Scenario: Renderer has no provider-SDK import in file-explorer code

- **WHEN** `pnpm lint` runs
- **THEN** ESLint reports an error for any file under `apps/desktop/src/renderer/src/features/file-explorer/` that imports from a provider SDK package (`googleapis`, `@microsoft/microsoft-graph-client`, `@aws-sdk/client-s3`) or from any `apps/desktop/src/main/` or `apps/desktop/src/preload/` path; the CI grep step backs the ESLint rule

### Requirement: Directory-size ceiling is enforced on mocked fixtures

The in-memory mock file system SHALL NOT seed any single directory with more than 300 entries in this change. A Vitest test SHALL assert this ceiling against every seeded directory. The renderer SHALL be permitted to use a naive (non-virtualized) render for directories at or below this ceiling across all six view modes.

#### Scenario: Ceiling test fails when a mock directory exceeds 300 entries

- **WHEN** a seeded directory in the mock file system contains more than 300 entries
- **THEN** the ceiling guardrail test fails with a message identifying the offending directory path and its entry count; the test is green for every directory at or below the ceiling

#### Scenario: Naive render of a 300-entry directory meets the frame budget

- **WHEN** a 300-entry directory is rendered in Details mode in a jsdom test environment
- **THEN** the initial render completes within 50 ms; the test asserts this bound via `performance.now()` taken before and after the render commit
