import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const mandatedDirs = [
  "apps/desktop/src/main",
  "apps/desktop/src/preload",
  "apps/desktop/src/renderer",
  "services/fs-monitor/src",
  "packages/ipc-contracts",
] as const;

describe("repo layout", () => {
  it.each(mandatedDirs)("tracks %s via .gitkeep", (relDir) => {
    const keep = path.resolve(repoRoot, relDir, ".gitkeep");
    expect(existsSync(keep), `expected .gitkeep to exist: ${keep}`).toBe(true);
  });
});
