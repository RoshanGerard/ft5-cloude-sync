// Standing guardrail: the visual direction (design.md Decision 8) prescribes a
// tight radius scale for feature code — shadcn primitives define `--radius` at
// `0.5rem` and expose `rounded-sm|md|lg|xl` from it. Feature code must stay at
// the `sm` / `md` end of that scale so the overall look stays dense and quiet;
// large pills, fully-rounded avatars, and oversized "card-looks-like-a-badge"
// surfaces are out of scope.
//
// Scope: `.tsx` files under
//   - apps/desktop/src/renderer/src/features/**
//   - apps/desktop/src/renderer/src/components/**   (non-`ui/` only)
// Exempt:
//   - apps/desktop/src/renderer/src/components/ui/**   (shadcn vendor code)
//   - any `__tests__/` directory
//
// Forbidden class names:
//   - `rounded-lg`, `rounded-xl`, `rounded-2xl`, `rounded-3xl`, `rounded-full`
//
// Single exception: files whose *basename* contains `dialog` may use
// `rounded-lg` — Dialog content is permitted the larger corner per design.md
// Decision 8. (The shadcn Dialog primitive itself lives under components/ui/**
// and is already exempt; the exception here is for any feature-level dialog
// that wraps/composes it.)
//
// Class-match anchoring: we look for the token within a whitespace- or
// quote-bounded context so `rounded-lg` doesn't match inside `rounded-lg-ish`
// or similar arbitrary-name near-misses (unlikely in .tsx but defensive).
//
// Covers task 4b.3 of the `ui-ux-design` OpenSpec change. Passes today (no
// feature code uses these classes); will light up as Phases 5/6 land.

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

const EXEMPT_DIRS = [path.join(RENDERER_SRC, "components", "ui")];

const FORBIDDEN_CLASSES = [
  "rounded-lg",
  "rounded-xl",
  "rounded-2xl",
  "rounded-3xl",
  "rounded-full",
] as const;

type Violation = {
  file: string;
  line: number;
  column: number;
  match: string;
};

// A class token is "bounded" if the character before is start-of-text,
// whitespace, or a quote; the character after is end-of-text, whitespace, or a
// quote. This means it matches free-form className strings as well as
// template-literal/cn() concatenations in the usual ways, but rejects
// `rounded-lgish` or `my-rounded-lg-variant`.
function buildClassRegex(cls: string): RegExp {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<=^|[\\s"'\`{])${escaped}(?=$|[\\s"'\`}])`, "g");
}

function findViolationsInText(
  text: string,
  file: string,
): Violation[] {
  const violations: Violation[] = [];
  const basename = path.basename(file).toLowerCase();
  const isDialog = basename.includes("dialog");

  for (const cls of FORBIDDEN_CLASSES) {
    // Single exception: `*dialog*.tsx` files may use `rounded-lg` — but NOT
    // the larger radii.
    if (isDialog && cls === "rounded-lg") continue;

    const re = buildClassRegex(cls);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const { line, column } = offsetToLineCol(text, m.index);
      violations.push({ file, line, column, match: cls });
    }
  }
  return violations;
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

describe("radii-ceiling guardrail — forbidden class detection", () => {
  it("flags rounded-lg in a non-dialog file", () => {
    const v = findViolationsInText(
      'const cls = "rounded-lg border";\n',
      path.join("features", "theme", "theme-switcher.tsx"),
    );
    expect(v.length).toBe(1);
    expect(v[0]!.match).toBe("rounded-lg");
  });

  it("flags rounded-xl in any file", () => {
    const v = findViolationsInText(
      'const cls = "rounded-xl";\n',
      "anything.tsx",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.match).toBe("rounded-xl");
  });

  it("flags rounded-2xl in any file", () => {
    const v = findViolationsInText('const cls = "rounded-2xl";\n', "x.tsx");
    expect(v.length).toBe(1);
    expect(v[0]!.match).toBe("rounded-2xl");
  });

  it("flags rounded-3xl in any file", () => {
    const v = findViolationsInText('const cls = "rounded-3xl";\n', "x.tsx");
    expect(v.length).toBe(1);
    expect(v[0]!.match).toBe("rounded-3xl");
  });

  it("flags rounded-full in any file", () => {
    const v = findViolationsInText('const cls = "rounded-full";\n', "x.tsx");
    expect(v.length).toBe(1);
    expect(v[0]!.match).toBe("rounded-full");
  });

  it("exempts rounded-lg in *dialog*.tsx filenames", () => {
    const v = findViolationsInText(
      'const cls = "rounded-lg border";\n',
      path.join("features", "datasources", "add-dialog.tsx"),
    );
    expect(v).toEqual([]);
  });

  it("still flags rounded-xl in dialog files (only rounded-lg is exempted)", () => {
    const v = findViolationsInText(
      'const cls = "rounded-xl";\n',
      path.join("features", "datasources", "add-dialog.tsx"),
    );
    expect(v.length).toBe(1);
    expect(v[0]!.match).toBe("rounded-xl");
  });

  it("does not flag rounded-sm or rounded-md", () => {
    const v = findViolationsInText(
      'const cls = "rounded-sm rounded-md";\n',
      "x.tsx",
    );
    expect(v).toEqual([]);
  });

  it("does not flag near-miss tokens like rounded-lgish", () => {
    const v = findViolationsInText(
      'const cls = "rounded-lgish my-rounded-full-variant";\n',
      "x.tsx",
    );
    expect(v).toEqual([]);
  });

  it("reports accurate line and column", () => {
    const text = 'line one\nline two\nconst c = "rounded-xl";\n';
    const v = findViolationsInText(text, "x.tsx");
    expect(v.length).toBe(1);
    expect(v[0]!.line).toBe(3);
    expect(v[0]!.column).toBe(12);
  });
});

describe("radii-ceiling guardrail — feature code is clean", () => {
  it("no feature-level .tsx file uses a forbidden rounded-* class", () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      walkTsx(root, files);
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
      violations.push(...findViolationsInText(text, file));
    }

    expect(
      violations,
      violations.length
        ? `Found forbidden rounded-* classes:\n${violations
            .map((v) => `  ${v.file}:${v.line}:${v.column}  ${v.match}`)
            .join("\n")}`
        : "",
    ).toEqual([]);
  });
});
