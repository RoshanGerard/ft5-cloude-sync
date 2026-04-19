// Motion keyframes test (task 4b.4) — asserts that the two allowed motion
// primitives (sync-pulse for the syncing status dot, skeleton-shimmer for
// loading placeholders) are declared in `globals.css`, gated behind
// `prefers-reduced-motion: no-preference`, and exposed as Tailwind v4
// `--animate-*` theme variables so `animate-skeleton-shimmer` /
// `animate-sync-pulse` utilities are generated.
//
// Phase 4A chose the CSS-first `@theme` configuration (no `tailwind.config.ts`),
// so the motion animation tokens go in the `@theme inline` block of
// `globals.css`. This test reads that file as text and asserts on the
// declarations, mirroring the pattern used by `theme.test.ts`,
// `typography.test.ts`, and `density-config.test.ts`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GLOBALS_CSS = path.resolve(__dirname, "..", "globals.css");

const css = readFileSync(GLOBALS_CSS, "utf8");

// Extract the contents of the `@media (prefers-reduced-motion: no-preference)`
// at-rule. A full CSS parser is overkill — we count balanced braces from the
// opening `{` that follows the media query.
function extractMediaBlock(source: string, query: RegExp): string | null {
  const match = query.exec(source);
  if (!match) return null;
  const start = source.indexOf("{", match.index);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  return null;
}

function extractThemeBlock(source: string): string | null {
  // Anchor to `\n@theme` so the documentation-comment mention earlier in the
  // file (which has leading indentation) doesn't false-match.
  const m = /\n@theme\s+inline\s*\{/.exec(source);
  if (!m) return null;
  const start = source.indexOf("{", m.index);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  return null;
}

describe("motion keyframes — task 4b.4 (flipped for Motion Safe opt-in)", () => {
  // Motion-Safe-toggle phase (see features/settings/motion-store.ts): custom
  // animations now default to ALWAYS ON. The three @keyframes therefore move
  // OUT of the `prefers-reduced-motion: no-preference` media gate so they're
  // declared at top level. Gating happens on the utility level — if the user
  // has opted into Motion Safe (Settings dialog → Motion Safe toggle ON),
  // `data-motion="safe"` appears on <html> and a separate media block with a
  // `html[data-motion="safe"] .animate-*` selector overrides `animation: none`
  // when the OS also signals reduce-motion. Non-Motion-Safe users see animations
  // regardless of OS preference. shadcn primitive motion (Dialog / DropdownMenu /
  // Tooltip) is independently gated via Tailwind's `motion-safe:` variants and
  // is unaffected by this toggle.

  it("skeleton-shimmer @keyframes is declared at top level (not inside a media block)", () => {
    // Strip every media block; what remains should still contain the keyframe.
    const stripped = css.replace(
      /@media\s*\([^)]*\)\s*\{[\s\S]*?\n\}/g,
      "",
    );
    expect(stripped).toMatch(/@keyframes\s+skeleton-shimmer\s*\{/);
  });

  it("sync-pulse @keyframes is declared at top level (not inside a media block)", () => {
    const stripped = css.replace(
      /@media\s*\([^)]*\)\s*\{[\s\S]*?\n\}/g,
      "",
    );
    expect(stripped).toMatch(/@keyframes\s+sync-pulse\s*\{/);
  });

  it("sync-ripple @keyframes is declared at top level (not inside a media block)", () => {
    const stripped = css.replace(
      /@media\s*\([^)]*\)\s*\{[\s\S]*?\n\}/g,
      "",
    );
    expect(stripped).toMatch(/@keyframes\s+sync-ripple\s*\{/);
  });

  it("declares the Motion Safe opt-in override media block (prefers-reduced-motion: reduce)", () => {
    // The opt-in override: custom animations are disabled ONLY when BOTH the
    // `data-motion="safe"` attribute is set on <html> AND the OS signals
    // reduce-motion. Users who haven't toggled Motion Safe continue to see
    // animations regardless of OS preference.
    const block = extractMediaBlock(
      css,
      /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/,
    );
    expect(block).not.toBeNull();
  });

  it("Motion Safe override disables animate-sync-pulse when data-motion='safe' + OS reduce-motion", () => {
    const block = extractMediaBlock(
      css,
      /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/,
    );
    expect(block).not.toBeNull();
    expect(block!).toMatch(
      /html\[data-motion\s*=\s*"safe"\][^{]*\.animate-sync-pulse[^{]*\{[^}]*animation\s*:\s*none/,
    );
  });

  it("Motion Safe override disables animate-sync-ripple when data-motion='safe' + OS reduce-motion", () => {
    const block = extractMediaBlock(
      css,
      /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/,
    );
    expect(block).not.toBeNull();
    expect(block!).toMatch(
      /html\[data-motion\s*=\s*"safe"\][^{]*\.animate-sync-ripple[^{]*\{[^}]*animation\s*:\s*none/,
    );
  });

  it("Motion Safe override disables animate-skeleton-shimmer when data-motion='safe' + OS reduce-motion", () => {
    const block = extractMediaBlock(
      css,
      /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/,
    );
    expect(block).not.toBeNull();
    expect(block!).toMatch(
      /html\[data-motion\s*=\s*"safe"\][^{]*\.animate-skeleton-shimmer[^{]*\{[^}]*animation\s*:\s*none/,
    );
  });

  it("exposes --animate-skeleton-shimmer in the @theme inline block", () => {
    const theme = extractThemeBlock(css);
    expect(theme).not.toBeNull();
    expect(theme!).toMatch(/--animate-skeleton-shimmer\s*:\s*skeleton-shimmer\s+/);
  });

  it("exposes --animate-sync-pulse in the @theme inline block", () => {
    const theme = extractThemeBlock(css);
    expect(theme).not.toBeNull();
    expect(theme!).toMatch(/--animate-sync-pulse\s*:\s*sync-pulse\s+/);
  });

  it("skeleton-shimmer uses the 1.5s linear infinite timing from design.md Decision 10", () => {
    const theme = extractThemeBlock(css);
    expect(theme).not.toBeNull();
    expect(theme!).toMatch(
      /--animate-skeleton-shimmer\s*:\s*skeleton-shimmer\s+1\.5s\s+linear\s+infinite/,
    );
  });

  it("sync-pulse uses the 1.2s ease-in-out infinite timing from design.md Decision 10", () => {
    const theme = extractThemeBlock(css);
    expect(theme).not.toBeNull();
    expect(theme!).toMatch(
      /--animate-sync-pulse\s*:\s*sync-pulse\s+1\.2s\s+ease-in-out\s+infinite/,
    );
  });

  it("exposes --animate-sync-ripple in the @theme inline block (round-3)", () => {
    const theme = extractThemeBlock(css);
    expect(theme).not.toBeNull();
    expect(theme!).toMatch(/--animate-sync-ripple\s*:\s*sync-ripple\s+/);
  });

  it("sync-ripple uses the 1.8s ease-out infinite timing", () => {
    const theme = extractThemeBlock(css);
    expect(theme).not.toBeNull();
    expect(theme!).toMatch(
      /--animate-sync-ripple\s*:\s*sync-ripple\s+1\.8s\s+ease-out\s+infinite/,
    );
  });
});
