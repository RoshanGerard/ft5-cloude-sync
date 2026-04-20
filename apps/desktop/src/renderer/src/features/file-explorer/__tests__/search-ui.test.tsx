/** @vitest-environment jsdom */
//
// Phase 7.1 — Search UI (TDD red).
//
// Contract (from tasks.md 7.1):
//
//   "Toolbar search toggle opens an input, typing + Enter dispatches
//    `window.api.files.search`, results replace the main pane while a
//    'Clear search' affordance is visible."
//
// Swap-renderer model (Phase 7 Decision 1, locked): when
// `state.search.active === true`, the composite renders a `<SearchResults>`
// surface in place of `<ViewModeSwitcher>`. These tests assert the swap by
// test-id only — they do NOT import the not-yet-existing SearchResults
// module. All assertions are behavioural (contract, not layout), so they
// remain valid once 7.2/7.4 land.
//
// House style reminder: `@testing-library/user-event` is NOT a project dep
// (see tasks.md note at line 70). We use `fireEvent` + synthetic events,
// matching the existing toolbar / composite tests.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { FileEntry } from "@ft5/ipc-contracts";

import { FileExplorer } from "../file-explorer.js";
import { __resetExplorerStoreCacheForTests } from "../store.js";
import { seedEntry } from "./test-utils.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let filesListMock: Mock;
let filesSearchMock: Mock;

interface InstallOptions {
  listResponses?: Map<string, { entries: FileEntry[]; nextCursor: string | null }>;
  searchResponse?: {
    entries: FileEntry[];
    truncated: boolean;
    providerSearchDeferred?: boolean;
  };
}

function installApiMock(options: InstallOptions = {}): void {
  filesListMock = vi.fn();
  const listResponses = options.listResponses ?? new Map();
  filesListMock.mockImplementation(async (req: { path: string }) => {
    const canned = listResponses.get(req.path);
    if (canned !== undefined) return canned;
    return { entries: [], nextCursor: null };
  });

  filesSearchMock = vi.fn();
  const searchResponse = options.searchResponse ?? {
    entries: [],
    truncated: false,
  };
  filesSearchMock.mockResolvedValue(searchResponse);

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockResolvedValue({ datasources: [] }),
      add: vi.fn(),
      remove: vi.fn(),
      action: vi.fn(),
      upload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
    },
    files: {
      list: filesListMock,
      stat: vi.fn(),
      search: filesSearchMock,
      rename: vi.fn(),
      remove: vi.fn(),
      download: vi.fn(),
    },
  };
}

// Radix portals (ContextMenu, DropdownMenu) need a ResizeObserver polyfill
// in jsdom — the toolbar.test.tsx establishes this pattern.
function installResizeObserverPolyfill(): void {
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FileExplorer — search UI (Phase 7.1)", () => {
  beforeEach(() => {
    installResizeObserverPolyfill();
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("toolbar surfaces a Search control that opens a focused input", async () => {
    // Seed a single entry so the main pane resolves before we click Search.
    installApiMock({
      listResponses: new Map([
        ["/", { entries: [seedEntry({ id: "a", name: "alpha.png", path: "/alpha.png" })], nextCursor: null }],
      ]),
    });

    render(<FileExplorer datasourceId="ds-search-1" />);

    // Wait for initial load so we know we're looking at a stable composite.
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });

    // The trigger is a toolbar button with an accessible name matching /search/i
    // and a stable test-id the impl will use.
    const trigger = screen.getByTestId("file-explorer-search-trigger");
    expect(trigger).toBeInTheDocument();
    expect(trigger.tagName).toBe("BUTTON");
    const triggerLabel =
      trigger.getAttribute("aria-label") ?? trigger.textContent ?? "";
    expect(triggerLabel.toLowerCase()).toMatch(/search/);

    // Activating it reveals a searchbox and focuses it.
    fireEvent.click(trigger);

    const input = await screen.findByRole("searchbox");
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("typing + Enter dispatches window.api.files.search with the typed query + path '/'", async () => {
    const hit = seedEntry({ id: "h1", name: "hit.txt", path: "/folder/hit.txt" });
    installApiMock({
      listResponses: new Map([
        ["/", { entries: [seedEntry({ id: "a", name: "alpha.png", path: "/alpha.png" })], nextCursor: null }],
      ]),
      searchResponse: { entries: [hit], truncated: false },
    });

    render(<FileExplorer datasourceId="ds-search-2" />);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });

    fireEvent.click(screen.getByTestId("file-explorer-search-trigger"));

    const input = (await screen.findByRole("searchbox")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "hit" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(filesSearchMock).toHaveBeenCalledTimes(1);
    });
    expect(filesSearchMock).toHaveBeenCalledWith({
      datasourceId: "ds-search-2",
      query: "hit",
      path: "/",
    });
  });

  it("results replace the main pane: ViewModeSwitcher is gone, SearchResults is present", async () => {
    const hit = seedEntry({ id: "h1", name: "hit.txt", path: "/folder/hit.txt" });
    installApiMock({
      listResponses: new Map([
        ["/", { entries: [seedEntry({ id: "a", name: "alpha.png", path: "/alpha.png" })], nextCursor: null }],
      ]),
      searchResponse: { entries: [hit], truncated: false },
    });

    render(<FileExplorer datasourceId="ds-search-3" />);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });

    fireEvent.click(screen.getByTestId("file-explorer-search-trigger"));
    const input = await screen.findByRole("searchbox");
    fireEvent.change(input, { target: { value: "hit" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // After the search resolves, the default Details renderer's rows should
    // be gone (ViewModeSwitcher has been swapped out) and the SearchResults
    // surface should be mounted.
    await waitFor(() => {
      expect(screen.getByTestId("file-explorer-search-results")).toBeInTheDocument();
    });
    expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(0);
  });

  it("'Clear search' affordance is visible while search is active and dismisses the results", async () => {
    const hit = seedEntry({ id: "h1", name: "hit.txt", path: "/folder/hit.txt" });
    installApiMock({
      listResponses: new Map([
        ["/", { entries: [seedEntry({ id: "a", name: "alpha.png", path: "/alpha.png" })], nextCursor: null }],
      ]),
      searchResponse: { entries: [hit], truncated: false },
    });

    render(<FileExplorer datasourceId="ds-search-4" />);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });

    fireEvent.click(screen.getByTestId("file-explorer-search-trigger"));
    const input = await screen.findByRole("searchbox");
    fireEvent.change(input, { target: { value: "hit" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // SearchResults present → swap happened → search is active.
    await waitFor(() => {
      expect(screen.getByTestId("file-explorer-search-results")).toBeInTheDocument();
    });

    // Clear affordance is visible and accessibly named.
    const clearBtn = screen.getByTestId("file-explorer-search-clear");
    expect(clearBtn).toBeInTheDocument();
    expect(clearBtn.tagName).toBe("BUTTON");
    const clearLabel =
      clearBtn.getAttribute("aria-label") ?? clearBtn.textContent ?? "";
    expect(clearLabel.toLowerCase()).toMatch(/clear search/);

    fireEvent.click(clearBtn);

    // After clear: SearchResults is gone and ViewModeSwitcher output
    // (the default details row) is back.
    await waitFor(() => {
      expect(screen.queryByTestId("file-explorer-search-results")).toBeNull();
    });
    expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
  });
});
