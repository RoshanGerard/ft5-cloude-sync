/** @vitest-environment jsdom */
//
// Decision 14 (review-round-1) — AppHeader renders brand chrome: logo,
// product wordmark, and the ThemeSwitcher trigger. The header is
// test-mounted in isolation; integration with RootLayout is exercised
// indirectly via the dashboard tests.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { AppHeader } from "../app-header";

beforeEach(() => {
  // Radix Dialog needs ResizeObserver on mount.
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
});

afterEach(() => {
  cleanup();
});

describe("AppHeader — brand chrome (Decision 14)", () => {
  it("renders the Forti5 logo SVG", () => {
    render(<AppHeader />);
    const logo = document.querySelector("[data-testid='forti5-logo']");
    expect(logo).not.toBeNull();
    expect(logo!.tagName.toLowerCase()).toBe("svg");
  });

  it("renders the product wordmark 'FT5 Unified Cloud Sync'", () => {
    render(<AppHeader />);
    expect(
      screen.getByText(/FT5 Unified Cloud Sync/i),
    ).toBeInTheDocument();
  });

  it("renders the ThemeSwitcher trigger (right side)", () => {
    render(<AppHeader />);
    // ThemeSwitcher renders a Button with aria-label="Toggle theme".
    const toggle = screen.getByRole("button", { name: /toggle theme/i });
    expect(toggle).toBeInTheDocument();
  });

  it("is a <header> landmark with a bottom hairline border", () => {
    const { container } = render(<AppHeader />);
    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    expect(header!.className).toMatch(/\bborder-b\b/);
  });

  // Motion-Safe-toggle phase: the header grows a Settings icon button that
  // opens the SettingsDialog. It sits BEFORE the ThemeSwitcher (left of
  // it) so the order reads: [logo/title] … [settings] [theme]. The button
  // uses the same ghost-icon variant and is keyboard-accessible.
  it("renders a Settings button with an accessible name", () => {
    render(<AppHeader />);
    const settings = screen.getByRole("button", { name: /open settings/i });
    expect(settings).toBeInTheDocument();
  });

  it("clicking the Settings button opens the Settings dialog", () => {
    render(<AppHeader />);
    const settings = screen.getByRole("button", { name: /open settings/i });
    fireEvent.click(settings);
    // DialogTitle renders as an accessible heading.
    expect(
      screen.getByRole("heading", { name: /^settings$/i }),
    ).toBeInTheDocument();
  });

  it("places the Settings button before the ThemeSwitcher in DOM order", () => {
    render(<AppHeader />);
    const settings = screen.getByRole("button", { name: /open settings/i });
    const theme = screen.getByRole("button", { name: /toggle theme/i });
    // Settings precedes Theme in document order (left-to-right layout).
    const position = settings.compareDocumentPosition(theme);
    // Node.DOCUMENT_POSITION_FOLLOWING = 4 → `theme` follows `settings`.
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
