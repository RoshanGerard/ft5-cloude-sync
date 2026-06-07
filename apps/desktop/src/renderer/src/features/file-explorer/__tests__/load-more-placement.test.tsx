/** @vitest-environment jsdom */
//
// Composite placement + gating tests for the shared load-more region
// (add-engine-listdirectory-pagination groups 9 + 10, Visual direction V-1).
//
// The region lives in `file-explorer.tsx` as a SINGLE shared placement
// between the scrollable entries area (the `overflow-auto` main column that
// hosts the view modes) and the status row — never inside any view-mode's
// scroll container, always full-width, rendering identically below all six
// view modes. These tests mount the real composite with a `window.api` mock
// that PRESERVES `nextCursor` (the standard composite mock strips it), then
// assert structural placement, view-mode coverage, and the visibility gate.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { FileEntry } from "@ft5/ipc-contracts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

import { FileExplorer } from "../file-explorer.js";
import {
  __resetExplorerStoreCacheForTests,
  getOrCreateExplorerStore,
  type ViewMode,
} from "../store.js";
import { seedEntry } from "./test-utils.js";

let filesListMock: Mock;

interface ListInner {
  entries: FileEntry[];
  truncated?: boolean;
  nextCursor?: string | null;
}

/**
 * Install a `window.api` whose `files.list` PRESERVES `nextCursor` from the
 * canned per-path responses (unlike the shared composite mock). First-page
 * calls (no cursor) read the path map; cursor-bearing calls (load-more) read
 * an optional follow-up response keyed by the cursor string.
 */
function installApiMock(opts: {
  byPath?: Map<string, ListInner>;
  byCursor?: Map<string, ListInner>;
  reject?: Error;
}): void {
  filesListMock = vi.fn();
  if (opts.reject) {
    filesListMock.mockRejectedValue(opts.reject);
  } else {
    const byPath = opts.byPath ?? new Map();
    const byCursor = opts.byCursor ?? new Map();
    filesListMock.mockImplementation(
      async (req: { path: string; cursor?: string }) => {
        const inner =
          req.cursor !== undefined
            ? byCursor.get(req.cursor)
            : byPath.get(req.path);
        const resolved = inner ?? { entries: [] };
        return {
          ok: true as const,
          value: {
            entries: resolved.entries,
            truncated: resolved.nextCursor != null,
            nextCursor: resolved.nextCursor ?? null,
          },
        };
      },
    );
  }

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockResolvedValue({ datasources: [] }),
      add: vi.fn(),
      remove: vi.fn().mockResolvedValue({ ok: true }),
      action: vi.fn(),
      pickFilesToUpload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
    sync: {
      listJobs: vi.fn().mockResolvedValue({ jobs: [] }),
      onEvent: vi.fn().mockReturnValue(() => {}),
      authenticateStart: vi.fn(),
      authenticateComplete: vi.fn(),
      authenticateCancel: vi.fn(),
    },
    files: {
      list: filesListMock,
      stat: vi.fn(),
      search: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      download: vi.fn(),
    },
  };
}

const ALL_VIEW_MODES: ViewMode[] = [
  "list",
  "details",
  "small",
  "tiles",
  "medium",
  "large",
];

function pageOf(count: number, prefix = "e"): FileEntry[] {
  return Array.from({ length: count }, (_, i) =>
    seedEntry({ id: `${prefix}-${i}`, name: `${prefix}-${i}.txt`, path: `/big/${prefix}-${i}.txt` }),
  );
}

describe("LoadMoreRegion placement in the composite (V-1)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders the Load-more button between the entries scroll container and the status row", async () => {
    installApiMock({
      byPath: new Map([["/", { entries: pageOf(3), nextCursor: "tokA" }]]),
    });
    render(<FileExplorer datasourceId="ds-page" />);

    const button = await screen.findByRole("button", { name: "Load more" });

    // 1. The button is NOT a descendant of the overflow-auto scroll
    //    container that hosts the view modes.
    const scrollContainer = screen
      .getByTestId("view-mode-keyboard-container")
      .closest(".overflow-auto");
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer?.contains(button)).toBe(false);

    // 2. The region sits between the entries row and the status row in DOM
    //    order: scroll container precedes the button; the button precedes
    //    the status row.
    const status = screen.getByRole("status");
    const positionScrollVsButton = scrollContainer!.compareDocumentPosition(
      button,
    );
    const positionButtonVsStatus = button.compareDocumentPosition(status);
    // DOCUMENT_POSITION_FOLLOWING (4) — the argument node comes AFTER.
    expect(positionScrollVsButton & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(positionButtonVsStatus & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(ALL_VIEW_MODES)(
    "renders the same full-width Load-more button under the %s view mode",
    async (mode) => {
      installApiMock({
        byPath: new Map([["/", { entries: pageOf(3), nextCursor: "tokA" }]]),
      });
      const store = getOrCreateExplorerStore("ds-page");
      act(() => {
        store.setViewMode(mode);
      });
      render(<FileExplorer datasourceId="ds-page" />);

      const button = await screen.findByRole("button", { name: "Load more" });
      expect(button).toHaveAttribute("data-variant", "ghost");
      expect(button).toHaveClass("w-full");
      // Exactly one shared placement — not duplicated per mode.
      expect(screen.getAllByRole("button", { name: "Load more" })).toHaveLength(
        1,
      );
    },
  );

  it("status row reads 'N+ items · N loaded' alongside the Load-more button", async () => {
    installApiMock({
      byPath: new Map([["/", { entries: pageOf(3), nextCursor: "tokA" }]]),
    });
    render(<FileExplorer datasourceId="ds-page" />);
    await screen.findByRole("button", { name: "Load more" });
    expect(screen.getByRole("status")).toHaveTextContent(/^3\+ items · 3 loaded$/);
  });
});

describe("LoadMoreRegion visibility gate in the composite", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("is NOT rendered while the initial list is loading (deferred response)", async () => {
    // A never-resolving list keeps `loading === true`.
    filesListMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    (window as unknown as { api: unknown }).api = {
      ping: vi.fn(),
      datasources: {
        list: vi.fn().mockResolvedValue({ datasources: [] }),
        onUploadProgress: vi.fn().mockReturnValue(() => {}),
        onEvent: vi.fn().mockReturnValue(() => {}),
      },
      sync: { onEvent: vi.fn().mockReturnValue(() => {}) },
      files: { list: filesListMock },
    };
    render(<FileExplorer datasourceId="ds-page" />);
    // Skeleton is up; no Load-more button while loading.
    await waitFor(() => {
      expect(filesListMock).toHaveBeenCalled();
    });
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });

  it("is NOT rendered when a search is active even if a cursor lingers", async () => {
    installApiMock({
      byPath: new Map([["/", { entries: pageOf(3), nextCursor: "tokA" }]]),
    });
    render(<FileExplorer datasourceId="ds-page" />);
    await screen.findByRole("button", { name: "Load more" });

    // Activating search must hide the region (search surface is authoritative).
    const store = getOrCreateExplorerStore("ds-page");
    act(() => {
      store.startSearch();
    });
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });

  it("is NOT rendered when the list errors out (full-replace state) even if entries exist", async () => {
    installApiMock({
      byPath: new Map([["/", { entries: pageOf(3), nextCursor: "tokA" }]]),
    });
    render(<FileExplorer datasourceId="ds-page" />);
    await screen.findByRole("button", { name: "Load more" });

    // Simulate a disconnected re-fetch: errorTag set with entries still
    // present (the store does not clear entries on a tagged error). The
    // full-replace DisconnectedState must own the pane — no Load-more.
    const store = getOrCreateExplorerStore("ds-page");
    act(() => {
      store.setErrorTag("disconnected");
      store.setError("offline");
    });
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });

  it("is NOT rendered when the folder is empty (no cursor, no entries)", async () => {
    installApiMock({
      byPath: new Map([["/", { entries: [], nextCursor: null }]]),
    });
    render(<FileExplorer datasourceId="ds-page" />);
    await waitFor(() => {
      expect(
        screen.getByTestId("file-explorer-state-empty") ??
          screen.queryByText(/empty/i),
      ).toBeTruthy();
    });
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });
});

describe("LoadMoreRegion behavior through the composite (spec scenarios)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("Load-more click appends entries, advances the cursor, and updates the status row (spec lines 18-21)", async () => {
    installApiMock({
      byPath: new Map([["/", { entries: pageOf(3, "p1"), nextCursor: "tokA" }]]),
      byCursor: new Map([["tokA", { entries: pageOf(2, "p2"), nextCursor: null }]]),
    });
    render(<FileExplorer datasourceId="ds-page" />);

    const button = await screen.findByRole("button", { name: "Load more" });
    expect(screen.getByRole("status")).toHaveTextContent(/^3\+ items · 3 loaded$/);

    await act(async () => {
      button.click();
    });

    // Entries appended (3 + 2 = 5); cursor exhausted → button gone, status
    // collapses to plain "5 items".
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Load more" }),
      ).not.toBeInTheDocument();
    });
    expect(getOrCreateExplorerStore("ds-page").getSnapshot().entries.length).toBe(
      5,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/^5 items$/);
  });

  it("Load-more failure surfaces the inline retry row + updates the status row to 'couldn't load more' (spec lines 48-51)", async () => {
    // First page OK with a cursor; the load-more call (cursor: tokA) rejects
    // at the envelope level (fs-sync's auto-retry already exhausted).
    filesListMock = vi
      .fn()
      .mockImplementation(async (req: { path: string; cursor?: string }) => {
        if (req.cursor === "tokA") {
          return {
            ok: false as const,
            error: {
              tag: "other" as const,
              message: "connection timed out",
              retryable: true,
            },
          };
        }
        return {
          ok: true as const,
          value: { entries: pageOf(3), truncated: true, nextCursor: "tokA" },
        };
      });
    (window as unknown as { api: unknown }).api = {
      ping: vi.fn(),
      datasources: {
        list: vi.fn().mockResolvedValue({ datasources: [] }),
        onUploadProgress: vi.fn().mockReturnValue(() => {}),
        onEvent: vi.fn().mockReturnValue(() => {}),
      },
      sync: { onEvent: vi.fn().mockReturnValue(() => {}) },
      files: { list: filesListMock },
    };

    render(<FileExplorer datasourceId="ds-page" />);
    const button = await screen.findByRole("button", { name: "Load more" });

    await act(async () => {
      button.click();
    });

    // Failed row swaps in; entries stay; status row flips to the failed copy.
    await waitFor(() => {
      expect(screen.getByTestId("load-more-failed")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Couldn't load more entries")).toBeInTheDocument();
    expect(getOrCreateExplorerStore("ds-page").getSnapshot().entries.length).toBe(
      3,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /^3 items · couldn't load more$/,
    );
    // Retry button present and wired (re-issues the same cursor).
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("Retry on the failed row swaps to the busy button, then appends + hides on success (spec lines 53-56)", async () => {
    // Stateful mock: the FIRST load-more (cursor: tokA) fails; the retry of
    // the SAME cursor succeeds with a final page (nextCursor: null).
    let tokAAttempts = 0;
    filesListMock = vi
      .fn()
      .mockImplementation(async (req: { path: string; cursor?: string }) => {
        if (req.cursor === "tokA") {
          tokAAttempts += 1;
          if (tokAAttempts === 1) {
            return {
              ok: false as const,
              error: {
                tag: "other" as const,
                message: "connection timed out",
                retryable: true,
              },
            };
          }
          return {
            ok: true as const,
            value: { entries: pageOf(2, "p2"), truncated: false, nextCursor: null },
          };
        }
        return {
          ok: true as const,
          value: { entries: pageOf(3, "p1"), truncated: true, nextCursor: "tokA" },
        };
      });
    (window as unknown as { api: unknown }).api = {
      ping: vi.fn(),
      datasources: {
        list: vi.fn().mockResolvedValue({ datasources: [] }),
        onUploadProgress: vi.fn().mockReturnValue(() => {}),
        onEvent: vi.fn().mockReturnValue(() => {}),
      },
      sync: { onEvent: vi.fn().mockReturnValue(() => {}) },
      files: { list: filesListMock },
    };

    render(<FileExplorer datasourceId="ds-page" />);
    const loadMore = await screen.findByRole("button", { name: "Load more" });

    // First click → failed row.
    await act(async () => {
      loadMore.click();
    });
    await waitFor(() => {
      expect(screen.getByTestId("load-more-failed")).toBeInTheDocument();
    });

    // Click Retry → on success the row is gone, the final page appended,
    // the button hidden (cursor exhausted), and the status row plain.
    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("load-more-failed")).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
    expect(getOrCreateExplorerStore("ds-page").getSnapshot().entries.length).toBe(
      5,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/^5 items$/);
    // The retry re-issued the SAME cursor (tokA) — two attempts total.
    expect(tokAAttempts).toBe(2);
  });
});
