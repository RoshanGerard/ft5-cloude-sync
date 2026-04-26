// implement-datasource-onboarding §29 — verify no `consent-` references
// remain in production renderer code.
//
// Per design.md Decision 7, the consent-* event family was retired in
// favour of the service-emitted auth-* family. Per spec scenario
// "useConsentSession is no longer exported" the hook is gone. Per the
// IPC contract update, `window.api.datasources.startConsent` no longer
// exists on the surface.
//
// This test scans every `.ts` / `.tsx` file under
// `apps/desktop/src/renderer/src/` and asserts that NO non-test file
// contains the literal `consent-`, `useConsentSession`, or
// `datasources.startConsent`. Test files (under `__tests__/` directories)
// and `.test.tsx` / `.test-d.ts` files are excluded — historical context
// or documentation that mentions the legacy names is allowed to live in
// tests during the migration window.

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const RENDERER_SRC = path.resolve(
  __dirname,
  "..",
);

interface OffendingMatch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly pattern: string;
}

/**
 * Recursively walk a directory and yield every `.ts` / `.tsx` file path.
 * Skips `__tests__/` directories and any test file (`.test.ts`,
 * `.test.tsx`, `.test-d.ts`). Skips `node_modules/`, `dist/`, and
 * `__forbidden_lint_regression__/` (the latter is a deliberately broken
 * fixture for renderer-lint guardrail tests; nothing in there ships).
 */
function* walkProductionFiles(dir: string): Generator<string> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "__forbidden_lint_regression__"
      ) {
        continue;
      }
      yield* walkProductionFiles(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (
      !entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".tsx")
    ) {
      continue;
    }
    if (
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".test.tsx") ||
      entry.name.endsWith(".test-d.ts")
    ) {
      continue;
    }
    // Self-exclude this test file from the scan — its assertion strings
    // contain the very patterns we're searching for, which would otherwise
    // self-flag.
    if (entry.name === "no-consent-references.test.ts") continue;
    yield full;
  }
}

const FORBIDDEN_PATTERNS: ReadonlyArray<string> = [
  "consent-",
  "useConsentSession",
  "datasources.startConsent",
];

describe("renderer production code is free of consent-* references", () => {
  it("does not contain `consent-`, `useConsentSession`, or `datasources.startConsent` in any non-test file", () => {
    const offenders: OffendingMatch[] = [];

    for (const file of walkProductionFiles(RENDERER_SRC)) {
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (line.includes(pattern)) {
            offenders.push({
              file: path.relative(RENDERER_SRC, file),
              line: i + 1,
              text: line.trim(),
              pattern,
            });
          }
        }
      }
    }

    if (offenders.length > 0) {
      const formatted = offenders
        .map((o) => `  ${o.file}:${o.line} [${o.pattern}] → ${o.text}`)
        .join("\n");
      throw new Error(
        `Found ${offenders.length} forbidden consent reference(s) in renderer production code:\n${formatted}`,
      );
    }

    expect(offenders).toEqual([]);
  });
});
