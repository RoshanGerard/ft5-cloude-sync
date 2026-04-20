/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import type { FileEntry } from "@ft5/ipc-contracts";

import { DetailsPane } from "../details-pane.js";
import {
  EXPLORER_STORAGE_KEY_PREFIX,
  __resetExplorerStoreCacheForTests,
  createExplorerStore,
} from "../store.js";
import type { ExplorerStore } from "../store.js";
import { Toolbar } from "../toolbar.js";

/**
 * Details pane — Phase 5.3/5.4.
 *
 * Spec reference — specs/file-explorer/spec.md "Details pane renders
 * metadata for the current selection, independently of Properties modal":
 *   - Single selection: pane renders the curated `paneFields` subset plus
 *     up to 3 provider-metadata rows.
 *   - Multi-selection: summary with count + combined file-size total
 *     (directories excluded) + common parent path; individual-entry
 *     metadata NOT shown.
 *   - State persists per-datasource in localStorage (reuses the existing
 *     store prefs key — see store.ts EXPLORER_STORAGE_KEY_PREFIX).
 *
 * Design reference — design.md Decision 4 ("Details pane AND Properties
 * modal — two surfaces, one shape") and Decision 9 ("Visual direction"):
 *   right side, 320 px fixed width, border-l, surface background.
 */

function makeEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: "e1",
    kind: "file",
    name: "hero.png",
    path: "/project/hero.png",
    parentPath: "/project",
    size: 12_288,
    mimeFamily: "image",
    mimeType: "image/png",
    modifiedAt: "2026-04-18T10:30:00.000Z",
    createdAt: null,
    providerMetadata: {},
    ...overrides,
  };
}

function makeStore(id = "ds-details-test"): ExplorerStore {
  return createExplorerStore(id);
}

function storageKey(datasourceId: string): string {
  return `${EXPLORER_STORAGE_KEY_PREFIX}${datasourceId}.prefs`;
}

describe("DetailsPane — visibility", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("is hidden from the accessibility tree when detailsPaneOpen is false", () => {
    const store = makeStore();
    // default is closed
    render(<DetailsPane store={store} />);
    // The pane is an <aside aria-label="Details"> — when closed it is
    // either unmounted OR rendered with the hidden attribute. Either is
    // acceptable; queryByRole must not surface it.
    expect(screen.queryByRole("complementary", { name: /details/i })).toBeNull();
  });

  it("is visible (as <aside aria-label='Details'>) when detailsPaneOpen is true", () => {
    const store = makeStore();
    act(() => {
      store.toggleDetailsPane();
    });
    render(<DetailsPane store={store} />);
    const aside = screen.getByRole("complementary", { name: /details/i });
    expect(aside).toBeInTheDocument();
  });
});

describe("DetailsPane — no selection", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("shows a 'Nothing selected' placeholder when open and selection is empty", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([makeEntry({ id: "a" }), makeEntry({ id: "b" })]);
      store.toggleDetailsPane();
    });
    render(<DetailsPane store={store} />);
    // Placeholder copy — match the dense-quiet aesthetic; assert case-
    // insensitive "nothing selected".
    expect(screen.getByText(/nothing selected/i)).toBeInTheDocument();
  });
});

describe("DetailsPane — single selection", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders the curated paneFields for the single selected entry", () => {
    const store = makeStore();
    const entry = makeEntry({
      id: "e1",
      name: "report.pdf",
      path: "/project/report.pdf",
      parentPath: "/project",
      size: 4096,
      mimeFamily: "document",
      mimeType: "application/pdf",
      modifiedAt: "2026-04-18T10:30:00.000Z",
    });
    act(() => {
      store.setEntries([entry]);
      store.select("e1", "replace");
      store.toggleDetailsPane();
    });
    render(<DetailsPane store={store} />);

    // paneFields = [name, type, size, modified, path]. Each renders a
    // label cell AND a value cell via FieldRow.
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();

    expect(screen.getByText("Type")).toBeInTheDocument();
    // formatType capitalises the mimeFamily
    expect(screen.getByText("Document")).toBeInTheDocument();

    expect(screen.getByText("Size")).toBeInTheDocument();
    expect(screen.getByText("4 KB")).toBeInTheDocument();

    expect(screen.getByText("Modified")).toBeInTheDocument();
    expect(screen.getByText("Apr 18, 2026")).toBeInTheDocument();

    expect(screen.getByText("Path")).toBeInTheDocument();
    expect(screen.getByText("/project/report.pdf")).toBeInTheDocument();
  });

  it("renders up to 3 provider-metadata rows (PANE_PROVIDER_METADATA_LIMIT)", () => {
    const store = makeStore();
    const entry = makeEntry({
      id: "e1",
      providerMetadata: {
        owner: "alice",
        shared: true,
        starred: false,
        revision: 7,
        checksum: "deadbeef",
      },
    });
    act(() => {
      store.setEntries([entry]);
      store.select("e1", "replace");
      store.toggleDetailsPane();
    });
    render(<DetailsPane store={store} />);

    // The first three keys in insertion order: owner, shared, starred.
    // Labels are humanised by the catalog.
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Shared")).toBeInTheDocument();
    expect(screen.getByText("Starred")).toBeInTheDocument();

    // Fourth and fifth must NOT leak into the pane (modal's privilege).
    expect(screen.queryByText("Revision")).toBeNull();
    expect(screen.queryByText("Checksum")).toBeNull();
  });
});

describe("DetailsPane — multi selection", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders a summary (count + combined file size + common parent) and NOT individual-entry fields", () => {
    const store = makeStore();
    const entries: FileEntry[] = [
      makeEntry({
        id: "a",
        name: "alpha.png",
        path: "/project/assets/alpha.png",
        parentPath: "/project/assets",
        size: 1024,
      }),
      makeEntry({
        id: "b",
        name: "bravo.png",
        path: "/project/assets/bravo.png",
        parentPath: "/project/assets",
        size: 2048,
      }),
      // Directory — excluded from the size sum.
      makeEntry({
        id: "c",
        name: "nested",
        path: "/project/assets/nested",
        parentPath: "/project/assets",
        kind: "directory",
        size: null,
        mimeFamily: "unknown",
        mimeType: null,
      }),
    ];
    act(() => {
      store.setEntries(entries);
      store.select("a", "replace");
      store.select("b", "toggle");
      store.select("c", "toggle");
      store.toggleDetailsPane();
    });
    render(<DetailsPane store={store} />);

    // Count
    expect(screen.getByText(/3 items selected/i)).toBeInTheDocument();
    // Combined size = 1024 + 2048 = 3072 B = 3 KB (the directory is excluded).
    expect(screen.getByText("3 KB")).toBeInTheDocument();
    // Common parent
    expect(screen.getByText("/project/assets")).toBeInTheDocument();

    // Individual-entry labels from paneFields MUST NOT be present.
    expect(screen.queryByText("alpha.png")).toBeNull();
    expect(screen.queryByText("bravo.png")).toBeNull();
  });

  it("computes common parent via path-segment longest prefix when parents diverge", () => {
    const store = makeStore();
    const entries: FileEntry[] = [
      makeEntry({
        id: "a",
        path: "/project/alpha/file.txt",
        parentPath: "/project/alpha",
        size: 100,
      }),
      makeEntry({
        id: "b",
        path: "/project/bravo/file.txt",
        parentPath: "/project/bravo",
        size: 200,
      }),
    ];
    act(() => {
      store.setEntries(entries);
      store.select("a", "replace");
      store.select("b", "toggle");
      store.toggleDetailsPane();
    });
    render(<DetailsPane store={store} />);

    // /project/alpha ∩ /project/bravo → /project (not "/project/" from naive string prefix).
    expect(screen.getByText("/project")).toBeInTheDocument();
  });

  it("falls back to root '/' when selected entries span parents with no common segment", () => {
    const store = makeStore();
    const entries: FileEntry[] = [
      makeEntry({
        id: "a",
        path: "/alpha/file.txt",
        parentPath: "/alpha",
        size: 100,
      }),
      makeEntry({
        id: "b",
        path: "/bravo/file.txt",
        parentPath: "/bravo",
        size: 200,
      }),
    ];
    act(() => {
      store.setEntries(entries);
      store.select("a", "replace");
      store.select("b", "toggle");
      store.toggleDetailsPane();
    });
    render(<DetailsPane store={store} />);
    expect(screen.getByText("/")).toBeInTheDocument();
  });
});

describe("DetailsPane — toolbar toggle + persistence wiring", () => {
  beforeEach(() => {
    if (!("ResizeObserver" in window)) {
      (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
        class MockResizeObserver {
          observe() {}
          unobserve() {}
          disconnect() {}
        };
    }
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("toolbar renders a Details toggle button with aria-pressed='false' when pane is closed", () => {
    const store = makeStore();
    render(<Toolbar store={store} />);
    const btn = screen.getByRole("button", { name: /details/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking the toolbar Details button flips aria-pressed and writes the new state to localStorage", () => {
    const datasourceId = "ds-details-persist";
    const store = createExplorerStore(datasourceId);
    render(<Toolbar store={store} />);
    const btn = screen.getByRole("button", { name: /details/i });

    act(() => {
      fireEvent.click(btn);
    });

    // aria-pressed reflects the new state.
    expect(btn).toHaveAttribute("aria-pressed", "true");

    // Component-level assertion: the click wrote the prefs payload, and
    // detailsPaneOpen is true. Store-level persistence mechanics are
    // already covered by store.test.ts; here we verify the button → store
    // → storage wiring.
    const raw = window.localStorage.getItem(storageKey(datasourceId));
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { detailsPaneOpen: boolean };
    expect(parsed.detailsPaneOpen).toBe(true);
  });
});
