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

  it("reads 'All rights reserved.'", () => {
    render(<AppFooter />);
    expect(
      screen.getByText(/All rights reserved\./i),
    ).toBeInTheDocument();
  });
});
