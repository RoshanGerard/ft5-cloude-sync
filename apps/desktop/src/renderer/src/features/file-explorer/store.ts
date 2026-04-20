"use client";

import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import type {
  FileEntry,
  FilesRemoveResponse,
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

  // Remove (delete) — accepts one or more paths; issues a single IPC call.
  remove(paths: string[]): Promise<void>;
}

export const DIRECTORY_RENAME_REFUSAL =
  "Folder rename is not supported in this version";
export const EMPTY_NAME_REFUSAL = "Name cannot be empty";

export const EXPLORER_STORAGE_KEY_PREFIX = "ft5.file-explorer.";

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

  let state: ExplorerState = {
    currentPath: "/",
    history: { stack: ["/"], index: 0 },
    entries: [],
    loading: false,
    error: null,
    selection: new Set<string>(),
    lastSelectedId: null,
    sortBy: prefs.sortBy,
    sortDir: prefs.sortDir,
    viewMode: prefs.viewMode,
    search: { query: "", active: false, results: null },
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
    set(
      {
        ...state,
        currentPath: path,
        history: { stack: nextStack, index: nextStack.length - 1 },
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
    if (state.search.active) return;
    set({ ...state, search: { ...state.search, active: true } }, false);
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
    set(
      {
        ...state,
        search: { query: "", active: false, results: null },
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
      set(clearEditing(state), false);
      return;
    }

    const op: PendingOp = { kind: "rename", startedAt: Date.now(), newName };
    set(
      clearEditing({
        ...state,
        pendingOps: { ...state.pendingOps, [entryId]: op },
        lastError: null,
      }),
      false,
    );

    try {
      const api = (globalThis as unknown as {
        window?: {
          api?: {
            files?: {
              rename?: (req: {
                datasourceId: string;
                path: string;
                newName: string;
              }) => Promise<FilesRenameResponse>;
            };
          };
        };
      }).window?.api?.files?.rename;
      if (api === undefined) {
        throw new Error("window.api.files.rename is unavailable");
      }
      const response = await api({
        datasourceId,
        path: entry.path,
        newName,
      });
      const nextPending: Record<string, PendingOp> = { ...state.pendingOps };
      delete nextPending[entryId];
      const nextEntries = state.entries.map((e) =>
        e.id === entryId ? response.entry : e,
      );
      set(
        {
          ...state,
          entries: nextEntries,
          pendingOps: nextPending,
          lastError: null,
        },
        false,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const nextPending: Record<string, PendingOp> = { ...state.pendingOps };
      delete nextPending[entryId];
      set(
        {
          ...state,
          pendingOps: nextPending,
          lastError: { entryId, reason },
        },
        false,
      );
      toast.error(reason);
    }
  }

  // --- Remove (delete) --------------------------------------------------

  async function remove(paths: string[]): Promise<void> {
    if (paths.length === 0) return;

    const total = paths.length;
    // Seed one pendingOp per path (keyed by path — matches the IPC
    // contract's `paths` payload and the handler's `failed[].path` field).
    const now = Date.now();
    const nextOps: Record<string, PendingOp> = { ...state.pendingOps };
    for (const p of paths) nextOps[p] = { kind: "remove", startedAt: now };
    set({ ...state, pendingOps: nextOps, lastError: null }, false);

    try {
      const api = (globalThis as unknown as {
        window?: {
          api?: {
            files?: {
              remove?: (req: {
                datasourceId: string;
                paths: string[];
              }) => Promise<FilesRemoveResponse>;
            };
          };
        };
      }).window?.api?.files?.remove;
      if (api === undefined) {
        throw new Error("window.api.files.remove is unavailable");
      }
      const response = await api({ datasourceId, paths });

      const removedSet = new Set(response.removed);
      const clearedOps: Record<string, PendingOp> = { ...state.pendingOps };
      for (const p of paths) delete clearedOps[p];

      const nextEntries = state.entries.filter((e) => !removedSet.has(e.path));

      const failedCount = response.failed.length;
      const removedCount = response.removed.length;

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
      const first = response.failed[0];
      const pathToEntryId = new Map(
        state.entries.map((e) => [e.path, e.id] as const),
      );
      const lastError: ExplorerLastError | null =
        first !== undefined
          ? {
              entryId: pathToEntryId.get(first.path) ?? first.path,
              reason: first.reason,
            }
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
      for (const p of paths) delete clearedOps[p];
      const pathToEntryId = new Map(
        state.entries.map((e) => [e.path, e.id] as const),
      );
      const firstPath = paths[0];
      const entryId =
        firstPath !== undefined
          ? (pathToEntryId.get(firstPath) ?? firstPath)
          : firstPath ?? "";
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

  return {
    subscribe,
    getSnapshot,
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
    toggleDetailsPane,
    startPendingOp,
    clearPendingOp,
    setLastError,
    openProperties,
    closeProperties,
    startEdit,
    cancelEdit,
    rename,
    remove,
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
