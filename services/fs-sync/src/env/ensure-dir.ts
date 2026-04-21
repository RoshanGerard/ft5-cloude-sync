// Creates the data directory with user-only access on first run. On Unix
// the mode is enforced to `0o700`; on Windows we shell out to `icacls` to
// strip inherited ACEs and grant only the current user. Idempotent: if the
// directory already exists with correct permissions, this is a no-op.

import { execFileSync } from "node:child_process";
import * as fsp from "node:fs/promises";

export interface EnsureDirOptions {
  /**
   * Test seam: Windows ACL application shells out to `icacls.exe`. Tests pass
   * a spy here to observe the call without spawning a real process.
   */
  readonly icaclsRunner?: (dir: string) => void;
}

const DEFAULT_ICACLS: (dir: string) => void = (dir) => {
  // Strip inheritance, remove all existing ACEs, then grant the current
  // user full control. `%USERNAME%` is resolved by cmd on Windows.
  execFileSync(
    "icacls",
    [dir, "/inheritance:r", "/grant:r", `${process.env["USERNAME"] ?? ""}:(OI)(CI)F`],
    { stdio: "ignore" },
  );
};

export async function ensureDataDir(
  dir: string,
  options: EnsureDirOptions = {},
): Promise<void> {
  if (process.platform === "win32") {
    await fsp.mkdir(dir, { recursive: true });
    const runIcacls = options.icaclsRunner ?? DEFAULT_ICACLS;
    runIcacls(dir);
    return;
  }
  // Unix: mkdir -p with mode 0o700, then chmod to enforce even if the dir
  // already existed with a broader mode.
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);
}
