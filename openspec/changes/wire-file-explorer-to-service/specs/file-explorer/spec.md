## ADDED Requirements

### Requirement: Non-usable datasource states render as pattern-A full-replace treatments

When the datasource is not in a state that permits browsing — `disconnected`, `auth-revoked`, or `syncing` (initial sync in progress) — the entries area of the file explorer SHALL be replaced by a centered state component with a Lucide icon (40px), a 15px semibold headline, 13px body at `text-muted-foreground` (width-capped ~320px), and, for the two amber states, a single primary action button (`Retry` for disconnected; `Reconnect` for auth-revoked). The `syncing` state SHALL include a progress label (e.g., "~1,240 files · 32%") rendered in `text-blue-600` but no action button. The `connected-but-empty` state (the datasource is reachable, sync is complete, and the current folder contains zero entries) SHALL render the same pattern with neutral iconography (`FolderOpen`, `text-muted-foreground`) and no action button. The toolbar, breadcrumb, history buttons, and Details pane SHALL remain rendered above / beside the state area in every case.

#### Scenario: Disconnected state renders when list rejects with tag "disconnected"

- **WHEN** `window.api.files.list` rejects with `{ error: { tag: "disconnected", message: "Network unreachable", retryable: true } }` for the currently-viewed folder
- **THEN** the explorer renders a centered component with the `CloudOff` icon in `text-amber-600`, headline "Can't reach this datasource", body "Check your network or try again in a moment.", and an amber `Retry` button that re-dispatches the list when clicked; no file rows are rendered

#### Scenario: Auth-revoked state renders when list rejects with tag "auth-revoked"

- **WHEN** `window.api.files.list` rejects with `{ error: { tag: "auth-revoked", message: "Refresh token expired", retryable: false } }`
- **THEN** the explorer renders a centered component with the `KeyRound` icon in `text-amber-600`, headline "Sign in again to view files", body "Your session for this datasource expired or was revoked.", and an amber `Reconnect` button that routes to the datasource reconnect flow; no file rows are rendered

#### Scenario: Syncing state renders when datasources-store status is "syncing" before the first list response resolves

- **WHEN** the explorer mounts against a datasource whose status in the datasources store is `syncing`, and no prior list response has resolved for the current folder
- **THEN** the explorer renders a centered component with the `RefreshCw` icon spinning at 2.4s linear in `text-blue-600`, headline "Indexing your files…", body "This happens once on first connect. Files will appear as they're discovered."; no action button is rendered; the component includes `role="status"` and `aria-live="polite"`

#### Scenario: Connected-but-empty state renders when the list returns zero entries

- **WHEN** `window.api.files.list` resolves successfully with an empty `entries` array for the current folder, and the datasource status is `connected` or `paused`
- **THEN** the explorer renders a centered component with the `FolderOpen` icon in `text-muted-foreground`, headline "This folder is empty", body "Drop files on your datasource or upload from the sync service — they'll appear here.", and no action button

#### Scenario: State components meet WCAG AA color contrast and expose live regions

- **WHEN** any of the four state components renders
- **THEN** the primary text / icon against the component's background passes WCAG AA contrast (amber-600 on white meets 4.66:1); the component carries `role="status"` (for loading and syncing) or `role="alert"` (for disconnected and auth-revoked) with `aria-live="polite"`; icons are marked `aria-hidden="true"`; the primary action button is focusable via keyboard and lands in the tab order immediately after the toolbar

### Requirement: Loading renders skeleton rows matched to the active view mode

While `window.api.files.list` is in flight and no prior response has resolved for the current folder, the entries area SHALL render 6 greyed skeleton rows whose structural silhouette matches the active view mode (List / Details: icon rectangle + name rectangle + trailing metadata rectangle; Small Icons / Tiles: icon rectangle + wrapped-text rectangles; Medium / Large Icons: square image rectangle + name rectangle below). The skeleton rows SHALL NOT include a spinner or text. Skeletons SHALL replace the empty-state and error-state components while loading.

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

## MODIFIED Requirements

### Requirement: Rename, delete, and download are async operations with per-entry pending and error state

Every rename and delete operation SHALL be represented in the store as a pending operation keyed by the affected entry id. The entry SHALL render in a visibly-pending state (dim opacity plus an inline pending glyph drawing from the permitted motion set) from the moment the user commits the action until the IPC call resolves. On success the UI SHALL reflect the final state (renamed entry, entry removed from list). On failure the UI SHALL revert to the pre-operation state and surface the reason both inline on the entry (icon + tooltip) and as a `sonner` toast. Delete SHALL require a confirmation dialog before dispatching the IPC call. Rename and Download SHALL be disabled for engine-backed datasources per the separate "Rename and Download affordances are disabled for engine-backed datasources" requirement; on synthetic mock datasources, rename SHALL remain available for file entries only and directory rename SHALL be disabled with a "Folder rename is not supported in this version" affordance. Bulk delete issues a single `window.api.files.remove` call with N paths; the service processes each path in parallel against the engine, and the response carries a per-path result envelope.

#### Scenario: Delete shows a confirmation dialog before dispatching

- **WHEN** the user activates Delete on a selection of N entries
- **THEN** a confirmation dialog opens with the message "Delete N items? This action cannot be undone." and buttons "Cancel" and "Delete"; "Delete" is the destructive-styled default; dispatching the IPC call does NOT occur unless "Delete" is pressed; Escape cancels

#### Scenario: Entry shows pending state during a rename on a mock datasource

- **WHEN** the user commits a rename on entry X of a synthetic mock datasource
- **THEN** entry X renders at `opacity-60` with an inline pulsing glyph (using `animate-sync-pulse` from the permitted motion set) and its name shows the new requested name; other entries are unchanged; X's quick-action affordances are disabled until the operation resolves

#### Scenario: Partial-failure bulk delete surfaces per-path result

- **WHEN** the user deletes 5 engine-backed entries and the response is `{ ok: true, results: [{ path: "a", ok: true }, { path: "b", ok: true }, { path: "c", ok: true }, { path: "d", ok: false, error: { tag: "other", message: "provider locked the file" } }, { path: "e", ok: false, error: { tag: "rate-limited", message: "too many requests" } }] }`
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

## REMOVED Requirements

### Requirement: Directory-size ceiling is enforced on mocked fixtures

**Reason**: The 300-entry ceiling was a property of the in-memory mock file system, not of the file-explorer capability. Once `list` / `stat` / `search` / `remove` are backed by the live engine (per the `files:*` sync-service commands added in this change), the ceiling becomes meaningless: the engine returns whatever the provider returns. Directory-size limits in the real world are a function of provider pagination, which is tracked as a follow-up change (`add-engine-listdirectory-pagination`).

**Migration**: No migration is required for runtime behavior. Tests that asserted the 300-entry ceiling against the mock filesystem SHALL be removed as part of this change; the "naive render of a 300-entry directory meets the frame budget" assertion SHALL be replaced by a non-binding performance note in `design.md` until pagination is introduced. Callers that relied on "directories are always <= 300 entries" in their own code SHALL switch to defensive iteration or adopt the forthcoming pagination envelope from `add-engine-listdirectory-pagination`.
