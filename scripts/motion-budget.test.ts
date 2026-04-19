// Standing guardrail: the "motion whitelist" (design.md Decision 10) says the
// entire dashboard gets exactly two CSS-only animations (`animate-sync-pulse`
// for the syncing status dot, `animate-skeleton-shimmer` for loading
// placeholders), plus shadcn's own overlay/dropdown/tooltip transitions which
// ride on Radix `data-[state=*]` variants. Everything else — `animate-bounce`,
// `animate-spin`, `transition-all`, bespoke `@keyframes`, `animation:` or
// `transition:` declarations in CSS — is banned in feature code.
//
// Scope:
//   - `.tsx` files under apps/desktop/src/renderer/src/features/**
//   - `.tsx` files under apps/desktop/src/renderer/src/components/** (non-ui)
//   - `.css` files under apps/desktop/src/renderer/src/styles/**
// Exempt:
//   - apps/desktop/src/renderer/src/components/ui/**  (shadcn vendor code —
//     Radix motion classes are allowed there)
//   - any `__tests__/` directory
//
// Allowed in `.tsx`:
//   - `animate-skeleton-shimmer`, `animate-sync-pulse` class names
//   - `transition-colors` class name
//   - any `data-[state=*]:animate-*` variant (shadcn/Radix plumbing)
//   - `motion-safe:` / `motion-reduce:` variants (even wrapping the above)
// Allowed in `.css`:
//   - `--animate-*` variable declarations (Tailwind v4 theme tokens)
//   - `@keyframes skeleton-shimmer`, `@keyframes sync-pulse` declarations
//   - `animation: skeleton-shimmer ...` / `animation: sync-pulse ...` named
//     references
//   - `transition-property: color | border-color | background-color` only
//
// Covers task 4b.5 of the `ui-ux-design` OpenSpec change. Passes today; will
// remain a gate against feature code slipping in ad-hoc motion.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const RENDERER_SRC = path.join(
  repoRoot,
  "apps",
  "desktop",
  "src",
  "renderer",
  "src",
);

const TSX_ROOTS = [
  path.join(RENDERER_SRC, "features"),
  path.join(RENDERER_SRC, "components"),
];

const CSS_ROOT = path.join(RENDERER_SRC, "styles");

const EXEMPT_DIRS = [path.join(RENDERER_SRC, "components", "ui")];

const ALLOWED_ANIMATE_CLASSES = new Set([
  "animate-skeleton-shimmer",
  "animate-sync-pulse",
]);

// Allowed CSS `animation-name` / full `animation` shorthand references.
const ALLOWED_ANIMATION_NAMES = new Set([
  "skeleton-shimmer",
  "sync-pulse",
]);

// Allowed CSS `transition-property` values.
const ALLOWED_TRANSITION_PROPS = new Set([
  "color",
  "border-color",
  "background-color",
]);

type Violation = {
  file: string;
  line: number;
  column: number;
  match: string;
  rule: string;
};

function offsetToLineCol(
  text: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

// Detect motion class tokens in a `.tsx` file. We scan for:
//   - `animate-<name>` class tokens
//   - `transition-<modifier>` class tokens (including `transition-all`,
//     `transition`, `transition-opacity`, etc — only `transition-colors` is
//     whitelisted; note bare `transition` is also banned).
// A token is "bounded" by the usual class-list delimiters. Radix variants
// (`data-[state=open]:animate-in`) and motion-safe gates
// (`motion-safe:animate-in`) are recognised by looking at the character(s)
// immediately preceding the token.
export function findTsxViolations(
  text: string,
  file: string,
): Violation[] {
  const violations: Violation[] = [];

  const classTokenRe =
    /(?<pre>^|[\s"'`{>])(?<token>(?:[a-z][a-z0-9-]*:)*(?:animate-[a-zA-Z0-9-]+|transition(?:-[a-zA-Z0-9-]+)?))(?=$|[\s"'`}<])/g;

  let m: RegExpExecArray | null;
  while ((m = classTokenRe.exec(text)) !== null) {
    const token = m.groups!.token!;
    // Split variants: `data-[state=open]:animate-in` -> variants
    // `["data-[state=open]"]`, core `animate-in`. Use a splitter that's
    // aware of bracket contents so `data-[state=open]:foo` stays intact.
    const parts = splitVariants(token);
    const variants = parts.slice(0, -1);
    const core = parts[parts.length - 1]!;

    // Allow any `data-[state=*]:animate-*` token outright — shadcn primitives
    // use these for state-driven transitions (open/close fades) and we
    // forward them wholesale.
    if (variants.some((v) => /^data-\[state=[^\]]+\]$/.test(v))) {
      continue;
    }

    if (core.startsWith("animate-")) {
      if (ALLOWED_ANIMATE_CLASSES.has(core)) continue;
      const offset = m.index + m.groups!.pre!.length;
      const loc = offsetToLineCol(text, offset);
      violations.push({
        file,
        line: loc.line,
        column: loc.column,
        match: token,
        rule: "forbidden-animate-class",
      });
      continue;
    }

    if (core === "transition" || core.startsWith("transition-")) {
      if (core === "transition-colors") continue;
      const offset = m.index + m.groups!.pre!.length;
      const loc = offsetToLineCol(text, offset);
      violations.push({
        file,
        line: loc.line,
        column: loc.column,
        match: token,
        rule: "forbidden-transition-class",
      });
    }
  }

  return violations;
}

function splitVariants(token: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ":" && depth === 0) {
      out.push(token.slice(start, i));
      start = i + 1;
    }
  }
  out.push(token.slice(start));
  return out;
}

// Detect motion declarations in a `.css` file. We scan for:
//   - property-position `animation:` / `animation-*:` declarations
//   - property-position `transition:` / `transition-*:` declarations
// `--animate-*:` variables and `@keyframes <name> {}` rules are NOT
// property-position declarations (they live at the at-rule / custom-property
// level) and so they do not match this regex — they're allowed implicitly.
export function findCssViolations(
  text: string,
  file: string,
): Violation[] {
  const violations: Violation[] = [];

  // Match lines that look like `<whitespace>animation: ...;` or
  // `<whitespace>transition: ...;`. Anchored to start-of-line (multiline mode)
  // so `--animate-foo: ...` and `animation-timing-function` referenced inside
  // @keyframes bodies also match — which is fine, we audit them below.
  const re = /^[ \t]*(animation(?:-[a-z-]+)?|transition(?:-[a-z-]+)?)\s*:\s*([^;]+);/gm;

  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const prop = m[1]!;
    const value = m[2]!.trim();

    // Inside @keyframes bodies, animation-timing-function is used to define
    // the curve for a keyframe step. Exempt via prop-context: the regex
    // captures declarations inside any `{}` block indifferently, so we
    // inspect whether the declaration sits inside a `@keyframes` block by
    // scanning backwards for the nearest enclosing selector.
    if (isInsideKeyframes(text, m.index)) continue;

    // `animation-name: skeleton-shimmer` and the `animation` shorthand are
    // both allowed if they reference a whitelisted name.
    if (prop === "animation" || prop === "animation-name") {
      const firstWord = value.split(/\s+/)[0]!;
      if (ALLOWED_ANIMATION_NAMES.has(firstWord)) continue;
    }

    // `transition-property: color | border-color | background-color` is the
    // only allowed transition declaration form.
    if (prop === "transition-property") {
      const words = value.split(/[,\s]+/).filter(Boolean);
      if (words.every((w) => ALLOWED_TRANSITION_PROPS.has(w))) continue;
    }

    const loc = offsetToLineCol(text, m.index);
    violations.push({
      file,
      line: loc.line,
      column: loc.column,
      match: `${prop}: ${value}`,
      rule:
        prop.startsWith("animation") ? "forbidden-animation-decl" : "forbidden-transition-decl",
    });
  }

  return violations;
}

function isInsideKeyframes(text: string, offset: number): boolean {
  // Walk backwards from offset, tracking brace depth; if we cross an opening
  // `{` whose preceding selector (loosely, the text from the previous `{` or
  // `}` or `;`) contains `@keyframes`, treat as inside.
  let depth = 0;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        // Found the enclosing open-brace. Grab the selector text preceding.
        const sliceStart = Math.max(
          text.lastIndexOf("}", i - 1),
          text.lastIndexOf("{", i - 1),
          text.lastIndexOf(";", i - 1),
        );
        const selector = text.slice(sliceStart + 1, i);
        if (/@keyframes\s+/.test(selector)) return true;
        // Recurse outward: we might be two levels deep (media > keyframes).
        return isInsideKeyframes(text, sliceStart === -1 ? 0 : sliceStart);
      }
      depth--;
    }
  }
  return false;
}

function walkFiles(root: string, exts: string[], out: string[]): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      if (
        EXEMPT_DIRS.some(
          (exempt) => full === exempt || full.startsWith(exempt + path.sep),
        )
      ) {
        continue;
      }
      walkFiles(full, exts, out);
    } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
}

describe("motion-budget — .tsx class detection", () => {
  it("flags animate-bounce", () => {
    const v = findTsxViolations(
      'const cls = "animate-bounce";\n',
      "synthetic.tsx",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("forbidden-animate-class");
    expect(v[0]!.match).toBe("animate-bounce");
  });

  it("flags animate-spin", () => {
    const v = findTsxViolations(
      'const cls = "animate-spin";\n',
      "synthetic.tsx",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.match).toBe("animate-spin");
  });

  it("flags bare transition class", () => {
    const v = findTsxViolations(
      'const cls = "transition";\n',
      "synthetic.tsx",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.match).toBe("transition");
  });

  it("flags transition-all class", () => {
    const v = findTsxViolations(
      'const cls = "transition-all";\n',
      "synthetic.tsx",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.match).toBe("transition-all");
  });

  it("flags transition-opacity class", () => {
    const v = findTsxViolations(
      'const cls = "transition-opacity";\n',
      "synthetic.tsx",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.match).toBe("transition-opacity");
  });

  it("allows animate-skeleton-shimmer", () => {
    const v = findTsxViolations(
      'const cls = "animate-skeleton-shimmer";\n',
      "synthetic.tsx",
    );
    expect(v).toEqual([]);
  });

  it("allows animate-sync-pulse", () => {
    const v = findTsxViolations(
      'const cls = "animate-sync-pulse";\n',
      "synthetic.tsx",
    );
    expect(v).toEqual([]);
  });

  it("allows transition-colors", () => {
    const v = findTsxViolations(
      'const cls = "transition-colors";\n',
      "synthetic.tsx",
    );
    expect(v).toEqual([]);
  });

  it("allows data-[state=open]:animate-in Radix variant", () => {
    const v = findTsxViolations(
      'const cls = "data-[state=open]:animate-in data-[state=closed]:animate-out";\n',
      "synthetic.tsx",
    );
    expect(v).toEqual([]);
  });

  it("reports accurate line and column", () => {
    const text = 'line one\nline two\nconst c = "animate-bounce";\n';
    const v = findTsxViolations(text, "x.tsx");
    expect(v.length).toBe(1);
    expect(v[0]!.line).toBe(3);
    expect(v[0]!.column).toBe(12);
  });
});

describe("motion-budget — .css declaration detection", () => {
  it("flags bare transition: property", () => {
    const css = "div {\n  transition: all 300ms ease;\n}\n";
    const v = findCssViolations(css, "synthetic.css");
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("forbidden-transition-decl");
  });

  it("flags arbitrary animation: property with non-whitelisted name", () => {
    const css = "div {\n  animation: fadeIn 300ms ease;\n}\n";
    const v = findCssViolations(css, "synthetic.css");
    expect(v.length).toBe(1);
    expect(v[0]!.rule).toBe("forbidden-animation-decl");
  });

  it("allows animation: skeleton-shimmer shorthand", () => {
    const css = "div {\n  animation: skeleton-shimmer 1.5s linear infinite;\n}\n";
    const v = findCssViolations(css, "synthetic.css");
    expect(v).toEqual([]);
  });

  it("allows animation: sync-pulse shorthand", () => {
    const css = "div {\n  animation: sync-pulse 1.2s ease-in-out infinite;\n}\n";
    const v = findCssViolations(css, "synthetic.css");
    expect(v).toEqual([]);
  });

  it("allows transition-property: color", () => {
    const css = "a {\n  transition-property: color;\n}\n";
    const v = findCssViolations(css, "synthetic.css");
    expect(v).toEqual([]);
  });

  it("allows transition-property: color, border-color, background-color", () => {
    const css =
      "a {\n  transition-property: color, border-color, background-color;\n}\n";
    const v = findCssViolations(css, "synthetic.css");
    expect(v).toEqual([]);
  });

  it("does NOT flag --animate-* theme variables (custom properties, not animation: decls)", () => {
    const css = "@theme {\n  --animate-foo: fadeIn 1s linear infinite;\n}\n";
    const v = findCssViolations(css, "synthetic.css");
    expect(v).toEqual([]);
  });

  it("does NOT flag animation-timing-function inside @keyframes", () => {
    const css =
      "@keyframes fadeIn {\n  0% { opacity: 0; animation-timing-function: ease; }\n  100% { opacity: 1; }\n}\n";
    const v = findCssViolations(css, "synthetic.css");
    // The keyframes themselves aren't declared via `animation:`; the
    // timing-function declaration inside the body is exempt as within-keyframes.
    expect(v).toEqual([]);
  });
});

describe("motion-budget — repository is clean", () => {
  it("no feature-level .tsx file uses a non-whitelisted animate/transition class", () => {
    const files: string[] = [];
    for (const root of TSX_ROOTS) {
      walkFiles(root, [".tsx"], files);
    }
    expect(
      files.length,
      "expected at least one .tsx file to scan",
    ).toBeGreaterThan(0);

    const violations: Violation[] = [];
    for (const file of files) {
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      const text = readFileSync(file, "utf8");
      violations.push(...findTsxViolations(text, file));
    }

    expect(
      violations,
      violations.length
        ? `Found forbidden motion classes:\n${violations
            .map(
              (v) =>
                `  ${v.file}:${v.line}:${v.column}  [${v.rule}]  ${v.match}`,
            )
            .join("\n")}`
        : "",
    ).toEqual([]);
  });

  it("no .css file under styles/ uses a non-whitelisted animation/transition declaration", () => {
    const files: string[] = [];
    walkFiles(CSS_ROOT, [".css"], files);
    expect(files.length, "expected at least one .css file to scan").toBeGreaterThan(0);

    const violations: Violation[] = [];
    for (const file of files) {
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      const text = readFileSync(file, "utf8");
      violations.push(...findCssViolations(text, file));
    }

    expect(
      violations,
      violations.length
        ? `Found forbidden CSS motion declarations:\n${violations
            .map(
              (v) =>
                `  ${v.file}:${v.line}:${v.column}  [${v.rule}]  ${v.match}`,
            )
            .join("\n")}`
        : "",
    ).toEqual([]);
  });
});
