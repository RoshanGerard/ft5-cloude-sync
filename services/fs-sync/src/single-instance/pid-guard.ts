// Ensures a single service instance per data directory. On acquire, writes
// the current PID to `service.pid` (or `service-dev.pid` in dev). If the
// file already names a live process whose executable image matches the
// service binary, throws `AlreadyRunningError`; stale PIDs (process dead
// or image-mismatch) are overwritten transparently.
//
// Spec: "Single-instance guard via PID file" (base spec) and design.md D19.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

export class AlreadyRunningError extends Error {
  readonly existingPid: number;
  readonly pidFilePath: string;
  constructor(existingPid: number, pidFilePath: string) {
    super(
      `fs-sync-service already running (pid ${existingPid}, recorded in ${pidFilePath})`,
    );
    this.name = "AlreadyRunningError";
    this.existingPid = existingPid;
    this.pidFilePath = pidFilePath;
  }
}

export interface PidGuardOptions {
  /**
   * Test seam: query whether a PID's process image name matches the service
   * binary. Returns `true` if it's the same binary (collision), `false` if
   * the PID is stale (dead, or recycled to a different image).
   */
  readonly isLiveService?: (pid: number) => boolean;
  /** Test seam: the current process's PID (defaults to `process.pid`). */
  readonly currentPid?: number;
}

/**
 * Acquire the PID file. On success, returns a `release` function that
 * removes the PID file — call it in the process's shutdown path.
 */
export async function acquirePidGuard(
  pidFilePath: string,
  options: PidGuardOptions = {},
): Promise<() => Promise<void>> {
  const currentPid = options.currentPid ?? process.pid;
  const isLiveService = options.isLiveService ?? defaultIsLiveService;

  // Read any pre-existing PID. ENOENT means no previous instance — proceed.
  let existing: string | null = null;
  try {
    existing = await fsp.readFile(pidFilePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  if (existing !== null) {
    const parsed = Number.parseInt(existing.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0 && isLiveService(parsed)) {
      throw new AlreadyRunningError(parsed, pidFilePath);
    }
    // Stale or malformed — fall through and overwrite.
  }

  await fsp.writeFile(pidFilePath, `${currentPid}\n`, { flag: "w" });

  return async () => {
    try {
      const current = await fsp.readFile(pidFilePath, "utf8");
      if (Number.parseInt(current.trim(), 10) === currentPid) {
        await fsp.unlink(pidFilePath);
      }
      // Otherwise someone else owns the file now — leave it alone.
    } catch {
      /* tolerated — release is best-effort */
    }
  };
}

function defaultIsLiveService(pid: number): boolean {
  if (!isProcessAlive(pid)) return false;
  return hasServiceImageName(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 is the portable "does this process exist and can I signal
    // it?" check — works on all Node-supported platforms.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it — still alive.
    return code === "EPERM";
  }
}

function hasServiceImageName(pid: number): boolean {
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      // tasklist returns empty output when no match; otherwise a CSV row
      // whose first field is the image name in quotes.
      const first = out.split("\n")[0] ?? "";
      const match = /^"([^"]+)"/.exec(first.trim());
      if (!match) return false;
      const image = (match[1] ?? "").toLowerCase();
      return image.includes("node") || image.includes("fs-sync");
    } catch {
      return false;
    }
  }

  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const comm = out.trim().toLowerCase();
    return comm.includes("node") || comm.includes("fs-sync");
  } catch {
    return false;
  }
}

// Synchronous wrapper for hot-path callers (startup) that want to bail
// before any async I/O. Uses `fs.readFileSync` / `fs.writeFileSync`.
export function acquirePidGuardSync(
  pidFilePath: string,
  options: PidGuardOptions = {},
): () => void {
  const currentPid = options.currentPid ?? process.pid;
  const isLiveService = options.isLiveService ?? defaultIsLiveService;

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(pidFilePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  if (existing !== null) {
    const parsed = Number.parseInt(existing.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0 && isLiveService(parsed)) {
      throw new AlreadyRunningError(parsed, pidFilePath);
    }
  }

  fs.writeFileSync(pidFilePath, `${currentPid}\n`, { flag: "w" });

  return () => {
    try {
      const current = fs.readFileSync(pidFilePath, "utf8");
      if (Number.parseInt(current.trim(), 10) === currentPid) {
        fs.unlinkSync(pidFilePath);
      }
    } catch {
      /* tolerated */
    }
  };
}
