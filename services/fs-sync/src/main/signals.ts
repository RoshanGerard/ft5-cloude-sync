// Signal-driven shutdown with a bounded grace period. The process-level
// shell (index.ts) calls `installSignalHandlers(runtime, { pidPath })`
// during startup and exits with the code that `installed.shutdown`
// resolves to.
//
// Behaviour:
//   * Registers `once` listeners for SIGINT and SIGTERM on the emitter
//     (defaults to `process` — tests inject a fresh `EventEmitter` so
//     they don't kill the vitest worker).
//   * On the first such signal: log the canonical shutdown line, then
//     race `runtime.stop()` against a `graceMs` timeout (default 5 s).
//     Whichever resolves first drives the resolution of the `shutdown`
//     promise with exit code 0.
//   * If the timeout wins, log `"fs-sync-service grace period exceeded;
//     forcing exit"`, let `runtime.stop()` continue in the background, and
//     still resolve 0 — task 2.6 is the one that introduces non-zero exit
//     codes (ipc-bind-failed path).
//   * After `runtime.stop()` settles, best-effort `fs.unlinkSync(pidPath)`.
//     The PID guard release inside `runtime.stop()` already removes the
//     file on the happy path; the unlink here covers paths where the
//     release call silently skipped it (tolerates ENOENT).
//   * `dispose()` un-registers the listeners without triggering shutdown —
//     used by callers that want to tear down cooperatively instead of
//     waiting for an OS signal.

import { EventEmitter } from "node:events";
import * as fs from "node:fs";

import type { Runtime } from "./bootstrap.js";

export interface InstallSignalHandlersOptions {
  readonly pidPath: string;
  readonly graceMs?: number;
  readonly emitter?: NodeJS.EventEmitter;
}

export interface InstalledSignalHandlers {
  /** Resolves with the exit code once shutdown (graceful or grace-period-forced) completes. */
  readonly shutdown: Promise<number>;
  /** Remove signal listeners without triggering shutdown. */
  dispose(): void;
}

const DEFAULT_GRACE_MS = 5_000;

export function installSignalHandlers(
  runtime: Runtime,
  options: InstallSignalHandlersOptions,
): InstalledSignalHandlers {
  const emitter: NodeJS.EventEmitter =
    options.emitter ?? (process as unknown as EventEmitter);
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

  let resolveShutdown!: (code: number) => void;
  const shutdown = new Promise<number>((resolve) => {
    resolveShutdown = resolve;
  });

  // Guards against a second signal re-entering the shutdown path while
  // runtime.stop() is still in flight. The `once` registration handles
  // single-listener semantics; this flag covers SIGINT-then-SIGTERM.
  let shuttingDown = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`fs-sync-service received ${signal}; shutting down`);

    // Remove the *other* signal listener so a second signal is ignored.
    // (We registered with `once` so the current one is already gone.)
    removeListeners();

    let timer: NodeJS.Timeout | null = null;
    const gracePromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), graceMs);
      // Don't hold the event loop open on this timer alone; the runtime
      // is shutting down and we don't want the process to linger solely
      // because of the grace timer.
      timer.unref?.();
    });

    const stopPromise = runtime
      .stop()
      .then(() => "stopped" as const)
      .catch(() => "stopped" as const);

    void Promise.race([stopPromise, gracePromise]).then((winner) => {
      if (winner === "timeout") {
        console.log(
          "fs-sync-service grace period exceeded; forcing exit",
        );
        // Let runtime.stop() keep running in the background, but don't
        // block the exit on it.
        void stopPromise.finally(() => unlinkPidFile(options.pidPath));
        resolveShutdown(0);
        return;
      }
      if (timer !== null) clearTimeout(timer);
      unlinkPidFile(options.pidPath);
      resolveShutdown(0);
    });
  };

  const sigintListener = (): void => onSignal("SIGINT");
  const sigtermListener = (): void => onSignal("SIGTERM");

  emitter.once("SIGINT", sigintListener);
  emitter.once("SIGTERM", sigtermListener);

  const removeListeners = (): void => {
    emitter.removeListener("SIGINT", sigintListener);
    emitter.removeListener("SIGTERM", sigtermListener);
  };

  return {
    shutdown,
    dispose(): void {
      removeListeners();
    },
  };
}

function unlinkPidFile(pidPath: string): void {
  try {
    fs.unlinkSync(pidPath);
  } catch (err) {
    // ENOENT is expected — runtime.stop()'s PID-guard release already
    // removed the file on the happy path. Anything else, tolerate too:
    // this is best-effort cleanup and shouldn't block shutdown.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      /* tolerated */
    }
  }
}
