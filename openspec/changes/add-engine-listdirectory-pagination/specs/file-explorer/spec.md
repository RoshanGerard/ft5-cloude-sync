# Spec delta: `file-explorer`

## ADDED Requirements

### Requirement: Inline "Load more" affordance below the entries list

The file-explorer SHALL render an inline "Load more" affordance whenever the most recent `files:list` response carried `nextCursor !== null`. The affordance SHALL be a full-width shadcn `Button variant="ghost"` rendered in a dedicated region between the scrollable entries area and the status row — never inside the entries scroll container, never overlapping file content, always visible at the bottom regardless of scroll position. The same component SHALL render below all six view modes (List, Details, Small Icons, Tiles, Medium Icons, Large Icons) at full width.

The affordance's button SHALL carry the visible label `Load more` preceded by a leading `<ChevronDown className="size-4" />` icon. The button SHALL apply `border-t border-border` to delineate from the entries area, `h-10` height, and `rounded-none` (the dedicated region edges to the explorer chrome on both sides).

Activating the affordance SHALL re-issue `window.api.files.list({ datasourceId, path, cursor: nextCursor, pageSize })` and append the response's entries to the existing list. While the request is in flight, the button SHALL set `aria-busy="true"`, swap the chevron for a spinner, and SHALL be disabled. On success, the affordance SHALL re-render with the new `nextCursor` (or hide itself when `nextCursor === null`). On failure (after fs-sync's 4-attempt auto-retry has exhausted), the affordance SHALL be replaced by the page-load-failed retry row described below.

#### Scenario: Load-more appears when nextCursor is non-null

- **WHEN** the renderer receives `{ ok: true, value: { entries: [<500>], truncated: true, nextCursor: "tokA" } }` from a `files:list` call against `/big`
- **THEN** the entries area renders the 500 entries; a full-width Load-more button (`<Button variant="ghost" className="w-full justify-center gap-2 rounded-none border-t border-border h-10 font-medium">`) is rendered in the dedicated region above the status row, in every view mode; the button's accessible name is `Load more`; it is keyboard-focusable; the entries scroll container is unchanged

#### Scenario: Load-more click appends entries and updates the cursor

- **WHEN** the user activates the "Load more" affordance and the resulting `files:list` response is `{ ok: true, value: { entries: [<300>], truncated: false, nextCursor: null } }`
- **THEN** the entries area renders 800 entries (the original 500 + the new 300, in response order); the Load-more button is removed from the layout; the status row updates from `500+ items · 500 loaded` to `800 items`

#### Scenario: Load-more is hidden when nextCursor is null on the first page

- **WHEN** the renderer receives `{ ok: true, value: { entries: [<42>], truncated: false, nextCursor: null } }` from a first-page `files:list` call
- **THEN** no Load-more button is rendered; the status row reads `42 items`

#### Scenario: Busy state during in-flight load-more

- **WHEN** the user clicks Load more and the response has not yet returned
- **THEN** the button sets `aria-busy="true"` and is disabled; the chevron icon is replaced by a spinner; the entries already rendered remain visible; selection state is preserved; ghost-variant hover styles are suppressed while busy

### Requirement: Page-load-failed inline retry row

When fs-sync's 4-attempt auto-retry on a paged `files:list` exhausts and returns `{ ok: false, error }`, the file-explorer SHALL render a page-load-failed retry row in place of the Load-more button, in the same dedicated region between the scrollable entries area and the status row. Already-loaded entries SHALL stay visible.

The row SHALL be a two-line layout at approximately `h-20`, with `bg-destructive/8` background tint, `border-t border-destructive/20`, and `text-destructive`. Layout from top:

1. A horizontal flex containing a leading `<AlertCircle className="size-4" />` icon and a stacked text block. The text block's first line is a bold `Couldn't load more entries` headline (`text-sm font-medium`); the second line is a smaller detail line carrying the humanized WIRE error tag and message (`text-xs font-normal opacity-85`), e.g. `Disconnected: connection timed out after 4 attempts` (the renderer only ever sees the wire `FilesErrorTag` vocabulary — `normalizeFilesError` surfaces an engine `network-error` as wire `disconnected`, and a generic engine `provider-error` as wire `other` → "Error").
2. Below the text block, a full-width `<Button variant="outline">` with the visible label `Retry`, bordered in the destructive palette.

The row SHALL announce via `aria-live="assertive"` and SHALL NOT steal focus from the entries area when it appears.

The row SHALL NOT be confused with the datasource-level non-usable-state pattern-A treatment ("Non-usable datasource states render as pattern-A full-replace treatments") — that pattern replaces the entries area; this row is inline and additive.

Retry SHALL re-issue the same request that failed (same `cursor`, same `pageSize`), restarting fs-sync's auto-retry budget. While the retry is in flight, the row SHALL swap back to the Load-more busy-state appearance (full-width ghost button with spinner). On success, the row SHALL be removed and the new entries appended; on second failure, the row SHALL re-render with the latest error.

#### Scenario: Network failure surfaces inline retry row

- **WHEN** fs-sync's `files:list` retry exhausts on a network failure (engine `network-error`, surfaced to the renderer as wire `tag: "disconnected"` per `normalizeFilesError`) for a Load-more click that requested `cursor: "tokA", pageSize: 500`
- **THEN** the entries already loaded remain visible; the Load-more button is replaced by a two-line row in the same region; the row's first line reads `Couldn't load more entries`; the second line reads `Disconnected: <message> after 4 attempts` (the humanized wire `disconnected` tag); a full-width outline Retry button appears below; the row uses `bg-destructive/8` + `border-t border-destructive/20` + `text-destructive`; `aria-live="assertive"` is set; focus is not stolen from the entries area; the status row updates from `500+ items · 500 loaded` to `500 items · couldn't load more`

#### Scenario: Retry click re-issues the same cursor with a fresh budget

- **WHEN** the user clicks Retry on the page-load-failed row
- **THEN** the renderer re-issues `files:list` with the same `cursor` and `pageSize` as the failed call; the row swaps back to the Load-more ghost-button busy-state during the in-flight call; on success the new entries append, the Load-more button reappears (or hides if `nextCursor === null`), and the status row updates accordingly; on failure the auto-retry budget runs again from 0 (4 attempts) before the row redisplays with the latest error message

### Requirement: Settings dialog includes an Explorer section with a Page-size dropdown

The `SettingsDialog` SHALL gain an "Explorer" section sitting between the existing Motion section and the existing Downloads section (top-down: General → Browsing → File-handling). The section SHALL use the same `<h3 className="text-sm font-semibold">` heading + flex-row pattern as Downloads' "Default folder" row.

The section SHALL contain one row: a left-side stack with a `text-xs font-medium` label `Items loaded per page` and a `text-muted-foreground text-xs` description `Larger values fetch more per click; smaller values paint faster on first load.`, plus a right-side dropdown control. The control SHALL be a `<DropdownMenu>` whose `<DropdownMenuTrigger>` is a `<Button variant="outline" size="sm">` showing the current value (with comma separators on values ≥ 1000) and a trailing `<ChevronDown className="size-3" />`. The button SHALL carry `aria-label="Items loaded per page"` so the trigger is announced even before the menu opens.

The `<DropdownMenuContent>` SHALL render with `align="end"`, lead with a `<DropdownMenuLabel className="text-muted-foreground text-xs uppercase tracking-wider">Page size</DropdownMenuLabel>`, and contain a `<DropdownMenuRadioGroup>` with five `<DropdownMenuRadioItem>` entries: `100`, `500`, `1,000`, `5,000`, `10,000` (display text uses comma separators for values ≥ 1000; the underlying string value is the un-formatted integer). All digit displays SHALL use `tabular-nums`.

The selected value SHALL be persisted to the localStorage key `ft5.explorer.pageSize` (mirroring the `ft5.downloads.*` pattern) and SHALL default to `500` on first read. The selected value SHALL be passed as `pageSize` on every `files:list` call originating from the file-explorer (initial page-load and Load-more alike). Changing the setting SHALL NOT auto-refresh the current view; the new value applies to the next list call.

The codebase SHALL NOT introduce a shadcn `Select` primitive for this row — the `DropdownMenu` + `DropdownMenuRadioGroup` pattern matches the existing toolbar View-mode menu (`apps/desktop/src/renderer/src/features/file-explorer/toolbar.tsx`) and avoids a net-new primitive.

#### Scenario: Default page size is 500 on first launch

- **WHEN** the renderer launches with no value at `ft5.explorer.pageSize` and the user opens Settings
- **THEN** the Explorer section's Page-size trigger button shows `500` as the current value; the next `files:list` request emitted by the file-explorer carries `pageSize: 500`

#### Scenario: Changing page size persists and applies to the next list call

- **WHEN** the user opens Settings, opens the Page-size dropdown, selects `1,000`, closes the dialog, then navigates to a new folder
- **THEN** the localStorage key `ft5.explorer.pageSize` is `"1000"` (no comma in the persisted value); the trigger button now shows `1,000`; the next `files:list` request carries `pageSize: 1000`; the previously rendered folder is NOT re-fetched

#### Scenario: Page size dropdown is keyboard-reachable and labeled

- **WHEN** the user tabs through the Settings dialog with the Explorer section visible
- **THEN** the Page-size trigger button receives focus with the standard 3px focus ring; it has accessible name `Items loaded per page`; activating it (Enter or Space) opens the menu; arrow keys move through `100`, `500`, `1,000`, `5,000`, `10,000`; Enter selects; Escape closes the menu without changing the value

#### Scenario: Active value is indicated in the menu

- **WHEN** the dropdown is open with the persisted value at `500`
- **THEN** the `500` `<DropdownMenuRadioItem>` shows a check icon to its left (the standard `DropdownMenuRadioItem` indicator); the other four entries do not; the menu's leading `<DropdownMenuLabel>` reads `Page size` in uppercase, `tracking-wider`, `text-muted-foreground`

## MODIFIED Requirements

### Requirement: Explorer chrome — breadcrumb, back / forward / up, toolbar, status row

The explorer SHALL render a navigation bar below the window title bar containing: Back, Forward, and Up-one-level buttons, plus a clickable breadcrumb trail showing every path segment from the datasource root to the current folder. The explorer SHALL also render a toolbar with controls for Upload (opens the Upload dialog), Delete (selection), Sort, Search, View mode, and Details-pane toggle. The explorer SHALL render a status row at the bottom showing the current item count, selection count, and a more-available indicator when the current listing has unloaded pages.

#### Scenario: Breadcrumb renders the full path with segment-level navigation

- **WHEN** the current path is `/projects/docs/2026`
- **THEN** the breadcrumb renders four keyboard-focusable segments ("root" → "projects" → "docs" → "2026") separated by `›` chevrons at `text-muted-foreground`; clicking or pressing Enter on any segment navigates to that path

#### Scenario: Back, Forward, and Up operate on the explorer's history stack

- **WHEN** the user navigates root → `projects` → `docs`, then clicks Back
- **THEN** the explorer navigates to `projects`; clicking Back again navigates to root; clicking Forward from root navigates to `projects`; clicking Up from `/projects/docs` navigates to `/projects`; Back and Forward buttons are disabled at the ends of the stack

#### Scenario: Status row reflects item and selection counts

- **WHEN** the current folder contains 12 entries (all loaded, `nextCursor === null`) and the user has 3 selected
- **THEN** the status row renders the text `12 items · 3 selected` with digits in a `tabular-nums` element; the text updates within one render when selection or contents change; the status is exposed via `aria-live="polite"`

#### Scenario: Status row indicates more-available when nextCursor is non-null

- **WHEN** the current folder has 500 entries loaded and `nextCursor !== null` (the response indicated more pages)
- **THEN** the status row renders the text `500+ items · 500 loaded` with both numerals in `tabular-nums`; if a selection exists the suffix `· N selected` is appended; `aria-live="polite"` remains in place

#### Scenario: Status row indicates load-failed after exhausted retry

- **WHEN** the current folder has 500 entries loaded and the most recent Load-more click failed after fs-sync's 4-attempt auto-retry exhausted
- **THEN** the status row renders the text `500 items · couldn't load more` with the numeral in `tabular-nums`; if a selection exists the suffix `· N selected` is appended; the entries already loaded remain visible

#### Scenario: Toolbar controls are all keyboard reachable and accessibly named

- **WHEN** the user tabs through the toolbar
- **THEN** each control (Upload, Delete, Sort, Search, View mode, Details toggle) receives focus with a visible focus ring; each has an accessible name regardless of whether the visible label is icon-only; each can be activated via Enter or Space

#### Scenario: Upload toolbar button is present and opens the Upload dialog

- **WHEN** the user activates the Upload toolbar button (click, Enter, or Space) while viewing `/projects/2026` on a connected datasource
- **THEN** the Upload dialog opens with the destination pre-selected to `/projects/2026`; the Files-to-upload list is empty; clicking "+ Add files…" opens the native OS picker via `window.api.datasources.pickFilesToUpload`

### Requirement: File operations use the `window.api.files.*` IPC surface with full four-layer wiring

All file-system reads and mutations from the renderer SHALL go through the `window.api.files.*` surface. The surface SHALL expose `list(req)`, `stat(req)`, `search(req)`, `rename(req)`, `remove(req)`, and `download(req)`. Each method SHALL have a typed request/response pair in `packages/ipc-contracts/src/files.ts`, an `ipcMain.handle` implementation under `apps/desktop/src/main/ipc/files/`, a preload binding via `contextBridge.exposeInMainWorld`, and at least one renderer call site. The `list`, `stat`, `search`, and `remove` handlers SHALL delegate to the `fs-sync-service` RPC commands `files:list` / `files:stat` / `files:search` / `files:remove`, which in turn delegate to the live engine. The `rename` and `download` handlers SHALL continue to delegate to `mock-fs` until the `add-engine-rename-download` change lands. The renderer SHALL NOT import any provider SDK, `fs`, `child_process`, `electron`, `drizzle-orm`, or any module under `apps/desktop/src/main/` or `apps/desktop/src/preload/`.

The `list` request SHALL accept optional `cursor: string` and `pageSize: number` fields. The `list` response value SHALL include `nextCursor: string | null` in addition to `entries` and `truncated`.

#### Scenario: All six methods are wired at all four layers

- **WHEN** a Vitest test inspects the project for the `files` IPC surface
- **THEN** each of `list`, `stat`, `search`, `rename`, `remove`, `download` has a declared contract type, a main-process handler file, a preload-exposed method on `window.api.files`, and at least one renderer call site; missing any layer SHALL cause the test to fail

#### Scenario: list / stat / search / remove round-trip through the sync service to the engine

- **WHEN** the renderer invokes `window.api.files.list({ datasourceId, path, cursor, pageSize })` for an engine-backed datasource
- **THEN** the main-process handler sends `files:list` to the sync service via `SyncClient.request` with the same `{ cursor, pageSize }`; the sync service resolves the engine client for `datasourceId` and calls `client.listDirectory({ kind: "path", path }, { cursor, pageSize })`; the result (including `nextCursor`) is serialized through the sync-service command envelope back to the renderer without any provider-SDK type leaking across the process boundary

#### Scenario: list response carries `nextCursor` and derived `truncated`

- **WHEN** a unit test stubs the `files:list` round-trip to resolve with `{ ok: true, value: { entries: [<10>], truncated: true, nextCursor: "tokA" } }`
- **THEN** the renderer's explorer store records `nextCursor: "tokA"`; the file-explorer renders the full-width Load-more ghost button in its dedicated region above the status row; the status row reads `10+ items · 10 loaded`

#### Scenario: rename and download still round-trip through mock-fs

- **WHEN** the renderer (e.g., a synthetic mock datasource test page) invokes `window.api.files.rename` or `window.api.files.download`
- **THEN** the main-process handler delegates to `mock-fs` and returns structured-clone-safe data; no sync-service call is issued

#### Scenario: Renderer has no provider-SDK import in file-explorer code

- **WHEN** `pnpm lint` runs
- **THEN** ESLint reports an error for any file under `apps/desktop/src/renderer/src/features/file-explorer/` that imports from a provider SDK package (`googleapis`, `@microsoft/microsoft-graph-client`, `@aws-sdk/client-s3`) or from any `apps/desktop/src/main/` or `apps/desktop/src/preload/` path; the CI grep step backs the ESLint rule
