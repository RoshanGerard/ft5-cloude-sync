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
import { MediumIconsView } from "../medium-icons.js";
import { seedEntry } from "../../__tests__/test-utils.js";

/**
 * MediumIconsView — per design.md Decision 3:
 *   64 px icon above name; wrapping grid.
 *
 * Structurally shares a `<IconAboveNameCell>` helper with LargeIconsView.
 * Distinguishing features vs. Tiles: icon sits ABOVE the name (not beside
 * it) and no metadata lines are rendered. Distinguishing features vs.
 * LargeIconsView: icon is `size-16` (64 px) rather than `size-24`
 * (96 px).
 */

function makeStore(id = "medium-test"): ExplorerStore {
  return createExplorerStore(id);
}

function getCells(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="explorer-cell"]'),
  );
}

describe("MediumIconsView", () => {
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

    render(<MediumIconsView store={store} />);
    expect(getCells()).toHaveLength(3);
  });

  it("stacks the icon above the name in DOM order; no metadata lines", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "hero.png", path: "/hero.png", size: 12_288 }),
      ]);
    });
    render(<MediumIconsView store={store} />);

    const cell = getCells()[0]!;
    const icon = cell.querySelector("svg");
    const nameEl = within(cell).getByText("hero.png");
    expect(icon).not.toBeNull();
    // Icon appears before name in DOM order (icon-above-name vertical stack).
    expect(
      icon!.compareDocumentPosition(nameEl) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // No type label, no size label.
    expect(within(cell).queryByText(/image/i)).toBeNull();
    expect(within(cell).queryByText(/12(\.0)?\s*KB/i)).toBeNull();
  });

  it("renders the icon at 64 px (size-16)", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "hero.png", path: "/hero.png" }),
      ]);
    });
    render(<MediumIconsView store={store} />);

    const cell = getCells()[0]!;
    const icon = cell.querySelector("svg")!;
    expect(icon.getAttribute("class") ?? "").toMatch(/\bsize-16\b/);
  });

  it("outer container uses an auto-fill wrapping grid", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a.png", path: "/a.png" }),
      ]);
    });
    render(<MediumIconsView store={store} />);
    const grid = screen.getByRole("grid");
    expect(grid.className).toMatch(/\bgrid\b/);
    expect(grid.className).toMatch(/auto-fill/);
  });

  it("clicking a cell replaces the selection via useSelection", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a.png", path: "/a.png" }),
        seedEntry({ id: "e2", name: "b.png", path: "/b.png" }),
      ]);
    });
    render(<MediumIconsView store={store} />);

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
    render(<MediumIconsView store={store} />);

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
    render(<MediumIconsView store={store} />);
    act(() => {
      store.startPendingOp("e1", "rename");
    });

    const cells = getCells();
    expect(cells[0]!.className).toMatch(/\bopacity-60\b/);
    expect(cells[1]!.className).not.toMatch(/\bopacity-60\b/);
  });

  it("renders 'This folder is empty' when entries are empty", () => {
    const store = makeStore();
    render(<MediumIconsView store={store} />);
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
    render(<MediumIconsView store={store} />);

    // Lucide renders the folder glyph as an SVG whose class list carries
    // `lucide-folder`. The Icon adapter preserves class names from
    // lucide-react.
    const cell = getCells()[0]!;
    const icon = cell.querySelector("svg")!;
    expect(icon.getAttribute("class") ?? "").toMatch(/lucide-folder(?!-)/);
  });
});
