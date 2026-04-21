// fs-sync-service entry point. Resolves the data dir, ensures it exists
// with user-only permissions, acquires the single-instance PID guard, then
// (in this phase) exits. Later phases wire the IPC listener and scheduler.
//
// Exit codes:
//   0 — normal
//   3 — another live instance holds the PID guard
//   4 — database integrity check failed (wired in Phase 5)

import { ensureDataDir } from "../env/ensure-dir.js";
import { resolveDataDir, resolvePidPath } from "../env/paths.js";
import {
  AlreadyRunningError,
  acquirePidGuardSync,
} from "../single-instance/pid-guard.js";

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const dev = argv.includes("--dev");
  const mode = dev ? "dev" : "prod";
  const dataDir = resolveDataDir({ dev });
  const pidPath = resolvePidPath({ dev });

  await ensureDataDir(dataDir);

  let release: (() => void) | null = null;
  try {
    release = acquirePidGuardSync(pidPath);
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      console.error(
        `fs-sync-service already running (pid=${err.existingPid}, mode=${mode}); exiting`,
      );
      return 3;
    }
    throw err;
  }

  console.log(`fs-sync-service starting (pid=${process.pid}, mode=${mode})`);

  try {
    // Phase 3 scaffold: no IPC listener yet. Later phases insert the
    // scheduler start, IPC server bind, and signal-driven shutdown here.
    return 0;
  } finally {
    release();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error("fs-sync-service: fatal error during startup", err);
    process.exit(1);
  },
);
