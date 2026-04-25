// Task 8.3 — Negative guardrail: the retired `datasources.upload` surface is
// NOWHERE in the codebase outside `openspec/` (where retired channels are
// referenced by name in proposals, designs, tasks, and archives).
//
// Recursively walks the worktree and fails if any source file references the
// retired channel literal, type names, namespace property, or call site.
// Lockfiles, build outputs, vendored deps, openspec docs, and this test file
// itself are exempt; the test file is exempt by file name (skip-by-path)
// rather than by indirection alone, because we ALSO build the patterns from
// substring fragments so the literal `datasources:upload"` never appears in
// this source — that keeps the test self-clean even if some future refactor
// points the walker at `__tests__/`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename_ = fileURLToPath(import.meta.url);
const __dirname_ = path.dirname(__filename_);
const repoRoot = path.resolve(__dirname_, "../../../..");

// Build the retired-channel literal from fragments so this source file
// itself doesn't contain the exact string the regexes below search for.
const RETIRED_CHANNEL = "datasources:" + "upload";

// Patterns that, if found in any non-exempt file, indicate the retired
// surface is still referenced somewhere it shouldn't be.
const VIOLATING_PATTERNS: ReadonlyArray<{
  readonly description: string;
  readonly pattern: RegExp;
}> = [
  {
    description: `${RETIRED_CHANNEL} as a double-quoted string literal`,
    // Must NOT match the surviving "...:upload:progress" channel — the
    // closing double-quote anchors that distinction.
    pattern: new RegExp(RETIRED_CHANNEL + `"`),
  },
  {
    description: `${RETIRED_CHANNEL} as a single-quoted string literal`,
    pattern: new RegExp(RETIRED_CHANNEL + `'`),
  },
  {
    description: "datasources.upload( — renderer call site",
    pattern: /datasources\.upload\s*\(/,
  },
  {
    description: "DatasourcesUploadRequest type reference",
    pattern: /\bDatasourcesUploadRequest\b/,
  },
  {
    description: "DatasourcesUploadResponse type reference",
    pattern: /\bDatasourcesUploadResponse\b/,
  },
  {
    description:
      "DATASOURCES_CHANNELS.upload (anything except the surviving uploadProgress)",
    pattern: /DATASOURCES_CHANNELS\.upload(?!Progress)/,
  },
];

// Directories never to walk into — vendored deps, build outputs, version
// control internals, sibling worktrees, openspec docs (allowed by spec),
// and coverage reports.
const SKIP_DIRS = new Set<string>([
  "node_modules",
  "dist",
  ".git",
  ".worktrees",
  "openspec",
  "coverage",
  ".turbo",
  ".next",
  ".cache",
  // Renderer (Next.js) build artifacts that occasionally hang around
  // in a checked-out tree even when fresh `pnpm install` clears
  // dist/. The TypeScript .tsbuild output mirrors the renderer's
  // tsconfig outDir; `out` is Next.js's static-export landing dir.
  // Both contain pre-archive build output and would surface
  // false-positive references to symbol names that have been
  // renamed/retired in source.
  ".tsbuild",
  "out",
]);

// File names exempt from the scan: lockfiles (gigantic and never the source
// of a real wiring violation) and this test file itself (its source legally
// must reference the patterns).
const SKIP_FILES = new Set<string>([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  path.basename(__filename_),
]);

const SCANNED_EXTENSIONS = new Set<string>([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
]);

interface Violation {
  readonly file: string;
  readonly pattern: string;
}

describe("retired datasources.upload surface is gone", () => {
  it("no source file references the retired channel, types, or call site", () => {
    const violations: Violation[] = [];
    walk(repoRoot, (filePath) => {
      const base = path.basename(filePath);
      if (SKIP_FILES.has(base)) return;
      const ext = path.extname(filePath);
      if (!SCANNED_EXTENSIONS.has(ext)) return;
      let contents: string;
      try {
        contents = readFileSync(filePath, "utf8");
      } catch {
        return;
      }
      for (const { description, pattern } of VIOLATING_PATTERNS) {
        if (pattern.test(contents)) {
          violations.push({
            file: path.relative(repoRoot, filePath),
            pattern: description,
          });
        }
      }
    });

    if (violations.length > 0) {
      const lines = violations
        .map((v) => `  - ${v.file}: ${v.pattern}`)
        .join("\n");
      expect.fail(
        `Found ${violations.length} reference(s) to the retired ` +
          `${RETIRED_CHANNEL} surface:\n${lines}`,
      );
    }
    expect(violations.length).toBe(0);
  });
});

function walk(root: string, visit: (filePath: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(fullPath, visit);
    } else if (stat.isFile()) {
      visit(fullPath);
    }
  }
}
