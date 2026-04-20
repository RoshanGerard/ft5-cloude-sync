/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createElement, useSyncExternalStore } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

// Sonner is mocked so rename's toast.error call is observable.
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { toast } from "sonner";

import {
  EXPLORER_STORAGE_KEY_PREFIX,
  createExplorerStore,
  useExplorerStore,
} from "../store.js";
import type {
  ExplorerState,
  ExplorerStore,
  SortBy,
  ViewMode,
} from "../store.js";

// --- Test helpers ---------------------------------------------------------

function storageKey(datasourceId: string): string {
  return `${EXPLORER_STORAGE_KEY_PREFIX}${datasourceId}.prefs`;
}

function makeEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: "entry-1",
    kind: "file",
    name: "file.txt",
    path: "/file.txt",
    parentPath: "/",
    size: 123,
    mimeFamily: "text",
    mimeType: "text/plain",
    modifiedAt: "2026-04-01T00:00:00.000Z",
    createdAt: null,
    providerMetadata: {},
    ...overrides,
  };
}

function seed(ids: string[]): FileEntry[] {
  return ids.map((id, i) =>
    makeEntry({
      id,
      name: `${id}.txt`,
      path: `/${id}.txt`,
      modifiedAt: `2026-04-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    }),
  );
}

function readStoredPrefs(datasourceId: string): Record<string, unknown> | null {
  const raw = window.localStorage.getItem(storageKey(datasourceId));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeStoredPrefs(
  datasourceId: string,
  prefs: Partial<{
    viewMode: ViewMode;
    sortBy: SortBy;
    sortDir: "asc" | "desc";
    detailsPaneOpen: boolean;
  }>,
): void {
  window.localStorage.setItem(storageKey(datasourceId), JSON.stringify(prefs));
}

function makeStore(datasourceId = "ds-1"): ExplorerStore {
  return createExplorerStore(datasourceId);
}

function snap(store: ExplorerStore): ExplorerState {
  return store.getSnapshot();
}

// --- Tests ----------------------------------------------------------------

describe("createExplorerStore — initial state", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("returns the documented Decision-5 defaults when nothing is persisted", () => {
    const store = makeStore("ds-1");
    const s = snap(store);

    expect(s.currentPath).toBe("/");
    expect(s.history).toEqual({ stack: ["/"], index: 0 });
    expect(s.entries).toEqual([]);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();

    expect(s.selection).toBeInstanceOf(Set);
    expect(s.selection.size).toBe(0);

    expect(s.sortBy).toBe("name");
    expect(s.sortDir).toBe("asc");

    expect(s.viewMode).toBe("details");

    expect(s.search).toEqual({ query: "", active: false, results: null });

    expect(s.detailsPaneOpen).toBe(false);

    expect(s.pendingOps).toEqual({});
    expect(s.lastError).toBeNull();
  });

  it("exports a storage key prefix of the expected shape", () => {
    expect(EXPLORER_STORAGE_KEY_PREFIX).toBe("ft5.file-explorer.");
  });
});

describe("createExplorerStore — persistence load", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("hydrates viewMode / sortBy / sortDir / detailsPaneOpen from localStorage", () => {
    writeStoredPrefs("ds-1", {
      viewMode: "tiles",
      sortBy: "size",
      sortDir: "desc",
      detailsPaneOpen: true,
    });

    const store = makeStore("ds-1");
    const s = snap(store);
    expect(s.viewMode).toBe("tiles");
    expect(s.sortBy).toBe("size");
    expect(s.sortDir).toBe("desc");
    expect(s.detailsPaneOpen).toBe(true);
  });

  it("falls back to defaults on malformed storage JSON", () => {
    window.localStorage.setItem(storageKey("ds-1"), "not-valid-json{{");

    const store = makeStore("ds-1");
    const s = snap(store);
    expect(s.viewMode).toBe("details");
    expect(s.sortBy).toBe("name");
    expect(s.sortDir).toBe("asc");
    expect(s.detailsPaneOpen).toBe(false);
  });

  it("ignores non-whitelisted keys in stored prefs", () => {
    writeStoredPrefs("ds-1", { viewMode: "list" });
    // Inject a dangerous extra entry — it must not leak into state.
    window.localStorage.setItem(
      storageKey("ds-1"),
      JSON.stringify({ viewMode: "list", selection: ["x"], entries: ["x"] }),
    );
    const s = snap(makeStore("ds-1"));
    expect(s.viewMode).toBe("list");
    expect(s.selection.size).toBe(0);
    expect(s.entries).toEqual([]);
  });

  it("isolates persistence per datasource id", () => {
    writeStoredPrefs("ds-1", { viewMode: "tiles" });
    writeStoredPrefs("ds-2", { viewMode: "large" });

    const s1 = snap(makeStore("ds-1"));
    const s2 = snap(makeStore("ds-2"));
    expect(s1.viewMode).toBe("tiles");
    expect(s2.viewMode).toBe("large");
  });
});

describe("createExplorerStore — persistence save", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("persists viewMode on setViewMode", () => {
    const store = makeStore("ds-1");
    store.setViewMode("large");
    expect(readStoredPrefs("ds-1")).toMatchObject({ viewMode: "large" });
  });

  it("persists sortBy and sortDir on setSort", () => {
    const store = makeStore("ds-1");
    store.setSort("size");
    expect(readStoredPrefs("ds-1")).toMatchObject({ sortBy: "size", sortDir: "asc" });
    store.setSort("size"); // toggles dir
    expect(readStoredPrefs("ds-1")).toMatchObject({ sortBy: "size", sortDir: "desc" });
  });

  it("persists detailsPaneOpen on toggleDetailsPane", () => {
    const store = makeStore("ds-1");
    store.toggleDetailsPane();
    expect(readStoredPrefs("ds-1")).toMatchObject({ detailsPaneOpen: true });
    store.toggleDetailsPane();
    expect(readStoredPrefs("ds-1")).toMatchObject({ detailsPaneOpen: false });
  });

  it("does NOT persist selection / entries / history / pendingOps / search", () => {
    const store = makeStore("ds-1");
    store.setEntries(seed(["a", "b"]));
    store.select("a", "replace");
    store.navigate("/projects");
    store.startPendingOp("a", "remove");
    store.setSearchQuery("hello");

    const prefs = readStoredPrefs("ds-1");
    // After any persisted mutation, prefs will be written; otherwise null is fine.
    // We care that the non-persisted keys aren't leaking in.
    if (prefs !== null) {
      expect(prefs).not.toHaveProperty("selection");
      expect(prefs).not.toHaveProperty("entries");
      expect(prefs).not.toHaveProperty("history");
      expect(prefs).not.toHaveProperty("pendingOps");
      expect(prefs).not.toHaveProperty("search");
      expect(prefs).not.toHaveProperty("currentPath");
    }
  });

  it("written payload contains only viewMode, sortBy, sortDir, detailsPaneOpen", () => {
    const store = makeStore("ds-1");
    store.setViewMode("medium");
    store.setSort("modified");
    store.toggleDetailsPane();

    const prefs = readStoredPrefs("ds-1");
    expect(prefs).not.toBeNull();
    const keys = Object.keys(prefs ?? {}).sort();
    expect(keys).toEqual(["detailsPaneOpen", "sortBy", "sortDir", "viewMode"]);
  });
});

describe("navigate / back / forward / up — history semantics", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("navigate pushes a new history entry and updates currentPath", () => {
    const store = makeStore("ds-1");
    store.navigate("/projects");
    const s = snap(store);
    expect(s.currentPath).toBe("/projects");
    expect(s.history).toEqual({ stack: ["/", "/projects"], index: 1 });
  });

  it("navigate to current path is a no-op", () => {
    const store = makeStore("ds-1");
    store.navigate("/projects");
    const before = snap(store).history;
    store.navigate("/projects");
    expect(snap(store).history).toEqual(before);
  });

  it("navigate after back truncates the forward branch", () => {
    const store = makeStore("ds-1");
    store.navigate("/a");
    store.navigate("/b");
    store.navigate("/c"); // stack ["/","/a","/b","/c"], index 3
    store.back(); // index 2
    store.back(); // index 1
    store.navigate("/d"); // should truncate /b,/c and push /d

    const s = snap(store);
    expect(s.history.stack).toEqual(["/", "/a", "/d"]);
    expect(s.history.index).toBe(2);
    expect(s.currentPath).toBe("/d");
  });

  it("back() decrements index and updates currentPath; bottom is a no-op", () => {
    const store = makeStore("ds-1");
    store.navigate("/a");
    store.navigate("/b"); // index 2
    store.back();
    expect(snap(store).currentPath).toBe("/a");
    store.back();
    expect(snap(store).currentPath).toBe("/");
    // At index 0 — further back is no-op.
    const before = snap(store).history;
    store.back();
    expect(snap(store).history).toEqual(before);
    expect(snap(store).history.index).toBe(0);
  });

  it("forward() increments index; at top is a no-op", () => {
    const store = makeStore("ds-1");
    store.navigate("/a");
    store.navigate("/b"); // index 2
    store.back(); // index 1
    store.forward(); // index 2
    expect(snap(store).currentPath).toBe("/b");
    const before = snap(store).history;
    store.forward();
    expect(snap(store).history).toEqual(before);
  });

  it("up() computes the parent path and navigates there (pushing history)", () => {
    const store = makeStore("ds-1");
    store.navigate("/projects/docs");
    store.up();
    expect(snap(store).currentPath).toBe("/projects");
    // history grew as if we clicked to /projects
    expect(snap(store).history.stack).toEqual(["/", "/projects/docs", "/projects"]);

    store.up();
    expect(snap(store).currentPath).toBe("/");

    // At root — up is a no-op
    const before = snap(store).history;
    store.up();
    expect(snap(store).history).toEqual(before);
    expect(snap(store).currentPath).toBe("/");
  });
});

describe("selection — select / selectAll / clearSelection", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  function storeWithEntries(): ExplorerStore {
    const store = makeStore("ds-1");
    store.setEntries(seed(["a", "b", "c", "d", "e", "f"]));
    return store;
  }

  it("'replace' sets selection to exactly { id }", () => {
    const store = storeWithEntries();
    store.select("c", "replace");
    expect([...snap(store).selection]).toEqual(["c"]);
    store.select("e", "replace");
    expect([...snap(store).selection]).toEqual(["e"]);
  });

  it("'toggle' flips presence of id", () => {
    const store = storeWithEntries();
    store.select("b", "toggle");
    expect(snap(store).selection.has("b")).toBe(true);
    store.select("d", "toggle");
    expect(snap(store).selection.has("d")).toBe(true);
    expect(snap(store).selection.size).toBe(2);
    store.select("b", "toggle");
    expect(snap(store).selection.has("b")).toBe(false);
    expect(snap(store).selection.size).toBe(1);
  });

  it("'range' selects anchor→target inclusive over the visible order", () => {
    const store = storeWithEntries();
    store.select("b", "replace"); // anchor = b
    store.select("e", "range"); // expands b..e inclusive
    const sel = [...snap(store).selection].sort();
    expect(sel).toEqual(["b", "c", "d", "e"]);
  });

  it("'range' works backward as well (anchor after target)", () => {
    const store = storeWithEntries();
    store.select("e", "replace"); // anchor = e
    store.select("b", "range"); // b..e inclusive, reversed
    const sel = [...snap(store).selection].sort();
    expect(sel).toEqual(["b", "c", "d", "e"]);
  });

  it("'range' without a prior anchor behaves like replace (single id)", () => {
    const store = storeWithEntries();
    store.select("c", "range");
    expect([...snap(store).selection]).toEqual(["c"]);
  });

  it("'range' keeps the anchor stable across repeated shift-clicks (Windows Explorer semantics)", () => {
    // User clicks "a" (plain) → anchor=a.
    // Shift-clicks "c" → range a..c, anchor still a.
    // Still holding shift, clicks "e" → range a..e (NOT c..e).
    // Regression: earlier implementation updated lastSelectedId on every
    // range-mode call, walking the anchor along each endpoint and giving
    // the wrong range on the second shift-click.
    const store = storeWithEntries();
    store.select("a", "replace");
    store.select("c", "range");
    expect([...snap(store).selection]).toEqual(["a", "b", "c"]);

    store.select("e", "range");
    expect([...snap(store).selection]).toEqual(["a", "b", "c", "d", "e"]);

    // A subsequent shrink back to "b" still uses the anchor at "a".
    store.select("b", "range");
    expect([...snap(store).selection]).toEqual(["a", "b"]);
  });

  it("'range' anchor DOES move on plain click between shift-clicks", () => {
    // The sticky-anchor rule is about REPEATED shift-clicks. A plain
    // click in between MUST reset the anchor so the user can start a
    // fresh range.
    const store = storeWithEntries();
    store.select("a", "replace");
    store.select("e", "range"); // a..e, anchor=a
    expect([...snap(store).selection]).toEqual(["a", "b", "c", "d", "e"]);

    store.select("c", "replace"); // plain click → anchor=c, selection={c}
    expect([...snap(store).selection]).toEqual(["c"]);

    store.select("e", "range"); // c..e, not a..e
    expect([...snap(store).selection]).toEqual(["c", "d", "e"]);
  });

  it("'clear-add' clears prior selection and adds the id", () => {
    const store = storeWithEntries();
    store.select("a", "toggle");
    store.select("b", "toggle");
    expect(snap(store).selection.size).toBe(2);
    store.select("f", "clear-add");
    expect([...snap(store).selection]).toEqual(["f"]);
  });

  it("selectAll selects every currently-visible entry's id", () => {
    const store = storeWithEntries();
    store.selectAll();
    expect([...snap(store).selection].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("clearSelection empties selection", () => {
    const store = storeWithEntries();
    store.select("a", "replace");
    store.select("c", "toggle");
    store.clearSelection();
    expect(snap(store).selection.size).toBe(0);
  });

  it("clearSelection resets the anchor so subsequent 'range' does not use an old one", () => {
    const store = storeWithEntries();
    store.select("a", "replace"); // anchor = a
    store.clearSelection();
    store.select("c", "range"); // no anchor -> single id
    expect([...snap(store).selection]).toEqual(["c"]);
  });
});

describe("setViewMode / setSort", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("setViewMode updates state", () => {
    const store = makeStore("ds-1");
    const modes: ViewMode[] = ["list", "details", "small", "tiles", "medium", "large"];
    for (const m of modes) {
      store.setViewMode(m);
      expect(snap(store).viewMode).toBe(m);
    }
  });

  it("setSort with a new field defaults to asc; same field toggles dir", () => {
    const store = makeStore("ds-1");
    // Default is name/asc
    store.setSort("size");
    expect(snap(store).sortBy).toBe("size");
    expect(snap(store).sortDir).toBe("asc");
    store.setSort("size");
    expect(snap(store).sortDir).toBe("desc");
    store.setSort("size");
    expect(snap(store).sortDir).toBe("asc");
    store.setSort("modified");
    expect(snap(store).sortBy).toBe("modified");
    expect(snap(store).sortDir).toBe("asc");
  });
});

describe("search actions", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("startSearch activates search without touching query/results", () => {
    const store = makeStore("ds-1");
    store.setSearchQuery("stale");
    store.startSearch();
    const s = snap(store);
    expect(s.search.active).toBe(true);
    expect(s.search.query).toBe("stale");
  });

  it("setSearchQuery updates query", () => {
    const store = makeStore("ds-1");
    store.setSearchQuery("hello world");
    expect(snap(store).search.query).toBe("hello world");
  });

  it("setSearchResults sets entries + truncated + providerSearchDeferred", () => {
    const store = makeStore("ds-1");
    const hits = seed(["x", "y"]);
    store.setSearchResults(hits, true, true);
    const s = snap(store);
    expect(s.search.results).toEqual(hits);
    expect(s.search.truncated).toBe(true);
    expect(s.search.providerSearchDeferred).toBe(true);
  });

  it("setSearchResults without providerSearchDeferred leaves the flag absent/false", () => {
    const store = makeStore("ds-1");
    store.setSearchResults(seed(["x"]), false);
    const s = snap(store);
    expect(s.search.truncated).toBe(false);
    expect(s.search.providerSearchDeferred).toBeFalsy();
  });

  it("clearSearch resets active/query/results; not persisted", () => {
    const store = makeStore("ds-1");
    store.setSearchQuery("q");
    store.startSearch();
    store.setSearchResults(seed(["x"]), false);
    store.clearSearch();
    const s = snap(store);
    expect(s.search).toEqual({ query: "", active: false, results: null });
    expect(readStoredPrefs("ds-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 7.9 — Pre-search state snapshot + restore
//
// Spec (file-explorer/spec.md, "Clearing the search restores the current
// folder view"):
//   WHEN the user clears the search input or dismisses the search UI
//   THEN the main pane reverts to showing the current folder's entries
//   from before the search was initiated; selection that was in place
//   before the search is restored; focus returns to the search-toggle
//   control or the previously-focused entry.
//
// Locked Phase 7 Decision D:
//   startSearch() snapshots { selection, focusedId } into a new store
//   field `preSearchState`. clearSearch() restores them.
//
// Architectural refinement: focusedId lives in the useKeyboardNav hook,
// NOT the store (see use-keyboard-nav.ts:38–42). So at the STORE level
// we only snapshot + restore `selection`. Focus restoration is a
// composite-level concern, covered separately in search-ui.test.tsx.
//
// Shape: `state.search.preSearchSelection: string[] | null`
//   - `null` at initial state and after clearSearch (consumed).
//   - An array (structured-clone-safe; easier to assert equality on)
//     captured by the first startSearch call while search is inactive.
//   - startSearch is idempotent: a second startSearch while search is
//     already active MUST NOT overwrite the snapshot.
//   - navigate() while search is active clears search state AND drops
//     the snapshot without restoring — the user moved on, their
//     pre-search selection was for a different folder.
//
// These tests fail today because the field does not yet exist on the
// search-state shape and the snapshot/restore behaviour is not wired.
// Implementation lands in task 7.10.
// ---------------------------------------------------------------------------

describe("search: pre-search state snapshot + restore (7.9)", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("initial store: search.preSearchSelection === null", () => {
    const store = makeStore("ds-1");
    // @ts-expect-error — `preSearchSelection` field is added by task 7.10
    // on `ExplorerSearchState`. Until then the field is absent from the
    // type; the runtime read must still return `null` by the contract
    // above.
    expect(snap(store).search.preSearchSelection).toBeNull();
  });

  it("startSearch snapshots the current selection into search.preSearchSelection", () => {
    const store = makeStore("ds-1");
    store.setEntries(seed(["a", "b", "c"]));
    store.select("a", "replace");
    store.select("b", "toggle");
    // Pre-condition sanity check: selection is {a, b}.
    expect([...snap(store).selection].sort()).toEqual(["a", "b"]);

    store.startSearch();

    const s = snap(store);
    expect(s.search.active).toBe(true);
    // Snapshot is captured as a string[] (structured-clone-safe). Order
    // is not part of the contract — compare as sorted arrays.
    // @ts-expect-error — field added by 7.10; see describe header.
    const snapshot: string[] | null = s.search.preSearchSelection;
    expect(snapshot).not.toBeNull();
    expect([...(snapshot ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("clearSearch restores the snapshotted selection and consumes the snapshot", () => {
    const store = makeStore("ds-1");
    store.setEntries(seed(["a", "b", "c"]));
    store.select("a", "replace");
    store.select("b", "toggle");
    store.startSearch();

    // Simulate the user selecting a different entry while search is
    // active (e.g. clicking a result row). The pre-search snapshot must
    // survive this — restore is against the *pre-search* state.
    store.clearSelection();
    store.select("c", "replace");
    expect([...snap(store).selection]).toEqual(["c"]);

    store.clearSearch();

    const s = snap(store);
    // Selection restored to {a, b}.
    expect([...s.selection].sort()).toEqual(["a", "b"]);
    // Snapshot consumed.
    // @ts-expect-error — field added by 7.10.
    expect(s.search.preSearchSelection).toBeNull();
    // And the rest of clearSearch's existing contract still holds.
    expect(s.search.active).toBe(false);
    expect(s.search.query).toBe("");
    expect(s.search.results).toBeNull();
  });

  it("clearSearch with no snapshot (e.g. search never started) leaves selection alone", () => {
    // Defensive: clearSearch called from an already-clean state must not
    // blow away the current selection just because the snapshot is null.
    const store = makeStore("ds-1");
    store.setEntries(seed(["a", "b"]));
    store.select("a", "replace");

    store.clearSearch();

    expect([...snap(store).selection]).toEqual(["a"]);
  });

  it("navigate while search is active clears search AND drops the snapshot without restoring", () => {
    const store = makeStore("ds-1");
    store.setEntries(seed(["a", "b"]));
    store.select("a", "replace");
    store.startSearch();

    // User clicked a search result → store.navigate fires. The pre-search
    // selection was for the *old* folder; the new folder should start
    // fresh, not with the stale ids.
    store.navigate("/some/other/path");

    const s = snap(store);
    expect(s.currentPath).toBe("/some/other/path");
    expect(s.search.active).toBe(false);
    expect(s.search.results).toBeNull();
    expect(s.search.query).toBe("");
    // Snapshot dropped — the user has actively moved on.
    // @ts-expect-error — field added by 7.10.
    expect(s.search.preSearchSelection).toBeNull();
    // Selection must NOT be the restored {a}: the pre-search snapshot
    // was for the old folder and belongs to nobody now. Here we accept
    // any post-navigation selection except the stale restore.
    expect([...s.selection]).not.toEqual(["a"]);
  });

  it("startSearch is idempotent: a second call while active does not clobber the snapshot", () => {
    const store = makeStore("ds-1");
    store.setEntries(seed(["a", "b", "c"]));
    store.select("a", "replace");
    store.startSearch();

    // While search is active the user selects a result — selection
    // becomes {b}. The important invariant: if the search UI calls
    // startSearch() a second time (e.g. remount, re-entry) it MUST NOT
    // re-snapshot the current {b} over the original {a}.
    store.clearSelection();
    store.select("b", "replace");
    store.startSearch();
    store.clearSearch();

    // First snapshot restored, NOT the mid-search {b}.
    expect([...snap(store).selection]).toEqual(["a"]);
  });
});

describe("entries / loading / error setters", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("setEntries replaces entries", () => {
    const store = makeStore("ds-1");
    const entries = seed(["a", "b"]);
    store.setEntries(entries);
    expect(snap(store).entries).toEqual(entries);
  });

  it("setLoading sets loading flag", () => {
    const store = makeStore("ds-1");
    store.setLoading(true);
    expect(snap(store).loading).toBe(true);
    store.setLoading(false);
    expect(snap(store).loading).toBe(false);
  });

  it("setError sets error; null clears it", () => {
    const store = makeStore("ds-1");
    store.setError("boom");
    expect(snap(store).error).toBe("boom");
    store.setError(null);
    expect(snap(store).error).toBeNull();
  });
});

describe("toggleDetailsPane", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("flips detailsPaneOpen and persists", () => {
    const store = makeStore("ds-1");
    expect(snap(store).detailsPaneOpen).toBe(false);
    store.toggleDetailsPane();
    expect(snap(store).detailsPaneOpen).toBe(true);
    store.toggleDetailsPane();
    expect(snap(store).detailsPaneOpen).toBe(false);
  });
});

describe("pendingOps lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("startPendingOp inserts an entry with kind + startedAt", () => {
    const store = makeStore("ds-1");
    const before = Date.now();
    store.startPendingOp("a", "rename");
    const after = Date.now();
    const op = snap(store).pendingOps["a"];
    expect(op).toBeDefined();
    expect(op?.kind).toBe("rename");
    expect(op?.startedAt).toBeGreaterThanOrEqual(before);
    expect(op?.startedAt).toBeLessThanOrEqual(after);
  });

  it("clearPendingOp removes the entry", () => {
    const store = makeStore("ds-1");
    store.startPendingOp("a", "remove");
    store.clearPendingOp("a");
    expect(snap(store).pendingOps["a"]).toBeUndefined();
  });

  it("setLastError records entryId + reason; null clears", () => {
    const store = makeStore("ds-1");
    store.setLastError("a", "locked");
    expect(snap(store).lastError).toEqual({ entryId: "a", reason: "locked" });
    store.setLastError(null, null);
    expect(snap(store).lastError).toBeNull();
  });
});

describe("subscribe / getSnapshot contract", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("subscribe returns an unsubscribe; listener fires on each mutation", () => {
    const store = makeStore("ds-1");
    let count = 0;
    const unsub = store.subscribe(() => {
      count += 1;
    });

    store.setViewMode("tiles"); // +1
    store.navigate("/x"); // +1
    store.select("x", "replace"); // +1

    expect(count).toBeGreaterThanOrEqual(3);

    unsub();
    const countAtUnsub = count;
    store.setViewMode("large");
    expect(count).toBe(countAtUnsub);
  });

  it("getSnapshot returns a stable reference when nothing changes", () => {
    const store = makeStore("ds-1");
    const s1 = store.getSnapshot();
    const s2 = store.getSnapshot();
    expect(s1).toBe(s2);
  });

  it("getSnapshot returns a new reference after a mutation", () => {
    const store = makeStore("ds-1");
    const s1 = store.getSnapshot();
    store.setViewMode("tiles");
    const s2 = store.getSnapshot();
    expect(s1).not.toBe(s2);
  });
});

// --- Rename action -------------------------------------------------------

type FilesRenameStub = ReturnType<typeof vi.fn>;
type FilesRemoveStub = ReturnType<typeof vi.fn>;

function installFilesApi(renameImpl: FilesRenameStub): void {
  (window as unknown as { api: unknown }).api = {
    files: { rename: renameImpl },
  };
}

function installFilesRemoveApi(removeImpl: FilesRemoveStub): void {
  (window as unknown as { api: unknown }).api = {
    files: { remove: removeImpl },
  };
}

type FilesDownloadStub = ReturnType<typeof vi.fn>;

function installFilesDownloadApi(downloadImpl: FilesDownloadStub): void {
  (window as unknown as { api: unknown }).api = {
    files: { download: downloadImpl },
  };
}

function clearFilesApi(): void {
  delete (window as unknown as { api?: unknown }).api;
}

describe("rename action", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("happy path: inserts a pendingOp, awaits IPC, replaces the entry, clears pendingOp", async () => {
    const entry = makeEntry({ id: "e1", name: "old.txt", path: "/old.txt" });
    const renamed: FileEntry = { ...entry, name: "new.txt", path: "/new.txt" };
    // Deferred resolution so we can observe the pendingOp mid-flight.
    let resolveRename: (value: { entry: FileEntry }) => void = () => {};
    const renameFn = vi.fn(
      () =>
        new Promise<{ entry: FileEntry }>((res) => {
          resolveRename = res;
        }),
    );
    installFilesApi(renameFn);

    const store = makeStore("ds-1");
    store.setEntries([entry]);

    const promise = store.rename("e1", "new.txt");
    // Mid-flight: pendingOp present, kind === "rename", carries newName.
    const mid = snap(store);
    expect(mid.pendingOps["e1"]).toBeDefined();
    expect(mid.pendingOps["e1"]?.kind).toBe("rename");
    expect(mid.pendingOps["e1"]?.newName).toBe("new.txt");
    expect(renameFn).toHaveBeenCalledTimes(1);
    expect(renameFn).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/old.txt", newName: "new.txt" }),
    );

    resolveRename({ entry: renamed });
    await promise;

    const after = snap(store);
    expect(after.pendingOps["e1"]).toBeUndefined();
    expect(after.entries.find((e) => e.id === "e1")?.name).toBe("new.txt");
    expect(after.entries.find((e) => e.id === "e1")?.path).toBe("/new.txt");
    expect(after.lastError).toBeNull();
  });

  it("failure path: rejection clears pendingOp, entries unchanged, lastError populated", async () => {
    const entry = makeEntry({ id: "e1", name: "old.txt", path: "/old.txt" });
    const renameFn = vi.fn(() => Promise.reject(new Error("provider locked")));
    installFilesApi(renameFn);

    const store = makeStore("ds-1");
    store.setEntries([entry]);

    await store.rename("e1", "new.txt");

    const after = snap(store);
    expect(after.pendingOps["e1"]).toBeUndefined();
    expect(after.entries).toEqual([entry]);
    expect(after.lastError).toEqual({ entryId: "e1", reason: "provider locked" });
    expect(toast.error).toHaveBeenCalledWith("provider locked");
  });

  it("refuses directory rename: no IPC, lastError set, entries unchanged", async () => {
    const dir = makeEntry({
      id: "dir-1",
      kind: "directory",
      name: "docs",
      path: "/docs",
      size: null,
    });
    const renameFn = vi.fn();
    installFilesApi(renameFn);

    const store = makeStore("ds-1");
    store.setEntries([dir]);

    await store.rename("dir-1", "newdocs");

    const after = snap(store);
    expect(renameFn).not.toHaveBeenCalled();
    expect(after.pendingOps["dir-1"]).toBeUndefined();
    expect(after.entries).toEqual([dir]);
    expect(after.lastError).toEqual({
      entryId: "dir-1",
      reason: "Folder rename is not supported in this version",
    });
    expect(toast.error).toHaveBeenCalledWith(
      "Folder rename is not supported in this version",
    );
  });

  it("no-op when newName === entry.name: no IPC, no pendingOp, no lastError", async () => {
    const entry = makeEntry({ id: "e1", name: "same.txt", path: "/same.txt" });
    const renameFn = vi.fn();
    installFilesApi(renameFn);

    const store = makeStore("ds-1");
    store.setEntries([entry]);

    await store.rename("e1", "same.txt");

    const after = snap(store);
    expect(renameFn).not.toHaveBeenCalled();
    expect(after.pendingOps["e1"]).toBeUndefined();
    expect(after.lastError).toBeNull();
  });

  it("refuses empty / whitespace-only newName: no IPC, lastError 'Name cannot be empty'", async () => {
    const entry = makeEntry({ id: "e1", name: "a.txt", path: "/a.txt" });
    const renameFn = vi.fn();
    installFilesApi(renameFn);

    const store = makeStore("ds-1");
    store.setEntries([entry]);

    await store.rename("e1", "");
    let after = snap(store);
    expect(renameFn).not.toHaveBeenCalled();
    expect(after.pendingOps["e1"]).toBeUndefined();
    expect(after.lastError).toEqual({
      entryId: "e1",
      reason: "Name cannot be empty",
    });

    await store.rename("e1", "   ");
    after = snap(store);
    expect(renameFn).not.toHaveBeenCalled();
    expect(after.lastError).toEqual({
      entryId: "e1",
      reason: "Name cannot be empty",
    });
    expect(toast.error).toHaveBeenCalledWith("Name cannot be empty");
  });

  it("refuses when entry id is not in state.entries: no IPC, no throw", async () => {
    const renameFn = vi.fn();
    installFilesApi(renameFn);
    const store = makeStore("ds-1");
    store.setEntries([]);

    await store.rename("missing", "new.txt");
    expect(renameFn).not.toHaveBeenCalled();
  });
});

// --- Remove action -------------------------------------------------------

describe("remove action", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => {
    localStorage.clear();
    clearFilesApi();
  });

  function seedEntries(paths: string[]): FileEntry[] {
    return paths.map((p) =>
      makeEntry({ id: p, name: `${p}.txt`, path: p }),
    );
  }

  it("single-entry happy path: one pendingOp, single IPC call, removes entry, toast.success", async () => {
    const entries = seedEntries(["file-1"]);
    let resolveRemove: (value: { removed: string[]; failed: [] }) => void = () => {};
    const removeFn = vi.fn(
      () =>
        new Promise<{ removed: string[]; failed: [] }>((res) => {
          resolveRemove = res;
        }),
    );
    installFilesRemoveApi(removeFn);

    const store = makeStore("ds-1");
    store.setEntries(entries);

    const promise = store.remove(["file-1"]);
    // Mid-flight
    const mid = snap(store);
    expect(mid.pendingOps["file-1"]).toBeDefined();
    expect(mid.pendingOps["file-1"]?.kind).toBe("remove");
    expect(removeFn).toHaveBeenCalledTimes(1);
    expect(removeFn).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ["file-1"] }),
    );

    resolveRemove({ removed: ["file-1"], failed: [] });
    await promise;

    const after = snap(store);
    expect(after.pendingOps["file-1"]).toBeUndefined();
    expect(after.entries.find((e) => e.id === "file-1")).toBeUndefined();
    expect(after.lastError).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Deleted 1 item");
  });

  it("multi-entry happy path: one IPC call with all paths, removes all, toast 'Deleted 3 items'", async () => {
    const entries = seedEntries(["a", "b", "c"]);
    const removeFn = vi.fn(() =>
      Promise.resolve({ removed: ["a", "b", "c"], failed: [] }),
    );
    installFilesRemoveApi(removeFn);

    const store = makeStore("ds-1");
    store.setEntries(entries);

    // Prime pendingOps synchronously BEFORE the await so the test observes
    // the "three ops all present" invariant.
    const promise = store.remove(["a", "b", "c"]);
    const mid = snap(store);
    expect(mid.pendingOps["a"]).toBeDefined();
    expect(mid.pendingOps["b"]).toBeDefined();
    expect(mid.pendingOps["c"]).toBeDefined();

    await promise;

    expect(removeFn).toHaveBeenCalledTimes(1);
    expect(removeFn).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ["a", "b", "c"] }),
    );

    const after = snap(store);
    expect(after.pendingOps).toEqual({});
    expect(after.entries).toEqual([]);
    expect(after.lastError).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Deleted 3 items");
  });

  it("partial failure: removes succeeded, leaves failed, lastError on failed, mixed toast", async () => {
    const entries = seedEntries(["a", "b", "c"]);
    const removeFn = vi.fn(() =>
      Promise.resolve({
        removed: ["a", "b"],
        failed: [{ path: "c", reason: "provider locked the file" }],
      }),
    );
    installFilesRemoveApi(removeFn);

    const store = makeStore("ds-1");
    store.setEntries(entries);

    await store.remove(["a", "b", "c"]);

    const after = snap(store);
    expect(after.pendingOps).toEqual({});
    expect(after.entries.map((e) => e.id).sort()).toEqual(["c"]);
    expect(after.lastError).toEqual({
      entryId: "c",
      reason: "provider locked the file",
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Deleted 2 of 3 items; 1 failed",
    );
  });

  it("full failure: IPC throws — all pending ops cleared, entries unchanged, lastError set, toast.error", async () => {
    const entries = seedEntries(["a", "b"]);
    const removeFn = vi.fn(() => Promise.reject(new Error("network down")));
    installFilesRemoveApi(removeFn);

    const store = makeStore("ds-1");
    store.setEntries(entries);

    await store.remove(["a", "b"]);

    const after = snap(store);
    expect(after.pendingOps).toEqual({});
    expect(after.entries).toEqual(entries);
    expect(after.lastError?.reason).toBe("network down");
    expect(toast.error).toHaveBeenCalledWith("network down");
  });

  it("empty paths is a silent no-op: no IPC, no toast, no state change", async () => {
    const removeFn = vi.fn();
    installFilesRemoveApi(removeFn);

    const store = makeStore("ds-1");
    store.setEntries(seedEntries(["a"]));
    const before = snap(store);

    await store.remove([]);

    expect(removeFn).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(snap(store)).toBe(before);
  });
});

// --- Download action -----------------------------------------------------

describe("download action", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => {
    localStorage.clear();
    clearFilesApi();
  });

  it("happy path: dispatches IPC once with entry path and toasts success with savedPath", async () => {
    const entry = makeEntry({ id: "e1", name: "file.pdf", path: "/file.pdf" });
    const downloadFn = vi.fn(() =>
      Promise.resolve({ savedPath: "/path/to/saved/file.pdf" }),
    );
    installFilesDownloadApi(downloadFn);

    const store = makeStore("ds-1");
    store.setEntries([entry]);

    await store.download("e1");

    expect(downloadFn).toHaveBeenCalledTimes(1);
    expect(downloadFn).toHaveBeenCalledWith(
      expect.objectContaining({ datasourceId: "ds-1", path: "/file.pdf" }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Downloaded to /path/to/saved/file.pdf",
    );
    // Download does not use pendingOps; state shape stays clean.
    const after = snap(store);
    expect(after.pendingOps).toEqual({});
    expect(after.lastError).toBeNull();
  });

  it("failure path: IPC throws — fires toast.error(reason), sets lastError", async () => {
    const entry = makeEntry({ id: "e1", name: "file.pdf", path: "/file.pdf" });
    const downloadFn = vi.fn(() => Promise.reject(new Error("network down")));
    installFilesDownloadApi(downloadFn);

    const store = makeStore("ds-1");
    store.setEntries([entry]);

    await store.download("e1");

    const after = snap(store);
    expect(after.lastError).toEqual({ entryId: "e1", reason: "network down" });
    expect(toast.error).toHaveBeenCalledWith("network down");
    expect(toast.success).not.toHaveBeenCalled();
    // No pendingOps mutation — download is not an in-list op.
    expect(after.pendingOps).toEqual({});
  });

  it("directory entry: silent no-op, no IPC, no toast, no state change", async () => {
    const dir = makeEntry({
      id: "d1",
      kind: "directory",
      name: "docs",
      path: "/docs",
      size: null,
    });
    const downloadFn = vi.fn();
    installFilesDownloadApi(downloadFn);

    const store = makeStore("ds-1");
    store.setEntries([dir]);
    const before = snap(store);

    await store.download("d1");

    expect(downloadFn).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(snap(store)).toBe(before);
  });

  it("missing entry id: silent no-op, no IPC, no toast", async () => {
    const downloadFn = vi.fn();
    installFilesDownloadApi(downloadFn);

    const store = makeStore("ds-1");
    store.setEntries([]);
    const before = snap(store);

    await store.download("unknown-id");

    expect(downloadFn).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(snap(store)).toBe(before);
  });
});

describe("startEdit / cancelEdit actions", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("startEdit on a file entry sets editingId", () => {
    const entry = makeEntry({ id: "e1", name: "a.txt" });
    const store = makeStore("ds-1");
    store.setEntries([entry]);

    store.startEdit("e1");
    expect(snap(store).editingId).toBe("e1");
  });

  it("cancelEdit clears editingId", () => {
    const entry = makeEntry({ id: "e1", name: "a.txt" });
    const store = makeStore("ds-1");
    store.setEntries([entry]);
    store.startEdit("e1");

    store.cancelEdit();
    expect(snap(store).editingId).toBeNull();
  });

  it("startEdit on a directory entry is a refusal: no editingId, lastError set", () => {
    const dir = makeEntry({
      id: "d1",
      kind: "directory",
      name: "docs",
      path: "/docs",
      size: null,
    });
    const store = makeStore("ds-1");
    store.setEntries([dir]);

    store.startEdit("d1");
    const after = snap(store);
    expect(after.editingId).toBeNull();
    expect(after.lastError).toEqual({
      entryId: "d1",
      reason: "Folder rename is not supported in this version",
    });
  });

  it("startEdit on an entry with an active pendingOp is a no-op", () => {
    const entry = makeEntry({ id: "e1", name: "a.txt" });
    const store = makeStore("ds-1");
    store.setEntries([entry]);
    store.startPendingOp("e1", "rename");

    store.startEdit("e1");
    expect(snap(store).editingId).toBeNull();
  });
});

describe("useExplorerStore hook", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("caches stores per datasource id across calls", () => {
    const selections: { store: ExplorerStore | null } = { store: null };
    const selectionsB: { store: ExplorerStore | null } = { store: null };

    function Probe({
      id,
      sink,
    }: {
      id: string;
      sink: { store: ExplorerStore | null };
    }) {
      const { store } = useExplorerStore(id);
      // capture on first render
      sink.store = store;
      // subscribe to state so the hook wires useSyncExternalStore
      useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      return null;
    }

    render(createElement(Probe, { id: "ds-1", sink: selections }));
    render(createElement(Probe, { id: "ds-1", sink: selectionsB }));

    expect(selections.store).not.toBeNull();
    expect(selections.store).toBe(selectionsB.store);
  });

  it("returns distinct stores for distinct datasource ids", () => {
    const a: { store: ExplorerStore | null } = { store: null };
    const b: { store: ExplorerStore | null } = { store: null };

    function Probe({ id, sink }: { id: string; sink: { store: ExplorerStore | null } }) {
      const { store } = useExplorerStore(id);
      sink.store = store;
      return null;
    }

    render(createElement(Probe, { id: "ds-A", sink: a }));
    render(createElement(Probe, { id: "ds-B", sink: b }));

    expect(a.store).not.toBeNull();
    expect(b.store).not.toBeNull();
    expect(a.store).not.toBe(b.store);
  });

  it("re-renders consumers when the store mutates", () => {
    let capturedViewMode: ViewMode | null = null;
    let capturedStore: ExplorerStore | null = null;

    function Probe() {
      const { state, store } = useExplorerStore("ds-hook");
      capturedViewMode = state.viewMode;
      capturedStore = store;
      return null;
    }

    render(createElement(Probe));
    expect(capturedViewMode).toBe("details");

    act(() => {
      capturedStore!.setViewMode("tiles");
    });
    expect(capturedViewMode).toBe("tiles");
  });
});

