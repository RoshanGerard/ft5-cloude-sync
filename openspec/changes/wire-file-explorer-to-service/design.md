## Context

The file-explorer feature (`apps/desktop/src/renderer/src/features/file-explorer/`) was built in parallel with the datasource engine: the UI shipped first against a mock backend (`apps/desktop/src/main/ipc/files/mock-fs.ts`), and the engine was later consolidated into the `fs-sync-service` process under its RPC surface (`packages/ipc-contracts/src/sync-service/commands.ts`). Today the UI can display files, browse folders, search, rename, and delete — but every operation hits the mock. The sync-service already owns the live engine client and is already reached from the main process via `SyncClient` (`apps/desktop/src/main/sync/client.ts`). This change extends the existing RPC surface with `files:*` commands and rewires the main-process IPC handlers, so the explorer becomes a first-class consumer of the engine without introducing a second engine instance on the main side.

Five visual states — loading, disconnected, auth-revoked, syncing, connected-but-empty — currently collapse into a plaintext `Loading…` / `Failed to load: <msg>` pair. The UX rules in `CLAUDE.md` require an approved visual direction before implementation, captured in this document under "Visual direction".

## Goals / Non-Goals

**Goals:**
- Replace mock backing for `files.list`, `files.stat`, `files.search`, `files.remove` with live engine calls routed through new `files:*` commands on the `fs-sync-service` RPC.
- Surface the five persistent / transient explorer states with pattern A full-replace visuals (disconnected, auth-revoked, syncing, connected-but-empty) plus skeleton rows for loading, each distinguishable by a deterministic error tag (not a string-matched message).
- Preserve every existing explorer test — view modes, store, breadcrumb, toolbar, status row, search, context-menu, properties modal — and the stale-response guard in `useExplorerData`.
- Disable Rename and Download UI surfaces when the datasource is engine-backed so users do not silently mutate / retrieve mock state.
- Keep `mock-fs` in the tree for `rename` and `download` until the sibling change `add-engine-rename-download` wires them through the engine.

**Non-Goals:**
- Wiring `files.rename` or `files.download` to the engine. Explicitly deferred to `add-engine-rename-download`.
- Paginating `listDirectory`. Engine currently returns the first provider page only (Drive: 1000, OneDrive: default, S3: list limit). Larger folders silently truncate; flagged as a known limitation.
- Adding a local cache / last-known list. Pattern A full-replace means disconnected = no files shown, not "show stale entries".
- OAuth UI, add-datasource flow, or any change to the sync-supervisor / engine internals.
- Packaged-build runtime for the sync service (tracked separately as `wire-packaged-build-fs-sync-service`).

## Decisions

### Decision 1: Route through sync-service RPC, not a second engine instance in main

**Choice:** Add `files:list`, `files:stat`, `files:search`, `files:remove` to `CommandMap` in `packages/ipc-contracts/src/sync-service/commands.ts`. Implement handlers in `services/fs-sync/src/commands/` that resolve the engine client by `datasourceId` from the service's per-datasource registry and delegate to `listDirectory` / `getMetadata` / `search` / `deleteFile`|`deleteDirectory`. Desktop main-process `apps/desktop/src/main/ipc/files/*.ts` delegates to `syncClient.request("files:list", …)` etc.

**Alternatives considered:**
- **Instantiate engine directly in main.** Rejected: duplicates OAuth token stores, duplicates the `node-fetch` HTTP client, breaks single-source-of-truth for rate-limit/auth state, makes the sync service's engine lifecycle decisions (reconnect, token refresh) invisible to the explorer.
- **Put the explorer in the renderer and use a direct fetch to providers.** Rejected: bypasses the engine's normalization, error tagging, credential storage, and transaction bookkeeping — the entire reason the engine exists.

**Why:** The sync-service already owns the engine lifecycle. Extending its RPC surface is cheaper than duplicating the engine and keeps the explorer honest about what the service knows.

### Decision 2: Deterministic discriminated-error envelope carried to the renderer

**Choice:** Each `files:*` command returns `{ ok: true; value: … } | { ok: false; error: { tag: "auth-revoked" | "disconnected" | "rate-limited" | "other"; message: string; retryable: boolean; retryAfterMs?: number } }`. The main-process IPC handler preserves the envelope as-is in the `FilesListResponse` / etc. The renderer's `useExplorerData` maps the tag to one of the five state components without string-matching.

**Alternatives considered:**
- **Throw on error, rely on caller to read the message.** Rejected: the current explorer shows `Failed to load: {error.message}` which is what we're replacing. A tagged union is the whole point.
- **A single `type: "error"` with the engine's internal tag vocabulary leaked as-is.** Rejected: the engine has finer-grained tags (`rate-limited`, `payload-too-large`, `server-error`, etc.) than the UI needs; collapsing to `auth-revoked` / `disconnected` / `rate-limited` / `other` simplifies UI branching and lets the engine vocabulary evolve.

**Why:** Tags are the source of truth for UI state selection; `message` remains as freeform diagnostic for the debug panel or toast.

### Decision 3: Engine response wins over datasources-store status

**Choice:** `useExplorerData` consults the datasources-store status for *predictive* initial render only (`syncing` → show syncing skeleton; `error` with known errorReason → show disconnected pre-fetch). Once `files:list` returns, the envelope's tag is authoritative. If store says `connected` but the fetch returns `auth-revoked`, the explorer switches to the auth-revoked state without waiting for the store to catch up.

**Alternatives considered:**
- **Store wins.** Rejected: store state lags behind engine reality (engine knows immediately when a token is revoked; the store learns via a `status-changed` event that propagates through event-bridge). Using store as authority produces user-visible lag.
- **Synchronize store before rendering.** Rejected: blocks the UI on a handshake that can be skipped if we just trust the live response.

**Why:** The live response is ground truth; the store is an optimistic hint.

### Decision 4: Best-effort bulk remove with per-path aggregation

**Choice:** `files:remove` accepts `{ datasourceId, paths: string[] }` and returns `{ ok: true, results: Array<{ path: string; ok: true } | { path: string; ok: false; error: { tag: …, message: string } }> }` — the outer `ok` is `true` as long as the command itself executed; per-path status lives in `results`. The service processes each path in parallel via `Promise.allSettled` on `deleteFile` or `deleteDirectory` (chosen by entry kind resolved via `getMetadata`). The renderer surfaces an aggregate toast: "3 of 5 deleted; 2 failed — see details".

**Alternatives considered:**
- **Transactional all-or-nothing.** Rejected: engine has no rollback primitive; deletes are destructive and cannot be undone by the service.
- **Stop on first error.** Rejected: leaves the remaining paths in an indeterminate state from the user's perspective ("did the rest delete or not?").
- **Outer `ok: false` when any path fails.** Rejected: conflates command-execution failure with per-path failure, making renderer branching awkward.

**Why:** Best-effort matches UI expectation (the delete dialog already implies "try all"). Per-path results let the toast name the failures.

### Decision 5: Disable Rename and Download affordances for engine-backed datasources

**Choice:** Toolbar's Rename / Download buttons and the per-entry context menu's Rename / Download items check a `engineBacked` boolean derived from the datasource's `providerKind` (everything except a synthetic `"mock"` kind returns `true`). When `engineBacked`, the affordances render as disabled buttons with an `aria-describedby` tooltip: "Rename is coming in a future release (see change add-engine-rename-download)".

**Alternatives considered:**
- **Hide the affordances entirely.** Rejected: discoverability — users will wonder whether the app supports rename at all. Disabled-with-tooltip tells them it's coming.
- **Leave enabled with a runtime "not supported" toast.** Rejected: users will hit it repeatedly and report it as a bug.
- **Make `add-engine-rename-download` a prerequisite.** Rejected: that reorders work behind the more user-visible "files show real data" win; the disabled affordance is a cheap honest placeholder.

**Why:** Discoverable and honest; avoids silent-broken UX.

### Decision 6: Paused treated as connected for browsing

**Choice:** The file-explorer treats `paused` identically to `connected` — files list, navigation works, search works, remove works. No banner or state component for `paused`.

**Alternatives considered:**
- **Read-only "paused" banner.** Rejected: paused only affects the sync scheduler; the provider remains fully accessible. Browsing while paused is desirable (user may pause to prevent syncs during travel).
- **Disable remove while paused.** Rejected: conflates sync-job scheduling with direct provider operations. Remove goes through the engine, not the sync queue.

**Why:** `paused` is a sync-engine concept, not a provider-reachability concept.

### Decision 7: Skeleton rows for loading; pattern A for persistent states

**Choice:** Loading renders 6 grey skeleton rows matched to the active view mode's row structure (icon rectangle + name rectangle + trailing metadata rectangle). Persistent states (`disconnected`, `auth-revoked`, `syncing`, `connected-but-empty`) render the pattern A full-replace with a centered Lucide icon, semantic color (amber / blue / neutral), headline, body, and primary action button (or no button for `connected-but-empty` / `syncing`).

**Alternatives considered:**
- **Deferred spinner (nothing for 250ms, then spinner).** Considered during brainstorming; rejected in favor of skeleton rows which communicate "something will appear here" more concretely.
- **Full-replace spinner for loading.** Rejected: flashes annoyingly on fast loads; tested visually and confirmed skeleton is better.

**Why:** Skeletons are the industry norm for file lists, and the transition from skeleton → rows is visually continuous.

## Visual direction

- **Aesthetic:** Quiet, utilitarian. Mirrors the rest of the desktop app (shadcn-on-Tailwind with Lucide icons). No decorative gradients or illustrations; visual hierarchy comes from spacing and semantic color, not chrome.
- **Layout pattern for non-usable states:** Pattern A (full-replace) — the entries area is replaced by a centered 40px Lucide icon, 15px semibold headline, 13px body text at `text-muted-foreground`, and (where applicable) a single primary action button. Toolbar and breadcrumb remain rendered above; DetailsPane remains visible to the right. Width-capped at 320px for the body text to maintain readability.
- **Type:** Inherits the project default (system / Tailwind defaults via shadcn). No new display typeface. Headlines 15px/600, body 13px/400.
- **Color palette (semantic, Tailwind):**
  - Amber (`text-amber-600` / `bg-amber-600`) — "you need to act" (disconnected, auth-revoked). Primary action button uses amber background, white text.
  - Blue (`text-blue-600`) — "system is working" (syncing initial sync). No action button; progress label in blue.
  - Neutral (`text-muted-foreground`) — connected-but-empty. No color accent; pure grey iconography.
- **Iconography:** Lucide icons via the existing `components/icon.tsx` adapter. Disconnected = `CloudOff`, auth-revoked = `KeyRound`, syncing = `RefreshCw` with `animate-spin` at 2.4s linear, empty = `FolderOpen`. Loading skeleton uses no icon.
- **Spacing:** Vertical rhythm of 48px top / 48px bottom around the centered content, 10px gap between icon / headline / body / button. Matches existing dashboard empty-state spacing.
- **Motion:** `RefreshCw` rotates continuously at 2.4s linear. No other motion. No animated transitions between states (avoid jitter on rapid state flips during retry).
- **Accessibility:**
  - Each state component is a single `<div role="status">` (for loading/syncing) or `<div role="alert">` (for error states) with `aria-live="polite"` so screen readers announce the state on entry.
  - Primary buttons reach WCAG AA contrast on amber-600 / white (`#d97706` on `#fff` is 4.66:1 — passes AA for 15px semibold).
  - Icons are `aria-hidden="true"` (decorative); all semantics flow through text.
  - Keyboard: primary action button is focusable; Tab lands on it after the toolbar. Escape dismisses no modal (there is none).
  - Disabled Rename / Download buttons retain their focusable state (`aria-disabled="true"`, not `disabled`) so keyboard users can read the tooltip-describing attribute via screen reader.
- **No deviations from WCAG AA.** Flagged none.

## Risks / Trade-offs

- **Listing truncates past the first provider page.** → Documented limitation. The `design.md` "Known limitations" section names `add-engine-listdirectory-pagination` as the follow-up. Dashboard / explorer status row does NOT currently tell the user the listing was truncated (no `nextPageToken` surfaced). Acceptable for v1; re-visit when pagination lands.
- **Two response shapes (engine-throw vs engine-envelope) during migration.** → Change is atomic per file (list/stat/search/remove each rewritten in one commit) and the envelope is added at the contracts package + sync-service + main handler in the same commit. No intermediate state ships.
- **Renderer reads `providerKind` to decide "engineBacked"; a future synthetic provider could break the check.** → We only have `"google-drive"`, `"onedrive"`, `"amazon-s3"` + mock. The rule is "everything non-mock is engine-backed". Adding a new non-engine-backed provider in the future should update this check; documented in the disable logic's JSDoc.
- **Bulk remove of 100 files launches 100 parallel engine calls.** → Engine rate-limits per-provider. Likely fine for reasonable selections (≤ 50 files); if users start selecting thousands, we add throttling. Not gated here.
- **Predictive state from datasources-store can flash before the engine response arrives.** → `syncing` state mid-fetch for a fast-connected datasource is <200ms visible; acceptable. Guarded by the stale-response guard already in `useExplorerData`.
- **`files:search` scope semantics — datasource-wide vs current-folder.** → Engine's `search(query, scope?)` supports both via the optional `scope`. This change uses `scope = currentPath` (folder-scoped) to match user expectation when they're inside a folder. Documented in the spec's Search requirement.
- **Tooling test (`no-provider-sdk-imports.test.ts`) enforces that main-process code does not import provider SDKs.** → Honored. All provider access goes through the sync-service RPC; main holds no SDK code.

## Known limitations (follow-up tracked)

- **`add-engine-listdirectory-pagination`** — engine's `listDirectory` exposes no continuation token; folders with more than one provider page worth of entries silently truncate. Proposed follow-up change name. Scope will include: plumbing `{ entries, nextCursor }` through the base-client, updating all three strategies (Google Drive `nextPageToken`, OneDrive `@odata.nextLink`, S3 `ContinuationToken`), surfacing a "load more" affordance in the explorer.

## Migration Plan

- No data migration. The change is a pure code swap on the main process + one new command on the sync service + renderer state additions.
- Roll-out order (per `/opsx:apply` phase sequence, each phase behind its own failing test):
  1. Add `files:*` to `CommandMap`; extend `packages/ipc-contracts` test expectations; implement sync-service handlers with an in-memory fake engine fixture.
  2. Extend `FilesListResponse` / `FilesStatResponse` / `FilesSearchResponse` / `FilesRemoveResponse` in `packages/ipc-contracts/src/files.ts` with the discriminated envelope. Update `no-provider-sdk-imports.test.ts` if needed.
  3. Rewrite `apps/desktop/src/main/ipc/files/{list,stat,search,remove}.ts` to call `syncClient.request("files:*")`. Keep `mock-fs.ts` for `rename` and `download`.
  4. Renderer: add `file-explorer/states/{disconnected,auth-revoked,syncing,empty,skeleton}.tsx`; wire `useExplorerData` to route by envelope tag; update `file-explorer.tsx` branching.
  5. Renderer: disable Rename / Download affordances for non-mock datasources in toolbar + context menu; tooltip copy.
  6. End-to-end smoke in the worktree: real Google Drive datasource, empty Drive folder (should show `connected-but-empty`), revoked-token scenario (should show `auth-revoked`), offline (should show `disconnected`), bulk-delete 3 files (should show aggregate toast).
- Rollback: revert the commits. No schema changes, no persistent state written.

## Open Questions

None at this time. All six decision points flagged during brainstorming are resolved above.
