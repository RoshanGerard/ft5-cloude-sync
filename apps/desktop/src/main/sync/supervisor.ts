// Supervisor — desktop-side bring-up of a connection to fs-sync-service.
//
// Design: `openspec/changes/wire-fs-sync-service/design.md:68-81`
// (Decision 2 — connect-or-spawn-detached, Option 3).
//
// Scope of THIS module today (tasks.md 4.3 — connect-first; 4.5 — spawn;
// 4.7 — dev-mode connect-only branch):
//   - attempt `net.connect(pipePath)` with a bounded timeout
//   - on success, hand the socket to a new `SyncClient` and resolve
//   - mode='prod', on ENOENT/ECONNREFUSED, if `nodeBinary`+`servicePath`
//     were given:
//       * `child_process.spawn(nodeBinary, [servicePath],
//          { detached: true, stdio: 'ignore' })` then `unref()`
//       * retry-connect on a 25/50/100/200/400 ms geometric schedule
//         (5 attempts, ~975 ms wall time before giving up)
//       * on all retries failing, reject with a fatal error that names
//         the pipe path and the attempt count
//   - mode='prod', on ENOENT/ECONNREFUSED with no spawn paths given,
//     reject with a clear "opt-out" error naming the missing options
//   - mode='dev', on ENOENT/ECONNREFUSED, reject with a user-visible
//     error telling the operator to run `pnpm dev`. Dev mode NEVER
//     spawns the service (design.md Decision 6, :136-144) — the pnpm
//     parallel supervisor already started it. Spawn options, if passed,
//     are ignored in dev.
//   - race-tolerant retry lands in 4.8/4.9
//
// Design decisions made at this step:
//   1. `pipePath` is a PARAMETER on `StartSupervisorOptions`. The
//      supervisor stays pure wrt path resolution; the production caller
//      (task 4.10 in `main/index.ts`) will resolve it from a small
//      desktop-side mirror of `services/fs-sync/src/env/paths.ts`.
//   2. Connect timeout defaults to 2000 ms on the initial attempt; each
//      retry attempt after spawn uses the same helper but with a shorter
//      2000 ms bound since the service *should* be coming up fast.
//   3. The spawned child is intentionally NEVER tracked, killed, or
//      referenced again after `unref()`. No `app.quit` hook, no
//      SIGTERM relay. The service outlives the desktop app by design
//      (see `design.md:79`, "What the supervisor does NOT do").
//   4. `nodeBinary` and `servicePath` are optional on the options type
//      for backward compatibility with task 4.2's connect-only callers.
//      If the connect fails and they were not provided, the supervisor
//      rejects with an error listing the missing option — that is how
//      callers opt out of the spawn path.
//   5. The retry loop uses the EXACT schedule 25/50/100/200/400 ms
//      measured from the start of the previous failure; task 4.8/4.9
//      will add race-awareness (tolerating a loser's exit-3) on top.

import * as net from "node:net";
import { spawn } from "node:child_process";

import { SyncClient, type SyncClientOptions } from "./client.js";

export interface StartSupervisorOptions {
  readonly mode: "prod" | "dev";
  readonly pipePath: string;
  /** Passed through to the `SyncClient` constructor. */
  readonly clientOptions?: SyncClientOptions;
  /** Overrides the default 2000 ms connect-timeout (tests / tuning). */
  readonly connectTimeoutMs?: number;
  /** Absolute path to a plain-Node binary. Required for the spawn path. */
  readonly nodeBinary?: string;
  /** Absolute path to the service's entry JS. Required for the spawn path. */
  readonly servicePath?: string;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
const RETRY_DELAYS_MS: readonly number[] = [25, 50, 100, 200, 400];

/**
 * Connect to a running service at `pipePath` and return a wrapped
 * `SyncClient`. If the initial connect fails with ENOENT/ECONNREFUSED
 * and the caller supplied `nodeBinary`+`servicePath`, spawn a detached
 * service and retry on a geometric-backoff schedule. On unrecoverable
 * failure, reject with a descriptive error.
 */
export async function startSupervisor(
  opts: StartSupervisorOptions,
): Promise<SyncClient> {
  const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  try {
    const socket = await connectWithTimeout(opts.pipePath, timeoutMs);
    return new SyncClient(socket, opts.clientOptions ?? {});
  } catch (err) {
    if (!isNoListenerError(err)) throw err;
    // Initial connect failed because nothing was listening. In dev, we
    // refuse to spawn — pnpm's parallel supervisor already owns the
    // service lifecycle (design.md Decision 6). In prod, fall through
    // to the spawn path (or the opt-out error if no spawn paths given).
    if (opts.mode === "dev") {
      throw new Error(
        `supervisor: sync service not reachable at ${opts.pipePath}. In dev mode the service is managed by pnpm — run \`pnpm dev\` from the repo root to start it.`,
      );
    }
  }

  if (!opts.nodeBinary || !opts.servicePath) {
    throw new Error(
      `supervisor: connect to ${opts.pipePath} failed and no nodeBinary/servicePath were provided to start the service`,
    );
  }

  const child = spawn(opts.nodeBinary, [opts.servicePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const socket = await retryConnect(opts.pipePath, timeoutMs);
  return new SyncClient(socket, opts.clientOptions ?? {});
}

/**
 * Retry `net.connect(pipePath)` on the geometric schedule. Resolves on
 * the first successful connect; rejects after the final failure with an
 * error naming the pipe path and attempt count.
 */
async function retryConnect(
  pipePath: string,
  timeoutMs: number,
): Promise<net.Socket> {
  let lastError: unknown;
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    const delay = RETRY_DELAYS_MS[i]!;
    await sleep(delay);
    try {
      return await connectWithTimeout(pipePath, timeoutMs);
    } catch (err) {
      lastError = err;
      // Single-line diagnostic; full logging/metrics are out of scope.
      console.warn(
        `supervisor: retry ${i + 1}/${RETRY_DELAYS_MS.length} to ${pipePath} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  throw new Error(
    `supervisor: connect to ${pipePath} failed after ${RETRY_DELAYS_MS.length} retries (last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    })`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Detect "nothing is listening on this pipe" — the signal to fall
 * through to the spawn path. Both Unix-domain sockets and Windows named
 * pipes surface this as ENOENT; TCP-style setups (unused here today)
 * would use ECONNREFUSED. We deliberately do NOT catch timeouts — a
 * timeout means "a listener MAY exist but is too slow," which is a
 * different failure mode and should not trigger a spawn.
 */
function isNoListenerError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

function connectWithTimeout(
  pipePath: string,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(
        new Error(
          `supervisor: connect to ${pipePath} timed out after ${timeoutMs} ms`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });

    socket.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}
