import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

// Token parity check for shadcn/ui slate palette, gated by design.md Decisions
// 1 and 6: both light and dark themes must be defined with the same token set,
// dark must be class-driven (`.dark`, not `@media (prefers-color-scheme)`),
// and no required token may be missing from either block. These assertions
// read `globals.css` as a string — they don't depend on a browser or a
// rendered DOM, so jsdom is not required.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GLOBALS_CSS_PATH = join(__dirname, "..", "globals.css");

// The 20 tokens design.md Decision 1 mandates for the slate palette. Both
// `:root` (light) and `.dark` must define every one of these.
const REQUIRED_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--radius",
] as const;

function extractBlock(css: string, selector: RegExp): string | null {
  // Find the selector, then return the text inside the matching { ... }.
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

function tokenValueMap(block: string): Map<string, string> {
  const out = new Map<string, string>();
  // Match `--token-name: value;` declarations, value up to the terminating
  // semicolon, allowing oklch() / hsl() / var() / raw values.
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

describe("renderer theme tokens (shadcn slate palette, class-driven dark)", () => {
  const css = readFileSync(GLOBALS_CSS_PATH, "utf8");

  it("imports Tailwind v4 via the `@import` idiom, not v3 directives", () => {
    expect(css).toMatch(/@import\s+["']tailwindcss["'];/);
    expect(css).not.toMatch(/@tailwind\s+(?:base|components|utilities)\s*;/);
  });

  it("does not gate the dark theme behind a prefers-color-scheme media query", () => {
    // Class-driven only (Decision 6). `@custom-variant dark (&:is(.dark *));`
    // or a `.dark {}` block is required; `@media (prefers-color-scheme: *)`
    // with theme-token overrides is not.
    expect(css).not.toMatch(/@media\s*\([^)]*prefers-color-scheme[^)]*\)/);
  });

  const rootBlock = extractBlock(css, /(^|\s):root\s*\{/);
  const darkBlock = extractBlock(css, /(^|\s)(?:html\s*)?\.dark\s*\{/);

  it("defines a :root block", () => {
    expect(rootBlock).not.toBeNull();
  });

  it("defines a .dark block (class-driven, not media-driven)", () => {
    expect(darkBlock).not.toBeNull();
  });

  it(":root declares every required token", () => {
    const tokens = tokenValueMap(rootBlock ?? "");
    const missing = REQUIRED_TOKENS.filter((t) => !tokens.has(t));
    expect(missing).toEqual([]);
  });

  it(".dark redeclares every required token", () => {
    const tokens = tokenValueMap(darkBlock ?? "");
    const missing = REQUIRED_TOKENS.filter((t) => !tokens.has(t));
    expect(missing).toEqual([]);
  });

  it(".dark changes every non-radius token's value relative to :root (dark is not a no-op)", () => {
    const light = tokenValueMap(rootBlock ?? "");
    const dark = tokenValueMap(darkBlock ?? "");
    // Radius is a geometric token — it legitimately stays the same across
    // themes. Colour/layout tokens must differ.
    const colourTokens = REQUIRED_TOKENS.filter((t) => t !== "--radius");
    const unchanged = colourTokens.filter((t) => light.get(t) === dark.get(t));
    expect(unchanged).toEqual([]);
  });
});
