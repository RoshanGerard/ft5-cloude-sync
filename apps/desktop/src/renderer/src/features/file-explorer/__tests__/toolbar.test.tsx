/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Task 6.5 — Upload toolbar button is part of the toolbar-controls list.
// Spec "Toolbar controls are all keyboard reachable and accessibly named"
// names Upload, Delete, Sort, Search, View, Details; tasks.md §6.4 pins
// Upload as the FIRST control. Disabled-state behaviour is asserted
// separately so the default path stays minimal.
describe("Toolbar — Upload button (task 6.4 / 6.5)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders an Upload control with a non-empty accessible name", () => {
    const store = makeStore();
    render(<Toolbar store={store} onUploadClick={() => {}} />);
    const upload = screen.getByTestId("file-explorer-upload-trigger");
    const name =
      upload.getAttribute("aria-label") ?? upload.textContent ?? "";
    expect(name.toLowerCase()).toMatch(/upload/);
  });

  it("is the FIRST button inside the toolbar (leading position per tasks.md §6.4)", () => {
    const store = makeStore();
    render(<Toolbar store={store} onUploadClick={() => {}} />);
    const toolbar = screen.getByRole("toolbar", { name: /explorer toolbar/i });
    const firstButton = toolbar.querySelector("button");
    expect(firstButton?.getAttribute("data-testid")).toBe(
      "file-explorer-upload-trigger",
    );
  });

  it("toolbar exposes the full control set (Upload, Delete, Search, View, Details)", () => {
    // Sort is called out in the spec but lives behind a later-phase flag
    // (see `toolbar.tsx`'s "Sort control is a later phase" comment), so
    // this assertion checks the shipping surface only.
    const store = makeStore();
    render(<Toolbar store={store} onUploadClick={() => {}} />);
    expect(
      screen.getByTestId("file-explorer-upload-trigger"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("file-explorer-delete-trigger"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("file-explorer-search-trigger"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("file-explorer-view-trigger"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("file-explorer-details-toggle"),
    ).toBeInTheDocument();
  });

  it("activates onUploadClick when enabled", () => {
    const store = makeStore();
    const onUploadClick = vi.fn();
    render(<Toolbar store={store} onUploadClick={onUploadClick} />);
    act(() => {
      fireEvent.click(screen.getByTestId("file-explorer-upload-trigger"));
    });
    expect(onUploadClick).toHaveBeenCalledTimes(1);
  });

  it("with `uploadBlockedReason` set: renders aria-disabled=true, exposes the reason via title, and swallows clicks", () => {
    const store = makeStore();
    const onUploadClick = vi.fn();
    render(
      <Toolbar
        store={store}
        onUploadClick={onUploadClick}
        uploadBlockedReason="This datasource is disconnected"
      />,
    );
    const upload = screen.getByTestId("file-explorer-upload-trigger");
    // Per spec line 73: aria-disabled, NOT the HTML `disabled` attribute.
    expect(upload.getAttribute("aria-disabled")).toBe("true");
    expect(upload.hasAttribute("disabled")).toBe(false);
    expect(upload.getAttribute("title")).toBe("This datasource is disconnected");
    act(() => {
      fireEvent.click(upload);
    });
    expect(onUploadClick).not.toHaveBeenCalled();
  });
});
