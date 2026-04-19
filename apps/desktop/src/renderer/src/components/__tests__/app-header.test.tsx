/** @vitest-environment jsdom */
//
// Decision 14 (review-round-1) — AppHeader renders brand chrome: logo,
// product wordmark, and the ThemeSwitcher trigger. The header is
// test-mounted in isolation; integration with RootLayout is exercised
// indirectly via the dashboard tests.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { AppHeader } from "../app-header";

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
});
