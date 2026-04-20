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
import { LargeIconsView } from "../large-icons.js";
import { seedEntry } from "../../__tests__/test-utils.js";

/**
 * LargeIconsView — per design.md Decision 3:
 *   96 px icon above name; wrapping grid.
 *
 * Shares the `<IconAboveNameCell>` helper with MediumIconsView; the
 * difference is the icon renders at `size-24` (96 px) and the grid
 * uses a wider cell minimum track.
 */

function makeStore(id = "large-test"): ExplorerStore {
  return createExplorerStore(id);
}

function getCells(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="explorer-cell"]'),
  );
}

describe("LargeIconsView", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders one cell per entry", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "alpha.png", path: "/alpha.png" }),
        seedEntry({
          id: "e2",
          name: "beta.txt",
          path: "/beta.txt",
          mimeFamily: "text",
        }),
        seedEntry({
          id: "e3",
          name: "gamma",
          path: "/gamma",
          kind: "directory",
          size: null,
          mimeFamily: "unknown",
        }),
      ]);
    });

    render(<LargeIconsView store={store} />);
    expect(getCells()).toHaveLength(3);
  });

  it("stacks the icon above the name in DOM order; no metadata lines", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "hero.png", path: "/hero.png", size: 12_288 }),
      ]);
    });
    render(<LargeIconsView store={store} />);

    const cell = getCells()[0]!;
    const icon = cell.querySelector("svg");
    const nameEl = within(cell).getByText("hero.png");
    expect(icon).not.toBeNull();
    expect(
      icon!.compareDocumentPosition(nameEl) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(within(cell).queryByText(/image/i)).toBeNull();
    expect(within(cell).queryByText(/12(\.0)?\s*KB/i)).toBeNull();
  });

  it("renders the icon at 96 px (size-24)", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "hero.png", path: "/hero.png" }),
      ]);
    });
    render(<LargeIconsView store={store} />);

    const cell = getCells()[0]!;
    const icon = cell.querySelector("svg")!;
    expect(icon.getAttribute("class") ?? "").toMatch(/\bsize-24\b/);
  });

  it("outer container uses an auto-fill wrapping grid with a wider cell minimum than Medium", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a.png", path: "/a.png" }),
      ]);
    });
    render(<LargeIconsView store={store} />);
    const grid = screen.getByRole("grid");
    expect(grid.className).toMatch(/\bgrid\b/);
    expect(grid.className).toMatch(/auto-fill/);
    // Design.md Decision 3: Large cells are wider than Medium. Medium
    // declares a `minmax(8rem,...)` column track; Large should declare
    // at least `minmax(10rem,...)`.
    expect(grid.className).toMatch(/minmax\(10rem/);
  });

  it("clicking a cell replaces the selection via useSelection", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a.png", path: "/a.png" }),
        seedEntry({ id: "e2", name: "b.png", path: "/b.png" }),
      ]);
    });
    render(<LargeIconsView store={store} />);

    const cells = getCells();
    fireEvent.click(cells[1]!);
    const sel = store.getSnapshot().selection;
    expect(sel.has("e2")).toBe(true);
    expect(sel.size).toBe(1);
  });

  it("selected cell carries bg-accent", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([seedEntry({ id: "e1", name: "a", path: "/a" })]);
    });
    render(<LargeIconsView store={store} />);

    const cell = getCells()[0]!;
    fireEvent.click(cell);
    expect(cell.className).toMatch(/\bbg-accent\b/);
  });

  it("pending-op cell renders with opacity-60", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a", path: "/a" }),
        seedEntry({ id: "e2", name: "b", path: "/b" }),
      ]);
    });
    render(<LargeIconsView store={store} />);
    act(() => {
      store.startPendingOp("e1", "rename");
    });

    const cells = getCells();
    expect(cells[0]!.className).toMatch(/\bopacity-60\b/);
    expect(cells[1]!.className).not.toMatch(/\bopacity-60\b/);
  });

  it("renders 'This folder is empty' when entries are empty", () => {
    const store = makeStore();
    render(<LargeIconsView store={store} />);
    expect(screen.getByText(/this folder is empty/i)).toBeInTheDocument();
    expect(getCells()).toHaveLength(0);
  });

  it("directory entries render with the folder icon", () => {
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
    render(<LargeIconsView store={store} />);

    const cell = getCells()[0]!;
    const icon = cell.querySelector("svg")!;
    expect(icon.getAttribute("class") ?? "").toMatch(/lucide-folder(?!-)/);
  });
});
