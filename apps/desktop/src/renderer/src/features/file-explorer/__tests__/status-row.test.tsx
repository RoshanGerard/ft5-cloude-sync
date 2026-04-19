/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

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
