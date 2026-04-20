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
import { TilesView } from "../tiles.js";
import { seedEntry } from "../../__tests__/test-utils.js";

/**
 * TilesView — wrapping grid of 64-px-icon cards (design.md Decision 3).
 * Each tile has the icon on the left and a column with name + type +
 * size on the right. Type mirrors DetailsView's `formatType` rule —
 * capitalized mimeFamily for files, "Folder" for directories. Size uses
 * `formatSize` and carries the `tabular-nums` class so digit widths
 * stay stable as tiles wrap.
 *
 * Tiles carry `data-testid="explorer-tile"` so tests can filter them
 * from the full `role="gridcell"` set.
 */

function makeStore(id = "tiles-test"): ExplorerStore {
  return createExplorerStore(id);
}

function getTiles(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="explorer-tile"]'),
  );
}

describe("TilesView", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders one tile per entry", () => {
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
    render(<TilesView store={store} />);
    expect(getTiles()).toHaveLength(3);
  });

  it("each tile shows a 64-px icon (size-16) plus name plus two metadata lines (type and size)", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "alpha.png", path: "/alpha.png" }),
      ]);
    });
    render(<TilesView store={store} />);
    const tile = getTiles()[0]!;
    // Icon: size-16 == 64 px.
    const svg = tile.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("class") ?? "").toMatch(/\bsize-16\b/);

    // Name visible.
    expect(within(tile).getByText("alpha.png")).toBeInTheDocument();
    // Type visible — "image" (mimeFamily) capitalized by formatType.
    expect(within(tile).getByText("Image")).toBeInTheDocument();
    // Size visible — 12 KB from the seed fixture (12_288 bytes).
    expect(within(tile).getByText("12 KB")).toBeInTheDocument();
  });

  it("the size line carries the tabular-nums class", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "alpha.png", path: "/alpha.png" }),
      ]);
    });
    render(<TilesView store={store} />);
    const tile = getTiles()[0]!;
    const sizeEl = within(tile).getByTestId("explorer-tile-size");
    expect(sizeEl.className).toMatch(/\btabular-nums\b/);
  });

  it("outer container uses a wrapping grid layout", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a.png", path: "/a.png" }),
      ]);
    });
    render(<TilesView store={store} />);
    const grid = screen.getByRole("grid");
    expect(grid.className).toMatch(/\bgrid\b/);
    // Either `grid-cols-<N>` or the auto-fill template counts as
    // "wrapping grid".
    expect(grid.className).toMatch(/\bgrid-cols-/);
  });

  it("clicking a tile replaces selection with that entry", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a.png", path: "/a.png" }),
        seedEntry({ id: "e2", name: "b.png", path: "/b.png" }),
      ]);
    });
    render(<TilesView store={store} />);
    const tiles = getTiles();
    fireEvent.click(tiles[1]!);
    const sel = store.getSnapshot().selection;
    expect(sel.has("e2")).toBe(true);
    expect(sel.size).toBe(1);
  });

  it("selected tile carries the bg-accent class", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([seedEntry({ id: "e1", name: "a.png", path: "/a.png" })]);
    });
    render(<TilesView store={store} />);
    const tile = getTiles()[0]!;
    fireEvent.click(tile);
    expect(tile.className).toMatch(/\bbg-accent\b/);
  });

  it("pending-op tile renders with opacity-60 and the inline pulse glyph", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a.png", path: "/a.png" }),
        seedEntry({ id: "e2", name: "b.png", path: "/b.png" }),
      ]);
    });
    render(<TilesView store={store} />);

    act(() => {
      store.startPendingOp("e1", "rename");
    });

    const tile = getTiles()[0]!;
    expect(tile.className).toMatch(/\bopacity-60\b/);
    const pulse = within(tile).getByTestId("explorer-pending-glyph");
    expect(pulse.className).toMatch(/\banimate-sync-pulse\b/);

    const otherTile = getTiles()[1]!;
    expect(otherTile.className).not.toMatch(/\bopacity-60\b/);
  });

  it("renders 'This folder is empty' when there are no entries", () => {
    const store = makeStore();
    render(<TilesView store={store} />);
    expect(screen.getByText(/this folder is empty/i)).toBeInTheDocument();
    expect(getTiles()).toHaveLength(0);
  });

  it("directory tile shows the folder icon, 'Folder' as type, and '\u2014' as size", () => {
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
    render(<TilesView store={store} />);
    const tile = getTiles()[0]!;
    const svg = tile.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("class") ?? "").toMatch(/\blucide-folder\b/);
    expect(within(tile).getByText("Folder")).toBeInTheDocument();
    expect(within(tile).getByText("\u2014")).toBeInTheDocument();
  });
});
