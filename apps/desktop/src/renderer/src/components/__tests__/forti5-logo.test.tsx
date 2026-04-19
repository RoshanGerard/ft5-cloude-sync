/** @vitest-environment jsdom */
//
// Review-round-2, Task 1 — the round-1 logo was a simplified chevron
// interpretation. The user supplied the real geometry (a central pentagon
// plus 5 outer petals in a 174.16 x 166.81 viewBox). These assertions
// lock the real-geometry contract:
//
//   - 6 <polygon> elements total (1 central pentagon + 5 outer petals).
//   - The central pentagon is the smallest by area, and its fill resolves
//     to var(--background) so it reads as a theme-reactive "hole".
//   - The 5 outer petals fill with var(--brand-primary) for consistent
//     brand-crimson across both themes.
//   - The SVG exposes role="img" and the product aria-label.
//   - No hex colour literals anywhere in the source (literals-ban).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { Forti5Logo } from "../forti5-logo";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOGO_SRC_PATH = join(__dirname, "..", "forti5-logo.tsx");

afterEach(() => {
  cleanup();
});

describe("Forti5Logo — real brand geometry (review-round-2)", () => {
  it("renders a single <svg> with role='img' and the product aria-label", () => {
    const { container } = render(<Forti5Logo />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBe(1);
    const svg = svgs[0]!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toMatch(/FT5 Unified Cloud Sync/i);
    expect(svg.getAttribute("data-testid")).toBe("forti5-logo");
  });

  it("uses the user-supplied viewBox 0 0 174.16 166.81", () => {
    const { container } = render(<Forti5Logo />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 174.16 166.81");
  });

  it("renders exactly 6 polygons (1 central pentagon + 5 outer petals)", () => {
    const { container } = render(<Forti5Logo />);
    const polygons = container.querySelectorAll("svg polygon");
    expect(polygons.length).toBe(6);
  });

  it("5 polygons fill with var(--brand-primary) (the outer petals)", () => {
    const { container } = render(<Forti5Logo />);
    const polygons = Array.from(
      container.querySelectorAll<SVGPolygonElement>("svg polygon"),
    );
    const brandPetals = polygons.filter((p) => {
      // The fill may sit directly on the polygon or be inherited from a
      // parent <g fill="..."> — check both.
      const direct = p.getAttribute("fill");
      if (direct && direct.includes("var(--brand-primary)")) return true;
      let node: Element | null = p.parentElement;
      while (node && node.tagName.toLowerCase() !== "svg") {
        const gFill = node.getAttribute("fill");
        if (gFill && gFill.includes("var(--brand-primary)")) return true;
        node = node.parentElement;
      }
      return false;
    });
    expect(brandPetals.length).toBe(5);
  });

  it("exactly 1 polygon fills with var(--background) (the central pentagon)", () => {
    const { container } = render(<Forti5Logo />);
    const polygons = Array.from(
      container.querySelectorAll<SVGPolygonElement>("svg polygon"),
    );
    const centerFills = polygons.filter((p) => {
      const direct = p.getAttribute("fill");
      if (direct && direct.includes("var(--background)")) return true;
      let node: Element | null = p.parentElement;
      while (node && node.tagName.toLowerCase() !== "svg") {
        const gFill = node.getAttribute("fill");
        if (gFill && gFill.includes("var(--background)")) return true;
        node = node.parentElement;
      }
      return false;
    });
    expect(centerFills.length).toBe(1);
  });

  it("honours the `size` prop on both width and height", () => {
    const { container } = render(<Forti5Logo size={40} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("40");
    expect(svg.getAttribute("height")).toBe("40");
  });

  it("source file contains no hex/rgb/hsl/oklch colour literals", () => {
    const source = readFileSync(LOGO_SRC_PATH, "utf8");
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
