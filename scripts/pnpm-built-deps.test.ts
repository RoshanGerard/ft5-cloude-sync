import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const expectedOnlyBuiltDependencies = [
  "better-sqlite3",
  "electron",
  "electron-winstaller",
  "esbuild",
  "sharp",
  "unrs-resolver",
] as const;

describe("pnpm.onlyBuiltDependencies allowlist", () => {
  it("includes every package pnpm 10 flags in its 'Ignored build scripts' warning", () => {
    const pkgJsonPath = path.resolve(repoRoot, "package.json");
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      pnpm?: { onlyBuiltDependencies?: string[] };
    };
    const actual = pkg.pnpm?.onlyBuiltDependencies;
    expect(actual, "root package.json must declare pnpm.onlyBuiltDependencies").toBeDefined();
    expect([...(actual ?? [])].sort()).toEqual([...expectedOnlyBuiltDependencies].sort());
  });
});
