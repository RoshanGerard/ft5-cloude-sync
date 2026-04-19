/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { createExplorerStore } from "../store.js";
import type { ExplorerStore } from "../store.js";
import { Breadcrumb } from "../breadcrumb.js";

/**
 * Breadcrumb renders a keyboard-navigable path trail derived from the
 * explorer store's `currentPath`. Prior segments are focusable buttons that
 * call `store.navigate(<path>)`; the final segment is rendered as
 * non-interactive current-location text with `aria-current="page"`.
 *
 * Tests use a fresh `createExplorerStore(id)` per case to avoid leaking
 * state through the module-level cache used by `useExplorerStore`.
 */

function makeStore(id = "ds-test"): ExplorerStore {
  return createExplorerStore(id);
}

describe("Breadcrumb", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("wraps its segments in a <nav aria-label='Folder path'> landmark", () => {
    const store = makeStore();
    render(<Breadcrumb store={store} />);
    const nav = screen.getByRole("navigation", { name: /folder path/i });
    expect(nav).toBeInTheDocument();
  });

  it("renders a single root segment and no chevrons when path is '/'", () => {
    const store = makeStore();
    render(<Breadcrumb store={store} />);

    const nav = screen.getByRole("navigation", { name: /folder path/i });
    const items = within(nav).getAllByRole("listitem");
    expect(items).toHaveLength(1);

    // Root is the current path at initial state, so it's the current-location
    // segment (aria-current="page"), not a button.
    const root = within(nav).getByText(/root/i);
    expect(root).toHaveAttribute("aria-current", "page");

    // No chevron separators on a single-segment breadcrumb.
    expect(nav.querySelectorAll("svg")).toHaveLength(0);
  });

  it("renders four segments for '/projects/docs/2026' with chevron separators", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects/docs/2026");
    });
    render(<Breadcrumb store={store} />);

    const nav = screen.getByRole("navigation", { name: /folder path/i });
    const items = within(nav).getAllByRole("listitem");
    expect(items).toHaveLength(4);

    // Prior segments are buttons (keyboard-focusable), last is current-page.
    expect(within(nav).getByRole("button", { name: /root/i })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /^projects$/i })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /^docs$/i })).toBeInTheDocument();

    const current = within(nav).getByText(/^2026$/);
    expect(current).toHaveAttribute("aria-current", "page");
    // Current segment must NOT be a button.
    expect(current.tagName).not.toBe("BUTTON");

    // Three chevron separators between four segments (one per non-first segment).
    expect(nav.querySelectorAll("svg")).toHaveLength(3);
  });

  it("clicking a prior segment calls store.navigate with that segment's path", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects/docs/2026");
    });
    render(<Breadcrumb store={store} />);

    const projects = screen.getByRole("button", { name: /^projects$/i });
    fireEvent.click(projects);

    expect(store.getSnapshot().currentPath).toBe("/projects");
  });

  it("clicking the 'root' segment navigates to '/'", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects/docs");
    });
    render(<Breadcrumb store={store} />);

    fireEvent.click(screen.getByRole("button", { name: /root/i }));
    expect(store.getSnapshot().currentPath).toBe("/");
  });

  it("renders segments as native <button> elements so Enter/Space map to click natively", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects/docs");
    });
    render(<Breadcrumb store={store} />);

    const projects = screen.getByRole("button", { name: /^projects$/i });
    expect(projects.tagName).toBe("BUTTON");
    // Not type="submit" — must be type="button" so it doesn't accidentally
    // submit an ancestor form.
    expect(projects).toHaveAttribute("type", "button");
  });

  it("re-renders when the store's currentPath changes after mount", () => {
    const store = makeStore();
    render(<Breadcrumb store={store} />);

    // Initial: root only.
    expect(screen.queryByRole("button", { name: /^alpha$/i })).toBeNull();

    act(() => {
      store.navigate("/alpha/beta");
    });

    const alpha = screen.getByRole("button", { name: /^alpha$/i });
    expect(alpha).toBeInTheDocument();
    const beta = screen.getByText(/^beta$/);
    expect(beta).toHaveAttribute("aria-current", "page");
  });

  it("root segment is accessibly named 'root' even when represented with a home glyph", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects");
    });
    render(<Breadcrumb store={store} />);

    // The root is a prior segment here (current is "projects"). Must be reachable
    // via its accessible name.
    const root = screen.getByRole("button", { name: /root/i });
    expect(root).toBeInTheDocument();
  });
});
