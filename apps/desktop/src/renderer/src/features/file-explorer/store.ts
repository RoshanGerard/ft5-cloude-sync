"use client";

import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { FilesErrorTag } from "@ft5/ipc-contracts";
import type {
  FileEntry,
  FilesDownloadResponse,
  FilesErrorEnvelope,
  FilesListResponse,
  FilesListValue,
  FilesRemoveResponse,
  FilesRemoveTarget,
  FilesRenameResponse,
} from "@ft5/ipc-contracts";

/**
 * File-explorer store. One instance per datasource id — each explorer view
 * owns its own history stack, selection, pending-op map, and visible entries.
 * See `openspec/changes/ui-file-explorer/design.md` Decision 5 for the state
 * shape and action vocabulary; Decision 7 for the async-op lifecycle.
 *
 * The factory pattern (`createExplorerStore(id)`) is deliberately not a
 * module-level singleton the way `theme-store.ts` is — themes are global,
 * explorers are per-datasource. Each factory closure owns its own listeners
 * Set and snapshot reference. The `useExplorerStore` hook below caches the
 * factory result in a module-level `Map<datasourceId, ExplorerStore>` so
 * unmounting and remounting within a session reuses the same state.
 *
 * Persistence mirrors `theme-store.ts`:
 *   - Only a curated subset (viewMode / sortBy / sortDir / detailsPaneOpen)
 *     is written to localStorage.
 *   - Defensive JSON.parse (try/catch) — malformed storage falls back to
 *     defaults, never throws.
 *   - SSR-safe: `typeof window` guard lets the factory run during Next.js
 *     static export.
 */

export type ViewMode = "list" | "details" | "small" | "tiles" | "medium" | "large";
export type SortBy = "name" | "type" | "size" | "modified";
export type SortDir = "asc" | "desc";

// Rename request's wire-level conflict policy (mirrors
// `FilesRenameRequest.conflictPolicy`). Distinct from upload's
// `ConflictPolicy` (which is `"overwrite" | "duplicate" | "skip"`) per
// add-engine-rename-download/design.md Decision 7.
export type RenameConflictPolicy = "fail" | "overwrite" | "keep-both";

// Choice surface for the rename-conflict prompt. The dialog returns
// `"cancel"` when the user dismisses the dialog (Escape, X, or Cancel
// button); `"overwrite"` / `"keep-both"` trigger a re-dispatch with
// the matching `conflictPolicy`. See `rename-conflict-dialog.tsx`.
export type RenameConflictChoice = "overwrite" | "keep-both" | "cancel";

/**
 * Prompt port for resolving a single rename conflict. The store invokes
 * this with the envelope's `existingPath` and awaits the user's choice.
 * `RenameConflictPrompt` is intentionally lightweight (one collision at
 * a time, no batch/queue semantics) — the upload `ConflictResolver`
 * shape doesn't fit (see design.md Decision 7).
 */
export type RenameConflictPrompt = (
  existingPath: string,
) => Promise<RenameConflictChoice>;

// ---------------------------------------------------------------------------
// Download conflict — types + prompt port
// (add-download-overwrite-confirm §5.2 / design.md Decision 5)
// ---------------------------------------------------------------------------

/**
 * Wire-level conflict policy on `FilesDownloadRequest`. Mirrors the
 * rename `RenameConflictPolicy` enum verbatim — both surfaces share the
 * same three-option matrix per add-download-overwrite-confirm/design.md
 * Decision 1 ("Reuse the rename `conflictPolicy` enum verbatim — distinct
 * from upload's").
 */
export type DownloadConflictPolicy = "fail" | "overwrite" | "keep-both";

/**
 * Choice surface for the download-conflict prompt. `"cancel"` is the
 * dismissal sentinel (Escape / overlay-click / Cancel button); the other
 * two values drive a re-dispatch with the matching `conflictPolicy`. See
 * `useDownloadConflictDialog()` in `rename-conflict-dialog.tsx` for the
 * production wiring and the orchestrator's loop in `use-download-orchestrator.ts`
 * for the consumer side.
 */
export type DownloadConflictChoice = "overwrite" | "keep-both" | "cancel";

/**
 * Prompt port for resolving a single download-destination conflict. The
 * orchestrator's loop invokes this with the envelope's `existingPath`
 * plus the optional `existingSize` / `existingModifiedAt` hint metadata
 * the service-side gate populates. Both hint fields may be absent in
 * principle (the contract is flat-optional); the dialog's hint block
 * renders conditionally on either being present.
 */
export type DownloadConflictPrompt = (
  existingPath: string,
  existingSize: number | undefined,
  existingModifiedAt: string | undefined,
) => Promise<DownloadConflictChoice>;
// "replace" and "clear-add" currently collapse to the same branch (both
// produce a fresh single-element selection). Kept as distinct modes to
// name the user-intent difference surfaced by the action's caller: a
// click in a view-mode cell is `"replace"`, while a drag-drop target
// or a programmatic navigation landing on a pre-highlighted entry would
// dispatch `"clear-add"`. If no concrete divergence emerges by Phase 6,
// collapse the two into `"replace"` and remove this mode.
export type SelectionMode = "replace" | "range" | "toggle" | "clear-add";
export type OpKind = "rename" | "remove";

export interface PendingOp {
  kind: OpKind;
  startedAt: number;
  // Optimistic rename: requested name shown while the op is in flight.
  newName?: string;
}

export interface ExplorerSearchState {
  query: string;
  active: boolean;
  results: FileEntry[] | null;
  truncated?: boolean;
  providerSearchDeferred?: boolean;
  // Snapshot of `state.selection` (as a sorted `string[]`) captured by
  // `startSearch` while search was inactive, restored by `clearSearch`.
  // `null` at initial state and after `clearSearch` consumes it.
  // Session-only; never persisted to localStorage. See task 7.10.
  preSearchSelection: string[] | null;
}

export interface ExplorerHistory {
  stack: string[];
  index: number;
}

export interface ExplorerLastError {
  entryId: string;
  reason: string;
}

export interface ExplorerState {
  currentPath: string;
  history: ExplorerHistory;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  /**
   * Opaque continuation cursor for the CURRENT path (add-engine-
   * listdirectory-pagination Decision 1/2). `null` means the listing is
   * exhausted (no "Load more"); a string is the token to re-issue for the
   * next page. Per-path: cleared by `navigate` / `back` / `forward`
   * (Decision: cursors are per-list-call, discarded on navigation).
   * Set by `applyInitialPage` (first page) and `loadMore` / `retryLoadMore`
   * (subsequent pages).
   */
  nextCursor: string | null;
  /**
   * True while a `loadMore` / `retryLoadMore` IPC is in flight. Doubles as
   * the re-entrancy guard (a second `loadMore` bails while this is true)
   * AND the `aria-busy` signal the group-9 Load-more affordance consumes.
   * Distinct from the full-listing `loading` flag.
   */
  loadingMore: boolean;
  /**
   * The error envelope from the most recent FAILED `loadMore` /
   * `retryLoadMore` (fs-sync's 4-attempt env-retry already exhausted per
   * Decision 4). DISTINCT from `error` / `errorTag`, which drive the
   * full-screen state components in `file-explorer.tsx`; a page-load
   * failure must NOT replace the already-rendered entries with a
   * full-screen error. `null` when the last load-more succeeded or none
   * has been attempted. The cursor is left UNTOUCHED on failure so a
   * manual Retry can re-issue with it (task 8.4).
   */
  loadMoreError: FilesErrorEnvelope | null;
  /**
   * Tag carried alongside `error` when the list response was a tagged
   * envelope rejection. Drives the renderer's state-component selection
   * in `file-explorer.tsx` so the renderer picks the right full-replace
   * pattern (disconnected / auth-revoked / rate-limited / other) without
   * string-matching `error`.
   */
  errorTag: FilesErrorTag | null;
  /**
   * Monotonic counter bumped by `retryLoad()` to trigger a re-fetch in
   * `useExplorerData` without changing `currentPath`. Starts at 0.
   */
  refetchToken: number;
  selection: Set<string>;
  lastSelectedId: string | null;
  sortBy: SortBy;
  sortDir: SortDir;
  viewMode: ViewMode;
  search: ExplorerSearchState;
  detailsPaneOpen: boolean;
  pendingOps: Record<string, PendingOp>;
  lastError: ExplorerLastError | null;
  // Properties modal — nullable entry is the single source of truth;
  // modal open state is derived (`propertiesEntry !== null`).
  propertiesEntry: FileEntry | null;
  // Inline-rename UI — id of the entry currently being edited or null.
  editingId: string | null;
}

export interface ExplorerStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ExplorerState;

  // Identity — the datasource this store instance belongs to. Exposed so
  // toolbar sub-components (e.g. the Phase 7.2 SearchInput) can construct
  // IPC requests keyed on the same id that seeded `createExplorerStore`
  // without re-threading the prop through every intermediate component.
  readonly datasourceId: string;

  // Navigation
  navigate(path: string): void;
  back(): void;
  forward(): void;
  up(): void;

  // Selection
  select(id: string, mode: SelectionMode): void;
  selectAll(): void;
  clearSelection(): void;

  // View / sort
  setViewMode(mode: ViewMode): void;
  setSort(by: SortBy): void;

  // Search
  startSearch(): void;
  setSearchQuery(query: string): void;
  setSearchResults(
    entries: FileEntry[],
    truncated: boolean,
    providerSearchDeferred?: boolean,
  ): void;
  clearSearch(): void;

  // Entries / load
  setEntries(entries: FileEntry[]): void;
  setLoading(loading: boolean): void;
  setError(error: string | null): void;
  setErrorTag(tag: FilesErrorTag | null): void;

  // --- Pagination (add-engine-listdirectory-pagination §8) ---------------

  /**
   * Apply a successful FIRST-page list response: replace `entries` with
   * `value.entries` and set `nextCursor` from `value.nextCursor`. Called by
   * `use-explorer-data.ts` on the initial-list resolve so the renderer knows
   * whether to show "Load more" (`nextCursor !== null`). Shares the
   * cursor-write semantics with `loadMore` (which APPENDS instead). Also
   * clears any stale `loadMoreError` (a fresh first page starts clean).
   */
  applyInitialPage(value: FilesListValue): void;

  /**
   * Load the next page: re-issue `window.api.files.list` with the stored
   * `nextCursor` and the current `readExplorerPageSize()`. On success,
   * APPENDS `value.entries` to the existing entries and advances
   * `nextCursor`. On failure (fs-sync retry already exhausted), records
   * `loadMoreError` and leaves the cursor untouched for a manual retry.
   *
   * Guards:
   *   - no-op when `nextCursor === null` (nothing more to load)
   *   - no-op when `loadingMore` is already true (re-entrancy)
   *   - if the path changed while the call was in flight, the resolved
   *     page is discarded (stale-response guard — cursors are per-path)
   */
  loadMore(): Promise<void>;

  /**
   * Manual retry after a `loadMore` failure. Re-issues with the SAME stored
   * cursor + the current page size; clears `loadMoreError` on success
   * (append + advance cursor as in `loadMore`). Identical mechanics to
   * `loadMore` — the only difference is intent (user-initiated retry vs
   * first attempt).
   */
  retryLoadMore(): Promise<void>;
  /**
   * Bump `refetchToken` to re-dispatch the list IPC for the current
   * folder. Used by the disconnected-state's Retry button; does NOT
   * clear existing state (`useExplorerData` sets loading / error
   * before the new dispatch per normal effect sequencing).
   */
  retryLoad(): void;

  // Details pane
  toggleDetailsPane(): void;

  // Pending ops
  startPendingOp(entryId: string, kind: OpKind): void;
  clearPendingOp(entryId: string): void;
  setLastError(entryId: string | null, reason: string | null): void;

  // Properties modal
  openProperties(entry: FileEntry): void;
  closeProperties(): void;

  // Inline rename
  startEdit(entryId: string): void;
  cancelEdit(): void;
  rename(entryId: string, newName: string): Promise<void>;
  /**
   * Register / unregister the rename-conflict prompt port. The
   * `<FileExplorer>` mounts a `useRenameConflictDialog()` hook and wires
   * its `prompt` into the store via this setter inside a `useEffect`.
   * On a `tag: "conflict"` rename response, `store.rename` invokes the
   * prompt with the envelope's `existingPath` and re-dispatches with
   * the user's chosen policy (`"overwrite" | "keep-both"`) or aborts on
   * `"cancel"`. See add-engine-rename-download/design.md Decision 7
   * (renderer-wiring deviation 2026-04-28) for why rename uses a
   * parallel hook rather than the upload `ConflictResolutionDialog`.
   *
   * Pass `null` on unmount to detach. When unset, a conflict envelope
   * falls through to the existing `lastError` + `toast.error` path.
   */
  setRenameConflictPrompt(prompt: RenameConflictPrompt | null): void;

  /**
   * Register / unregister the download-conflict prompt port
   * (add-download-overwrite-confirm §5.2). Mirrors
   * `setRenameConflictPrompt` in shape so the file-explorer mount-effect
   * symmetry-pair (`setRenameConflictPrompt` + `setDownloadConflictPrompt`)
   * is one read.
   *
   * The store stashes the registered prompt on a per-instance slot;
   * `getDownloadConflictPrompt()` returns the latest registration. The
   * actual conflict re-prompt loop lives in `useDownloadOrchestrator`,
   * NOT in `store.download` (which is deprecated and unreachable from
   * production — see the store-level JSDoc on the deprecated
   * `download(entryId)` method). `<FileExplorer>` passes the registered
   * prompt to the orchestrator via the hook's options on every render,
   * and also calls this setter so the rename mount-effect symmetry is
   * preserved and so future consumers have a single canonical
   * registration site if direct store access is ever needed.
   *
   * Pass `null` on unmount to detach. When unset, the orchestrator's
   * loop falls through to the existing error-toast path (the conflict
   * envelope's `message` becomes the toast text).
   */
  setDownloadConflictPrompt(prompt: DownloadConflictPrompt | null): void;

  /**
   * Read the currently-registered download-conflict prompt, or `null`
   * when none is set. Exposed as a method (not a state field) because
   * the prompt port is intentionally NOT part of the reactive state
   * snapshot — re-renders triggered by every prompt swap would cause
   * extraneous churn in `useExplorerStore` consumers.
   */
  getDownloadConflictPrompt(): DownloadConflictPrompt | null;

  // Remove (delete) — accepts one or more paths; issues a single IPC call.
  remove(targets: FilesRemoveTarget[]): Promise<void>;

  // Download — one-shot IPC for a file entry; does NOT use pendingOps
  // (the entry stays in the list; the op is user-facing via toast only).
  //
  // @deprecated Superseded by `useDownloadOrchestrator` +
  //   `createDownloadJobToaster` (`add-engine-rename-download` §23/§24).
  //   The file-explorer composite no longer calls this — the orchestrator
  //   resolves `toPath` (default folder + Shift / Always-ask), runs the
  //   first-run modal, and dispatches `window.api.files.download` while
  //   the toaster owns the per-job lifecycle UI. This method is kept
  //   only because store-level tests at `__tests__/store.test.ts`
  //   reference it directly; remove once those tests retire.
  download(entryId: string): Promise<void>;
}

export const DIRECTORY_RENAME_REFUSAL =
  "Folder rename is not supported in this version";
export const EMPTY_NAME_REFUSAL = "Name cannot be empty";

export const EXPLORER_STORAGE_KEY_PREFIX = "ft5.file-explorer.";

// Pagination page-size preference (add-engine-listdirectory-pagination
// Decision 3). Read from a single global localStorage key (NOT per-
// datasource, mirroring the `ft5.downloads.*` flat-key pattern) on every
// list-call origination — both the initial list (issued by
// `use-explorer-data.ts`) and each `loadMore` / `retryLoadMore`. Default
// is 500 when the key is absent or holds a non-positive / non-numeric
// value. The Settings dropdown (group 12) writes one of
// 100 / 500 / 1000 / 5000 / 10000; the strategy layer clamps to each
// provider's cap, so the renderer does not validate the upper bound.
export const EXPLORER_PAGE_SIZE_KEY = "ft5.explorer.pageSize";
export const DEFAULT_EXPLORER_PAGE_SIZE = 500;

/**
 * Read the user's configured page size from localStorage, falling back to
 * `DEFAULT_EXPLORER_PAGE_SIZE` (500) when the key is absent, malformed, or
 * non-positive. Mirrors `downloads-store.ts`'s `getDefaultFolder` read
 * pattern: defensive try/catch, SSR-safe, storage is the source of truth.
 *
 * Exported so BOTH list-origination sites share it: the initial-list hook
 * (`use-explorer-data.ts`) and the store's `loadMore` / `retryLoadMore`.
 */
export function readExplorerPageSize(): number {
  if (!isBrowser()) return DEFAULT_EXPLORER_PAGE_SIZE;
  try {
    const raw = window.localStorage.getItem(EXPLORER_PAGE_SIZE_KEY);
    if (raw === null) return DEFAULT_EXPLORER_PAGE_SIZE;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_EXPLORER_PAGE_SIZE;
    }
    return parsed;
  } catch {
    return DEFAULT_EXPLORER_PAGE_SIZE;
  }
}

function storageKeyFor(datasourceId: string): string {
  return `${EXPLORER_STORAGE_KEY_PREFIX}${datasourceId}.prefs`;
}

interface PersistedPrefs {
  viewMode: ViewMode;
  sortBy: SortBy;
  sortDir: SortDir;
  detailsPaneOpen: boolean;
}

const DEFAULT_PREFS: PersistedPrefs = {
  viewMode: "details",
  sortBy: "name",
  sortDir: "asc",
  detailsPaneOpen: false,
};

const VALID_VIEW_MODES: ReadonlySet<ViewMode> = new Set<ViewMode>([
  "list",
  "details",
  "small",
  "tiles",
  "medium",
  "large",
]);
const VALID_SORT_BY: ReadonlySet<SortBy> = new Set<SortBy>([
  "name",
  "type",
  "size",
  "modified",
]);
const VALID_SORT_DIR: ReadonlySet<SortDir> = new Set<SortDir>(["asc", "desc"]);

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function loadPrefs(datasourceId: string): PersistedPrefs {
  if (!isBrowser()) return { ...DEFAULT_PREFS };
  try {
    const raw = window.localStorage.getItem(storageKeyFor(datasourceId));
    if (raw === null) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const prefs: PersistedPrefs = { ...DEFAULT_PREFS };
    if (
      typeof parsed.viewMode === "string" &&
      VALID_VIEW_MODES.has(parsed.viewMode as ViewMode)
    ) {
      prefs.viewMode = parsed.viewMode as ViewMode;
    }
    if (
      typeof parsed.sortBy === "string" &&
      VALID_SORT_BY.has(parsed.sortBy as SortBy)
    ) {
      prefs.sortBy = parsed.sortBy as SortBy;
    }
    if (
      typeof parsed.sortDir === "string" &&
      VALID_SORT_DIR.has(parsed.sortDir as SortDir)
    ) {
      prefs.sortDir = parsed.sortDir as SortDir;
    }
    if (typeof parsed.detailsPaneOpen === "boolean") {
      prefs.detailsPaneOpen = parsed.detailsPaneOpen;
    }
    return prefs;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(datasourceId: string, state: ExplorerState): void {
  if (!isBrowser()) return;
  const payload: PersistedPrefs = {
    viewMode: state.viewMode,
    sortBy: state.sortBy,
    sortDir: state.sortDir,
    detailsPaneOpen: state.detailsPaneOpen,
  };
  try {
    window.localStorage.setItem(storageKeyFor(datasourceId), JSON.stringify(payload));
  } catch {
    // Storage quota / sandbox — best-effort; state remains in memory.
  }
}

function parentOf(path: string): string {
  if (path === "/" || path === "") return "/";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

export function createExplorerStore(datasourceId: string): ExplorerStore {
  const listeners = new Set<() => void>();
  const prefs = loadPrefs(datasourceId);

  // Rename-conflict prompt port. Registered by the `<FileExplorer>`'s
  // `useRenameConflictDialog()` mount-effect via `setRenameConflictPrompt`.
  // `null` on first render and after unmount; when null, the rename loop
  // surfaces a conflict envelope through the existing `lastError` /
  // `toast.error` path. See ExplorerStore.setRenameConflictPrompt.
  let renameConflictPrompt: RenameConflictPrompt | null = null;

  // Download-conflict prompt port (add-download-overwrite-confirm §5.2).
  // Registered by the `<FileExplorer>`'s `useDownloadConflictDialog()`
  // mount-effect via `setDownloadConflictPrompt`. The actual conflict
  // re-prompt loop runs inside `useDownloadOrchestrator` — file-explorer
  // passes this slot's value into the hook's options on each render so
  // the orchestrator's `dispatchAgainstFolder` can invoke it on a
  // `tag: "conflict"` envelope. Stored as a closure (not reactive state)
  // because re-rendering on prompt swap would churn every explorer
  // consumer for no useful UI signal.
  let downloadConflictPrompt: DownloadConflictPrompt | null = null;

  let state: ExplorerState = {
    currentPath: "/",
    history: { stack: ["/"], index: 0 },
    entries: [],
    loading: false,
    error: null,
    errorTag: null,
    nextCursor: null,
    loadingMore: false,
    loadMoreError: null,
    refetchToken: 0,
    selection: new Set<string>(),
    lastSelectedId: null,
    sortBy: prefs.sortBy,
    sortDir: prefs.sortDir,
    viewMode: prefs.viewMode,
    search: {
      query: "",
      active: false,
      results: null,
      preSearchSelection: null,
    },
    detailsPaneOpen: prefs.detailsPaneOpen,
    pendingOps: {},
    lastError: null,
    propertiesEntry: null,
    editingId: null,
  };

  function emit(): void {
    for (const l of listeners) l();
  }

  function set(next: ExplorerState, persist: boolean): void {
    state = next;
    if (persist) savePrefs(datasourceId, state);
    emit();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): ExplorerState {
    return state;
  }

  // --- Navigation --------------------------------------------------------

  function navigate(path: string): void {
    if (path === state.currentPath) return;
    const truncated = state.history.stack.slice(0, state.history.index + 1);
    const nextStack = [...truncated, path];
    // When search is active, navigation moves the user to a new folder
    // context. Drop the search state entirely — including the pre-search
    // snapshot — because the prior selection belonged to the now-stale
    // folder. Selection is cleared for the same reason (entry ids are
    // scoped to a folder's listing).
    const wasSearching = state.search.active;
    const nextSearch: ExplorerSearchState = wasSearching
      ? {
          query: "",
          active: false,
          results: null,
          truncated: false,
          providerSearchDeferred: false,
          preSearchSelection: null,
        }
      : state.search;
    const nextSelection = wasSearching ? new Set<string>() : state.selection;
    const nextLastSelectedId = wasSearching ? null : state.lastSelectedId;
    set(
      {
        ...state,
        currentPath: path,
        history: { stack: nextStack, index: nextStack.length - 1 },
        search: nextSearch,
        selection: nextSelection,
        lastSelectedId: nextLastSelectedId,
        // Cursors are per-path — discard on navigation (Decision: cursors
        // are per-list-call). Clear any page-load-failed row too.
        nextCursor: null,
        loadMoreError: null,
      },
      false,
    );
  }

  function back(): void {
    if (state.history.index <= 0) return;
    const nextIndex = state.history.index - 1;
    const nextPath = state.history.stack[nextIndex];
    if (typeof nextPath !== "string") return;
    set(
      {
        ...state,
        currentPath: nextPath,
        history: { ...state.history, index: nextIndex },
        // back() changes the path without going through navigate(), so it
        // must independently discard the per-path cursor + failed-state.
        nextCursor: null,
        loadMoreError: null,
      },
      false,
    );
  }

  function forward(): void {
    if (state.history.index >= state.history.stack.length - 1) return;
    const nextIndex = state.history.index + 1;
    const nextPath = state.history.stack[nextIndex];
    if (typeof nextPath !== "string") return;
    set(
      {
        ...state,
        currentPath: nextPath,
        history: { ...state.history, index: nextIndex },
        // forward() also bypasses navigate() — same per-path cursor reset.
        nextCursor: null,
        loadMoreError: null,
      },
      false,
    );
  }

  function up(): void {
    const parent = parentOf(state.currentPath);
    if (parent === state.currentPath) return;
    navigate(parent);
  }

  // --- Selection ---------------------------------------------------------

  function select(id: string, mode: SelectionMode): void {
    if (mode === "replace" || mode === "clear-add") {
      const next = new Set<string>([id]);
      set({ ...state, selection: next, lastSelectedId: id }, false);
      return;
    }

    if (mode === "toggle") {
      const next = new Set(state.selection);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      set({ ...state, selection: next, lastSelectedId: id }, false);
      return;
    }

    // mode === "range"
    //
    // The anchor is the last non-range selection (Windows Explorer
    // semantics): click N sets anchor=N; shift-click M extends from
    // N..M without moving the anchor, so a subsequent shift-click K
    // extends from the *same* N to K. Without this, repeated shift-
    // clicks would walk the anchor along the trail of previous
    // endpoints, producing the wrong range.
    const anchor = state.lastSelectedId;
    if (anchor === null) {
      // No anchor yet — treat this as the initial selection. Setting
      // lastSelectedId here seeds the anchor so subsequent shift-clicks
      // have a fixed reference. This is the only range-mode path that
      // mutates the anchor.
      const next = new Set<string>([id]);
      set({ ...state, selection: next, lastSelectedId: id }, false);
      return;
    }
    const ids = state.entries.map((e) => e.id);
    const anchorIdx = ids.indexOf(anchor);
    const targetIdx = ids.indexOf(id);
    if (anchorIdx === -1 || targetIdx === -1) {
      // Anchor or target not in current entries — fall back to replace,
      // which DOES move the anchor (mimics a plain click).
      const next = new Set<string>([id]);
      set({ ...state, selection: next, lastSelectedId: id }, false);
      return;
    }
    const [from, to] =
      anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
    const next = new Set<string>();
    for (let i = from; i <= to; i += 1) {
      const entryId = ids[i];
      if (typeof entryId === "string") next.add(entryId);
    }
    // Critical: preserve lastSelectedId so the anchor stays put for
    // further shift-clicks. Only replace/toggle/clear-add update it.
    set({ ...state, selection: next }, false);
  }

  function selectAll(): void {
    const next = new Set<string>(state.entries.map((e) => e.id));
    const last = state.entries.length > 0 ? (state.entries[state.entries.length - 1]?.id ?? null) : null;
    set({ ...state, selection: next, lastSelectedId: last }, false);
  }

  function clearSelection(): void {
    set({ ...state, selection: new Set<string>(), lastSelectedId: null }, false);
  }

  // --- View / sort -------------------------------------------------------

  function setViewMode(mode: ViewMode): void {
    if (state.viewMode === mode) return;
    set({ ...state, viewMode: mode }, true);
  }

  function setSort(by: SortBy): void {
    if (state.sortBy === by) {
      const nextDir: SortDir = state.sortDir === "asc" ? "desc" : "asc";
      set({ ...state, sortDir: nextDir }, true);
      return;
    }
    set({ ...state, sortBy: by, sortDir: "asc" }, true);
  }

  // --- Search ------------------------------------------------------------

  function startSearch(): void {
    // Idempotent: a second call while active MUST NOT overwrite the
    // pre-search selection snapshot.
    if (state.search.active) return;
    const snapshot = Array.from(state.selection).sort();
    set(
      {
        ...state,
        search: {
          ...state.search,
          active: true,
          preSearchSelection: snapshot,
        },
      },
      false,
    );
  }

  function setSearchQuery(query: string): void {
    set({ ...state, search: { ...state.search, query } }, false);
  }

  function setSearchResults(
    entries: FileEntry[],
    truncated: boolean,
    providerSearchDeferred?: boolean,
  ): void {
    set(
      {
        ...state,
        search: {
          ...state.search,
          results: entries,
          truncated,
          providerSearchDeferred: providerSearchDeferred ?? false,
        },
      },
      false,
    );
  }

  function clearSearch(): void {
    // If a pre-search snapshot exists, restore it; otherwise leave the
    // current selection untouched (defensive — clearSearch may be called
    // from an already-clean state).
    const snap = state.search.preSearchSelection;
    const restoredSelection =
      snap === null ? state.selection : new Set<string>(snap);
    set(
      {
        ...state,
        selection: restoredSelection,
        search: {
          query: "",
          active: false,
          results: null,
          preSearchSelection: null,
        },
      },
      false,
    );
  }

  // --- Entries / load ----------------------------------------------------

  function setEntries(entries: FileEntry[]): void {
    set({ ...state, entries }, false);
  }

  function setLoading(loading: boolean): void {
    set({ ...state, loading }, false);
  }

  function setError(error: string | null): void {
    set({ ...state, error }, false);
  }

  function setErrorTag(errorTag: FilesErrorTag | null): void {
    set({ ...state, errorTag }, false);
  }

  function retryLoad(): void {
    set({ ...state, refetchToken: state.refetchToken + 1 }, false);
  }

  // --- Pagination (add-engine-listdirectory-pagination §8) ---------------

  function applyInitialPage(value: FilesListValue): void {
    // First page: REPLACE entries and seed the cursor together so the UI's
    // "Load more" visibility (`nextCursor !== null`) is correct from the
    // first paint. Clears any stale page-load-failed row.
    //
    // Coerce a missing `nextCursor` to `null`: the wire contract makes it
    // required, but pre-pagination test fixtures (and any older payload)
    // may omit it. Without this, the field would be `undefined`, and
    // `loadMore`'s `nextCursor === null` guard would not bail correctly.
    set(
      {
        ...state,
        entries: value.entries,
        nextCursor: value.nextCursor ?? null,
        loadMoreError: null,
      },
      false,
    );
  }

  // Defensive `window.api.files.list` accessor, mirroring the
  // rename/remove/download pattern: tests and non-Electron environments
  // don't always inject `window.api`.
  function resolveListApi():
    | ((req: {
        datasourceId: string;
        path: string;
        cursor?: string;
        pageSize?: number;
      }) => Promise<FilesListResponse>)
    | undefined {
    return (
      globalThis as unknown as {
        window?: {
          api?: {
            files?: {
              list?: (req: {
                datasourceId: string;
                path: string;
                cursor?: string;
                pageSize?: number;
              }) => Promise<FilesListResponse>;
            };
          };
        };
      }
    ).window?.api?.files?.list;
  }

  /**
   * Shared next-page fetch for `loadMore` + `retryLoadMore`. Issues the IPC
   * with the supplied cursor + the current page size, then APPENDS on
   * success / records `loadMoreError` on failure. Captures `currentPath` at
   * call start; if the path changed before the call resolves (the user
   * navigated mid-flight), the result is discarded — cursors are per-path,
   * so appending to a different folder would corrupt the listing.
   */
  async function runPage(cursor: string): Promise<void> {
    const requestPath = state.currentPath;
    set({ ...state, loadingMore: true, loadMoreError: null }, false);

    // After the call resolves, bail if the user navigated away (cursors are
    // per-path; appending to the new folder would corrupt it). The
    // navigation already reset cursor/failed-state for the new folder, but
    // we still flip OUR `loadingMore` flag off so the new folder's
    // Load-more affordance isn't stuck busy.
    const bailIfStale = (): boolean => {
      if (state.currentPath === requestPath) return false;
      if (state.loadingMore) {
        set({ ...state, loadingMore: false }, false);
      }
      return true;
    };

    try {
      const api = resolveListApi();
      if (api === undefined) {
        throw new Error("window.api.files.list is unavailable");
      }
      const response = await api({
        datasourceId,
        path: requestPath,
        cursor,
        pageSize: readExplorerPageSize(),
      });
      if (bailIfStale()) return;
      if (response.ok) {
        set(
          {
            ...state,
            entries: [...state.entries, ...response.value.entries],
            nextCursor: response.value.nextCursor,
            loadingMore: false,
            loadMoreError: null,
          },
          false,
        );
        return;
      }
      // fs-sync's env-retry is already exhausted by the time we see
      // ok:false. Record the envelope; leave `nextCursor` untouched so a
      // manual Retry re-issues with the SAME cursor (task 8.4).
      set(
        { ...state, loadingMore: false, loadMoreError: response.error },
        false,
      );
    } catch (err) {
      if (bailIfStale()) return;
      const message = err instanceof Error ? err.message : String(err);
      // A thrown error (ipcRenderer reject) carries no tag — synthesize a
      // minimal envelope so the page-load-failed row has a `tag`/`message`
      // to humanize. `other` is the generic wire fallback.
      set(
        {
          ...state,
          loadingMore: false,
          loadMoreError: {
            tag: FilesErrorTag.Other,
            message,
            retryable: false,
          },
        },
        false,
      );
    }
  }

  async function loadMore(): Promise<void> {
    // Nothing more to load, or a fetch is already in flight (re-entrancy).
    if (state.nextCursor === null || state.loadingMore) return;
    await runPage(state.nextCursor);
  }

  async function retryLoadMore(): Promise<void> {
    // Re-issue with the SAME stored cursor. Same guards as loadMore.
    if (state.nextCursor === null || state.loadingMore) return;
    await runPage(state.nextCursor);
  }

  // --- Details pane ------------------------------------------------------

  function toggleDetailsPane(): void {
    set({ ...state, detailsPaneOpen: !state.detailsPaneOpen }, true);
  }

  // --- Pending ops -------------------------------------------------------

  function startPendingOp(entryId: string, kind: OpKind): void {
    const op: PendingOp = { kind, startedAt: Date.now() };
    set(
      { ...state, pendingOps: { ...state.pendingOps, [entryId]: op } },
      false,
    );
  }

  function clearPendingOp(entryId: string): void {
    if (!(entryId in state.pendingOps)) return;
    const next: Record<string, PendingOp> = { ...state.pendingOps };
    delete next[entryId];
    set({ ...state, pendingOps: next }, false);
  }

  function setLastError(entryId: string | null, reason: string | null): void {
    if (entryId === null || reason === null) {
      set({ ...state, lastError: null }, false);
      return;
    }
    set({ ...state, lastError: { entryId, reason } }, false);
  }

  // --- Properties modal --------------------------------------------------

  function openProperties(entry: FileEntry): void {
    set({ ...state, propertiesEntry: entry }, false);
  }

  function closeProperties(): void {
    if (state.propertiesEntry === null) return;
    set({ ...state, propertiesEntry: null }, false);
  }

  // --- Inline rename -----------------------------------------------------

  function startEdit(entryId: string): void {
    const entry = state.entries.find((e) => e.id === entryId);
    if (entry === undefined) return;
    if (entry.kind === "directory") {
      // Belt-and-suspenders: context menu disables the item, F2 filters in
      // the keyboard hook — but the store is the source of truth.
      set(
        {
          ...state,
          lastError: { entryId, reason: DIRECTORY_RENAME_REFUSAL },
        },
        false,
      );
      return;
    }
    // Don't let a stale input re-open on top of an in-flight rename.
    if (state.pendingOps[entryId] !== undefined) return;
    set({ ...state, editingId: entryId }, false);
  }

  function cancelEdit(): void {
    if (state.editingId === null) return;
    set({ ...state, editingId: null }, false);
  }

  function setRenameConflictPrompt(
    prompt: RenameConflictPrompt | null,
  ): void {
    renameConflictPrompt = prompt;
  }

  function setDownloadConflictPrompt(
    prompt: DownloadConflictPrompt | null,
  ): void {
    downloadConflictPrompt = prompt;
  }

  function getDownloadConflictPrompt(): DownloadConflictPrompt | null {
    return downloadConflictPrompt;
  }

  async function rename(entryId: string, newName: string): Promise<void> {
    const entry = state.entries.find((e) => e.id === entryId);
    if (entry === undefined) return;
    // Close the inline input regardless of which branch we take below.
    const clearEditing = (s: ExplorerState): ExplorerState =>
      s.editingId === entryId ? { ...s, editingId: null } : s;

    if (entry.kind === "directory") {
      set(
        clearEditing({
          ...state,
          lastError: { entryId, reason: DIRECTORY_RENAME_REFUSAL },
        }),
        false,
      );
      toast.error(DIRECTORY_RENAME_REFUSAL);
      return;
    }
    const trimmed = newName.trim();
    if (trimmed.length === 0) {
      set(
        clearEditing({
          ...state,
          lastError: { entryId, reason: EMPTY_NAME_REFUSAL },
        }),
        false,
      );
      toast.error(EMPTY_NAME_REFUSAL);
      return;
    }
    if (newName === entry.name) {
      // Same-name rename is a no-op in IPC terms, but it's a user
      // gesture — if a previous refusal (empty name, directory rename,
      // IPC failure) left `lastError` pinned to this entry, the user's
      // "rename to the original" move is an implicit "I'm done, drop
      // the warning pin." Clear the pin scoped to this entry; leave
      // errors on other entries untouched.
      const nextLastError =
        state.lastError !== null && state.lastError.entryId === entryId
          ? null
          : state.lastError;
      set(
        clearEditing({ ...state, lastError: nextLastError }),
        false,
      );
      return;
    }

    const api = (globalThis as unknown as {
      window?: {
        api?: {
          files?: {
            rename?: (req: {
              datasourceId: string;
              path: string;
              newName: string;
              conflictPolicy: RenameConflictPolicy;
            }) => Promise<FilesRenameResponse>;
          };
        };
      };
    }).window?.api?.files?.rename;

    // Seed the optimistic pendingOp + close the inline input. The loop
    // below refreshes `pendingOp.startedAt` on each retry so the
    // optimistic UI reflects the new attempt (per
    // add-engine-rename-download §25.1).
    const seedPending = (s: ExplorerState): ExplorerState => ({
      ...s,
      pendingOps: {
        ...s.pendingOps,
        [entryId]: { kind: "rename", startedAt: Date.now(), newName },
      },
      lastError: null,
    });
    set(clearEditing(seedPending(state)), false);

    const clearPending = (s: ExplorerState): ExplorerState => {
      const next: Record<string, PendingOp> = { ...s.pendingOps };
      delete next[entryId];
      return { ...s, pendingOps: next };
    };

    // Conflict re-prompt loop. Initial dispatch carries
    // `conflictPolicy: "fail"`. On `tag: "conflict"`, invoke the
    // registered `RenameConflictPrompt` with `existingPath`; the
    // user's choice (`"overwrite" | "keep-both"`) drives a
    // re-dispatch with the matching policy; `"cancel"` exits cleanly.
    // When no prompt is registered, fall through to the legacy
    // surface-error path (preserves test fixtures that don't mock the
    // prompt).
    let policy: RenameConflictPolicy = "fail";
    try {
      if (api === undefined) {
        throw new Error("window.api.files.rename is unavailable");
      }
      // Bound the loop defensively so a rogue prompt that never
      // returns `"cancel"` and a backend that never resolves can't
      // spin forever. 5 attempts is comfortably more than any user
      // would step through a conflict re-prompt manually.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await api({
          datasourceId,
          path: entry.path,
          newName,
          conflictPolicy: policy,
        });
        if (response.ok) {
          const nextEntries = state.entries.map((e) =>
            e.id === entryId ? response.value.entry : e,
          );
          set(
            clearPending({
              ...state,
              entries: nextEntries,
              lastError: null,
            }),
            false,
          );
          return;
        }
        // Conflict + prompt registered → re-prompt and re-dispatch.
        if (
          response.error.tag === FilesErrorTag.Conflict &&
          renameConflictPrompt !== null
        ) {
          const choice = await renameConflictPrompt(
            response.error.existingPath ?? entry.path,
          );
          if (choice === "cancel") {
            // User aborted the rename. Clear pendingOp; leave the
            // entry as-is. No `lastError` — cancel is a soft outcome,
            // not a failure to surface.
            set(clearPending(state), false);
            return;
          }
          policy = choice;
          // Refresh pendingOp.startedAt so the optimistic UI reflects
          // the retry (per add-engine-rename-download §25.1).
          set(
            {
              ...state,
              pendingOps: {
                ...state.pendingOps,
                [entryId]: {
                  kind: "rename",
                  startedAt: Date.now(),
                  newName,
                },
              },
            },
            false,
          );
          continue;
        }
        // Non-conflict (or no prompt) → surface as before.
        throw new Error(response.error.message);
      }
      // Loop bound exhausted — surface as a generic failure.
      throw new Error("rename retry limit exceeded");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      set(
        clearPending({
          ...state,
          lastError: { entryId, reason },
        }),
        false,
      );
      toast.error(reason);
    }
  }

  // --- Remove (delete) --------------------------------------------------

  async function remove(targets: FilesRemoveTarget[]): Promise<void> {
    if (targets.length === 0) return;

    const total = targets.length;
    // Seed one pendingOp per target, keyed by handle (entry id). Keying
    // by path would collapse two duplicates at the same path into a
    // single pendingOp — the same bug that motivated handle-based
    // addressing in the first place.
    const now = Date.now();
    const nextOps: Record<string, PendingOp> = { ...state.pendingOps };
    for (const t of targets) nextOps[t.handle] = { kind: "remove", startedAt: now };
    set({ ...state, pendingOps: nextOps, lastError: null }, false);

    try {
      const api = (globalThis as unknown as {
        window?: {
          api?: {
            files?: {
              remove?: (req: {
                datasourceId: string;
                targets: FilesRemoveTarget[];
              }) => Promise<FilesRemoveResponse>;
            };
          };
        };
      }).window?.api?.files?.remove;
      if (api === undefined) {
        throw new Error("window.api.files.remove is unavailable");
      }
      const response = await api({ datasourceId, targets });

      const clearedOps: Record<string, PendingOp> = { ...state.pendingOps };
      for (const t of targets) delete clearedOps[t.handle];

      if (!response.ok) {
        // Whole-operation failure: nothing removed; revert all pending and
        // surface the envelope error to the user.
        const firstHandle = targets[0]?.handle;
        const entryId = firstHandle ?? "";
        set(
          {
            ...state,
            pendingOps: clearedOps,
            lastError: { entryId, reason: response.error.message },
          },
          false,
        );
        toast.error(response.error.message);
        return;
      }

      const removedHandles: string[] = [];
      const failedResults: { handle: string; message: string }[] = [];
      for (const result of response.value.results) {
        if (result.ok) {
          removedHandles.push(result.handle);
        } else {
          failedResults.push({
            handle: result.handle,
            message: result.error.message,
          });
        }
      }

      // Correlate by handle (entry id) so two rows with the same path but
      // distinct handles don't both disappear when only one was deleted.
      const removedSet = new Set(removedHandles);
      const nextEntries = state.entries.filter((e) => !removedSet.has(e.id));
      const removedCount = removedHandles.length;
      const failedCount = failedResults.length;

      if (failedCount === 0) {
        const noun = removedCount === 1 ? "item" : "items";
        set(
          {
            ...state,
            entries: nextEntries,
            pendingOps: clearedOps,
            lastError: null,
          },
          false,
        );
        toast.success(`Deleted ${removedCount} ${noun}`);
        return;
      }

      // Partial failure — pin lastError on the first failure (matches
      // rename's per-entry lastError model; the toast summarises the rest).
      const first = failedResults[0];
      const lastError: ExplorerLastError | null =
        first !== undefined
          ? { entryId: first.handle, reason: first.message }
          : null;

      set(
        {
          ...state,
          entries: nextEntries,
          pendingOps: clearedOps,
          lastError,
        },
        false,
      );
      toast.success(
        `Deleted ${removedCount} of ${total} items; ${failedCount} failed`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const clearedOps: Record<string, PendingOp> = { ...state.pendingOps };
      for (const t of targets) delete clearedOps[t.handle];
      const firstHandle = targets[0]?.handle;
      const entryId = firstHandle ?? "";
      set(
        {
          ...state,
          pendingOps: clearedOps,
          lastError: { entryId, reason },
        },
        false,
      );
      toast.error(reason);
    }
  }

  // --- Download ---------------------------------------------------------

  async function download(entryId: string): Promise<void> {
    const entry = state.entries.find((e) => e.id === entryId);
    if (entry === undefined) return;
    // Silent no-op on directories: the context menu disables it for folders
    // and the spec does not define a folder-download flow in v1.
    if (entry.kind === "directory") return;

    try {
      const api = (globalThis as unknown as {
        window?: {
          api?: {
            files?: {
              download?: (req: {
                datasourceId: string;
                path: string;
              }) => Promise<FilesDownloadResponse>;
            };
          };
        };
      }).window?.api?.files?.download;
      if (api === undefined) {
        throw new Error("window.api.files.download is unavailable");
      }
      const response = await api({ datasourceId, path: entry.path });
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      toast.success(`Downloaded to ${response.value.savedPath}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      set({ ...state, lastError: { entryId, reason } }, false);
      toast.error(reason);
    }
  }

  return {
    subscribe,
    getSnapshot,
    datasourceId,
    navigate,
    back,
    forward,
    up,
    select,
    selectAll,
    clearSelection,
    setViewMode,
    setSort,
    startSearch,
    setSearchQuery,
    setSearchResults,
    clearSearch,
    setEntries,
    setLoading,
    setError,
    setErrorTag,
    retryLoad,
    applyInitialPage,
    loadMore,
    retryLoadMore,
    toggleDetailsPane,
    startPendingOp,
    clearPendingOp,
    setLastError,
    openProperties,
    closeProperties,
    startEdit,
    cancelEdit,
    rename,
    setRenameConflictPrompt,
    setDownloadConflictPrompt,
    getDownloadConflictPrompt,
    remove,
    download,
  };
}

// ---------------------------------------------------------------------------
// React hook
//
// Module-level cache keyed by datasourceId. Per design.md Decision 5 we ship
// one explorer at a time in v1; the cache is a plain `Map` that never evicts.
// A future multi-explorer phase can swap this for an explicit registry with
// reference-counting and disposal.
// ---------------------------------------------------------------------------

const storeCache = new Map<string, ExplorerStore>();

export function getOrCreateExplorerStore(datasourceId: string): ExplorerStore {
  const existing = storeCache.get(datasourceId);
  if (existing) return existing;
  const created = createExplorerStore(datasourceId);
  storeCache.set(datasourceId, created);
  return created;
}

export interface UseExplorerStoreResult {
  state: ExplorerState;
  store: ExplorerStore;
}

export function useExplorerStore(datasourceId: string): UseExplorerStoreResult {
  const store = getOrCreateExplorerStore(datasourceId);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return { state, store };
}

// Test-only helper: clear the module-level cache. Not exposed in the public
// API surface; tests can reach it via the named export to get a clean slate
// between cases.
export function __resetExplorerStoreCacheForTests(): void {
  storeCache.clear();
}
