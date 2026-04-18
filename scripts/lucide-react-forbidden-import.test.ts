// Standing guardrail: `lucide-react` may be imported from exactly two places
// in the renderer:
//   1. `apps/desktop/src/renderer/src/components/icon.tsx` — the ONE allowed
//      adapter (Phase 4B). Feature code imports named icons from this module,
//      never from `lucide-react` directly.
//   2. `apps/desktop/src/renderer/src/components/ui/**` — shadcn-generated
//      vendor primitives that ship with `lucide-react` imports we own but do
//      not hand-author. Exempt as a group.
//
// Scope: `.tsx` files under
//   - apps/desktop/src/renderer/src/features/**
//   - apps/desktop/src/renderer/src/components/**
// Exempt: `components/icon.tsx`, every file under `components/ui/**`, and any
//         `__tests__/` directory.
//
// Covers task 4.9 of the `ui-ux-design` OpenSpec change. Passes today; will
// light up in Phase 5/6 if any feature file bypasses the adapter.

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

const EXEMPT_FILES = [path.join(RENDERER_SRC, "components", "icon.tsx")];
const EXEMPT_DIRS = [path.join(RENDERER_SRC, "components", "ui")];

// Matches, at the start of a line (under the /m flag):
//   import <anything-without-quotes> from "lucide-react"
//   import "lucide-react"
// and their single-quoted twins. Uses `multiline: true` via the `m` flag so
// `^` anchors at every line start. Does NOT match `@lucide/react` or any other
// near-miss because the quoted specifier is literally `lucide-react` with no
// slash prefix.
const LUCIDE_IMPORT_RE =
  /^(?:import\s+[^'"]+from\s+["']lucide-react["']|import\s+["']lucide-react["'])/gm;

type Violation = {
  file: string;
  line: number;
  column: number;
  match: string;
};

function findViolationsInText(
  text: string,
  file: string,
): Violation[] {
  const violations: Violation[] = [];
  LUCIDE_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LUCIDE_IMPORT_RE.exec(text)) !== null) {
    const { line, column } = offsetToLineCol(text, m.index);
    violations.push({ file, line, column, match: m[0] });
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

function isExemptFile(file: string): boolean {
  if (EXEMPT_FILES.includes(file)) return true;
  return EXEMPT_DIRS.some(
    (dir) => file === dir || file.startsWith(dir + path.sep),
  );
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
      walkTsx(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
}

describe("lucide-react forbidden-import guardrail — detection", () => {
  it("flags a named import from lucide-react", () => {
    const v = findViolationsInText(
      'import { Sun } from "lucide-react";\n',
      "fake.tsx",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.line).toBe(1);
    expect(v[0]!.column).toBe(1);
    expect(v[0]!.match).toContain("lucide-react");
  });

  it("flags a default import from lucide-react", () => {
    const v = findViolationsInText(
      'import Icons from "lucide-react";\n',
      "fake.tsx",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.match).toContain("lucide-react");
  });

  it("flags a side-effect import from lucide-react", () => {
    const v = findViolationsInText(
      'import "lucide-react";\n',
      "fake.tsx",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.match).toContain("lucide-react");
  });

  it("flags a single-quoted import from lucide-react", () => {
    const v = findViolationsInText(
      "import { Moon } from 'lucide-react';\n",
      "fake.tsx",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.match).toContain("lucide-react");
  });

  it("does NOT flag a near-miss like @lucide/react (different specifier)", () => {
    const v = findViolationsInText(
      'import { Bar } from "@lucide/react";\n',
      "fake.tsx",
    );
    expect(v).toEqual([]);
  });

  it("does NOT flag a near-miss like lucide-react-native", () => {
    const v = findViolationsInText(
      'import { Bar } from "lucide-react-native";\n',
      "fake.tsx",
    );
    expect(v).toEqual([]);
  });

  it("does NOT flag an import of another package that mentions lucide-react in its body", () => {
    const v = findViolationsInText(
      'import { Foo } from "some-other-pkg";\n// uses lucide-react under the hood\n',
      "fake.tsx",
    );
    expect(v).toEqual([]);
  });

  it("reports accurate line and column for an import on line 3", () => {
    const text = 'const a = 1;\nconst b = 2;\nimport { Sun } from "lucide-react";\n';
    const v = findViolationsInText(text, "x.tsx");
    expect(v.length).toBe(1);
    expect(v[0]!.line).toBe(3);
    expect(v[0]!.column).toBe(1);
  });
});

describe("lucide-react forbidden-import guardrail — feature code is clean", () => {
  it("only the Icon adapter and shadcn ui primitives import from lucide-react", () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      walkTsx(root, files);
    }
    expect(files.length, "expected at least one .tsx file to scan").toBeGreaterThan(0);

    const violations: Violation[] = [];
    for (const file of files) {
      if (isExemptFile(file)) continue;
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      const text = readFileSync(file, "utf8");
      violations.push(...findViolationsInText(text, file));
    }

    expect(
      violations,
      violations.length
        ? `Disallowed lucide-react imports (use @/components/icon instead):\n${violations
            .map((v) => `  ${v.file}:${v.line}:${v.column}  ${v.match}`)
            .join("\n")}`
        : "",
    ).toEqual([]);
  });

  it("the Icon adapter exists and is the single allowed lucide-react importer", () => {
    const iconPath = EXEMPT_FILES[0]!;
    expect(statSync(iconPath).isFile(), `missing ${iconPath}`).toBe(true);
    const text = readFileSync(iconPath, "utf8");
    const v = findViolationsInText(text, iconPath);
    expect(v.length).toBeGreaterThanOrEqual(1);
  });
});
