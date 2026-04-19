import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

// Density tokens per design.md Decision 8 (Linear/Vercel dense-quiet flavour):
// the renderer's baseline text size is 14px, not Tailwind's default 16px. That
// ships as the `--text-base` variable in the Tailwind v4 `@theme inline` block
// in globals.css, which overrides the default `text-base` utility to
// `0.875rem`. Per-component spacing (card `p-4`, dashboard `gap-3`) is handled
// by the default Tailwind scale — those utilities don't need to be redefined
// and get asserted at the component level in Phase 5 (tasks 5.1 and 5.4).
//
// Card padding and toolbar height tokens called out in the task description
// are captured by design.md Decision 8; they become load-bearing once Phase 5
// lands and the dashboard/card components are written. This test-phase check
// is scoped to the single config-level token that is genuinely new here.
//
// Reads globals.css as text (same house pattern as theme.test.ts) — Tailwind
// v4's CSS-first config has no JS export to import.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GLOBALS_CSS_PATH = join(__dirname, "..", "globals.css");

function extractThemeBlock(css: string): string {
  // Match the actual @theme at-rule declaration, NOT an occurrence of "@theme"
  // inside a preceding /* ... */ documentation comment. Anchoring with `\n`
  // (or start-of-file) and allowing an optional modifier like `inline` makes
  // the match unambiguous.
  const re = /(?:^|\n)@theme\b[^{]*\{/;
  const match = css.match(re);
  expect(
    match,
    "expected an @theme at-rule in globals.css (not a comment)",
  ).not.toBeNull();
  const openBrace = (match!.index ?? 0) + match![0].length - 1;
  let depth = 1;
  let i = openBrace + 1;
  while (i < css.length && depth > 0) {
    const c = css[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (depth === 0) break;
    i++;
  }
  return css.slice(openBrace + 1, i);
}

describe("density-config — Tailwind v4 @theme overrides", () => {
  it("overrides --text-base to 0.875rem (14px) for dense-quiet density", () => {
    const css = readFileSync(GLOBALS_CSS_PATH, "utf8");
    const themeBlock = extractThemeBlock(css);
    expect(themeBlock).toMatch(/--text-base\s*:\s*0\.875rem\b/);
  });

  it("--text-base is defined inside @theme, not at :root or .dark", () => {
    const css = readFileSync(GLOBALS_CSS_PATH, "utf8");
    // Extract :root block.
    const rootMatch = css.match(/:root\s*\{([\s\S]*?)\}/);
    const darkMatch = css.match(/\.dark\s*\{([\s\S]*?)\}/);
    if (rootMatch) {
      expect(rootMatch[1]).not.toMatch(/--text-base\b/);
    }
    if (darkMatch) {
      expect(darkMatch[1]).not.toMatch(/--text-base\b/);
    }
  });
});
