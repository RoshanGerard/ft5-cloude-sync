# Tasks

Implementation plan for `ui-file-explorer`. Every task is expected to follow the project's coding discipline (TDD, one task per subagent, two-stage review between tasks, four-layer IPC guardrail). Tasks are grouped into phases; phases are run in order; within a phase, sibling tasks are independent unless a dependency arrow (`→`) is noted.

## Phase 1 — Contracts and mocked IPC foundation

- [x] 1.1 Write failing `packages/ipc-contracts/src/__tests__/files.test-d.ts` asserting the shape of `FileEntry`, `FilesListRequest/Response`, `FilesStatRequest/Response`, `FilesSearchRequest/Response`, `FilesRenameRequest/Response`, `FilesRemoveRequest/Response`, `FilesDownloadRequest/Response` per design.md Decision 2.
- [x] 1.2 Implement `packages/ipc-contracts/src/files.ts` with the types in Decision 2. Export from the package's index.
- [x] 1.3 Extend the four-layer IPC guardrail test (`scripts/ipc-datasources-four-layer.test.ts` — rename to `ipc-four-layer.test.ts` if it doesn't already cover multiple surfaces) to also assert every `files.*` method has all four layers present. *(Impl note: kept as a sibling `scripts/ipc-files-four-layer.test.ts`. The two surfaces grow at different paces and channel literals differ — a single file would need a per-surface expected-channel table with no real simplification. Rename deferred until a third surface warrants consolidation.)*
- [x] 1.4 Write failing tests for the in-memory mock file system in `apps/desktop/src/main/ipc/files/__tests__/mock-fs.test.ts` — seeding per datasource id, directory listing, stat, rename (files only), remove (partial failure supported), download.
- [x] 1.5 Implement `apps/desktop/src/main/ipc/files/mock-fs.ts` with plausible fixture trees per datasource (Google Drive: document-heavy; OneDrive: mixed; S3: image / video / archive mix). Enforce the 300-entry per-directory ceiling inline and export a helper for the ceiling guardrail test.
- [x] 1.6 Write failing guardrail test `scripts/mock-fs-ceiling.test.ts` asserting no seeded directory exceeds 300 entries.
- [x] 1.7 Implement `apps/desktop/src/main/ipc/files/handlers.ts` (one `ipcMain.handle` per method) delegating to `mock-fs.ts`. Register via the existing `registerIpcHandlers` entry point. *(Impl note: split into one file per method — `list.ts`, `stat.ts`, `search.ts`, `rename.ts`, `remove.ts`, `download.ts` — to mirror the established `main/ipc/datasources/` layout. `ipcMain.handle` calls live in `main/ipc/index.ts` as before, not in a dedicated handlers.ts.)*
- [x] 1.8 Extend `apps/desktop/src/preload/index.ts` to expose `window.api.files.{list,stat,search,rename,remove,download}`. Update `preload-bundle.test.ts` to ensure the `@ft5/ipc-contracts` external still resolves correctly.
- [x] 1.9 Write failing test `apps/desktop/src/renderer/src/features/file-explorer/__tests__/ipc-round-trip.test.ts` calling each `window.api.files.*` method against a mocked preload bridge, asserting structured-clone-safe round-trip.

## Phase 2 — Explorer route, store, and history

- [x] 2.1 Write failing test for `features/file-explorer/store.ts` covering initial state, `navigate`, `back`, `forward`, `up`, `select` (single / range / toggle), `setViewMode`, `sort`, persisted preferences load / save, `pendingOps` insertion / clear, `lastError` surfacing.
- [x] 2.2 Implement `features/file-explorer/store.ts` using `useSyncExternalStore`, matching the pattern of `features/theme/theme-store.ts`. Cross-session preferences (view mode, details-pane open, sort order) via `localStorage` under a per-datasource key.
- [x] 2.3 Write failing test for `app/datasources/explore/page.tsx` — reads the `id` query parameter; renders the explorer when `id` resolves to a known datasource; renders a "Datasource not found" error when `id` is absent or unknown; mounts the store with the correct datasource id via `useExplorerStore(id)`.
- [x] 2.4 Implement the route page and wire it into Next.js routing.
- [x] 2.5 Write failing test for `features/file-explorer/breadcrumb.tsx` — renders segments for a given path, activates per-segment navigation on click and Enter, exposes `<nav aria-label="Folder path">`.
- [x] 2.6 Implement the breadcrumb component.
- [x] 2.7 Write failing test for back/forward/up buttons — correct enabled state at history bounds, keyboard activation, proper aria-labels.
- [x] 2.8 Implement the back / forward / up controls as part of the explorer chrome.

## Phase 3 — View modes and icon mapping

- [x] 3.1 Write failing test for `features/file-explorer/icons.ts` — covers every `MimeFamily` value plus `directory` `EntryKind`, returns the documented lucide icon names.
- [x] 3.2 Implement `features/file-explorer/icons.ts` consumed through the existing `Icon` adapter. Add any missing names to the `IconName` union and wire them to the lucide imports.
- [x] 3.3 Write a failing guardrail test asserting no file under `features/file-explorer/` contains an expression like `name.split('.').pop()` or similar extension-parsing for icon selection.
- [x] 3.4 Write failing test for `features/file-explorer/view-modes/details.tsx` — renders columns (icon, name, type, size, modified), sorts on column header click, renders `tabular-nums` for size and modified, handles empty directories.
- [x] 3.5 Implement `view-modes/details.tsx`. This is the default mode, so it also gets the happy-path tests for selection, keyboard nav, and sort wiring; subsequent modes reuse the shared selection/keyboard hooks.
- [x] 3.6 Write failing test for `view-modes/list.tsx` — single-column compact flow, icon + name only.
- [x] 3.7 Implement `view-modes/list.tsx`.
- [x] 3.8 Write failing test for `view-modes/small-icons.tsx` — 16 px icon + name, wrapping flex flow.
- [x] 3.9 Implement `view-modes/small-icons.tsx`.
- [x] 3.10 Write failing test for `view-modes/tiles.tsx` — 64 px icon + name + 2-line metadata (type, size).
- [x] 3.11 Implement `view-modes/tiles.tsx`.
- [x] 3.12 Write failing test for `view-modes/medium-icons.tsx` — 64 px icon above name, wrapping grid.
- [x] 3.13 Implement `view-modes/medium-icons.tsx`.
- [x] 3.14 Write failing test for `view-modes/large-icons.tsx` — 96 px icon above name, wrapping grid.
- [x] 3.15 Implement `view-modes/large-icons.tsx`.
- [x] 3.16 Write failing test for the View menu in `features/file-explorer/toolbar.tsx` — six radio items, current mode checked, selection switches the active renderer.
- [x] 3.17 Implement the View menu entry of the toolbar.
- [x] 3.18 Write failing test: selection and focus survive a mode switch (selection count identical before/after). *(Impl note: factored `view-mode-switcher.tsx` as a separate composable component so Phase 4's status row and Phase 5's details pane can compose with it.)*
- [x] 3.19 Verify Phase 3 against the guardrail test for directory-size render budget. *(Impl note: landed at `scripts/render-budget.test.tsx` (not `.ts` — the test renders React so JSX is needed; vitest include pattern widened to `scripts/**/*.test.{ts,tsx}`). Default ceiling 500 ms (jsdom is materially slower than the 50 ms dev-host budget in design.md Decision 10); measured locally at 150–180 ms. Ceiling overridable via `FT5_RENDER_BUDGET_MS` for CI.)*

## Phase 4 — Selection, keyboard, and context menu

> Composite-wiring note (not a numbered entry). Subagent P landed a follow-up commit on top of 4.1–4.8 that wires the previously-standalone chrome into the `FileExplorer` wrapper, adds `features/file-explorer/use-explorer-data.ts` to drive `window.api.files.list` on mount / currentPath change, and wraps each view-mode cell in `FileContextMenu`. No new task rows — the scope is the "make Phase 4 visible end-to-end" glue the prior subagents intentionally deferred. Covered by `features/file-explorer/__tests__/file-explorer-composite.test.tsx` (5 integration tests).


- [x] 4.1 Write failing test for the selection reducer — click, shift-click, ctrl-click, select-all, clear. *(Impl note: substantive coverage already shipped via `store.test.ts` (Phase 2, commit d92ae2b) + per-view-mode click tests (Phase 3). The new `keyboard-nav.test.tsx` includes the "click routes through `useSelection` and sets focus" case as the residual integration assertion.)*
- [x] 4.2 Implement the shared selection + keyboard-nav hooks consumed by every view mode. *(Impl note: `useSelection` already landed in Phase 3 (click translation only); `useKeyboardNav` in `features/file-explorer/use-keyboard-nav.ts` composes alongside it.)*
- [x] 4.3 Write failing test for keyboard bindings — arrow keys move focus, Enter activates, Delete initiates delete (opens confirm dialog), F2 starts rename, Ctrl/Cmd+A selects all. *(Impl note: landed as `features/file-explorer/__tests__/keyboard-nav.test.tsx` (15 tests) composing DetailsView with the hook. Delete + F2 assert their callback stubs fire — Phase 6 wires the confirm dialog / inline rename UI.)*
- [x] 4.4 Wire the bindings into each view mode; keep the binding layer in one shared hook so the six modes share semantics. *(Impl note: every view mode now accepts `{ focusedId, setFocusedId }`, applies a `ring-ring ring-2 ring-inset` highlight on the focused cell, and uses a roving-tabindex pattern (focused cell `tabIndex=0`; others `-1`). `ViewModeSwitcher` takes an optional `keyboardNav` bag and binds `onKeyDown` on its outer container so arrow keys fire regardless of which cell holds browser focus.)*
- [x] 4.5 Write failing test for `features/file-explorer/context-menu.tsx` — six items in order, directory disables Rename, Escape closes and restores focus. *(Impl note: Escape-closes-menu asserted directly; focus restoration to the trigger is a Radix `@radix-ui/react-focus-scope` concern not reliably reproducible in jsdom — test uses a weaker "trigger stays focusable" invariant instead, with an inline comment explaining the jsdom gap. Real-browser focus restoration verified by the spec scenario at archive-time.)*
- [x] 4.6 Implement the context menu, trigger on right-click and on Shift+F10 / Menu key.
- [x] 4.7 Write failing test for the `aria-live` status row — announces selection changes without announcing unrelated re-renders.
- [x] 4.8 Implement the status row.

## Phase 5 — Details pane and Properties modal

- [x] 5.1 Write failing test for `features/file-explorer/metadata/field-catalog.ts` — exports a field list and the two curated subsets (pane / modal).
- [x] 5.2 Implement the field catalog and the render primitives for each field (label, value, copy-to-clipboard affordance on modal). *(Impl note: Selectors return formatted display strings for non-null values (via `formatDate`, `formatSize`, `formatType`) and raw `null` for missing values; `rawSelector` exposes the original value for clipboard copy. Render primitives substitute em-dash for null.)*
- [x] 5.3 Write failing test for `features/file-explorer/details-pane.tsx` — toggles, reflects selection, shows multi-select summary, persists open state per-datasource across mounts (assert via `localStorage` side-effect). *(Impl note: reused the store's existing `ft5.file-explorer.<datasourceId>.prefs` key rather than inventing a pane-specific key — the prefs object already carried `detailsPaneOpen`.)*
- [x] 5.4 Implement the Details pane. *(Impl note: `commonParentPath` is a path-segment longest prefix (not char prefix), exposed as a named export so the multi-select summary tests can drive it directly. Slide motion is deferred until the 6.12 motion-whitelist update — pane mounts/unmounts without animation. Toolbar gains a `DetailsToggle` button with `aria-pressed`; no aria-expanded since the pane isn't a disclosure.)*
- [x] 5.5 Write failing test for `features/file-explorer/properties-modal.tsx` — opens on context-menu Properties, shows full metadata dossier, focus-trapped, Escape closes. *(Impl note: Tab-cycling asserted as a jsdom-portable invariant — all focusables contained in the dialog + shadcn close button present — because `@testing-library/user-event` is not a project dep and Radix focus-scope Tab handling is unreliable under jsdom. Same pattern as `context-menu.test.tsx`. Escape-closes-modal asserted directly; focus restoration left to real-browser verification at archive time.)*
- [x] 5.6 Implement the Properties modal via the existing shadcn `Dialog` primitive. *(Impl note: store gained `propertiesEntry: FileEntry | null` + `openProperties` / `closeProperties`; modal open state is derived (`propertiesEntry !== null`) and session-local — modal state is transient per the Windows Explorer idiom. Provider metadata rows use `FieldRowWithCopy` (not plain `FieldRow`) so every row carries a copy affordance. Added an sr-only `DialogDescription` to silence Radix's a11y warning. Clipboard-copy failures surface through `onCopyError` → `sonner` toast.)*

## Phase 6 — Rename, delete, download operations

- [x] 6.1 Write failing test for the `rename` action in the store — inserts into `pendingOps`, awaits IPC, on success replaces the entry, on failure reverts and sets `lastError`; test covers file rename and rejects directory rename with a "not supported in v1" error. *(Impl note: refusal copy exported as `DIRECTORY_RENAME_REFUSAL` and `EMPTY_NAME_REFUSAL` constants from `store.ts` so 6.5+ can reuse them.)*
- [x] 6.2 Implement the rename action. Wire F2 + context-menu Rename into it. *(Impl note: F2 and context-menu Rename both call `store.startEdit(entry.id)` — the inline UI's Enter is what commits the rename. Store actions are `startEdit` / `cancelEdit` / `rename`. `PendingOp` gained an optional `newName` so the optimistic-display path can paint the requested name during flight.)*
- [x] 6.3 Write failing test for the inline rename UI — F2 flips the name to an editable input with the name selected; Enter commits; Escape aborts without dispatching IPC.
- [x] 6.4 Implement the inline rename UI inside each view mode's cell. *(Impl note: landed as a shared `features/file-explorer/entry-name-cell.tsx` consumed by every view mode's name element; the cell subscribes to the store directly via `useSyncExternalStore` so editing / pending-op state is reflected in every mode without per-mode plumbing. Input handles onBlur-cancels (click-outside) and stops Enter/Escape/Arrow propagation so they don't bubble to the view-mode keyboard handler.)*
- [x] 6.5 Write failing test for `features/file-explorer/confirm-delete-dialog.tsx` — shows "Delete N items?" for N ≥ 1, destructive-styled Delete button, Escape cancels. *(Impl note: focus-trap asserted as the jsdom-portable invariant used by `properties-modal.test.tsx` — all focusables inside dialog + close button present — not by simulating Tab.)*
- [x] 6.6 Implement the confirm-delete dialog. *(Impl note: pure presentational wrapper over shadcn `Dialog`; no store dep, no toasts. Radix's `onOpenChange(false)` routes Escape / overlay-click / close-button through the same `onCancel` path.)*
- [x] 6.7 Write failing test for the `remove` action — single-entry and multi-entry cases, partial failure handling (some removed, some failed), proper status-row update, toast announcement including failure count when relevant. *(Impl note: tests cover single happy, multi happy, partial failure, full failure (IPC throw), and empty-paths silent-no-op.)*
- [x] 6.8 Implement the remove action. *(Impl note: store `remove(paths)` keys `pendingOps` by path (not entry id) because the IPC contract's request and `failed[].path` are path-based. Rename keys by entry id — the key asymmetry between rename and remove is intentional deferral for 6.11/6.12 to reconcile if needed. Partial failure pins `lastError` on the first failed path (matching rename's single-entry model); the toast summarises the rest. Successful removes use `toast.success`; full failures use `toast.error`. Toolbar gains a `DeleteButton` (icon-only, `trash-2`, `aria-label="Delete selection"`, disabled when selection empty). Composite wiring captures target paths in a `pendingDeleteRef` and opens `ConfirmDeleteDialog`.)*
- [x] 6.9 Write failing test for the `download` action — dispatches `window.api.files.download`, surfaces the saved path in a toast on success, surfaces the error on failure; stub the main-process handler to return a fixture-level path. *(Impl note: directory download is a silent no-op (no lastError, no toast) — context menu already disables it for directories; the silent fallback matches the missing-entry case.)*
- [x] 6.10 Implement the download action. Context-menu Download and toolbar Download (if we decide to expose it) delegate to it; v1 exposes via context menu only. *(Impl note: `store.download(entryId)` deliberately skips `pendingOps` — a download is not an in-list mutation so there's no pending row state to surface. Success toast is `"Downloaded to ${savedPath}"`; failure uses `toast.error(reason)` and pins `lastError`.)*
- [x] 6.11 Write failing test asserting rendered pending-op entries use `opacity-60` + `animate-sync-pulse` glyph and are listed in the motion-budget whitelist test for this feature. *(Impl note: 13 tests in `pending-op-visuals.test.tsx` covering the helper (`entryPendingOp` / `entryError`), path-keyed remove visibility, `line-through` on remove, error-pin `title` + `aria-label`, Details-pane `data-state` + motion-safe slide classes. Error pin handles the download-failure visual too since download pins `lastError` without touching `pendingOps`.)*
- [x] 6.12 Update `scripts/motion-budget.test.ts` to whitelist the explorer's pending-op pulse surface and the details-pane slide; assert no other motion is introduced by this feature. *(Impl note: no whitelist edits required — the guardrail's regex matches only `animate-*` / `transition-*`; `slide-in-from-right-8` / `slide-out-to-right-8` / `fade-*` don't match, and `data-[state=*]:animate-in/out` is already variant-allowed. Details-pane stays mounted in both states (`hidden` + `aria-hidden` close the a11y-tree gap) so the `data-[state=closed]` exit animation can play. Row-level pending treatment lives in new `pending-op-state.ts` helper + `pending-op-visuals.tsx` components (`PendingOpGlyph`, `ErrorPin`), consumed by all six view modes; the pendingOp key asymmetry (rename-by-id / remove-by-path) is hidden behind `entryPendingOp(state, entry)`. Added lucide `alert-triangle` to the icon registry for the error pin.)*

## Phase 7 — Search

- [x] 7.1 Write failing test for the search UI — toolbar search toggle opens an input, typing + Enter dispatches `window.api.files.search`, results replace the main pane while a "Clear search" affordance is visible.
- [x] 7.2 Implement the search input.
- [ ] 7.3 Write failing test for search result rendering — each result shows the entry plus its parent path as a secondary line; clicking a result navigates to the parent folder with the entry focused.
- [ ] 7.4 Implement search result rendering.
- [ ] 7.5 Write failing test for the S3 handler's client-side scan — searches match against key names, paginated scan respects a ceiling, response's `truncated` is `true` when the ceiling is hit.
- [ ] 7.6 Implement the S3 handler's client-side scan against the mock fixture.
- [ ] 7.7 Write failing test for the Drive / OneDrive handlers' deferred state — returns `{ entries: [], truncated: true, providerSearchDeferred: true }` (carry the flag via `providerMetadata` on the (empty) response envelope) and the UI surfaces the deferred message.
- [ ] 7.8 Implement the deferred handlers and the UI state.
- [ ] 7.9 Write failing test asserting search state is cleared on navigation and on explicit clear, and that the previously-focused entry is restored.
- [ ] 7.10 Implement clearing behaviour.

## Phase 8 — Card integration

- [ ] 8.1 Write failing test extending `features/datasources/card.test.tsx` — the quick-actions menu contains "Explore" as the first item.
- [ ] 8.2 Add the "Explore" item to the card's quick-actions menu in `features/datasources/card.tsx`; wire it to `router.push(\`/datasources/explore?id=${id}\`)`.
- [ ] 8.3 Update any snapshot or menu-order tests across the feature to include the new item without drift.

## Phase 9 — Accessibility, guardrails, and docs

- [ ] 9.1 Run the existing `scripts/literals-ban.test.ts` and `scripts/radii-ceiling.test.ts` against the new `features/file-explorer/` directory; fix any violations in the feature source.
- [ ] 9.2 Add a file-explorer-specific accessibility test: tab through the toolbar, breadcrumb, main pane, details pane — every interactive element gets a visible focus ring; announced labels match the visible labels.
- [ ] 9.3 Add a keyboard-only workflow e2e: navigate the explorer, select multiple files, delete with confirmation, rename a file, toggle the Details pane, switch view modes — all without a pointer device.
- [ ] 9.4 Write `docs/design/file-explorer.md` — layout diagrams per view mode, the operation-lifecycle state diagram, the selection state machine, keyboard bindings table, accessibility notes, the search-scope decision and deferred-provider surface.

## Phase 10 — Final verification

- [ ] 10.1 Run `pnpm -w test` and verify every suite is green; no skipped tests in the explorer feature.
- [ ] 10.2 Run `pnpm -w typecheck` and `pnpm -w lint`; fix any errors.
- [ ] 10.3 Run the Playwright e2e from Phase 9.3 end-to-end; record a screenshot of Details mode populated with mock data for `docs/design/file-explorer.md`.
- [ ] 10.4 Manual dev-mode walkthrough: open each provider's mock datasource, navigate deeply, search, delete a file, rename a file, download a file; verify pending-op states, failure reverts, toast messages. Record any deviations for a review-round follow-up.
- [ ] 10.5 Review all tasks marked complete; confirm none have been skipped. Update the `out of scope` section of `proposal.md` if any deferrals emerged during implementation.
