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

import { createExplorerStore } from "../store.js";
import type { ExplorerStore, ViewMode } from "../store.js";
import { Toolbar } from "../toolbar.js";

/**
 * Toolbar — Phase 3's scope lands the View menu only. Delete / Sort / Search /
 * Details-toggle buttons are placeholders that arrive in later phases; this
 * test file exercises the View menu surface exclusively.
 *
 * Spec reference — specs/file-explorer/spec.md "Six view modes":
 *   - Menu contains six radio-style items with the current mode indicated.
 *   - Labels exactly: "List", "Details", "Small icons", "Tiles",
 *     "Medium icons", "Large icons".
 *   - Selecting a different item switches the active renderer component
 *     within one render (the store's `viewMode` flips).
 *
 * Radix DropdownMenu requires a ResizeObserver polyfill in jsdom; the
 * dashboard-card tests follow the same pattern.
 */

function makeStore(id = "ds-toolbar-test"): ExplorerStore {
  return createExplorerStore(id);
}

const EXPECTED_ITEMS: ReadonlyArray<{ value: ViewMode; label: string }> = [
  { value: "list", label: "List" },
  { value: "details", label: "Details" },
  { value: "small", label: "Small icons" },
  { value: "tiles", label: "Tiles" },
  { value: "medium", label: "Medium icons" },
  { value: "large", label: "Large icons" },
];

function getTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /view/i });
}

function openMenu(): void {
  // Radix DropdownMenu responds to pointerDown (matching its pointer-native
  // semantics), not to a synthetic `click`. Mirrors the pattern used by
  // features/datasources/__tests__/card.test.tsx.
  fireEvent.pointerDown(getTrigger(), { button: 0 });
}

describe("Toolbar — View menu", () => {
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

  it("renders a trigger with an accessible name containing 'View'", () => {
    const store = makeStore();
    render(<Toolbar store={store} />);
    const trigger = getTrigger();
    expect(trigger).toBeInTheDocument();
    const label =
      trigger.getAttribute("aria-label") ?? trigger.textContent ?? "";
    expect(label.toLowerCase()).toMatch(/view/);
  });

  it("trigger is a native <button type='button'> (keyboard reachable)", () => {
    const store = makeStore();
    render(<Toolbar store={store} />);
    const trigger = getTrigger();
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("type", "button");
  });

  it("opening the menu shows six radio items in the documented order with the exact labels", async () => {
    const store = makeStore();
    render(<Toolbar store={store} />);
    openMenu();

    const items = await screen.findAllByRole("menuitemradio");
    expect(items).toHaveLength(6);
    const labels = items.map((el) => (el.textContent ?? "").trim());
    expect(labels).toEqual(EXPECTED_ITEMS.map((o) => o.label));
  });

  it("the currently-active mode (default: details) is marked as checked", async () => {
    const store = makeStore();
    render(<Toolbar store={store} />);
    openMenu();

    const items = await screen.findAllByRole("menuitemradio");
    const checkedStates = items.map((el) =>
      el.getAttribute("aria-checked"),
    );
    const detailsIdx = EXPECTED_ITEMS.findIndex((o) => o.value === "details");
    expect(checkedStates[detailsIdx]).toBe("true");
    // All other items are not checked.
    checkedStates.forEach((state, idx) => {
      if (idx === detailsIdx) return;
      expect(state).toBe("false");
    });
  });

  it("selecting 'List' dispatches store.setViewMode('list') and closes the menu", async () => {
    const store = makeStore();
    render(<Toolbar store={store} />);
    openMenu();

    const listItem = (await screen.findAllByRole("menuitemradio")).find(
      (el) => (el.textContent ?? "").trim() === "List",
    );
    expect(listItem).toBeDefined();

    act(() => {
      fireEvent.click(listItem!);
    });

    expect(store.getSnapshot().viewMode).toBe("list");
    // Menu closes — no menuitemradio in the DOM after selection.
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
  });

  it("reflects a current mode other than details — seeded 'tiles' becomes the checked item", async () => {
    const store = makeStore();
    act(() => {
      store.setViewMode("tiles");
    });
    render(<Toolbar store={store} />);
    openMenu();

    const items = await screen.findAllByRole("menuitemradio");
    const tilesIdx = EXPECTED_ITEMS.findIndex((o) => o.value === "tiles");
    expect(items[tilesIdx]!.getAttribute("aria-checked")).toBe("true");
  });
});
