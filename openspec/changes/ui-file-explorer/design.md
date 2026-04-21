## Context

The `ui-ux-design` change landed the datasources dashboard: cards per datasource, add-flow, theme system, Details-only metadata view at the *card* level. There is no way to walk into a datasource and see the files inside it. This change adds that — a Windows-File-Explorer-shaped surface reached from the card's quick-actions menu.

The mental model is classic: back / forward / up, breadcrumb, main pane with switchable view modes, right-side Details pane, right-click menu, toolbar with Delete / Sort / Search / View / Details-toggle, status row. The shape is familiar; the risk is in the details — async operation semantics, provider asymmetry, per-mode rendering, selection state, and not over-building.

The three providers do not present files symmetrically: Drive and OneDrive have real folder objects; S3 has a flat keyspace where "folders" are prefix conventions; "rename" on S3 is copy-then-delete, non-atomic. The UI has to pretend they're all "folders with files" while the main-process IPC contract is the narrow waist that normalizes.

This change is paired with a new `window.api.files.*` IPC surface whose v1 handlers return from an in-memory mock fixture. The shipping shape — contract, preload, renderer call sites, four-layer guardrail — is real. Only the handler bodies are mocked. Real provider-backed handlers land in a follow-up.

> **Cross-change note (add-fs-datasource-engine).** The real provider-backed handlers referenced above are delivered by change `add-fs-datasource-engine`. No contract conflict: the engine is CALLED BY these `files.*` handlers, not a replacement for their `ipc-contracts` types. When both changes are on trunk, the handler bodies read `getEngine().factory.create(providerId, creds, ctx)` and delegate `list` / `stat` / `search` / `rename` / `remove` / `download` to the resulting `DatasourceClient<T>` instead of returning fixtures.

## Goals / Non-Goals

**Goals:**
- A user opens a card menu → Explore, sees their (mocked) files, navigates deeply, switches view modes, deletes a file, renames a file, downloads a file, searches — all with the classic Explorer idioms intact.
- The contract + preload + renderer call sites are the shipping shape. Swapping mocked handlers for real provider handlers later touches handler files only.
- Async operation lifecycle is a first-class part of the UI: entries show "pending" / "failed" state, the user can see what's in flight, failures are surfaced not swallowed.
- Six view modes ship, each implemented as a cell renderer consuming a shared `Entry[]` plus shared selection / keyboard state, so the modes are interchangeable without any behavioural divergence.
- The Details pane (ambient, selection-driven) and Properties modal (explicit, right-click-driven) coexist without duplicating source of truth — both read from the same `Entry` + provider-metadata shape.
- Accessibility is not optional: keyboard-only navigation works across all six view modes; focus is visible; the breadcrumb is a proper landmark; the status row updates an `aria-live` region on selection changes.

**Non-Goals:**
- Real provider-backed file listing, rename, delete, download. v1 is mocked end to end.
- The background file-operations service. v1 awaits the handler in the store with per-entry pending/failed tracking; the service lands later with the same contract.
- Folder rename. S3 makes this non-atomic; we don't have a concrete need; we defer until we do.
- Move / copy / cut-paste between directories.
- Upload from inside the explorer. The existing card-level "Upload from local" stays. Explorer is browse + modify.
- Thumbnails for media files. Icon views show the mime icon; a thumbnail pipeline is downstream.
- File previews (PDF viewer, image viewer, text preview). Enter on a file opens Properties in v1.
- Virtualization for enormous directories. Ceiling documented; naive render in v1; escalate only on evidence.
- Drive / OneDrive native search. v1 uses the S3-style client-side scan for all three providers, or gates search behind a capability flag. See Decision 6.
- Per-extension icons (`.ts` / `.docx` / `.pdf` all getting bespoke glyphs). We use lucide mime-family icons only — the design-language tax for per-extension iconography isn't worth it.

## Decisions

### Decision 1: Route = `/datasources/[datasourceId]/explore`, one explorer per datasource, independent history

**Chosen:** The explorer lives at a Next.js file route under `apps/desktop/src/renderer/src/app/datasources/[datasourceId]/explore/page.tsx`. Each datasource gets its own explorer view with its own history stack (back / forward). Navigating from the card to the explorer is a standard router push. Back navigation from the browser / window level returns the user to the dashboard.

**Rationale:**
- Static export via Next.js is the existing renderer pattern; a file route matches how the rest of the app is structured.
- Per-datasource history means switching datasources doesn't poison back/forward state. The alternative (one shared explorer window) forces weird cross-provider breadcrumbs and a "what counts as back" conversation.
- A real route means the URL reflects the user's location — useful for diagnostics and for future deep-linking from `sonner` toasts ("file deleted — open location").

**Alternatives considered:**
- *Slide-over / side panel over the dashboard.* Rejected: nice for peek but the real surface area (six view modes, breadcrumb, details pane, status row) needs space. Slide-over forces crowding or scrolling; a full page gives it room.
- *Inline card expansion.* Rejected: puts the explorer in the dashboard grid cell, which fights every layout mode and gives the browser panel a screen-height fight with the rest of the cards.
- *One shared explorer with a datasource switcher in the chrome.* Rejected: creates the "what does back do when I switched sources" problem. Simpler to have each source be its own surface.

### Decision 2: `Entry` type + `window.api.files.*` IPC surface is the narrow waist

**Chosen:** Define:

```ts
// packages/ipc-contracts/src/files.ts
export type EntryKind = "directory" | "file";
export type MimeFamily =
  | "image" | "video" | "audio"
  | "document" | "archive" | "code" | "text"
  | "unknown";

export type FileEntry = {
  id: string;                 // stable within this datasource
  kind: EntryKind;
  name: string;
  path: string;               // full path within the datasource
  parentPath: string;         // for breadcrumb rendering
  size: number | null;        // null for directories
  mimeFamily: MimeFamily;     // for icon mapping; "unknown" if not derivable
  mimeType: string | null;    // raw type when known, e.g. "application/pdf"
  modifiedAt: string;         // ISO 8601
  createdAt: string | null;
  // provider-specific extras land here, structured-clone-safe
  providerMetadata: Record<string, string | number | boolean | null>;
};

export type FilesListRequest = { datasourceId: string; path: string };
export type FilesListResponse = { entries: FileEntry[]; nextCursor: string | null };

export type FilesStatRequest = { datasourceId: string; path: string };
export type FilesStatResponse = { entry: FileEntry };

export type FilesSearchRequest = { datasourceId: string; query: string; path: string };
export type FilesSearchResponse = { entries: FileEntry[]; truncated: boolean };

export type FilesRenameRequest = { datasourceId: string; path: string; newName: string };
export type FilesRenameResponse = { entry: FileEntry };

export type FilesRemoveRequest = { datasourceId: string; paths: string[] };
export type FilesRemoveResponse = { removed: string[]; failed: { path: string; reason: string }[] };

export type FilesDownloadRequest = { datasourceId: string; path: string; toPath?: string };
export type FilesDownloadResponse = { savedPath: string };
```

All six methods are wired via the standing four-layer pattern (contract → handler → preload → renderer call site). The v1 handlers are in-memory; the `mimeFamily` is derived in the handler so the renderer never parses `.ext` strings directly.

**Rationale:**
- Normalizing mime families in the handler is the single place to write the mapping. If we added a new provider tomorrow with bespoke type metadata, the handler translates; the UI is unchanged.
- `path` (not IDs) in the API is deliberate. S3 doesn't have opaque IDs for folders. Drive's IDs change under rename. A path string is the lowest common denominator, and the handler can map path ↔ provider-id internally when needed.
- Pagination via `nextCursor` is there from day one because Drive / OneDrive both need it and S3 does too; designing it in now avoids a contract break later. v1 handlers return a single page (`nextCursor: null`) but the renderer code handles multi-page already.
- `providerMetadata` is a structured-clone-safe bag for the extra fields the Properties modal surfaces (Drive-specific owner chain, OneDrive access levels, S3 storage class). The contract is open for growth without a version bump.

**Alternatives considered:**
- *Provider-specific contracts (one IPC surface per provider).* Rejected: multiplies handlers, contract files, and renderer call sites by provider count. The whole point of the datasources abstraction is one call shape.
- *ID-keyed API (no paths).* Rejected: S3 has no stable folder ids; synthesizing them is extra work for no gain. Paths are the natural shape.
- *Streaming results via IPC events.* Rejected for v1: current directory sizes don't require it; we can layer it in later behind the same request/response shape with a server-issued stream id.

### Decision 3: View modes — six concrete modes, shared state, different cell renderers

**Chosen:** Ship all six — List, Details, Small Icons, Tiles, Medium Icons, Large Icons — as the user requested. Each is a component that takes `Entry[]`, current selection, sort, and keyboard callbacks; they share nothing except their input props.

Default mode is **Details**. Selection, sort, keyboard nav, and search are identical across modes. The toolbar's View picker swaps the renderer component; no other state changes.

Concrete specs:

| Mode          | Cell size         | Columns shown                              | Layout           |
|---------------|-------------------|--------------------------------------------|------------------|
| List          | 1 row, compact    | icon + name                                | vertical, flow   |
| Details       | 1 row, data       | icon + name + type + size + modified       | table-like grid  |
| Small Icons   | 16 px icon + name | icon + name                                | wrapping flex    |
| Tiles         | 64 px icon        | icon + name + 2 lines metadata (type/size) | wrapping grid    |
| Medium Icons  | 64 px icon        | icon above name                            | wrapping grid    |
| Large Icons   | 96 px icon        | icon above name                            | wrapping grid    |

**Rationale:**
- User requested parity with Windows Explorer. All six is the honest answer.
- Separate components per mode means no mode is a special case of another with a thousand conditionals. Each is self-contained, testable, and swappable.
- Shared selection / keyboard state in the store (Decision 5) means switching modes mid-session preserves what the user has selected and where the focus is.

**Alternatives considered:**
- *Two modes (Details + Medium Icons) for v1.* Rejected per user decision. Worth noting that the cost of shipping all six is real — each has its own tests, its own tab-order semantics, its own responsive behaviour — but it's linear in mode count, not quadratic.
- *One parametrized cell component with `density="small" | "medium" | "large"`.* Rejected: List and Details are fundamentally different layouts (row vs table); Tiles have metadata beside the icon while Medium/Large have it below. Parametrizing would create enough branches that separate files are cleaner.

### Decision 4: Details pane AND Properties modal — two surfaces, one shape

**Chosen:** The Details pane is toggleable, ambient, selection-driven. When visible, it reflects the current single-selected entry (or shows "N items selected" summary on multi-select). The Properties modal is explicit, right-click-invoked, shows the full metadata dossier for one entry.

Both read the same `FileEntry` + `providerMetadata` shape. Both use the same field-renderer primitives. The modal is allowed to show more (extended provider metadata, raw mime type, full path, per-field copy-to-clipboard affordance); the pane shows a curated, compact subset.

A single `features/file-explorer/metadata/` subdirectory owns both surfaces' field catalog; the pane and modal pick which fields to render from a shared list.

**Rationale:**
- Users asked for both. Pane gives you the info at a glance while you keep browsing; modal gives you the full record when you want it. They are different ergonomics.
- A shared field catalog prevents the classic bug where the modal shows a field the pane forgot about.

**Alternatives considered:**
- *Pane only.* Rejected: loses the deep "give me everything" surface for power users.
- *Modal only (no pane).* Rejected: forces every curiosity click to open a modal, which is heavy for casual browsing.

### Decision 5: Per-explorer store via `useSyncExternalStore`, no global state library

**Chosen:** Each explorer instance owns a store built with `useSyncExternalStore` (matching the theme / motion stores already in the renderer). The store holds:

```ts
type ExplorerState = {
  currentPath: string;
  history: { stack: string[]; index: number }; // for back/forward
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  selection: Set<string>;       // entry ids
  sortBy: "name" | "type" | "size" | "modified";
  sortDir: "asc" | "desc";
  viewMode: "list" | "details" | "small" | "tiles" | "medium" | "large";
  search: { query: string; active: boolean; results: FileEntry[] | null };
  detailsPaneOpen: boolean;
  pendingOps: Record<string, { kind: "rename" | "remove"; startedAt: number }>;
  lastError: { entryId: string; reason: string } | null;
};
```

Actions: `navigate(path)`, `back()`, `forward()`, `up()`, `select(id, mode)`, `setViewMode(m)`, `sort(by)`, `startSearch()` / `setSearchQuery()` / `clearSearch()`, `toggleDetailsPane()`, `rename(id, newName)`, `remove(ids)`, `download(id)`.

Persistent cross-session preferences (view mode, details-pane open state, sort order) live in `localStorage` under a per-datasource key, loaded on mount.

**Rationale:**
- Matches the pattern already used for theme and motion stores — contributors recognize it, no new library to learn.
- `useSyncExternalStore` avoids the render-loop foot-guns of React Context for frequently-updated state like selection.
- Per-explorer isolation means two explorers (if we ever allow multiple) don't stomp each other. v1 ships one, but the store is ready.

**Alternatives considered:**
- *Zustand / Jotai / Redux.* Rejected: no justification per `project.md` dependency rule. React 19 + `useSyncExternalStore` is sufficient.
- *React Context.* Rejected: selection changes on every arrow-key press would re-render every subscribed component in the tree; external store + narrow selectors avoids that.

### Decision 6: Search scope — full datasource from root; S3 client-side scan; Drive/OneDrive deferred

**Chosen:** Search is scoped to the entire datasource starting from its root (not just the current folder). In v1:
- For **S3** datasources, the handler does a client-side paginated `list-objects` scan with the query matched client-side against the key names. The response's `truncated: boolean` is `true` if the scan hit its ceiling; the UI surfaces this with a "results may be incomplete — scanned N entries" notice.
- For **Google Drive** and **OneDrive**, the v1 handler returns `{ entries: [], truncated: true }` with a metadata flag indicating the provider's native search is not yet wired. The UI surfaces this with an informational state: "Search for Drive and OneDrive is in progress — see the deferred-work docs." A follow-up change replaces the stub with the provider's native search API.

This ships coherent search for one provider without blocking on the other two. The contract (`FilesSearchRequest` / `FilesSearchResponse`) is final; only handler bodies change.

**Rationale:**
- User accepted the S3 client-side strategy and asked us to plan the Drive / OneDrive strategy later. Shipping the stub is honest — the feature is visibly present, its limits are visibly documented, the contract doesn't change when the real implementation lands.
- The alternative ("defer search entirely") leaves the toolbar with a Search widget that doesn't exist, which is worse ergonomics than "search that tells you it's partial."

**Alternatives considered:**
- *Filter the currently-loaded folder.* Rejected per user decision — scope is the full datasource.
- *Defer search until native APIs are ready for all three providers.* Rejected: blocks the feature on work that needs its own credential provisioning.

### Decision 7: Async operation model — optimistic pending state, failure reverts, future service

**Chosen:** For rename and delete:

1. User invokes the operation (via menu / toolbar / key).
2. Store records a `pendingOps[entryId] = { kind, startedAt }`.
3. UI updates immediately: the entry renders with a dim opacity + small inline spinner glyph (`animate-sync-pulse` from the motion budget, already whitelisted) and its name is replaced by the new value (for rename) or the row is struck through + dimmed (for delete).
4. The IPC call is awaited.
5. On success: clear `pendingOps[entryId]`; for rename, update the entry in place with the response's new `FileEntry`; for delete, remove it from `entries`. A `sonner` toast announces "Renamed to X" / "Deleted N items" with an Undo affordance *only if the handler capabilities include soft-delete* (v1 mock: yes; real handlers per-provider).
6. On failure: clear `pendingOps[entryId]`; revert the UI state; set `lastError = { entryId, reason }`; surface the reason on the entry via a small error icon + tooltip and a `sonner` toast with the same message.

The contract explicitly permits partial failure on multi-select delete (`FilesRemoveResponse.failed` list). The store processes success and failure per-entry.

The v1 implementation is naive: the store `await`s the handler in the action. The background file-operations service lands later and will consume the same `pendingOps` shape — the UI code does not change.

**Rationale:**
- Optimistic UI keeps the app feeling fast even when the real handlers (later) have network latency. The "dim + spinner" treatment is honest about the in-flight state.
- Partial-failure on multi-delete is load-bearing: Drive and OneDrive can return per-item errors; making it part of the contract from day one avoids a later breaking change.
- The future service owns retry, backoff, and queue inspection; none of that needs to show in the UI today. Shipping `pendingOps` and `lastError` in the store gives the service a shape to write to later.

**Alternatives considered:**
- *Blocking "working…" modal during every operation.* Rejected: awful ergonomics for a bulk delete of 50 items.
- *Pessimistic (wait for handler, then update).* Rejected: on real providers, users would feel every round-trip.
- *Ship the background service now.* Rejected: non-trivial work that isn't on the critical path for a visible, usable explorer.

### Decision 8: Icon mapping — lucide mime-family icons, no per-extension set

**Chosen:** Use lucide-react file-family icons via the existing `Icon` adapter:

| MimeFamily | Lucide icon |
|------------|-------------|
| directory (EntryKind) | `folder` (closed) / `folder-open` when expanded |
| `image`    | `file-image` |
| `video`    | `file-video` |
| `audio`    | `file-audio` |
| `document` | `file-text` (or `file-type` variants when we add more specificity later) |
| `archive`  | `file-archive` |
| `code`     | `file-code` |
| `text`     | `file-text` |
| `unknown`  | `file` |

Mime-family derivation happens in the handler (per Decision 2). The renderer calls `iconForEntry(entry)` which is a pure function over `kind` + `mimeFamily`. No string-parsing of extensions in the renderer.

**Rationale:**
- Matches our Linear/Vercel dense-quiet aesthetic — lucide's outline weight is consistent with the rest of the app.
- Per-extension icons (a bespoke glyph for `.docx` vs `.pdf` vs `.ts`) are a ton of design debt and blow up the bundle. The few extra pixels of recognizability are not worth the maintenance.
- Centralizing the mapping in one function makes adding a new mime family a 3-line change.

**Alternatives considered:**
- *[vscode-icons](https://github.com/vscode-icons/vscode-icons) or similar rich per-extension sets.* Rejected per user decision.
- *Inline custom SVG set.* Rejected: design investment without a clear user-perceived gain at this layer.

### Decision 9: Visual direction — extends `ui-ux-design`'s Linear/Vercel dense-quiet system

The explorer is visually a continuation of the dashboard: Geist Sans / Geist Mono, `tabular-nums` on sizes and dates, `p-4` card padding, `rounded-md` ceiling, motion only on the whitelisted surfaces. Specifics:

- **Toolbar height:** matches the dashboard toolbar height for visual continuity.
- **Breadcrumb:** rendered as a horizontal flow below the title bar, each segment is a keyboard-focusable button, separators are `›` chevrons at `text-muted-foreground`.
- **Details pane:** right side, 320 px fixed width, CSS variable `--surface` background (same as card), a thin `border-l border-border` separator from the main pane. Toggleable via the toolbar button; collapse animates (slide) and is on the whitelist.
- **View-mode switcher:** a `DropdownMenu` with six radio-style items, the current mode check-marked. A lucide glyph per mode preserves the toolbar's dense-quiet feel.
- **Selected entries:** `bg-accent` background, slightly lighter border, no glow or drop-shadow. Focus ring on the row is visible-`:focus-visible`, 2 px outline, `ring-ring` token.
- **Pending-op entry styling:** `opacity-60`, cursor `wait`, an inline `animate-sync-pulse` dot glyph. Listed in the motion whitelist.
- **Empty directory state:** a small centered message "This folder is empty", no illustration, no CTA.
- **Search-active state:** the main pane shows matching results from across the datasource, each with a secondary line showing the parent path; clicking opens the containing folder with the entry focused.
- **Status row:** fixed bottom, `text-xs text-muted-foreground`, format `N items · M selected` / `Showing results for "query" · truncated` during search.

Accessibility:
- The main pane is a grid with `role="grid"` (or List where row-flow) and each entry is `role="gridcell"` / `role="option"` depending on mode.
- Selection changes announce on an `aria-live="polite"` status element.
- The breadcrumb is a `<nav aria-label="Folder path">` with an ordered list.
- Every toolbar button has an accessible name even when rendered icon-only.

### Decision 10: Directory-size ceiling in v1, virtualization deferred but not ignored

**Chosen:** The v1 mock fixtures cap at ~300 entries per directory. A Vitest guardrail test asserts the cap. The naive render (no virtualization) is acceptable at this scale across all six view modes; measured frame cost on Medium/Large Icons mode at 300 entries is well under the 16 ms frame budget.

A separate test asserts that the main pane renders within 50 ms for a 300-entry Details-mode render in a jsdom environment.

If a real provider-backed handler later returns >300 entries in a single page, the contract's `nextCursor` lets the handler paginate. If a user's real folder exceeds cumulative 1000 entries, we revisit virtualization as a dedicated follow-up (tanstack-virtual is the default candidate per the Next.js compatibility table). This is flagged, not solved, here.

**Rationale:**
- No library cost without evidence of need.
- The ceiling is a load-bearing test, not a vibe — so a future contributor can't quietly 10x the fixture without the test lighting up.

**Alternatives considered:**
- *Ship tanstack-virtual now.* Rejected: non-zero complexity cost, no user-observable benefit at our current fixture scale, and the virtualization sub-choice (windowing vs dynamic measurements) is better made when we have real size evidence.

## Risks / Trade-offs

- **Six view modes is real surface area.** Each has its own tab-order, its own keyboard behaviour, its own responsive breakpoint story. Accepted per user decision; the cost is linear in modes and we've scoped the view-mode components as thin cell renderers over shared state to keep the blast radius contained.
- **Search deferred for Drive / OneDrive.** The stub state in v1 is a UX compromise — a user expecting search to work across all three providers gets told "not yet" on two of them. Mitigated by the honest inline status and by keeping the contract final so the follow-up is swap-only.
- **Async optimistic updates can mask real failures.** If the handler takes 30 seconds and the user keeps clicking, they can queue pending ops. v1's mitigations: disable the entry's actions while `pendingOps[id]` is set; show the pending-op tooltip explaining "waiting for datasource". The background service later takes over the queue management.
- **Per-extension icons may be missed.** Users from Windows Explorer might expect `.docx` to look different from `.pdf`. Accepted: if the ask becomes frequent we can add a second-layer override later without a contract break.
- **Naive render at 300 entries is fine for mocks — real providers may not be.** The guardrail test is the canary; the virtualization follow-up is pre-scoped.
- **The store's `pendingOps` is a promise we have to keep.** If the background service lands with a different shape, we pay a migration. Mitigation: the shape is minimal (kind + startedAt), designed to be a subset of whatever the service emits.

## Migration Plan

Nothing to migrate in the strict sense — this is net-new surface. Two touchpoints:
1. The datasource card's quick-actions menu gets a new "Explore" item at the top of the list. Existing tests asserting the menu item order are updated once, everywhere. The MODIFIED requirement in `specs/datasources-ui/spec.md` captures this.
2. The in-memory mock datasource registry used by `ui-ux-design` is extended to also seed a mock file tree per datasource. The renderer code for the datasources dashboard is untouched; only the main-process mock fixture grows.

## Open Questions

- **Keyboard shortcut for "Focus breadcrumb address bar for direct path entry"** (like Windows' Alt+D): include in v1 or defer? Recommendation: defer — classic Explorer muscle memory but requires a "type a path" input UI we don't otherwise need. Revisit if asked.
- **Does Enter on a file open Properties, or something else?** Current plan: Enter opens Properties in v1 (since preview is out of scope); Double-click does the same. Alternative: Enter triggers Download. Leaning Properties for discoverability.
- **Undo for delete** — v1 mocks support soft-delete easily; should the real handlers surface an undo for providers that support trash (Drive does; OneDrive does; S3 doesn't)? The contract permits `Undo` as a sonner-toast affordance; providers without trash simply don't offer it. Recommendation: ship the affordance in v1 gated by `provider.capabilities.trash`; add the capability flag to `ProviderDescriptor`.

## Visual direction

The explorer visually extends `ui-ux-design`'s Linear/Vercel dense-quiet direction (Decision 9 above). No new tokens, no new motion keyframes. Typography: Geist Sans UI, Geist Mono for path segments and sizes, `tabular-nums` on sizes / timestamps / item counts. Motion budget extension: the pending-op pulse reuses `animate-sync-pulse` already whitelisted; the details-pane slide-in/out is a new entry on the whitelist scoped to that one surface. Glass surfaces stay on overlays only; the breadcrumb and toolbar are opaque.

Colors: selected rows use `bg-accent`, pending rows use `opacity-60`. No new palette. The Serene Blue theme from `ui-ux-design` is respected automatically (all styling is token-driven).
