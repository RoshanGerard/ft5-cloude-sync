/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { createExplorerStore } from "../store.js";
import type { ExplorerStore } from "../store.js";
import { HistoryButtons } from "../history-buttons.js";

/**
 * HistoryButtons — Back / Forward / Up-one-level controls for the explorer
 * chrome. Each is a native <button> with an icon-only affordance and an
 * `aria-label`. Enabled state derives from the store's history stack and
 * currentPath.
 */

function makeStore(id = "ds-test"): ExplorerStore {
  return createExplorerStore(id);
}

function getBackButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /go back/i }) as HTMLButtonElement;
}
function getForwardButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /go forward/i }) as HTMLButtonElement;
}
function getUpButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /go up one level/i }) as HTMLButtonElement;
}

describe("HistoryButtons", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders three buttons with accessible labels", () => {
    const store = makeStore();
    render(<HistoryButtons store={store} />);
    expect(getBackButton()).toBeInTheDocument();
    expect(getForwardButton()).toBeInTheDocument();
    expect(getUpButton()).toBeInTheDocument();
  });

  it("all three buttons are disabled at initial state (root, no history)", () => {
    const store = makeStore();
    render(<HistoryButtons store={store} />);
    expect(getBackButton()).toBeDisabled();
    expect(getForwardButton()).toBeDisabled();
    expect(getUpButton()).toBeDisabled();
  });

  it("after navigating to /projects: Back enabled, Forward disabled, Up enabled", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects");
    });
    render(<HistoryButtons store={store} />);
    expect(getBackButton()).not.toBeDisabled();
    expect(getForwardButton()).toBeDisabled();
    expect(getUpButton()).not.toBeDisabled();
  });

  it("after navigating root -> /projects -> /projects/docs: Back enabled, Forward disabled, Up enabled", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects");
    });
    act(() => {
      store.navigate("/projects/docs");
    });
    render(<HistoryButtons store={store} />);
    expect(getBackButton()).not.toBeDisabled();
    expect(getForwardButton()).toBeDisabled();
    expect(getUpButton()).not.toBeDisabled();
  });

  it("after Back from the middle of the stack: Forward and Back both enabled", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects");
    });
    act(() => {
      store.navigate("/projects/docs");
    });
    act(() => {
      store.back();
    });
    render(<HistoryButtons store={store} />);
    expect(getBackButton()).not.toBeDisabled();
    expect(getForwardButton()).not.toBeDisabled();
    expect(getUpButton()).not.toBeDisabled();
  });

  it("clicking Back invokes store.back (updates currentPath)", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects");
    });
    render(<HistoryButtons store={store} />);

    fireEvent.click(getBackButton());
    expect(store.getSnapshot().currentPath).toBe("/");
  });

  it("clicking Forward invokes store.forward (updates currentPath)", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects");
    });
    act(() => {
      store.back();
    });
    render(<HistoryButtons store={store} />);

    fireEvent.click(getForwardButton());
    expect(store.getSnapshot().currentPath).toBe("/projects");
  });

  it("clicking Up invokes store.up (navigates to parent)", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects/docs");
    });
    render(<HistoryButtons store={store} />);

    fireEvent.click(getUpButton());
    expect(store.getSnapshot().currentPath).toBe("/projects");
  });

  it("renders buttons as native <button> elements (Enter/Space mapped natively)", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects");
    });
    render(<HistoryButtons store={store} />);

    for (const btn of [getBackButton(), getForwardButton(), getUpButton()]) {
      expect(btn.tagName).toBe("BUTTON");
      expect(btn).toHaveAttribute("type", "button");
    }
  });

  // Spec scenario "Back, Forward, and Up operate on the explorer's history
  // stack" requires Enter/Space keyboard activation. jsdom doesn't bridge
  // Enter-keydown→click for native buttons (the browser does); we rely on
  // the native-button assertion above for that guarantee. This test
  // additionally proves that none of the three buttons carries a custom
  // onKeyDown handler that would mutate store state directly — which
  // would double-fire in real browsers and break the stack semantics.
  it("does not intercept keyDown with custom handlers (relies on native button semantics)", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects");
    });
    render(<HistoryButtons store={store} />);

    const snapshotBefore = store.getSnapshot();
    for (const btn of [getBackButton(), getForwardButton(), getUpButton()]) {
      btn.focus();
      fireEvent.keyDown(btn, { key: "Enter" });
      fireEvent.keyDown(btn, { key: " " });
    }

    // Pure keyDown should not have mutated history state; mutation only
    // happens via click (native browser Enter/Space → click is the path).
    const snapshotAfter = store.getSnapshot();
    expect(snapshotAfter.currentPath).toBe(snapshotBefore.currentPath);
    expect(snapshotAfter.history.index).toBe(snapshotBefore.history.index);
    expect(snapshotAfter.history.stack).toEqual(snapshotBefore.history.stack);
  });

  it("disabled buttons do not fire click handlers", () => {
    const store = makeStore();
    render(<HistoryButtons store={store} />);

    // At root, all are disabled; clicking them must not mutate state.
    fireEvent.click(getBackButton());
    fireEvent.click(getForwardButton());
    fireEvent.click(getUpButton());

    const state = store.getSnapshot();
    expect(state.currentPath).toBe("/");
    expect(state.history.index).toBe(0);
    expect(state.history.stack).toHaveLength(1);
  });

  it("re-renders when the store's history changes after mount", () => {
    const store = makeStore();
    render(<HistoryButtons store={store} />);

    // Initial — Back disabled.
    expect(getBackButton()).toBeDisabled();

    act(() => {
      store.navigate("/alpha");
    });

    // After navigation — Back enabled.
    expect(getBackButton()).not.toBeDisabled();
  });
});
