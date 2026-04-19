/** @vitest-environment jsdom */
// Task 4b.8 — Empty-state illustration component.
//
// The dashboard empty state (task 5.1 will mount it) shows a custom SVG
// instead of a lucide-react icon at ≥24px. The illustration must:
//   - Be a single inline <svg> with data-illustration="empty-datasources"
//     for test targeting.
//   - Carry an accessible name that mentions "datasource" via role="img"
//     plus aria-label or a nested <title>.
//   - Have a viewBox of 240×160 (or close) so it scales cleanly.
//   - Use `currentColor` for primary strokes so the illustration inherits
//     the theme text colour on dark/light switch without JS.
//   - Use at least one accent that references the theme `--primary`
//     custom property so the accent re-colours with the theme.
//
// Note on colour references:
//   The scripts/literals-ban.test.ts guardrail bans `hsl(`, `rgb(`,
//   `oklch(` etc. in feature code. We therefore reference the primary
//   custom property directly via `fill="var(--primary)"` (the `--primary`
//   variable already resolves to an oklch() colour at the root level),
//   not via `hsl(var(--primary))`. The assertion here mirrors that
//   choice.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { EmptyDatasourcesIllustration } from "../illustrations/empty-datasources";

describe("EmptyDatasourcesIllustration — task 4b.8", () => {
  it("renders a single <svg> with data-illustration='empty-datasources'", () => {
    const { container } = render(<EmptyDatasourcesIllustration />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBe(1);
    expect(svgs[0]!.getAttribute("data-illustration")).toBe(
      "empty-datasources",
    );
  });

  it("has a numeric viewBox at 240 x 160 aspect", () => {
    const { container } = render(<EmptyDatasourcesIllustration />);
    const svg = container.querySelector("svg")!;
    const viewBox = svg.getAttribute("viewBox");
    expect(viewBox).not.toBeNull();
    const parts = viewBox!.split(/\s+/).map(Number);
    expect(parts.length).toBe(4);
    expect(Number.isFinite(parts[2]!)).toBe(true);
    expect(Number.isFinite(parts[3]!)).toBe(true);
    expect(parts[2]).toBe(240);
    expect(parts[3]).toBe(160);
  });

  it("has role='img' and an accessible name mentioning 'datasource'", () => {
    const { container } = render(<EmptyDatasourcesIllustration />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");

    const ariaLabel = svg.getAttribute("aria-label");
    const titleText = svg.querySelector("title")?.textContent ?? "";
    const accessibleName = ariaLabel ?? titleText;
    expect(accessibleName.toLowerCase()).toMatch(/datasource/);
  });

  it("at least one child uses currentColor (so strokes inherit theme)", () => {
    const { container } = render(<EmptyDatasourcesIllustration />);
    const svg = container.querySelector("svg")!;
    const all = svg.querySelectorAll("*");
    const hasCurrentColor = Array.from(all).some((el) => {
      return (
        el.getAttribute("stroke") === "currentColor" ||
        el.getAttribute("fill") === "currentColor"
      );
    });
    expect(hasCurrentColor).toBe(true);
  });

  it("at least one child references the --primary theme token as a var()", () => {
    const { container } = render(<EmptyDatasourcesIllustration />);
    const svg = container.querySelector("svg")!;
    const all = svg.querySelectorAll("*");
    const hasPrimaryAccent = Array.from(all).some((el) => {
      const fill = el.getAttribute("fill") ?? "";
      const stroke = el.getAttribute("stroke") ?? "";
      return (
        fill.includes("var(--primary)") || stroke.includes("var(--primary)")
      );
    });
    expect(hasPrimaryAccent).toBe(true);
  });
});
