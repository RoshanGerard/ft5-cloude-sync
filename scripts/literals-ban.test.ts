// Standing guardrail: hard-coded visual-design literals are forbidden in
// renderer feature code. Every colour must come from a CSS variable / Tailwind
// token; every font-size must come from a Tailwind `text-*` utility.
//
// Scope: `.tsx` files under
//   - apps/desktop/src/renderer/src/features/**
//   - apps/desktop/src/renderer/src/components/**
//     (INCLUDING `components/ui/**` — Phase 9.1 lifted the shadcn-primitive
//     exemption. We customized those primitives during Phase 4B (glass
//     overlays, motion-safe gating) and round-3 (progress-bar bg-muted) so
//     they are effectively part of our owned surface. The scan's definition
//     of a "raw font-size" literal is a CSS-in-string `font-size:` declaration,
//     NOT a Tailwind `text-*` class or a spacing utility like `px-4` — so
//     lifting the exemption is safe for shadcn primitives that only use
//     class names.)
// Exempt:
//   - any `__tests__/` directory
//
// Forbidden patterns:
//   1. Hex colours      — #RGB, #RRGGBB, #RRGGBBAA  (but not inside comments)
//   2. Colour functions — rgb( rgba( hsl( hsla( oklch( oklab(
//   3. Raw font-size    — `font-size\s*:\s*\d+\s*(?:px|rem)` (inside strings
//      or CSS-in-JS blocks — feature code should use `text-*` utilities)
//
// Covers task 4.8 of the `ui-ux-design` OpenSpec change. Passes today (no
// violators exist in Phase 4B feature code) and will light up as Phases 5 and
// 6 add `DatasourceCard`, `DatasourcesDashboard`, `AddDatasourceDialog`, etc.

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

const SCAN_ROOTS = [
  path.join(RENDERER_SRC, "features"),
  path.join(RENDERER_SRC, "components"),
];

// Phase 9.1: the former `components/ui/**` exemption was lifted. The scan
// now reaches shadcn-vendored primitives too. They are currently clean, and
// keeping them clean is the point — the primitives were customized for glass
// overlays, motion-safe gating, and the progress-bar bg-muted tweak; hard-
// coded colour literals would bypass the theme tokens those tweaks rely on.
const EXEMPT_DIRS: string[] = [];

type Violation = {
  file: string;
  line: number;
  column: number;
  match: string;
  rule: string;
};

// Forbidden-pattern detection lives in a pure function so the negative-control
// block can exercise it on synthetic input independently of the filesystem.
function findViolationsInText(
  text: string,
  file: string,
): Violation[] {
  const violations: Violation[] = [];

  // Strip line and block comments from a *copy* of the text that we use for
  // pattern matching, but report offsets against the original so line/column
  // numbers line up with what a developer sees in their editor. We replace
  // comment content with same-length spaces (preserving newlines) so offsets
  // are preserved 1:1.
  const sanitized = stripComments(text);

  const patterns: Array<{ rule: string; re: RegExp }> = [
    // 8-digit first (longest match), then 6, then 3. Word-boundary-ish
    // anchoring: not preceded by alnum, not followed by alnum, so `#ff0000`
    // inside `abc#ff0000def` doesn't match (unlikely in .tsx but safe).
    { rule: "hex-color-8", re: /(?<![A-Za-z0-9_])#[0-9a-fA-F]{8}(?![0-9a-fA-F])/g },
    { rule: "hex-color-6", re: /(?<![A-Za-z0-9_])#[0-9a-fA-F]{6}(?![0-9a-fA-F])/g },
    { rule: "hex-color-3", re: /(?<![A-Za-z0-9_])#[0-9a-fA-F]{3}(?![0-9a-fA-F])/g },
    { rule: "rgb-func", re: /\brgba?\s*\(/g },
    { rule: "hsl-func", re: /\bhsla?\s*\(/g },
    { rule: "oklch-func", re: /\boklch\s*\(/g },
    { rule: "oklab-func", re: /\boklab\s*\(/g },
    { rule: "raw-font-size", re: /font-size\s*:\s*\d+(?:\.\d+)?\s*(?:px|rem)/gi },
  ];

  for (const { rule, re } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sanitized)) !== null) {
      const { line, column } = offsetToLineCol(text, m.index);
      violations.push({ file, line, column, match: m[0], rule });
    }
  }

  // De-dupe: 8-digit, 6-digit, 3-digit hex patterns never overlap because of
  // the boundary anchors, but be defensive anyway.
  return violations;
}

function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  let state: "code" | "line" | "block" | "str-sq" | "str-dq" | "str-bt" = "code";

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "'") {
        state = "str-sq";
        out += c;
        i++;
        continue;
      }
      if (c === '"') {
        state = "str-dq";
        out += c;
        i++;
        continue;
      }
      if (c === "`") {
        state = "str-bt";
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else {
        out += " ";
      }
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i++;
      continue;
    }
    // String states: preserve content so that legit tokens keep their line/col
    // and so the forbidden-literal regex can still flag them. Respect escapes.
    if (c === "\\" && i + 1 < n) {
      out += c;
      out += text[i + 1];
      i += 2;
      continue;
    }
    if (
      (state === "str-sq" && c === "'") ||
      (state === "str-dq" && c === '"') ||
      (state === "str-bt" && c === "`")
    ) {
      state = "code";
    }
    out += c;
    i++;
  }
  return out;
}

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

function walkTsx(root: string, out: string[]): void {
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
      if (EXEMPT_DIRS.some((exempt) => full === exempt || full.startsWith(exempt + path.sep))) {
        continue;
      }
      walkTsx(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
}

describe("literals-ban guardrail — forbidden pattern detection", () => {
  it("flags 3-digit hex literals", () => {
    const v = findViolationsInText('const c = "#fff";\n', "synthetic.tsx");
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0]!.match).toBe("#fff");
    expect(v[0]!.rule).toBe("hex-color-3");
  });

  it("flags 6-digit hex literals", () => {
    const v = findViolationsInText('const c = "#ff0000";\n', "synthetic.tsx");
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0]!.match).toBe("#ff0000");
    expect(v[0]!.rule).toBe("hex-color-6");
  });

  it("flags 8-digit hex literals (with alpha)", () => {
    const v = findViolationsInText('const c = "#ff0000ff";\n', "synthetic.tsx");
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0]!.match).toBe("#ff0000ff");
    expect(v[0]!.rule).toBe("hex-color-8");
  });

  it("flags rgb()/rgba() calls", () => {
    const v1 = findViolationsInText('const c = "rgb(255, 0, 0)";', "s.tsx");
    const v2 = findViolationsInText('const c = "rgba(0, 0, 0, 0.5)";', "s.tsx");
    expect(v1.some((x) => x.rule === "rgb-func")).toBe(true);
    expect(v2.some((x) => x.rule === "rgb-func")).toBe(true);
  });

  it("flags hsl()/hsla() calls", () => {
    const v1 = findViolationsInText('const c = "hsl(0 0% 100%)";', "s.tsx");
    const v2 = findViolationsInText('const c = "hsla(0, 0%, 100%, 1)";', "s.tsx");
    expect(v1.some((x) => x.rule === "hsl-func")).toBe(true);
    expect(v2.some((x) => x.rule === "hsl-func")).toBe(true);
  });

  it("flags oklch()/oklab() calls", () => {
    const v1 = findViolationsInText('const c = "oklch(0.5 0.1 200)";', "s.tsx");
    const v2 = findViolationsInText('const c = "oklab(0.5 0.1 0.1)";', "s.tsx");
    expect(v1.some((x) => x.rule === "oklch-func")).toBe(true);
    expect(v2.some((x) => x.rule === "oklab-func")).toBe(true);
  });

  it("flags raw font-size px/rem literals", () => {
    const v1 = findViolationsInText(
      'const s = "font-size: 14px";',
      "s.tsx",
    );
    const v2 = findViolationsInText(
      'const s = "font-size: 1.25rem";',
      "s.tsx",
    );
    expect(v1.some((x) => x.rule === "raw-font-size")).toBe(true);
    expect(v2.some((x) => x.rule === "raw-font-size")).toBe(true);
  });

  it("ignores forbidden patterns inside line comments", () => {
    const v = findViolationsInText('// #ff0000 is the bad colour\n', "s.tsx");
    expect(v).toEqual([]);
  });

  it("ignores forbidden patterns inside block comments", () => {
    const v = findViolationsInText('/* #ff0000 rgb(1,2,3) hsl(0,0,0) */\n', "s.tsx");
    expect(v).toEqual([]);
  });

  it("does not flag non-colour hashes (e.g. tailwind arbitrary values that are not colour-shaped)", () => {
    // 4 hex chars — not a valid CSS hex colour shape (3/6/8 only).
    const v = findViolationsInText('const id = "#abcd";', "s.tsx");
    expect(v.filter((x) => x.rule.startsWith("hex-color-"))).toEqual([]);
  });

  it("reports accurate line and column for a hex literal", () => {
    const text = 'line one\nline two\nconst c = "#ff0000";\n';
    const v = findViolationsInText(text, "x.tsx");
    expect(v.length).toBe(1);
    expect(v[0]!.line).toBe(3);
    // The `#` appears at column 12 of line 3 (1-indexed).
    expect(v[0]!.column).toBe(12);
  });
});

describe("literals-ban guardrail — feature code is clean", () => {
  it("no feature-level .tsx file contains forbidden visual-design literals", () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      walkTsx(root, files);
    }
    // Sanity check: at least one file must be scanned, otherwise the test
    // would pass vacuously if the directories disappeared.
    expect(files.length, "expected at least one .tsx file to scan").toBeGreaterThan(0);

    const violations: Violation[] = [];
    for (const file of files) {
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      const text = readFileSync(file, "utf8");
      violations.push(...findViolationsInText(text, file));
    }

    // Emit a rich expected/received diff: empty array is the "expected" side.
    expect(
      violations,
      violations.length
        ? `Found forbidden visual-design literals:\n${violations
            .map(
              (v) =>
                `  ${v.file}:${v.line}:${v.column}  [${v.rule}]  ${v.match}`,
            )
            .join("\n")}`
        : "",
    ).toEqual([]);
  });
});
