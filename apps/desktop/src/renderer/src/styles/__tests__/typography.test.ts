import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

// Typography wiring per design.md Decision 9: the renderer uses Geist Sans +
// Geist Mono via `next/font` (zero-runtime fetch — fonts are bundled at build
// time, not requested from fonts.googleapis.com on boot), and the fonts are
// applied to <html> as CSS variables `--font-geist-sans` + `--font-geist-mono`.
// Tailwind v4's `@theme inline` block bridges those variables to
// `font-sans` / `font-mono` utilities.
//
// This test reads the relevant source files as text — deliberately NOT
// rendering <RootLayout> via React Testing Library. Reasons:
//   1. `next/font` is a compile-time loader. Importing `geist/font/sans`
//      inside raw Vitest throws "Next.js font loaders can only be used
//      in the Next.js build."
//   2. `GeistSans.variable` at runtime is a generated class name (like
//      `__variable_abc123`) that maps to the CSS variable via a stylesheet
//      next/font injects at build time. It is NOT the literal string
//      `--font-geist-sans`, so a `className` string search wouldn't match.
//   3. The existing `theme.test.ts` already uses this file-as-text pattern
//      for CSS and layout assertions.
//
// The substantive correctness property — "fonts load via next/font and are
// exposed as CSS variables" — is encoded by:
//   (a) layout.tsx imports `GeistSans` from `geist/font/sans` and
//       `GeistMono` from `geist/font/mono`;
//   (b) both `.variable` className tokens appear in the <html> element's
//       className expression;
//   (c) no `fonts.googleapis.com` (or similar runtime-fetch domain) URL
//       appears in layout.tsx or globals.css;
//   (d) Tailwind v4's `@theme inline` block wires
//       `--font-sans: var(--font-geist-sans), ...` and
//       `--font-mono: var(--font-geist-mono), ...`.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LAYOUT_PATH = join(
  __dirname,
  "..",
  "..",
  "app",
  "layout.tsx",
);
const GLOBALS_CSS_PATH = join(__dirname, "..", "globals.css");

const RUNTIME_FONT_FETCH_DOMAINS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "use.typekit.net",
];

describe("typography — Geist font wiring", () => {
  it("layout.tsx imports GeistSans from geist/font/sans", () => {
    const text = readFileSync(LAYOUT_PATH, "utf8");
    expect(text).toMatch(
      /import\s*\{[^}]*\bGeistSans\b[^}]*\}\s*from\s*["']geist\/font\/sans["']/,
    );
  });

  it("layout.tsx imports GeistMono from geist/font/mono", () => {
    const text = readFileSync(LAYOUT_PATH, "utf8");
    expect(text).toMatch(
      /import\s*\{[^}]*\bGeistMono\b[^}]*\}\s*from\s*["']geist\/font\/mono["']/,
    );
  });

  it("layout.tsx applies both font variables to the <html> className", () => {
    const text = readFileSync(LAYOUT_PATH, "utf8");
    // Grab the <html ...> JSX opening tag. Requires whitespace after `<html`
    // so the text "<html>" appearing in a comment (no attributes) isn't the
    // match. Tolerates multi-line JSX attributes via `[\s\S]`.
    const htmlTagMatch = text.match(/<html\s[\s\S]*?>/);
    expect(
      htmlTagMatch,
      "expected a <html> element in layout.tsx",
    ).not.toBeNull();
    const htmlTag = htmlTagMatch![0];
    expect(htmlTag).toMatch(/\bGeistSans\.variable\b/);
    expect(htmlTag).toMatch(/\bGeistMono\.variable\b/);
  });

  it("layout.tsx does NOT fetch fonts at runtime from common font CDNs", () => {
    const text = readFileSync(LAYOUT_PATH, "utf8");
    for (const domain of RUNTIME_FONT_FETCH_DOMAINS) {
      expect(
        text.includes(domain),
        `layout.tsx must not reference ${domain} (fonts load via next/font at build time)`,
      ).toBe(false);
    }
  });

  it("globals.css does NOT fetch fonts at runtime from common font CDNs", () => {
    const text = readFileSync(GLOBALS_CSS_PATH, "utf8");
    for (const domain of RUNTIME_FONT_FETCH_DOMAINS) {
      expect(
        text.includes(domain),
        `globals.css must not reference ${domain} (fonts load via next/font at build time)`,
      ).toBe(false);
    }
  });

  it("globals.css maps --font-sans to var(--font-geist-sans) via @theme", () => {
    const text = readFileSync(GLOBALS_CSS_PATH, "utf8");
    // Looks inside the @theme block for `--font-sans: var(--font-geist-sans), ...`.
    expect(text).toMatch(/--font-sans\s*:\s*var\(--font-geist-sans\)/);
  });

  it("globals.css maps --font-mono to var(--font-geist-mono) via @theme", () => {
    const text = readFileSync(GLOBALS_CSS_PATH, "utf8");
    expect(text).toMatch(/--font-mono\s*:\s*var\(--font-geist-mono\)/);
  });
});
