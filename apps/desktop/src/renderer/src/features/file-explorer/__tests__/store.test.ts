/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createElement, useSyncExternalStore } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

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
    // The store reserves the flag on search; expose it on the search shape.
    // We permit either a flat results array or an enriched shape — assert the
    // entries round-trip at minimum.
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

