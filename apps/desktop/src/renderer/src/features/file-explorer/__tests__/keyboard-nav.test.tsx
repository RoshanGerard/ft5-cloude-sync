/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { FileEntry } from "@ft5/ipc-contracts";

import { createExplorerStore } from "../store.js";
import type { ExplorerStore } from "../store.js";
import { DetailsView } from "../view-modes/details.js";
import { useKeyboardNav } from "../use-keyboard-nav.js";
import { ViewModeSwitcher } from "../view-mode-switcher.js";
import { seedEntry } from "./test-utils.js";

/**
 * Keyboard navigation integration test (tasks 4.1 / 4.3). Mounts a view
 * mode (Details) composed with `useKeyboardNav` and exercises every
 * binding from the "Selection and keyboard navigation follow standard
 * conventions" requirement.
 *
 * The host component below mirrors the shape `ViewModeSwitcher` will
 * take after Phase 4.4 — it owns the keyboard hook, forwards the props
 * to the view mode, and binds `onKeyDown` to the outermost container.
 */

function makeFixture(): {
  store: ExplorerStore;
  entries: FileEntry[];
} {
  const store = createExplorerStore("ds-keynav");
  const entries: FileEntry[] = [
    seedEntry({ id: "e1", name: "alpha.txt", path: "/alpha.txt" }),
    seedEntry({ id: "e2", name: "beta.txt", path: "/beta.txt" }),
    seedEntry({ id: "e3", name: "docs", path: "/docs", kind: "directory", size: null, mimeFamily: "unknown" }),
    seedEntry({ id: "e4", name: "delta.txt", path: "/delta.txt" }),
    seedEntry({ id: "e5", name: "epsilon.txt", path: "/epsilon.txt" }),
  ];
  act(() => {
    store.setEntries(entries);
  });
  return { store, entries };
}

interface HostProps {
  store: ExplorerStore;
  entries: FileEntry[];
  onActivate?: (entry: FileEntry) => void;
  onRenameRequested?: (entry: FileEntry) => void;
  onDeleteRequested?: (entries: FileEntry[]) => void;
}

function Host({
  store,
  entries,
  onActivate,
  onRenameRequested,
  onDeleteRequested,
}: HostProps) {
  const kbd = useKeyboardNav(store, {
    entries,
    onActivate,
    onRenameRequested,
    onDeleteRequested,
  });
  return (
    <div onKeyDown={kbd.onKeyDown} data-testid="kbd-host">
      <DetailsView
        store={store}
        focusedId={kbd.focusedId}
        setFocusedId={kbd.setFocusedId}
      />
    </div>
  );
}

function getRow(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);
  if (el === null) throw new Error(`row not found: ${id}`);
  return el;
}

function getHost(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="kbd-host"]');
  if (el === null) throw new Error("host not found");
  return el;
}

describe("useKeyboardNav integration", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("ArrowDown moves focus to the next entry without changing selection", () => {
    const { store, entries } = makeFixture();
    render(<Host store={store} entries={entries} />);

    // Prime focus at e1.
    fireEvent.click(getRow("e1"));
    expect(store.getSnapshot().selection.has("e1")).toBe(true);

    fireEvent.keyDown(getHost(), { key: "ArrowDown" });
    // Focus moved to e2; selection still {e1} (arrow without shift doesn't
    // change selection).
    expect(store.getSnapshot().selection.has("e1")).toBe(true);
    expect(store.getSnapshot().selection.has("e2")).toBe(false);
    // The focused row paints the ring utility.
    expect(getRow("e2").className).toMatch(/ring-ring/);
  });

  it("ArrowUp moves focus to the previous entry", () => {
    const { store, entries } = makeFixture();
    render(<Host store={store} entries={entries} />);

    fireEvent.click(getRow("e3"));
    fireEvent.keyDown(getHost(), { key: "ArrowUp" });
    expect(getRow("e2").className).toMatch(/ring-ring/);
  });

  it("Shift+ArrowDown extends range selection", () => {
    const { store, entries } = makeFixture();
    render(<Host store={store} entries={entries} />);

    fireEvent.click(getRow("e1"));
    fireEvent.keyDown(getHost(), { key: "ArrowDown", shiftKey: true });
    const sel = store.getSnapshot().selection;
    expect(sel.has("e1")).toBe(true);
    expect(sel.has("e2")).toBe(true);
    expect(sel.size).toBe(2);
  });

  it("Shift+ArrowUp extends range selection upward", () => {
    const { store, entries } = makeFixture();
    render(<Host store={store} entries={entries} />);

    fireEvent.click(getRow("e3"));
    fireEvent.keyDown(getHost(), { key: "ArrowUp", shiftKey: true });
    const sel = store.getSnapshot().selection;
    expect(sel.has("e2")).toBe(true);
    expect(sel.has("e3")).toBe(true);
    expect(sel.size).toBe(2);
  });

  it("Home moves focus to the first entry", () => {
    const { store, entries } = makeFixture();
    render(<Host store={store} entries={entries} />);

    fireEvent.click(getRow("e4"));
    fireEvent.keyDown(getHost(), { key: "Home" });
    expect(getRow("e1").className).toMatch(/ring-ring/);
  });

  it("End moves focus to the last entry", () => {
    const { store, entries } = makeFixture();
    render(<Host store={store} entries={entries} />);

    fireEvent.click(getRow("e1"));
    fireEvent.keyDown(getHost(), { key: "End" });
    expect(getRow("e5").className).toMatch(/ring-ring/);
  });

  it("Enter on a directory navigates into it (default onActivate)", () => {
    const { store, entries } = makeFixture();
    const onActivate = vi.fn((entry: FileEntry) => {
      if (entry.kind === "directory") store.navigate(entry.path);
    });
    render(<Host store={store} entries={entries} onActivate={onActivate} />);

    fireEvent.click(getRow("e3")); // directory
    fireEvent.keyDown(getHost(), { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e3", kind: "directory" }),
    );
    expect(store.getSnapshot().currentPath).toBe("/docs");
  });

  it("Enter on a file calls onActivate with the file entry", () => {
    const { store, entries } = makeFixture();
    const onActivate = vi.fn();
    render(<Host store={store} entries={entries} onActivate={onActivate} />);

    fireEvent.click(getRow("e1"));
    fireEvent.keyDown(getHost(), { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e1", kind: "file" }),
    );
  });

  it("F2 on a file calls onRenameRequested", () => {
    const { store, entries } = makeFixture();
    const onRenameRequested = vi.fn();
    render(
      <Host
        store={store}
        entries={entries}
        onRenameRequested={onRenameRequested}
      />,
    );

    fireEvent.click(getRow("e1"));
    fireEvent.keyDown(getHost(), { key: "F2" });
    expect(onRenameRequested).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e1", kind: "file" }),
    );
  });

  it("F2 on a directory does NOT call onRenameRequested", () => {
    const { store, entries } = makeFixture();
    const onRenameRequested = vi.fn();
    render(
      <Host
        store={store}
        entries={entries}
        onRenameRequested={onRenameRequested}
      />,
    );

    fireEvent.click(getRow("e3")); // directory
    fireEvent.keyDown(getHost(), { key: "F2" });
    expect(onRenameRequested).not.toHaveBeenCalled();
  });

  it("Delete with a non-empty selection calls onDeleteRequested with the selected entries", () => {
    const { store, entries } = makeFixture();
    const onDeleteRequested = vi.fn();
    render(
      <Host
        store={store}
        entries={entries}
        onDeleteRequested={onDeleteRequested}
      />,
    );

    fireEvent.click(getRow("e1"));
    fireEvent.click(getRow("e2"), { ctrlKey: true });
    fireEvent.keyDown(getHost(), { key: "Delete" });

    expect(onDeleteRequested).toHaveBeenCalledTimes(1);
    const arg = onDeleteRequested.mock.calls[0]![0] as FileEntry[];
    const ids = arg.map((e) => e.id).sort();
    expect(ids).toEqual(["e1", "e2"]);
  });

  it("Delete with an empty selection is a no-op", () => {
    const { store, entries } = makeFixture();
    const onDeleteRequested = vi.fn();
    render(
      <Host
        store={store}
        entries={entries}
        onDeleteRequested={onDeleteRequested}
      />,
    );

    // No click → no selection.
    expect(store.getSnapshot().selection.size).toBe(0);
    fireEvent.keyDown(getHost(), { key: "Delete" });
    expect(onDeleteRequested).not.toHaveBeenCalled();
  });

  it("Ctrl+A selects every visible entry", () => {
    const { store, entries } = makeFixture();
    render(<Host store={store} entries={entries} />);

    fireEvent.keyDown(getHost(), { key: "a", ctrlKey: true });
    const sel = store.getSnapshot().selection;
    expect(sel.size).toBe(5);
    for (const e of entries) {
      expect(sel.has(e.id)).toBe(true);
    }
  });

  it("Cmd+A (metaKey) also selects all (macOS convention)", () => {
    const { store, entries } = makeFixture();
    render(<Host store={store} entries={entries} />);

    fireEvent.keyDown(getHost(), { key: "a", metaKey: true });
    const sel = store.getSnapshot().selection;
    expect(sel.size).toBe(5);
  });

  it("ArrowDown with no prior focus seeds focus at the first entry", () => {
    // Keyboard-only users who tab into the grid from the toolbar must
    // be able to start arrow navigation without first clicking a row.
    const { store, entries } = makeFixture();
    render(<Host store={store} entries={entries} />);

    // focusedId is null; ArrowDown should land on e1 (index 0).
    fireEvent.keyDown(getHost(), { key: "ArrowDown" });
    expect(getRow("e1").className).toMatch(/ring-ring/);
  });

  it("clicking a row via useSelection also sets focus to that row", () => {
    // Covers task 4.1's residual integration gap: the click → selection
    // flow wires focus through the same entry id, so later keyboard
    // navigation uses the clicked row as the anchor.
    const { store, entries } = makeFixture();
    render(<Host store={store} entries={entries} />);

    fireEvent.click(getRow("e3"));
    expect(store.getSnapshot().selection.has("e3")).toBe(true);
    expect(getRow("e3").className).toMatch(/ring-ring/);
  });
});

/**
 * ViewModeSwitcher keyboard composition — the shape Subagent P (the
 * composite explorer) will use. Verifies roving-tabindex semantics at
 * the container level: the switcher's outer element is tab-reachable
 * when no row is focused, then hands the tabindex=0 slot off to the
 * focused row once focus is seeded.
 */
function SwitcherHost({
  store,
  entries,
}: {
  store: ExplorerStore;
  entries: FileEntry[];
}) {
  const kbd = useKeyboardNav(store, { entries });
  return <ViewModeSwitcher store={store} keyboardNav={kbd} />;
}

describe("ViewModeSwitcher + keyboardNav composition", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("container is tab-reachable (tabindex=0) when no row is focused", () => {
    const { store, entries } = makeFixture();
    render(<SwitcherHost store={store} entries={entries} />);
    const container = document.querySelector<HTMLElement>(
      '[data-testid="view-mode-keyboard-container"]',
    );
    expect(container).not.toBeNull();
    expect(container!.getAttribute("tabindex")).toBe("0");
  });

  it("container drops to tabindex=-1 once a row is focused", () => {
    const { store, entries } = makeFixture();
    render(<SwitcherHost store={store} entries={entries} />);
    const container = document.querySelector<HTMLElement>(
      '[data-testid="view-mode-keyboard-container"]',
    );
    expect(container).not.toBeNull();

    // Seed focus via arrow-down.
    fireEvent.keyDown(container!, { key: "ArrowDown" });
    expect(container!.getAttribute("tabindex")).toBe("-1");
    // And the first row now owns the tab stop.
    expect(getRow("e1").getAttribute("tabindex")).toBe("0");
  });
});
