// fs-sync-service entry point. Parses --dev, hands off to `bootstrap()`,
// and installs SIGINT / SIGTERM handlers that gracefully stop the Runtime.
// All composition lives in `bootstrap.ts` so tests can drive the same
// wiring against a scratch data dir; signal handling lives in `signals.ts`
// so the grace-period contract has its own unit test.
//
// Exit codes:
//   0 — normal (signal-driven shutdown)
//   1 — uncaught fatal error during startup
//   3 — another live instance holds the PID guard (AlreadyRunningError)
//   4 — database integrity check failed (DatabaseIntegrityError)
//
// Task 2.6 handles the ipc-bind-failure path (exit 5).

import { AlreadyRunningError, bootstrap, type Runtime } from "./bootstrap.js";
import { DatabaseIntegrityError } from "../db/open.js";
import { resolvePidPath } from "../env/paths.js";
import { installSignalHandlers } from "./signals.js";

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const dev = argv.includes("--dev");
  const mode = dev ? "dev" : "prod";

  let runtime: Runtime;
  try {
    runtime = await bootstrap({ dev });
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      console.error(
        `fs-sync-service already running (pid=${err.existingPid}, mode=${mode}); exiting`,
      );
      return 3;
    }
    if (err instanceof DatabaseIntegrityError) {
      console.error(
        `fs-sync-service integrity-check-failed: ${err.observed}; exiting`,
      );
      return 4;
    }
    throw err;
  }

  console.log(
    `fs-sync-service started (pid=${process.pid}, mode=${mode}, pipe=${runtime.socketPath})`,
  );

  // Delegate signal wiring to signals.ts — it registers SIGINT/SIGTERM on
  // `process`, runs runtime.stop() against a 5 s grace budget, and cleans
  // up the PID file. The returned `shutdown` promise resolves with the
  // exit code.
  const pidPath = resolvePidPath({ dev }, process.env);
  const installed = installSignalHandlers(runtime, { pidPath });
  return installed.shutdown;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error("fs-sync-service: fatal error during startup", err);
    process.exit(1);
  },
);
