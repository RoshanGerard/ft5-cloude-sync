## Why

The archived `ui-ux-design` change landed the datasources dashboard — cards per registered cloud datasource, add-flow, status badges, upload action. But the card is terminal: the user can *see* a datasource exists, but cannot *browse into* it. The files that make the datasource meaningful are invisible from the app.

This change adds the File Explorer — the surface reached from the datasource card's quick-actions menu ("Explore") that lets the user walk the file tree of a connected datasource: navigate directories, inspect files, search, rename, delete, download. It is the first product surface where the datasources abstraction is *used*, not just listed.

The core mental model is Windows File Explorer: back / forward / up nav, a breadcrumb path bar, a main pane with switchable view modes, a right-side details pane, right-click context menu, toolbar with the common operations, status bar. That model is familiar across decades and is the shape the user has asked for. We're not inventing — we're adapting a known pattern to our dense-quiet visual direction.

Deferring this pins the app at "can register a datasource, cannot do anything with it." All downstream work (sync policies, exclude rules, conflict handling) depends on the user having a way to *see* files first.

## What Changes

- **New capability `file-explorer`** (see `specs/file-explorer/spec.md`) defining:
  - A new static route `/datasources/explore` (with the datasource id passed as the `id` query parameter, e.g. `/datasources/explore?id=<datasourceId>`) reached from the datasource card's quick-actions menu via a new "Explore" item. See `design.md` Decision 1 for the query-param-vs-dynamic-segment rationale (it's a `next.config.mjs` `output: "export"` constraint).
  - The explorer UI: back/forward/up navigation with a per-explorer history stack; a clickable breadcrumb trail below the window title bar; a main pane with six switchable view modes (List, Details, Small Icons, Tiles, Medium Icons, Large Icons); a toggleable right-side Details pane that mirrors the selected entry's metadata; a toolbar with Delete (selection, confirmation-gated), Sort, Search, View-mode picker, and Details-pane toggle; a status row with item count and selection count.
  - Entry icon mapping: directory → folder icon; known mime families (image / video / audio / document / archive / code / text) → matching lucide file-family icon; unknown → generic file icon. No per-extension iconography in v1.
  - Per-entry right-click context menu: Open, Download, Rename (files only), Delete, Copy path, Properties. Properties opens a separate modal (distinct from the Details pane) showing full metadata.
  - Operations in scope for v1: **browse**, **rename (files only)**, **delete (single and multi-selection)**, **download**. Folder rename is explicitly deferred.
  - Async operation model: every file-system mutation is queued; the UI shows "in progress" / "failed" state per entry; a future background service will own the queue/retry. This change lands the UI-visible state machine and the IPC contract; the naive "await the handler, surface errors" implementation is acceptable in v1 and replaced without UI churn when the service lands.
  - Search is scoped to the full datasource from its root. S3 uses a client-side paginated scan (honest about its slowness via a surfaced indicator). Drive and OneDrive use their native search APIs in a later change; v1 may ship a "search not available yet" state for those two providers or gate search behind a capability flag — decided in `design.md`.
  - Multi-select with standard conventions: click / shift-click / ctrl-click; Delete / F2 / Enter keyboard actions; arrow-key navigation.
- **Modified capability `datasources-ui`** (see `specs/datasources-ui/spec.md` delta) to extend the quick-actions menu with the "Explore" item and its contract with `window.api.navigation.openExplorer({ datasourceId })` — or, simpler, a renderer-side router push. The card itself does not learn about the explorer beyond exposing the new menu item.
- **New IPC surface `window.api.files.*`** in `packages/ipc-contracts/src/files.ts` defining: `list(req)`, `stat(req)`, `search(req)`, `rename(req)`, `remove(req)`, `download(req)`. Each with typed request/response pairs, a main-process handler under `apps/desktop/src/main/ipc/files/`, a preload exposure, and the standing four-layer guardrail test. Handlers in v1 operate against an **in-memory mock file system** seeded with plausible fixtures per provider so the UI can be exercised end-to-end without real cloud credentials. Real provider-backed handlers land in a follow-up change with OAuth.
- **New renderer surfaces**:
  - `features/file-explorer/page.tsx` — route entry point.
  - `features/file-explorer/explorer.tsx` — the composite orchestrating toolbar / breadcrumb / pane / details.
  - `features/file-explorer/view-modes/{list,details,small-icons,tiles,medium-icons,large-icons}.tsx` — one per mode, all receiving the same `Entry[]` and selection callbacks.
  - `features/file-explorer/details-pane.tsx`, `properties-modal.tsx`, `confirm-delete-dialog.tsx`, `breadcrumb.tsx`, `toolbar.tsx`.
  - `features/file-explorer/store.ts` — `useSyncExternalStore`-based per-explorer state: current path, history stack (back/forward), selection, view mode, sort order, search query, details-pane open flag, pending-operation map keyed by entry id.
  - `features/file-explorer/icons.ts` — mime family → lucide icon mapping, consumed through the existing `Icon` adapter.
- **Documentation** — `docs/design/file-explorer.md` captures layout diagrams, the view-mode cell specs, the selection state machine, the operation-lifecycle state diagram, and keyboard bindings. Behavioural rules stay in the spec; visual and pattern details live in the design doc.

## Capabilities

### New Capabilities

- `file-explorer`: the file-browsing surface reached from a datasource card's "Explore" quick-action. Covers navigation (back/forward/up, breadcrumb, click-to-open directory), the six view modes, the Details pane, the Properties modal, right-click context menu, toolbar operations (Delete, Sort, Search, View, Details-toggle), and the async-operation lifecycle for rename and delete. Backed by the `window.api.files.*` IPC surface, mocked in this change.

### Modified Capabilities

- `datasources-ui`: extends the card's quick-actions menu with a new "Explore" item positioned above the existing items. Selecting it navigates the renderer to the file-explorer route for that datasource. No other card behaviour changes.

## Impact

- **Code**: `apps/desktop/src/renderer/src/features/file-explorer/` new (toolbar, breadcrumb, pane, six view-mode cells, details-pane, properties-modal, confirm-delete, store, icons). Minor edits to `features/datasources/card.tsx` and its menu to add the Explore item. New `apps/desktop/src/main/ipc/files/` directory with mocked handlers. New `packages/ipc-contracts/src/files.ts` with the full contract surface plus a `test-d.ts` assertion.
- **Routing**: the renderer adds a static route at `/datasources/explore` with the datasource id passed as the `id` query parameter. Kept as a query param rather than a `[datasourceId]` dynamic file segment because `output: "export"` would require `generateStaticParams` enumerating every id at build time, which breaks for runtime-added datasources (see `design.md` Decision 1). Clicking Back in the window returns to the dashboard; closing the app returns it to its default home on next launch.
- **Docs**: `docs/design/file-explorer.md` new. README unchanged.
- **Dependencies (production)**: no new runtime packages. The view modes use Tailwind grid/flex, the breadcrumb and icons use existing primitives, keyboard handling uses Radix primitives already in the tree. If we discover we need a virtualization library for large directories, it is flagged in `design.md` as an open decision with the options (react-virtuoso vs @tanstack/react-virtual vs defer) — the v1 implementation will use a naive render with a loaded-pages ceiling and escalate only if a real fixture exceeds it.
- **Dependencies (dev)**: none new.
- **Tests**: Vitest (jsdom) suites for each view mode's rendering, selection semantics, breadcrumb parsing, history stack, operation-lifecycle state transitions, icon-mapping for a full mime matrix, and the four-layer IPC wiring. One Playwright e2e walking a datasource's mock tree, triggering delete with confirmation, verifying the status row updates.
- **Performance**: the v1 mock fixture per datasource is bounded to a few hundred entries; virtualization is not required at this scale. A guardrail test asserts the directory-size ceiling used by the mocks so future contributors don't quietly push it past what the naive render can handle.
- **Security**: no change to Electron hardening. All file-system work stays in the main process; the renderer only sees normalized `FileEntry` shapes.
- **Out of scope** (deferred, explicit):
  - Real provider-backed handlers (Drive / OneDrive / S3 APIs). This change ships mocks; real handlers are a follow-up, per the same pattern used for datasource registration.
  - Folder rename (S3 makes this non-atomic and gnarly; deferred until we have a concrete requirement).
  - Move / copy / cut-paste between directories.
  - Upload-from-explorer (the existing "Upload from local" on the card stays where it is; the explorer is read + modify, not create-in-place, for v1).
  - Thumbnails for media files (the medium/large icon views show the generic mime icon, not a provider-rendered thumbnail).
  - The background file-operations service itself. v1 is "await the handler in the store"; the service lands later with no UI changes.
  - Drive / OneDrive native search implementations; v1 either gates search behind the S3-style client-side scan or surfaces a "limited in v1" affordance — captured as a decision in `design.md`.
  - File previews (text, PDF, image viewer). Double-click / Enter on a file in v1 shows the Properties modal, not a preview.
  - Virtualization of large directories. v1 ships the naive render with a documented ceiling.
