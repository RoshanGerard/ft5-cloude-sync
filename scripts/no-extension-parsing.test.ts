// Standing guardrail for the file-explorer feature: icon selection MUST be
// driven by `iconForEntry(entry)` (the pure mapping from (kind, mimeFamily)
// → IconName added in Phase 3 of `ui-file-explorer`). No renderer code under
// `features/file-explorer/` may parse extensions out of file names to derive
// an icon — mime-family derivation lives in the main-process handler, per
// design.md Decision 2 and the spec requirement "No per-extension parsing
// in the renderer".
//
// This test is a regression guard. It is green today and is designed to
// light up red the day a future contributor reaches for `name.split(".")`
// or `path.extname` inside file-explorer feature code.
//
// Scope: every `.ts` / `.tsx` file under
//   apps/desktop/src/renderer/src/features/file-explorer/
// (including `__tests__/` — tests can cheat just as easily as production
// code). This file and anything else under `scripts/` is excluded by scope.
//
// Forbidden patterns (kept literal and small on purpose):
//   1. `.split(".")`          — `name.split(".").pop()` style
//   2. `path.extname(...)`    — the Node `path.extname` call
//   3. `.lastIndexOf(".")`    — another "find the extension start" idiom
//   4. `.match(/\.xxx$/...)`  — regex-on-extension pattern
//   5. `/\.xxx$/i`-style regex literals inline in the file — the catch-all
//      that trips bare `/\.jpg$/` / `/\.png$/` extension regexes used for
//      type derivation in the renderer.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const FILE_EXPLORER_DIR = path.join(
  repoRoot,
  "apps",
  "desktop",
  "src",
  "renderer",
  "src",
  "features",
  "file-explorer",
);

// Deliberately literal. Adding a sixth pattern should be a deliberate act;
// leave this list small so it's easy to reason about false positives.
const FORBIDDEN_PATTERNS: readonly { name: string; re: RegExp }[] = [
  {
    name: '`.split(".")` — splitting a name on "." to extract an extension',
    re: /\.split\(\s*["']\.["']\s*\)/,
  },
  {
    name: "`path.extname(...)` — Node path.extname call",
    re: /\bpath\.extname\s*\(/,
  },
  {
    name: '`.lastIndexOf(".")` — scanning for the final "."',
    re: /\.lastIndexOf\(\s*["']\.["']\s*\)/,
  },
  {
    name: "`.match(/\\.xxx$/...)` — regex match on a trailing extension",
    re: /\.match\(\s*\/\\\.[^/]+\$\//,
  },
  {
    name: "inline `/\\.xxx$/` extension regex literal",
    re: /\/\\\.[a-z0-9]+\$\/[gimsuy]*/i,
  },
];

type Violation = {
  file: string;
  line: number;
  column: number;
  pattern: string;
  match: string;
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

function findViolationsInText(text: string, file: string): Violation[] {
  const violations: Violation[] = [];
  for (const { name, re } of FORBIDDEN_PATTERNS) {
    // Build a fresh global copy so we can walk every occurrence without
    // mutating the shared RegExp's lastIndex across files.
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) {
      const { line, column } = offsetToLineCol(text, m.index);
      violations.push({ file, line, column, pattern: name, match: m[0] });
      if (m.index === g.lastIndex) g.lastIndex++;
    }
  }
  return violations;
}

function walkScoped(root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkScoped(full, out);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      out.push(full);
    }
  }
}

describe("no extension-parsing in file-explorer — detection", () => {
  it("flags `name.split('.').pop()`", () => {
    const v = findViolationsInText(
      'const ext = name.split(".").pop();\n',
      "fake.ts",
    );
    expect(v.length).toBe(1);
  });

  it("flags `path.extname(name)`", () => {
    const v = findViolationsInText(
      'import path from "node:path";\nconst ext = path.extname(name);\n',
      "fake.ts",
    );
    expect(v.length).toBe(1);
  });

  it("flags `name.lastIndexOf('.')`", () => {
    const v = findViolationsInText(
      'const at = name.lastIndexOf(".");\n',
      "fake.ts",
    );
    expect(v.length).toBe(1);
  });

  it("flags `.match(/\\.jpg$/i)`", () => {
    const v = findViolationsInText(
      "const m = name.match(/\\.jpg$/i);\n",
      "fake.ts",
    );
    expect(v.length).toBeGreaterThanOrEqual(1);
  });

  it("flags a bare `/\\.png$/` regex literal", () => {
    const v = findViolationsInText(
      "const isPng = /\\.png$/.test(name);\n",
      "fake.ts",
    );
    expect(v.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag unrelated `.split(',')` calls", () => {
    const v = findViolationsInText(
      'const parts = csv.split(",");\n',
      "fake.ts",
    );
    expect(v).toEqual([]);
  });
});

describe("no extension-parsing in file-explorer — feature code is clean", () => {
  it("no `.ts` / `.tsx` under features/file-explorer/ parses extensions", () => {
    const files: string[] = [];
    walkScoped(FILE_EXPLORER_DIR, files);
    expect(
      files.length,
      "expected at least one file under features/file-explorer/ to scan",
    ).toBeGreaterThan(0);

    const violations: Violation[] = [];
    for (const file of files) {
      const s = statSync(file);
      if (!s.isFile()) continue;
      const text = readFileSync(file, "utf8");
      violations.push(...findViolationsInText(text, file));
    }

    expect(
      violations,
      violations.length
        ? `Extension-parsing detected in file-explorer feature code (use iconForEntry instead):\n${violations
            .map(
              (v) =>
                `  ${v.file}:${v.line}:${v.column}  [${v.pattern}]  ${v.match}`,
            )
            .join("\n")}`
        : "",
    ).toEqual([]);
  });
});
