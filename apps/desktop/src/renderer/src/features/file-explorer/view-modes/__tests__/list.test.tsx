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
import { ListView } from "../list.js";
import { seedEntry } from "../../__tests__/test-utils.js";

/**
 * ListView — compact single-column view mode (design.md Decision 3).
 *
 * Rows are semantic `role="listitem"` elements carrying only an icon and
 * the entry name — NO type / size / modified columns. Clicks flow through
 * the shared `useSelection` hook, so modifier-key semantics (shift-range,
 * ctrl-toggle) are tested at the sanity-check level here — the exhaustive
 * mode-translation tests live in `details.test.tsx`.
 *
 * Data rows are discoverable via `data-testid="explorer-list-row"` so
 * tests can filter out any future chrome (header / status / empty state)
 * that also lives inside the root element.
 */

function makeStore(id = "ls-test"): ExplorerStore {
  return createExplorerStore(id);
}

function getListRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="explorer-list-row"]'),
  );
}

describe("ListView", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders one row per entry", () => {
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

    render(<ListView store={store} />);
    expect(getListRows()).toHaveLength(3);
  });

  it("each row contains only icon + name (no type/size/modified text)", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({
          id: "e1",
          name: "alpha.png",
          path: "/alpha.png",
          size: 12_288,
          modifiedAt: "2026-04-18T10:30:00.000Z",
        }),
      ]);
    });
    render(<ListView store={store} />);

    const row = getListRows()[0]!;
    // An SVG icon is present.
    expect(row.querySelector("svg")).not.toBeNull();
    // Row text content is exactly the entry name — no size (12 KB), no
    // modified date, no mime-type columns bleeding in.
    expect(row.textContent?.trim()).toBe("alpha.png");
  });

  it("uses list semantics (role='list' container, role='listitem' rows)", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([seedEntry({ id: "e1", name: "a", path: "/a" })]);
    });
    render(<ListView store={store} />);

    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("rows are tabbable (tabIndex=0) for Phase 4 keyboard nav wiring", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([seedEntry({ id: "e1", name: "a", path: "/a" })]);
    });
    render(<ListView store={store} />);

    const row = getListRows()[0]!;
    expect(row.getAttribute("tabindex")).toBe("0");
  });

  it("clicking a row replaces selection with that entry", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a", path: "/a" }),
        seedEntry({ id: "e2", name: "b", path: "/b" }),
        seedEntry({ id: "e3", name: "c", path: "/c" }),
      ]);
    });
    render(<ListView store={store} />);

    const rows = getListRows();
    fireEvent.click(rows[1]!);
    const sel = store.getSnapshot().selection;
    expect(sel.has("e2")).toBe(true);
    expect(sel.size).toBe(1);
  });

  it("shift-click selects an inclusive range (shared hook wired)", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a", path: "/a" }),
        seedEntry({ id: "e2", name: "b", path: "/b" }),
        seedEntry({ id: "e3", name: "c", path: "/c" }),
        seedEntry({ id: "e4", name: "d", path: "/d" }),
      ]);
    });
    render(<ListView store={store} />);

    const rows = getListRows();
    fireEvent.click(rows[0]!);
    fireEvent.click(rows[2]!, { shiftKey: true });

    const sel = store.getSnapshot().selection;
    expect(sel.has("e1")).toBe(true);
    expect(sel.has("e2")).toBe(true);
    expect(sel.has("e3")).toBe(true);
    expect(sel.has("e4")).toBe(false);
    expect(sel.size).toBe(3);
  });

  it("ctrl-click toggles an entry into/out of the selection", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([
        seedEntry({ id: "e1", name: "a", path: "/a" }),
        seedEntry({ id: "e2", name: "b", path: "/b" }),
      ]);
    });
    render(<ListView store={store} />);

    const rows = getListRows();
    fireEvent.click(rows[0]!);
    fireEvent.click(rows[1]!, { ctrlKey: true });
    expect(store.getSnapshot().selection.has("e2")).toBe(true);
    fireEvent.click(rows[1]!, { ctrlKey: true });

    const sel = store.getSnapshot().selection;
    expect(sel.has("e1")).toBe(true);
    expect(sel.has("e2")).toBe(false);
    expect(sel.size).toBe(1);
  });

  it("selected row carries the bg-accent class", () => {
    const store = makeStore();
    act(() => {
      store.setEntries([seedEntry({ id: "e1", name: "a", path: "/a" })]);
    });
    render(<ListView store={store} />);

    const row = getListRows()[0]!;
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
    render(<ListView store={store} />);

    act(() => {
      store.startPendingOp("e1", "rename");
    });

    const row = getListRows()[0]!;
    expect(row.className).toMatch(/\bopacity-60\b/);
    const pulse = within(row).getByTestId("explorer-pending-glyph");
    expect(pulse.className).toMatch(/\banimate-sync-pulse\b/);

    const otherRow = getListRows()[1]!;
    expect(otherRow.className).not.toMatch(/\bopacity-60\b/);
  });

  it("renders 'This folder is empty' when entries are empty", () => {
    const store = makeStore();
    render(<ListView store={store} />);
    expect(screen.getByText(/this folder is empty/i)).toBeInTheDocument();
    expect(getListRows()).toHaveLength(0);
  });

  it("directory entries render the folder icon, not a file-family icon", () => {
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
    render(<ListView store={store} />);

    const row = getListRows()[0]!;
    const svg = row.querySelector("svg");
    expect(svg).not.toBeNull();
    // lucide tags each rendered icon's <svg> with `lucide-<kebab-name>`.
    // Directory entries must resolve to `folder` (via iconForEntry), never
    // a file-family glyph.
    const cls = svg!.getAttribute("class") ?? "";
    expect(cls).toMatch(/\blucide-folder\b/);
    expect(cls).not.toMatch(/\blucide-file\b/);
  });
});
