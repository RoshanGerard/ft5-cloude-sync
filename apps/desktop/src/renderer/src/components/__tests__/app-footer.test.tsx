/** @vitest-environment jsdom */
//
// Decision 14 (review-round-1) — AppFooter is a single-line restrained
// footer with a dynamic-year copyright.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { AppFooter } from "../app-footer";

afterEach(() => {
  cleanup();
});

describe("AppFooter — copyright chrome (Decision 14)", () => {
  it("renders the current year in a copyright line", () => {
    render(<AppFooter />);
    const year = new Date().getFullYear().toString();
    const text = screen.getByText(
      new RegExp(`©\\s*${year}\\s*Forti5 Tech`, "i"),
    );
    expect(text).toBeInTheDocument();
  });

  it("is a <footer> landmark with a top hairline border", () => {
    const { container } = render(<AppFooter />);
    const footer = container.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(footer!.className).toMatch(/\bborder-t\b/);
  });

  it("left-aligns the copyright text with horizontal padding (review-round-3, Task 5)", () => {
    const { container } = render(<AppFooter />);
    const footer = container.querySelector("footer");
    expect(footer).not.toBeNull();
    // Round-3 review flipped center-align → left-align so the copyright
    // sits against the app's left gutter, matching the header's leading
    // content. `justify-start` on the flex row gives us that, and `px-4`
    // retains the gutter padding.
    expect(footer!.className).toMatch(/\bjustify-start\b/);
    expect(footer!.className).not.toMatch(/\bjustify-center\b/);
    expect(footer!.className).toMatch(/\bpx-4\b/);
  });

  it("reads 'All rights reserved.'", () => {
    render(<AppFooter />);
    expect(
      screen.getByText(/All rights reserved\./i),
    ).toBeInTheDocument();
  });
});
