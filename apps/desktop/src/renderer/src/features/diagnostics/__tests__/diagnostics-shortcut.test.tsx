/** @vitest-environment jsdom */
//
// Phase 7.3 — Developer keyboard shortcut: Ctrl/Cmd + Shift + D navigates to
// `/diagnostics`.
//
// The DiagnosticsShortcut component is a side-effect-only client component
// (returns null, binds a window-level keydown listener on mount, unbinds on
// unmount). Navigation uses Next.js `useRouter().push(...)` since the rest of
// the renderer shell uses the App Router already (the theme script, motion
// script, and dashboard trigger all operate inside this same router).
//
// Test strategy:
//   - Mock `next/navigation` so useRouter().push is a vi.fn we can assert on.
//     The module-level mock keeps the same pushMock across the describe block
//     so each test can assert call counts independently.
//   - Fire keydown on `window` — the listener binds at window level so menu
//     triggers / inputs / etc. don't have to dispatch it explicitly.
//   - Assert unmount removes the listener (dispatching after unmount MUST NOT
//     call push again).

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, render } from "@testing-library/react";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// Import AFTER the vi.mock call so the component's `useRouter` is the mocked one.
import { DiagnosticsShortcut } from "../diagnostics-shortcut";

beforeEach(() => {
  pushMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("DiagnosticsShortcut (task 7.3)", () => {
  it("Ctrl+Shift+D navigates to /diagnostics", () => {
    render(<DiagnosticsShortcut />);

    const event = new KeyboardEvent("keydown", {
      key: "D",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/diagnostics");
  });

  it("Cmd+Shift+D (metaKey) also navigates to /diagnostics", () => {
    render(<DiagnosticsShortcut />);

    const event = new KeyboardEvent("keydown", {
      key: "D",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/diagnostics");
  });

  it("handles lowercase 'd' (Firefox/Linux may deliver lowercase with Shift)", () => {
    // Defensive: browsers differ on whether Shift capitalizes `key`. The
    // implementation should lowercase before comparing.
    render(<DiagnosticsShortcut />);

    const event = new KeyboardEvent("keydown", {
      key: "d",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(pushMock).toHaveBeenCalledWith("/diagnostics");
  });

  it("plain 'D' without modifiers does NOT navigate", () => {
    render(<DiagnosticsShortcut />);

    const event = new KeyboardEvent("keydown", {
      key: "D",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(pushMock).not.toHaveBeenCalled();
  });

  it("Ctrl+D without Shift does NOT navigate", () => {
    render(<DiagnosticsShortcut />);

    const event = new KeyboardEvent("keydown", {
      key: "D",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(pushMock).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+X does NOT navigate", () => {
    render(<DiagnosticsShortcut />);

    const event = new KeyboardEvent("keydown", {
      key: "X",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(pushMock).not.toHaveBeenCalled();
  });

  it("prevents the default browser action (e.g. Firefox bookmark-all-tabs)", () => {
    render(<DiagnosticsShortcut />);

    const event = new KeyboardEvent("keydown", {
      key: "D",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("unmounts cleanly — keydown after unmount does NOT call push", () => {
    const { unmount } = render(<DiagnosticsShortcut />);
    unmount();

    const event = new KeyboardEvent("keydown", {
      key: "D",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(pushMock).not.toHaveBeenCalled();
  });
});
