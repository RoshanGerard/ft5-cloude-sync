// fs-sync-service entry point. Parses --dev, hands off to `bootstrap()`,
// and installs SIGINT / SIGTERM handlers that gracefully stop the Runtime.
// All composition lives in `bootstrap.ts` so tests can drive the same
// wiring against a scratch data dir; this file is the process-level shell.
//
// Exit codes:
//   0 — normal (signal-driven shutdown)
//   1 — uncaught fatal error during startup
//   3 — another live instance holds the PID guard (AlreadyRunningError)
//   4 — database integrity check failed (DatabaseIntegrityError)
//
// Task 2.4 fleshes out the signal path with a bounded grace period; for
// now a basic handler that calls Runtime.stop() and exits 0 is enough.
// Task 2.6 handles the ipc-bind-failure path (exit 5).

import { AlreadyRunningError, bootstrap, type Runtime } from "./bootstrap.js";
import { DatabaseIntegrityError } from "../db/open.js";

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
    `fs-sync-service started (pid=${process.pid}, mode=${mode}, pipe=${runtime.pipePath})`,
  );

  // Idle wait until a signal arrives. Resolves with the exit code.
  return new Promise<number>((resolve) => {
    const shutdown = (signal: NodeJS.Signals): void => {
      console.log(`fs-sync-service received ${signal}; shutting down`);
      void runtime
        .stop()
        .catch(() => void 0)
        .then(() => resolve(0));
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error("fs-sync-service: fatal error during startup", err);
    process.exit(1);
  },
);
