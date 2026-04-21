import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDataDir } from "./ensure-dir.js";

let cleanup: string[] = [];

afterEach(async () => {
  for (const dir of cleanup) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      /* tolerated */
    }
  }
  cleanup = [];
});

function scratchDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `ft5-sync-ensure-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  cleanup.push(dir);
  return dir;
}

describe("ensureDataDir", () => {
  it("creates the directory on first call", async () => {
    const dir = scratchDir();
    await ensureDataDir(dir, { icaclsRunner: vi.fn() });
    const stat = await fsp.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("is idempotent (second call is a no-op that still succeeds)", async () => {
    const dir = scratchDir();
    const runner = vi.fn();
    await ensureDataDir(dir, { icaclsRunner: runner });
    await ensureDataDir(dir, { icaclsRunner: runner });
    const stat = await fsp.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "enforces mode 0o700 on Unix",
    async () => {
      const dir = scratchDir();
      await ensureDataDir(dir);
      const stat = await fsp.stat(dir);
      expect(stat.mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === "win32")(
    "tightens mode on Unix even if the dir existed with a broader mode",
    async () => {
      const dir = scratchDir();
      await fsp.mkdir(dir, { recursive: true, mode: 0o755 });
      await ensureDataDir(dir);
      const stat = await fsp.stat(dir);
      expect(stat.mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "invokes the icacls runner exactly once per call on Windows",
    async () => {
      const dir = scratchDir();
      const runner = vi.fn();
      await ensureDataDir(dir, { icaclsRunner: runner });
      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner).toHaveBeenCalledWith(dir);
    },
  );
});
