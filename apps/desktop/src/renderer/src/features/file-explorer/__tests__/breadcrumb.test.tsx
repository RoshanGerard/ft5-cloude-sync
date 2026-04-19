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

  // Spec scenario "Breadcrumb renders the full path with segment-level
  // navigation" explicitly requires "clicking or pressing Enter" on a
  // segment to navigate. We can't simulate real Enter→click via
  // fireEvent.keyDown in jsdom (the browser does this implicitly for
  // native <button> elements; jsdom does not bridge the two). So this
  // guardrail test combines two assertions that together prove the
  // required behaviour:
  //   1. The segment IS a native <button type="button"> (checked in the
  //      test above) — guarantees real browsers will activate it on
  //      Enter and Space per HTML spec.
  //   2. The segment does NOT carry a custom `onKeyDown` handler that
  //      would mutate store state (which would cause double-fire in a
  //      real browser). We verify by firing keyDown and asserting
  //      navigate was NOT called — if someone later adds
  //      `onKeyDown={() => store.navigate(path)}`, this test goes red.
  it("does not intercept keyDown with a custom navigate handler (relies on native button semantics)", () => {
    const store = makeStore();
    act(() => {
      store.navigate("/projects/docs/2026");
    });
    render(<Breadcrumb store={store} />);

    const projects = screen.getByRole("button", { name: /^projects$/i });
    projects.focus();

    // jsdom does not convert Enter-keydown to click on native buttons.
    // If navigate() fires from keyDown alone, it means the component
    // added a custom handler — which would double-fire in real browsers.
    const before = store.getSnapshot().currentPath;
    fireEvent.keyDown(projects, { key: "Enter" });
    expect(store.getSnapshot().currentPath).toBe(before);

    // Sanity: real activation via the button's native click still works.
    fireEvent.click(projects);
    expect(store.getSnapshot().currentPath).toBe("/projects");
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
