/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { FilesErrorTag } from "@ft5/ipc-contracts";

import { createExplorerStore } from "../store.js";
import type { ExplorerStore } from "../store.js";
import { StatusRow, deriveStatusText } from "../status-row.js";
import { seedEntry } from "./test-utils.js";

/**
 * StatusRow — the aria-live status strip pinned to the bottom of the
 * explorer chrome. Renders one of three shapes:
 *
 *   1. Idle: "N items" (plus " · M selected" when selection is non-empty).
 *   2. Search active, normal results: `Showing N results for "<query>"`,
 *      appending " · truncated" when the provider reports a truncated scan.
 *   3. Search active, provider-deferred (Drive / OneDrive v1): an honest
 *      "not yet wired" message pointing at the deferred-work docs.
 *
 * The root element carries `role="status"` + `aria-live="polite"` so screen
 * readers announce changes without interrupting. Numeric segments wrap in
 * `tabular-nums` spans so digit widths stay stable when the count changes
 * (mirrors the Details-mode size/modified convention).
 */

function makeStore(id = "ds-status-row"): ExplorerStore {
  return createExplorerStore(id);
}

describe("StatusRow — root element semantics", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("has role='status' on the outer element", () => {
    const store = makeStore();
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
  });

  it("has aria-live='polite' (not assertive) on the outer element", () => {
    const store = makeStore();
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
  });
});

describe("StatusRow — idle state", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("empty directory with no selection renders '0 items' (no 'selected' segment)", () => {
    const store = makeStore();
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/^0 items$/);
    expect(status.textContent).not.toMatch(/selected/i);
  });

  it("12 entries with no selection renders '12 items'", () => {
    const store = makeStore();
    const entries = Array.from({ length: 12 }, (_, i) =>
      seedEntry({ id: `e-${i}`, name: `file-${i}.txt` }),
    );
    act(() => {
      store.setEntries(entries);
    });
    render(<StatusRow store={store} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^12 items$/);
  });

  it("12 entries with 3 selected renders '12 items · 3 selected'", () => {
    const store = makeStore();
    const entries = Array.from({ length: 12 }, (_, i) =>
      seedEntry({ id: `e-${i}`, name: `file-${i}.txt` }),
    );
    act(() => {
      store.setEntries(entries);
    });
    act(() => {
      store.select("e-0", "replace");
    });
    act(() => {
      store.select("e-1", "toggle");
    });
    act(() => {
      store.select("e-2", "toggle");
    });
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/12 items\s·\s3 selected/);
    expect(status).toBeInTheDocument();
  });

  it("numeric segments are wrapped in tabular-nums elements", () => {
    const store = makeStore();
    const entries = Array.from({ length: 7 }, (_, i) =>
      seedEntry({ id: `e-${i}`, name: `file-${i}.txt` }),
    );
    act(() => {
      store.setEntries(entries);
    });
    act(() => {
      store.select("e-0", "replace");
    });
    act(() => {
      store.select("e-1", "toggle");
    });
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    const numericSpans = Array.from(
      status.querySelectorAll<HTMLElement>(".tabular-nums"),
    );
    // Expect at least two tabular-nums spans: the item count and the
    // selection count. Each should carry a digit as its textContent.
    expect(numericSpans.length).toBeGreaterThanOrEqual(2);
    const digitTexts = numericSpans.map((el) => el.textContent ?? "");
    expect(digitTexts).toContain("7");
    expect(digitTexts).toContain("2");
  });
});

describe("StatusRow — pagination three-state count (V-3)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  function seedN(store: ExplorerStore, n: number): void {
    const entries = Array.from({ length: n }, (_, i) =>
      seedEntry({ id: `e-${i}`, name: `file-${i}.txt` }),
    );
    act(() => {
      store.setEntries(entries);
    });
  }

  it("more-available: nextCursor !== null renders 'N+ items · N loaded'", () => {
    const store = makeStore();
    seedN(store, 500);
    act(() => {
      // applyInitialPage seeds nextCursor (the more-available signal).
      store.applyInitialPage({
        entries: store.getSnapshot().entries,
        truncated: true,
        nextCursor: "tokA",
      });
    });
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/^500\+ items · 500 loaded$/);
  });

  it("more-available with selection: appends '· N selected' AFTER the pagination suffix", () => {
    const store = makeStore();
    seedN(store, 500);
    act(() => {
      store.applyInitialPage({
        entries: store.getSnapshot().entries,
        truncated: true,
        nextCursor: "tokA",
      });
    });
    act(() => {
      store.select("e-0", "replace");
    });
    act(() => {
      store.select("e-1", "toggle");
    });
    act(() => {
      store.select("e-2", "toggle");
    });
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      /^500\+ items · 500 loaded · 3 selected$/,
    );
  });

  it("more-available: both numerals are wrapped in tabular-nums", () => {
    const store = makeStore();
    seedN(store, 500);
    act(() => {
      store.applyInitialPage({
        entries: store.getSnapshot().entries,
        truncated: true,
        nextCursor: "tokA",
      });
    });
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    const digitTexts = Array.from(
      status.querySelectorAll<HTMLElement>(".tabular-nums"),
    ).map((el) => el.textContent ?? "");
    // Two distinct numerals: the "N+" count and the "N loaded" count.
    expect(digitTexts.filter((t) => t === "500").length).toBeGreaterThanOrEqual(
      2,
    );
  });

  async function driveLoadMoreFailure(
    store: ExplorerStore,
    message: string,
  ): Promise<void> {
    // Simulate the post-exhaustion store state: a failed loadMore leaves
    // BOTH nextCursor (for retry) AND loadMoreError set. The failed state
    // must win over the more-available suffix (spec scenario lines 117-119).
    (
      globalThis as unknown as {
        window: { api: { files: { list: () => Promise<unknown> } } };
      }
    ).window.api = {
      files: {
        list: () =>
          Promise.resolve({
            ok: false as const,
            error: { tag: FilesErrorTag.Other as const, message, retryable: true },
          }),
      },
    };
    await act(async () => {
      await store.loadMore();
    });
  }

  it("load-failed: loadMoreError !== null renders 'N items · couldn't load more' (failed wins over more-available)", async () => {
    const store = makeStore();
    seedN(store, 500);
    act(() => {
      store.applyInitialPage({
        entries: store.getSnapshot().entries,
        truncated: true,
        nextCursor: "tokA",
      });
    });
    await driveLoadMoreFailure(store, "connection timed out");
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/^500 items · couldn't load more$/);
  });

  it("load-failed with selection: appends '· N selected' after the failed suffix", async () => {
    const store = makeStore();
    seedN(store, 500);
    act(() => {
      store.applyInitialPage({
        entries: store.getSnapshot().entries,
        truncated: true,
        nextCursor: "tokA",
      });
    });
    act(() => {
      store.select("e-0", "replace");
    });
    await driveLoadMoreFailure(store, "boom");
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      /^500 items · couldn't load more · 1 selected$/,
    );
  });

  it("exhausted: nextCursor === null renders plain 'N items' (existing no-suffix behavior)", () => {
    const store = makeStore();
    seedN(store, 42);
    act(() => {
      store.applyInitialPage({
        entries: store.getSnapshot().entries,
        truncated: false,
        nextCursor: null,
      });
    });
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/^42 items$/);
  });

  it("suppresses the more-available suffix when a tagged error owns the pane (errorTag !== null)", () => {
    // A refetch (e.g. post-upload retryLoad) fails `disconnected` while a
    // stale `nextCursor` + entries linger. The main pane shows the
    // full-replace DisconnectedState; the status row must NOT claim
    // "N+ items · N loaded" — it falls back to the plain count.
    const store = makeStore();
    seedN(store, 500);
    act(() => {
      store.applyInitialPage({
        entries: store.getSnapshot().entries,
        truncated: true,
        nextCursor: "tokA",
      });
    });
    act(() => {
      store.setErrorTag("disconnected");
      store.setError("offline");
    });
    render(<StatusRow store={store} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^500 items$/);
  });

  it("suppresses the load-failed suffix when a tagged error owns the pane", async () => {
    const store = makeStore();
    seedN(store, 500);
    act(() => {
      store.applyInitialPage({
        entries: store.getSnapshot().entries,
        truncated: true,
        nextCursor: "tokA",
      });
    });
    await driveLoadMoreFailure(store, "boom");
    act(() => {
      store.setErrorTag("disconnected");
      store.setError("offline");
    });
    render(<StatusRow store={store} />);
    // loadMoreError lingers, but the tagged error owns the pane → plain.
    expect(screen.getByRole("status")).toHaveTextContent(/^500 items$/);
  });
});

describe("StatusRow — reactivity", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("re-renders the item count within one render when entries change", () => {
    const store = makeStore();
    render(<StatusRow store={store} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^0 items$/);

    act(() => {
      store.setEntries([
        seedEntry({ id: "a", name: "a.txt" }),
        seedEntry({ id: "b", name: "b.txt" }),
        seedEntry({ id: "c", name: "c.txt" }),
      ]);
    });
    expect(screen.getByRole("status")).toHaveTextContent(/^3 items$/);
  });

  it("re-renders the selected count within one render when selection changes", () => {
    const store = makeStore();
    const entries = Array.from({ length: 4 }, (_, i) =>
      seedEntry({ id: `e-${i}`, name: `file-${i}.txt` }),
    );
    act(() => {
      store.setEntries(entries);
    });
    render(<StatusRow store={store} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^4 items$/);

    act(() => {
      store.select("e-0", "replace");
    });
    expect(screen.getByRole("status")).toHaveTextContent(/4 items\s·\s1 selected/);

    act(() => {
      store.select("e-2", "toggle");
    });
    expect(screen.getByRole("status")).toHaveTextContent(/4 items\s·\s2 selected/);

    act(() => {
      store.clearSelection();
    });
    expect(screen.getByRole("status")).toHaveTextContent(/^4 items$/);
  });
});

describe("StatusRow — search active", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("normal results: renders 'Showing N results for \"<query>\"'", () => {
    const store = makeStore();
    act(() => {
      store.startSearch();
    });
    act(() => {
      store.setSearchQuery("budget");
    });
    const results = Array.from({ length: 7 }, (_, i) =>
      seedEntry({ id: `r-${i}`, name: `budget-${i}.xlsx` }),
    );
    act(() => {
      store.setSearchResults(results, false);
    });
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/Showing\s7\sresults for "budget"/);
    expect(status.textContent).not.toMatch(/truncated/);
  });

  it("truncated results: appends ' · truncated'", () => {
    const store = makeStore();
    act(() => {
      store.startSearch();
    });
    act(() => {
      store.setSearchQuery("x");
    });
    const results = Array.from({ length: 50 }, (_, i) =>
      seedEntry({ id: `r-${i}`, name: `x-${i}.txt` }),
    );
    act(() => {
      store.setSearchResults(results, true);
    });
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/Showing\s50\sresults for "x"/);
    expect(status).toHaveTextContent(/·\struncated/);
  });

  it("provider-deferred (Drive / OneDrive): surfaces a 'not yet wired' message", () => {
    const store = makeStore();
    act(() => {
      store.startSearch();
    });
    act(() => {
      store.setSearchQuery("annual-review");
    });
    // Drive / OneDrive v1 handlers return an empty, truncated response with
    // providerSearchDeferred=true. The status row must surface the deferred
    // state rather than announce "0 results".
    act(() => {
      store.setSearchResults([], true, true);
    });
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    // Don't pin the exact wording — the spec uses one phrasing, the design
    // note uses another. Assert the critical "not yet" / deferred signal
    // per the task brief.
    expect(status.textContent ?? "").toMatch(/not yet/i);
  });

  it("numeric result count is wrapped in a tabular-nums element", () => {
    const store = makeStore();
    act(() => {
      store.startSearch();
    });
    act(() => {
      store.setSearchQuery("report");
    });
    const results = Array.from({ length: 7 }, (_, i) =>
      seedEntry({ id: `r-${i}`, name: `report-${i}.pdf` }),
    );
    act(() => {
      store.setSearchResults(results, false);
    });
    render(<StatusRow store={store} />);
    const status = screen.getByRole("status");
    const numericSpans = Array.from(
      status.querySelectorAll<HTMLElement>(".tabular-nums"),
    );
    const digitTexts = numericSpans.map((el) => el.textContent ?? "");
    expect(digitTexts).toContain("7");
  });
});

describe("deriveStatusText (pure helper)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("idle with entries renders the same text the component does", () => {
    const store = makeStore();
    const entries = Array.from({ length: 5 }, (_, i) =>
      seedEntry({ id: `e-${i}`, name: `file-${i}.txt` }),
    );
    act(() => {
      store.setEntries(entries);
    });
    const node = deriveStatusText(store.getSnapshot());
    const { container } = render(<div>{node}</div>);
    expect(container.textContent).toMatch(/^5 items$/);
  });

  it("idle with selection renders the combined text", () => {
    const store = makeStore();
    const entries = Array.from({ length: 5 }, (_, i) =>
      seedEntry({ id: `e-${i}`, name: `file-${i}.txt` }),
    );
    act(() => {
      store.setEntries(entries);
    });
    act(() => {
      store.select("e-0", "replace");
    });
    const node = deriveStatusText(store.getSnapshot());
    const { container } = render(<div>{node}</div>);
    expect(container.textContent).toMatch(/5 items\s·\s1 selected/);
  });

  it("search active renders 'Showing N results for \"q\"'", () => {
    const store = makeStore();
    act(() => {
      store.startSearch();
    });
    act(() => {
      store.setSearchQuery("q");
    });
    const results = [seedEntry({ id: "r", name: "q-file.txt" })];
    act(() => {
      store.setSearchResults(results, false);
    });
    const node = deriveStatusText(store.getSnapshot());
    const { container } = render(<div>{node}</div>);
    expect(container.textContent).toMatch(/Showing\s1\sresults for "q"/);
  });
});
