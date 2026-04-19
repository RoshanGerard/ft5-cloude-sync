/** @vitest-environment jsdom */
//
// Review-round-2, Task 2 — asymmetric hex-network watermark.
//
// The previous tiled CSS watermark (Decision 16 round-1) didn't match the
// user's intent. Replaces it with a single inline <svg> component mounted
// inside the dashboard:
//   - hexagon outlines distributed asymmetrically (dense right, sparse
//     left), with connecting lines and vertex dots forming a "network",
//   - theme-adaptive via `currentColor` so the single component draws on
//     both light and dark themes,
//   - decorative only — `aria-hidden`, non-interactive, no motion.
//
// These assertions are behavioural structural checks on the rendered DOM,
// plus a source-level literals-ban spot-check (belt-and-suspenders on top
// of scripts/literals-ban.test.ts).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DashboardBackground } from "../dashboard-background";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COMPONENT_SRC_PATH = join(
  __dirname,
  "..",
  "dashboard-background.tsx",
);

describe("DashboardBackground — hex-network watermark (review-round-2)", () => {
  it("renders a single <svg>", () => {
    const { container } = render(<DashboardBackground />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBe(1);
  });

  it("the <svg> is aria-hidden (decorative, out of the a11y tree)", () => {
    const { container } = render(<DashboardBackground />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it("contains at least 10 <polygon> elements (hexagons)", () => {
    const { container } = render(<DashboardBackground />);
    const polys = container.querySelectorAll("svg polygon");
    expect(polys.length).toBeGreaterThanOrEqual(10);
  });

  it("contains at least one <circle> element (vertex dot)", () => {
    const { container } = render(<DashboardBackground />);
    const circles = container.querySelectorAll("svg circle");
    expect(circles.length).toBeGreaterThanOrEqual(1);
  });

  it("contains at least one <line> element (network connection)", () => {
    const { container } = render(<DashboardBackground />);
    const lines = container.querySelectorAll("svg line");
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it("is non-interactive (pointer-events: none via class)", () => {
    const { container } = render(<DashboardBackground />);
    const svg = container.querySelector("svg")!;
    // Tailwind utility ships the class name verbatim; the global CSS layer
    // turns it into `pointer-events: none`. We assert on the className rather
    // than the computed style because jsdom doesn't resolve Tailwind.
    expect(svg.className.baseVal ?? svg.getAttribute("class") ?? "").toMatch(
      /\bpointer-events-none\b/,
    );
  });

  it("source file contains no hex/rgb/hsl/oklch colour literals", () => {
    const source = readFileSync(COMPONENT_SRC_PATH, "utf8");
    // Strip line + block comments so doc-strings explaining the pattern
    // don't falsely trip the check.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3}(?![0-9a-fA-F])/);
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{6}(?![0-9a-fA-F])/);
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{8}(?![0-9a-fA-F])/);
    expect(stripped).not.toMatch(/\brgba?\s*\(/);
    expect(stripped).not.toMatch(/\bhsla?\s*\(/);
    expect(stripped).not.toMatch(/\boklch\s*\(/);
    expect(stripped).not.toMatch(/\boklab\s*\(/);
  });
});
