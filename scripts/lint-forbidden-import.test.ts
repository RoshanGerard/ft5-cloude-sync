// Standing regression test for the renderer-scoped `no-restricted-imports`
// ESLint rule in `eslint.config.mjs`. The rule itself was proven RED-then-
// GREEN during Section 2.5 of the setup-project change with a temporary
// fixture that was deleted. This test keeps that proof alive by writing a
// disposable fixture, invoking the real `eslint` binary on it, and asserting
// the rule still fires.
//
// Covers: `openspec/changes/setup-project/specs/app-shell/spec.md`
// Requirement 4, scenario "Lint rejects forbidden import".
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const fixtureDir = path.join(
  repoRoot,
  "apps",
  "desktop",
  "src",
  "renderer",
  "__forbidden_lint_regression__",
);
const fixturePath = path.join(fixtureDir, "forbidden.ts");

afterEach(() => {
  if (existsSync(fixturePath)) unlinkSync(fixturePath);
  if (existsSync(fixtureDir)) rmdirSync(fixtureDir);
});

describe("ESLint renderer forbidden-import rule", () => {
  it("rejects a 'fs' import from a renderer file", () => {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(fixturePath, 'import * as fs from "fs";\nexport const unused = fs;\n');
    let exitCode = 0;
    let output = "";
    try {
      execSync(`pnpm exec eslint ${JSON.stringify(fixturePath)} --no-warn-ignored`, {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as {
        status?: number;
        stdout?: Buffer;
        stderr?: Buffer;
      };
      exitCode = e.status ?? 1;
      output = `${e.stdout?.toString() ?? ""}\n${e.stderr?.toString() ?? ""}`;
    }
    expect(exitCode).toBeGreaterThan(0);
    expect(output).toMatch(/no-restricted-imports/);
    expect(output).toMatch(/fs/);
  }, 30_000);
});
