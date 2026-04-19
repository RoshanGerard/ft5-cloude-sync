/** @vitest-environment jsdom */
//
// SettingsDialog — the Settings modal triggered by the header's Settings
// button. First and only section (this phase): Motion. Hosts a Switch that
// drives the motion-store preference. Default (always-on) = switch OFF;
// toggling on writes `safe` to localStorage and sets `data-motion="safe"` on
// <html>, which activates the CSS override in globals.css.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { SettingsDialog } from "../settings-dialog";
import { MOTION_STORAGE_KEY } from "../motion-store";

// Radix DropdownMenu / Dialog rely on ResizeObserver at mount. Mirror the
// polyfill used in card.test / add-dialog.test.
beforeEach(() => {
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
  localStorage.clear();
  document.documentElement.removeAttribute("data-motion");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("data-motion");
});

describe("SettingsDialog — Motion Safe section", () => {
  it("renders a dialog with the 'Settings' title when open", () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    expect(
      screen.getByRole("heading", { name: /settings/i }),
    ).toBeInTheDocument();
  });

  it("renders a Motion Safe switch whose default state reflects the store (unchecked / always-on)", () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    const toggle = screen.getByRole("switch", { name: /motion safe/i });
    expect(toggle).toBeInTheDocument();
    // Default preference is `always-on` → switch reads as unchecked.
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects an existing 'safe' preference on mount (switch reads as checked)", () => {
    localStorage.setItem(MOTION_STORAGE_KEY, "safe");
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    const toggle = screen.getByRole("switch", { name: /motion safe/i });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("toggling the switch ON writes 'safe' to storage and sets data-motion='safe'", () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    const toggle = screen.getByRole("switch", { name: /motion safe/i });
    fireEvent.click(toggle);

    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe("safe");
    expect(document.documentElement.getAttribute("data-motion")).toBe("safe");
  });

  it("toggling the switch OFF (from safe) removes the storage key and the attribute", () => {
    localStorage.setItem(MOTION_STORAGE_KEY, "safe");
    document.documentElement.setAttribute("data-motion", "safe");
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    const toggle = screen.getByRole("switch", { name: /motion safe/i });
    fireEvent.click(toggle);

    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
  });

  it("restores focus to the trigger on close via returnFocusTo", async () => {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.textContent = "Open Settings";
    document.body.appendChild(trigger);

    const onOpenChange = vi.fn();
    const { rerender } = render(
      <SettingsDialog
        open={true}
        onOpenChange={onOpenChange}
        returnFocusTo={trigger}
      />,
    );

    // Dialog close via prop. Radix invokes onCloseAutoFocus on the content,
    // which the SettingsDialog implementation uses to redirect focus to the
    // returnFocusTo element (same pattern as AddDatasourceDialog — focus
    // restoration is async under Radix, so we poll with waitFor).
    rerender(
      <SettingsDialog
        open={false}
        onOpenChange={onOpenChange}
        returnFocusTo={trigger}
      />,
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });

    trigger.remove();
  });

  it("provides the help sentence describing the toggle behaviour", () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    // The copy should reference the OS reduce-motion behaviour so users know
    // what the toggle actually does. We match loosely on keywords rather than
    // pinning the exact wording.
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/reduce[ -]motion|system/i);
  });
});
