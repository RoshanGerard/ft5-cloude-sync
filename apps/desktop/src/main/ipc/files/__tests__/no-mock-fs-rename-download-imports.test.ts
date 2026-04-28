// Regression test for add-engine-rename-download §17.7.
//
// Once §17 swapped the main-process rename + download IPC handlers to
// SyncClient-based wrappers (matching the canonical list/stat/search/remove
// pattern), no source file under `apps/desktop/src/main/` other than
// `mock-fs.ts` itself is allowed to import `rename` or `download` from
// `./mock-fs`. A future change that re-introduces such an import would
// silently re-couple the main process to the in-memory fixture; this test
// fails first.
//
// Implementation: walk the main directory tree, read each .ts file, and
// regex-match any `import { ... } from "./mock-fs(.js)?"` line whose
// imported-name list contains `rename` or `download`. The test file lives
// under `apps/desktop/src/main/ipc/files/__tests__/`, so the walk is
// rooted at the resolved absolute path of `apps/desktop/src/main/`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// __tests__ → files → ipc → main
const MAIN_ROOT = path.resolve(HERE, "..", "..", "..");

// Matches:
//   import { foo, rename, bar } from "./mock-fs";
//   import { rename } from "./mock-fs.js";
//   import { download as d } from "../mock-fs";
// The `[^"']*` segment lets the import path land at any depth above the
// caller — the named-binding check is what enforces the rule.
const MOCK_FS_IMPORT_RE =
  /import\s*\{([^}]+)\}\s*from\s*["'][^"']*\/mock-fs(?:\.js)?["']/g;

interface Offender {
  readonly file: string;
  readonly importedNames: readonly string[];
}

function walkTsFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        // Skip nothing — even __tests__ subdirs are scanned. mock-fs.ts and
        // its test are excluded by name in the caller.
        stack.push(full);
        continue;
      }
      if (st.isFile() && full.endsWith(".ts")) {
        out.push(full);
      }
    }
  }
  return out;
}

function extractImportedNames(bindings: string): string[] {
  // Strip `as` aliases, comments, and whitespace; surface the original
  // imported identifier (the part to the left of `as`).
  return bindings
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.split(/\s+as\s+/)[0]!.trim());
}

describe("regression: no source under apps/desktop/src/main imports rename/download from mock-fs", () => {
  it("only mock-fs.ts itself defines rename/download; no consumers remain", () => {
    const files = walkTsFiles(MAIN_ROOT);
    expect(files.length, "main tree must contain at least some .ts files").toBeGreaterThan(0);

    const offenders: Offender[] = [];
    for (const file of files) {
      const base = path.basename(file);
      // mock-fs.ts itself is the source of truth; its sibling test is the
      // only file allowed to reference it for fixture coverage. Both are
      // exempted by filename so the test stays correct even if the tree
      // moves.
      if (base === "mock-fs.ts") continue;
      if (base === "mock-fs.test.ts") continue;
      // This regression test contains example import strings inside doc
      // comments — those are illustrative, not real imports. Exempt the
      // file from its own walk.
      if (base === "no-mock-fs-rename-download-imports.test.ts") continue;

      const text = readFileSync(file, "utf8");
      MOCK_FS_IMPORT_RE.lastIndex = 0;
      let match: RegExpExecArray | null = MOCK_FS_IMPORT_RE.exec(text);
      while (match !== null) {
        const names = extractImportedNames(match[1]!);
        if (names.includes("rename") || names.includes("download")) {
          offenders.push({ file, importedNames: names });
        }
        match = MOCK_FS_IMPORT_RE.exec(text);
      }
    }

    expect(
      offenders,
      `found imports of rename/download from mock-fs:\n${offenders
        .map((o) => `  ${o.file} — { ${o.importedNames.join(", ")} }`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
