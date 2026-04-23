import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Renderer source-tree grep-style invariant (tasks.md 9.7 of wire-fs-sync-service).
//
// Credential handling moved from the desktop main process into the fs-sync
// service (see change `wire-fs-sync-service`, section 9). The renderer must
// never have referenced these symbols to begin with — this guardrail turns
// "never has" into "and never will" by failing CI if any of the seven
// forbidden identifiers resurface in renderer source.
//
// Scope: only `apps/desktop/src/renderer/src/**/*.{ts,tsx}`. The preload
// surface (`apps/desktop/src/preload/`) is intentionally out of scope — it
// is a separate trust boundary and has its own audit in section 6.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// `__dirname` is `.../renderer/src/__tests__`, so the renderer source root
// is one level up.
const RENDERER_SRC = path.resolve(__dirname, "..");
const THIS_FILE = __filename;

const FORBIDDEN = [
  "safeStorage",
  "SqliteCredentialStore",
  "CredentialStore",
  "encryptString",
  "decryptString",
  "credentials.json",
  "datasource_credentials",
] as const;

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip `node_modules` (belt-and-braces; shouldn't appear under src/)
      // and any `__tests__` folder — tests legitimately reference symbols
      // in assertion strings, and this test file itself lives in one.
      if (entry.name === "node_modules" || entry.name === "__tests__") {
        continue;
      }
      yield* walkTsFiles(full);
    } else if (
      entry.isFile() &&
      /\.(ts|tsx)$/.test(entry.name) &&
      full !== THIS_FILE
    ) {
      yield full;
    }
  }
}

describe("renderer — no credential artifacts (9.7)", () => {
  it("every source file is free of credential-related symbols", () => {
    const violations: string[] = [];
    for (const file of walkTsFiles(RENDERER_SRC)) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (const [i, line] of lines.entries()) {
        for (const needle of FORBIDDEN) {
          if (line.includes(needle)) {
            violations.push(
              `${path.relative(RENDERER_SRC, file)}:${i + 1}  contains "${needle}"`,
            );
          }
        }
      }
    }
    expect(
      violations,
      `renderer should not reference credential APIs; found:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
