/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import type { FileEntry } from "@ft5/ipc-contracts";

import { createExplorerStore } from "../store.js";
import type { ExplorerStore } from "../store.js";
import { Toolbar } from "../toolbar.js";
import { ViewModeSwitcher } from "../view-mode-switcher.js";
import { seedEntry } from "./test-utils.js";

/**
 * Spec scenario "Selection survives a mode switch" — specs/file-explorer/
 * spec.md "Six view modes":
 *
 *   WHEN the user selects two entries in Details mode, then switches to
 *   Medium Icons mode
 *   THEN the same two entries remain selected in Medium Icons mode; the
 *   status row's selection count is unchanged.
 *
 * This test goes one step further per the implementation plan and exercises
 * a three-mode walk (Details → Medium Icons → List) with a shift-click
 * range selection covering three contiguous entries.
 *
 * ViewModeSwitcher is the thin router component that reads `state.viewMode`
 * and mounts the matching view-mode component with the same `store` prop.
 * It lives beside the toolbar in the explorer composite but is intentionally
 * a separate component so the Phase 5 details-pane and Phase 4 status-row
 * can compose with it cleanly.
 */

function makeStore(id = "ds-mode-switch"): ExplorerStore {
  return createExplorerStore(id);
}

function seedTree(): FileEntry[] {
  // Eight plausible entries: two folders, six files of mixed mime families.
  // Order is the natural/alphabetic flow the store renders.
  return [
    seedEntry({
      id: "e1",
      name: "alpha",
      kind: "directory",
      path: "/alpha",
      size: null,
      mimeFamily: "unknown",
      mimeType: null,
    }),
    seedEntry({
      id: "e2",
      name: "bravo.pdf",
      path: "/bravo.pdf",
      mimeFamily: "document",
      mimeType: "application/pdf",
      size: 45_000,
    }),
    seedEntry({
      id: "e3",
      name: "charlie.png",
      path: "/charlie.png",
      mimeFamily: "image",
      mimeType: "image/png",
      size: 12_288,
    }),
    seedEntry({
      id: "e4",
      name: "delta.txt",
      path: "/delta.txt",
      mimeFamily: "text",
      mimeType: "text/plain",
      size: 2_048,
    }),
    seedEntry({
      id: "e5",
      name: "echo.mp4",
      path: "/echo.mp4",
      mimeFamily: "video",
      mimeType: "video/mp4",
      size: 5_000_000,
    }),
    seedEntry({
      id: "e6",
      name: "foxtrot.zip",
      path: "/foxtrot.zip",
      mimeFamily: "archive",
      mimeType: "application/zip",
      size: 900_000,
    }),
    seedEntry({
      id: "e7",
      name: "golf",
      kind: "directory",
      path: "/golf",
      size: null,
      mimeFamily: "unknown",
      mimeType: null,
    }),
    seedEntry({
      id: "e8",
      name: "hotel.mp3",
      path: "/hotel.mp3",
      mimeFamily: "audio",
      mimeType: "audio/mpeg",
      size: 4_000_000,
    }),
  ];
}

function openViewMenu(): void {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /view/i }),
    { button: 0 },
  );
}

async function clickViewOption(label: string): Promise<void> {
  const items = await screen.findAllByRole("menuitemradio");
  const target = items.find((el) => (el.textContent ?? "").trim() === label);
  if (!target) throw new Error(`view option "${label}" not found`);
  fireEvent.click(target);
}

describe("Mode-switch integration — selection survives toolbar-driven mode changes", () => {
  beforeEach(() => {
    if (!("ResizeObserver" in window)) {
      (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
        class MockResizeObserver {
          observe() {}
          unobserve() {}
          disconnect() {}
        };
    }
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("contiguous range selected in Details persists through Medium Icons and List", async () => {
    const store = makeStore();
    const tree = seedTree();
    act(() => {
      store.setEntries(tree);
    });

    render(
      <>
        <Toolbar store={store} />
        <ViewModeSwitcher store={store} />
      </>,
    );

    // Default mode is Details.
    expect(store.getSnapshot().viewMode).toBe("details");

    // Click entry 2 (bravo.pdf) — plain click → "replace".
    const e2 = screen.getByText(/bravo\.pdf/);
    fireEvent.click(e2);
    expect(store.getSnapshot().selection.size).toBe(1);

    // Shift-click entry 4 (delta.txt) — range from e2 through e4 inclusive.
    const e4 = screen.getByText(/delta\.txt/);
    fireEvent.click(e4, { shiftKey: true });

    expect(store.getSnapshot().selection.size).toBe(3);
    const initiallySelected = new Set(store.getSnapshot().selection);
    expect(initiallySelected).toEqual(new Set(["e2", "e3", "e4"]));
    expect(store.getSnapshot().lastSelectedId).toBe("e4");

    // Switch to Medium Icons via the toolbar.
    openViewMenu();
    await clickViewOption("Medium icons");

    expect(store.getSnapshot().viewMode).toBe("medium");
    // Selection count is unchanged.
    expect(store.getSnapshot().selection.size).toBe(3);
    expect(new Set(store.getSnapshot().selection)).toEqual(initiallySelected);
    // Focus-location (the anchor the spec names "last-focused") persists.
    expect(store.getSnapshot().lastSelectedId).toBe("e4");

    // Medium Icons renders the three entries too.
    expect(screen.getByText(/bravo\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/charlie\.png/)).toBeInTheDocument();
    expect(screen.getByText(/delta\.txt/)).toBeInTheDocument();

    // Switch to List.
    openViewMenu();
    await clickViewOption("List");

    expect(store.getSnapshot().viewMode).toBe("list");
    expect(store.getSnapshot().selection.size).toBe(3);
    expect(new Set(store.getSnapshot().selection)).toEqual(initiallySelected);
    expect(store.getSnapshot().lastSelectedId).toBe("e4");
    expect(screen.getByText(/bravo\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/delta\.txt/)).toBeInTheDocument();
  });
});
