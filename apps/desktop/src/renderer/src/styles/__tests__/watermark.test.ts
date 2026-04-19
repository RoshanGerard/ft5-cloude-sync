import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

// Decision 16 (review-round-1) — ambient geometric watermark.
//
// The watermark is authored as a CSS custom property `--watermark-image`
// in globals.css, theme-aware (different stroke value per theme because
// SVG data URLs can't inherit `currentColor` from the element context).
// The dashboard's root container consumes the variable via a
// `[background-image:var(--watermark-image)]` utility (or the shorthand
// `.dashboard-canvas` class, equivalent outcome).
//
// These assertions are structural — they don't render anything; they
// read source files as strings and verify the coupling is explicit.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GLOBALS_CSS_PATH = join(__dirname, "..", "globals.css");
const DASHBOARD_TSX_PATH = join(
  __dirname,
  "..",
  "..",
  "features",
  "datasources",
  "dashboard.tsx",
);

function extractBlock(css: string, selector: RegExp): string | null {
  const match = selector.exec(css);
  if (!match) return null;
  const openIdx = css.indexOf("{", match.index);
  if (openIdx === -1) return null;
  let depth = 1;
  let i = openIdx + 1;
  while (i < css.length && depth > 0) {
    const ch = css[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return depth === 0 ? css.slice(openIdx + 1, i - 1) : null;
}

function watermarkValue(block: string): string | null {
  const re = /--watermark-image\s*:\s*([^;]+);/;
  const m = re.exec(block);
  return m ? m[1]!.trim() : null;
}

describe("geometric watermark (Decision 16 — review-round-1)", () => {
  const css = readFileSync(GLOBALS_CSS_PATH, "utf8");
  const rootBlock = extractBlock(css, /(^|\s):root\s*\{/);
  const darkBlock = extractBlock(css, /(^|\s)(?:html\s*)?\.dark\s*\{/);

  it("declares --watermark-image in :root (light theme)", () => {
    expect(rootBlock).not.toBeNull();
    const value = watermarkValue(rootBlock ?? "");
    expect(value).not.toBeNull();
    expect(value!).toMatch(/data:image\/svg\+xml/);
  });

  it("redeclares --watermark-image in .dark with a different value", () => {
    expect(darkBlock).not.toBeNull();
    const lightValue = watermarkValue(rootBlock ?? "");
    const darkValue = watermarkValue(darkBlock ?? "");
    expect(darkValue).not.toBeNull();
    expect(darkValue!).toMatch(/data:image\/svg\+xml/);
    // Light and dark must differ — the whole point of redeclaring the
    // variable is so the stroke colour (and nothing else) shifts with the
    // theme. Equal values would be a silent bug.
    expect(darkValue).not.toBe(lightValue);
  });

  it("dashboard root couples explicitly to --watermark-image", () => {
    const dashboard = readFileSync(DASHBOARD_TSX_PATH, "utf8");
    // Accept either the arbitrary-property-value utility
    // `[background-image:var(--watermark-image)]` or a named class
    // `dashboard-canvas` that owns the coupling in globals.css. Either
    // way the feature code must name the coupling so a future refactor
    // can find it.
    const usesArbitraryUtility =
      /\[background-image:var\(--watermark-image\)\]/.test(dashboard);
    const usesDashboardCanvasClass = /\bdashboard-canvas\b/.test(dashboard);
    expect(usesArbitraryUtility || usesDashboardCanvasClass).toBe(true);
  });

  it("if .dashboard-canvas is used, globals.css defines it with the watermark background", () => {
    const dashboard = readFileSync(DASHBOARD_TSX_PATH, "utf8");
    const usesDashboardCanvasClass = /\bdashboard-canvas\b/.test(dashboard);
    if (!usesDashboardCanvasClass) return;
    // The class must wire background-image → var(--watermark-image) so
    // the test can't pass on a stub.
    const rule = /\.dashboard-canvas\s*\{[^}]*background-image\s*:\s*var\(--watermark-image\)[^}]*\}/;
    expect(rule.test(css)).toBe(true);
  });
});
