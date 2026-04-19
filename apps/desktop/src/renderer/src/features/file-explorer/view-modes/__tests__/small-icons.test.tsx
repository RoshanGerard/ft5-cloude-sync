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
import { SmallIconsView } from "../small-icons.js";
import { seedEntry } from "../../__tests__/test-utils.js";

/**
 * SmallIconsView — wrapping flex flow of 16-px icon + name cells
 * (design.md Decision 3). Per-cell semantics mirror DetailsView: the
 * shared `useSelection` hook handles click-mode translation, pending-op
 * rows render at `opacity-60` with the `animate-sync-pulse` glyph, and
 * the empty state text matches Details ("This folder is empty").
 *
 * Cells carry `data-testid="explorer-cell"` so tests can filter them out
 * of any incidental role="listitem" elements.
 */

function makeStore(id = "si-test"): ExplorerStore {
  return createExplorerStore(id);
}

function getCells(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="explorer-cell"]'),
  );
}

describe("SmallIconsView", () => {
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
        seedEntry({ id: "e2", name: "beta.txt", path: "/beta.txt", mimeFamily: "text" }),
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
    render(<SmallIconsView store={store} />);
    expect(getCells()).toHaveLength(3);
  });

  it("each cell shows only icon + name (no type / size / modified labels)", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "alpha.png", path: "/alpha.png" }),
      ]);
    });
    render(<SmallIconsView store={store} />);
    const cell = getCells()[0]!;
    expect(within(cell).getByText("alpha.png")).toBeInTheDocument();
    // Size / type / modified strings produced by formatters should NOT
    // appear in a Small Icons cell.
    expect(cell.textContent).not.toMatch(/12 KB/);
    expect(cell.textContent).not.toMatch(/Image/);
    expect(cell.textContent).not.toMatch(/Apr 18, 2026/);
  });

  it("icon in each cell carries the size-4 class (16 px)", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "alpha.png", path: "/alpha.png" }),
      ]);
    });
    render(<SmallIconsView store={store} />);
    const cell = getCells()[0]!;
    // The icon is the SVG rendered by the Icon adapter; the size-4
    // Tailwind class sets width/height to 1rem == 16 px.
    const svg = cell.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("class") ?? "").toMatch(/\bsize-4\b/);
  });

  it("outer container uses a wrapping flex layout when populated", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a.png", path: "/a.png" }),
      ]);
    });
    render(<SmallIconsView store={store} />);
    const list = screen.getByRole("list");
    expect(list.className).toMatch(/\bflex\b/);
    expect(list.className).toMatch(/\bflex-wrap\b/);
  });

  it("clicking a cell replaces selection with that entry", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a.png", path: "/a.png" }),
        seedEntry({ id: "e2", name: "b.png", path: "/b.png" }),
      ]);
    });
    render(<SmallIconsView store={store} />);
    const cells = getCells();
    fireEvent.click(cells[1]!);
    const sel = store.getSnapshot().selection;
    expect(sel.has("e2")).toBe(true);
    expect(sel.size).toBe(1);
  });

  it("selected cell carries the bg-accent class", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([seedEntry({ id: "e1", name: "a.png", path: "/a.png" })]);
    });
    render(<SmallIconsView store={store} />);
    const cell = getCells()[0]!;
    fireEvent.click(cell);
    expect(cell.className).toMatch(/\bbg-accent\b/);
  });

  it("pending-op cell renders with opacity-60 and the inline pulse glyph", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a.png", path: "/a.png" }),
        seedEntry({ id: "e2", name: "b.png", path: "/b.png" }),
      ]);
    });
    render(<SmallIconsView store={store} />);

    act(() => {
      store.startPendingOp("e1", "rename");
    });

    const cell = getCells()[0]!;
    expect(cell.className).toMatch(/\bopacity-60\b/);
    const pulse = within(cell).getByTestId("explorer-pending-glyph");
    expect(pulse.className).toMatch(/\banimate-sync-pulse\b/);

    const otherCell = getCells()[1]!;
    expect(otherCell.className).not.toMatch(/\bopacity-60\b/);
  });

  it("renders 'This folder is empty' when there are no entries", () => {
    const store = makeStore();
    render(<SmallIconsView store={store} />);
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
    render(<SmallIconsView store={store} />);
    // Lucide icons render with a `lucide-<name>` class on their SVG.
    const cell = getCells()[0]!;
    const svg = cell.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("class") ?? "").toMatch(/\blucide-folder\b/);
  });
});
