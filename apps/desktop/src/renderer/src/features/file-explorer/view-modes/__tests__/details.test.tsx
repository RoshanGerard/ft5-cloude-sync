/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { createExplorerStore } from "../../store.js";
import type { ExplorerStore } from "../../store.js";
import { DetailsView } from "../details.js";
import { seedEntry } from "../../__tests__/test-utils.js";

/**
 * DetailsView — the default view mode. A five-column ARIA grid:
 *   icon | name | type | size | modified
 *
 * Tests use a fresh `createExplorerStore(id)` per case to avoid leaking
 * state through the module-level cache used by `useExplorerStore`.
 *
 * Data rows carry `data-testid="explorer-row"` so tests can filter them
 * out of the full `role="row"` set (which includes the column header
 * row). This pattern will be reused by the five other view-mode tests
 * as those land in later phases.
 */

function makeStore(id = "ds-test"): ExplorerStore {
  return createExplorerStore(id);
}

function getDataRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="explorer-row"]'),
  );
}

describe("DetailsView", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders one row per entry (header row excluded)", () => {
    const store = makeStore();
    const entries = [
      seedEntry({ id: "e1", name: "alpha.png", path: "/alpha.png" }),
      seedEntry({ id: "e2", name: "beta.txt", path: "/beta.txt", mimeFamily: "text" }),
      seedEntry({
        id: "e3",
        name: "gamma",
        path: "/gamma",
        kind: "directory",
        size: null,
        mimeFamily: "unknown",
      }),
    ];
    act(() => {
      store.setEntries(entries);
    });

    render(<DetailsView store={store} />);
    expect(getDataRows()).toHaveLength(3);
  });

  it("renders column headers in order: icon / name / type / size / modified", () => {
    const store = makeStore();
    render(<DetailsView store={store} />);

    // Name / Type / Size / Modified are keyboard-activatable column headers.
    const nameHeader = screen.getByRole("columnheader", { name: /name/i });
    const typeHeader = screen.getByRole("columnheader", { name: /type/i });
    const sizeHeader = screen.getByRole("columnheader", { name: /size/i });
    const modifiedHeader = screen.getByRole("columnheader", {
      name: /modified/i,
    });

    const headers = screen.getAllByRole("columnheader");
    // Five columns total: icon (unnamed / aria-hidden) + the four labelled ones.
    expect(headers).toHaveLength(5);

    // Order: the indexOf values in `headers` reflect the visual left-to-right
    // order of columnheader elements in the DOM.
    const nameIdx = headers.indexOf(nameHeader);
    const typeIdx = headers.indexOf(typeHeader);
    const sizeIdx = headers.indexOf(sizeHeader);
    const modifiedIdx = headers.indexOf(modifiedHeader);

    expect(nameIdx).toBeGreaterThan(-1);
    expect(nameIdx).toBeLessThan(typeIdx);
    expect(typeIdx).toBeLessThan(sizeIdx);
    expect(sizeIdx).toBeLessThan(modifiedIdx);
    // The icon column is the first header (index 0) and the name column
    // sits at index 1 (the name is the header labelled "Name").
    expect(nameIdx).toBe(1);
  });

  it("size and modified cells carry the tabular-nums class", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "alpha.png", path: "/alpha.png" }),
      ]);
    });
    render(<DetailsView store={store} />);

    const row = getDataRows()[0];
    expect(row).toBeDefined();
    const sizeCell = within(row!).getByTestId("explorer-cell-size");
    const modifiedCell = within(row!).getByTestId("explorer-cell-modified");
    expect(sizeCell.className).toMatch(/\btabular-nums\b/);
    expect(modifiedCell.className).toMatch(/\btabular-nums\b/);
  });

  it("renders 'This folder is empty' when entries are empty", () => {
    const store = makeStore();
    render(<DetailsView store={store} />);
    expect(screen.getByText(/this folder is empty/i)).toBeInTheDocument();
    expect(getDataRows()).toHaveLength(0);
  });

  it("clicking a row replaces selection with that entry", () => {
    const store = makeStore();
    const entries = [
      seedEntry({ id: "e1", name: "a.png", path: "/a.png" }),
      seedEntry({ id: "e2", name: "b.png", path: "/b.png" }),
      seedEntry({ id: "e3", name: "c.png", path: "/c.png" }),
    ];
    act(() => {
      store.setEntries(entries);
    });
    render(<DetailsView store={store} />);

    const rows = getDataRows();
    fireEvent.click(rows[1]!);
    const sel = store.getSnapshot().selection;
    expect(sel.has("e2")).toBe(true);
    expect(sel.size).toBe(1);
  });

  it("shift-click selects an inclusive range", () => {
    const store = makeStore();
    const entries = [
      seedEntry({ id: "e1", name: "a", path: "/a" }),
      seedEntry({ id: "e2", name: "b", path: "/b" }),
      seedEntry({ id: "e3", name: "c", path: "/c" }),
      seedEntry({ id: "e4", name: "d", path: "/d" }),
    ];
    act(() => {
      store.setEntries(entries);
    });
    render(<DetailsView store={store} />);

    const rows = getDataRows();
    fireEvent.click(rows[0]!); // anchor at e1
    fireEvent.click(rows[2]!, { shiftKey: true }); // range e1..e3

    const sel = store.getSnapshot().selection;
    expect(sel.has("e1")).toBe(true);
    expect(sel.has("e2")).toBe(true);
    expect(sel.has("e3")).toBe(true);
    expect(sel.has("e4")).toBe(false);
    expect(sel.size).toBe(3);
  });

  it("ctrl-click toggles an entry into and out of the selection", () => {
    const store = makeStore();
    const entries = [
      seedEntry({ id: "e1", name: "a", path: "/a" }),
      seedEntry({ id: "e2", name: "b", path: "/b" }),
    ];
    act(() => {
      store.setEntries(entries);
    });
    render(<DetailsView store={store} />);

    const rows = getDataRows();
    fireEvent.click(rows[0]!); // replace → {e1}
    fireEvent.click(rows[1]!, { ctrlKey: true }); // toggle-in → {e1, e2}
    expect(store.getSnapshot().selection.has("e2")).toBe(true);
    fireEvent.click(rows[1]!, { ctrlKey: true }); // toggle-out → {e1}

    const sel = store.getSnapshot().selection;
    expect(sel.has("e1")).toBe(true);
    expect(sel.has("e2")).toBe(false);
    expect(sel.size).toBe(1);
  });

  it("clicking a column header cycles sort direction", () => {
    const store = makeStore();
    // Seed a different sort column first so the first click on the Name
    // header lands on `name/asc` rather than toggling the default
    // `name/asc → name/desc`. The store's `setSort(by)` rule is: same
    // column toggles dir, different column resets to asc.
    act(() => {
      store.setSort("modified");
    });
    render(<DetailsView store={store} />);

    const nameHeader = screen.getByRole("columnheader", { name: /name/i });
    // Inside the header is a button that dispatches `setSort("name")`.
    const nameButton = within(nameHeader).getByRole("button", { name: /name/i });

    fireEvent.click(nameButton);
    expect(store.getSnapshot().sortBy).toBe("name");
    expect(store.getSnapshot().sortDir).toBe("asc");

    fireEvent.click(nameButton);
    expect(store.getSnapshot().sortBy).toBe("name");
    expect(store.getSnapshot().sortDir).toBe("desc");

    const sizeHeader = screen.getByRole("columnheader", { name: /size/i });
    const sizeButton = within(sizeHeader).getByRole("button", { name: /size/i });
    fireEvent.click(sizeButton);
    expect(store.getSnapshot().sortBy).toBe("size");
    expect(store.getSnapshot().sortDir).toBe("asc");
  });

  it("selected row carries the bg-accent class", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([seedEntry({ id: "e1", name: "a", path: "/a" })]);
    });
    render(<DetailsView store={store} />);

    const row = getDataRows()[0]!;
    fireEvent.click(row);
    expect(row.className).toMatch(/\bbg-accent\b/);
  });

  it("pending-op row renders with opacity-60 and an inline pulse glyph", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a", path: "/a" }),
        seedEntry({ id: "e2", name: "b", path: "/b" }),
      ]);
    });
    render(<DetailsView store={store} />);

    act(() => {
      store.startPendingOp("e1", "rename");
    });

    const row = getDataRows()[0]!;
    expect(row.className).toMatch(/\bopacity-60\b/);
    // Inline pulse glyph uses the motion-budget `animate-sync-pulse`
    // utility (per design.md Decision 7 / spec).
    const pulse = within(row).getByTestId("explorer-pending-glyph");
    expect(pulse.className).toMatch(/\banimate-sync-pulse\b/);

    // The other row remains unaffected.
    const otherRow = getDataRows()[1]!;
    expect(otherRow.className).not.toMatch(/\bopacity-60\b/);
  });

  it("uses ARIA grid semantics (role='grid' container, role='row' rows, role='cell' cells)", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([seedEntry({ id: "e1", name: "a", path: "/a" })]);
    });
    render(<DetailsView store={store} />);

    expect(screen.getByRole("grid")).toBeInTheDocument();
    // One header row + one data row.
    expect(screen.getAllByRole("row").length).toBeGreaterThanOrEqual(2);
    const dataRow = getDataRows()[0]!;
    expect(within(dataRow).getAllByRole("cell").length).toBe(5);
  });

  it("directory entries show an em-dash in the size cell", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({
          id: "e1",
          name: "docs",
          path: "/docs",
          kind: "directory",
          size: null,
          mimeFamily: "unknown",
        }),
      ]);
    });
    render(<DetailsView store={store} />);

    const sizeCell = screen.getByTestId("explorer-cell-size");
    expect(sizeCell.textContent).toContain("\u2014");
  });
});
