// Supervisor — desktop-side bring-up of a connection to fs-sync-service.
//
// Design: `openspec/changes/wire-fs-sync-service/design.md:68-81`
// (Decision 2 — connect-or-spawn-detached, Option 3).
// Decision 12 — supervisor lifecycle: reconnect policy + handle shape.
//
// This module owns TWO loops:
//   1. Initial connect (or spawn + retry) loop — started at bootstrap.
//   2. Reconnect loop — started on each disconnect after initial connect.
//
// Scope of THIS module today (tasks.md 4.3 — connect-first; 4.5 — spawn;
// 4.7 — dev-mode connect-only branch; 7.6 — reconnect loop + handle):
//   - attempt `net.connect(pipePath)` with a bounded timeout
//   - on success, hand the socket to a new `SyncClient` and resolve with
//     a `SupervisorHandle`
//   - mode='prod', on ENOENT/ECONNREFUSED, if `nodeBinary`+`servicePath`
//     were given:
//       * `child_process.spawn(nodeBinary, [servicePath],
//          { detached: true, stdio: 'ignore' })` then `unref()`
//       * retry-connect on a 25/50/100/200/400 ms geometric schedule
//         (5 attempts, ~775 ms wall time sleeping before giving up)
//       * on all retries failing, reject with a fatal error that names
//         the pipe path and the attempt count
//   - mode='prod', on ENOENT/ECONNREFUSED with no spawn paths given,
//     reject with a clear "opt-out" error naming the missing options
//   - mode='dev', on ENOENT/ECONNREFUSED, reject with a user-visible
//     error telling the operator to run `pnpm dev`. Dev mode NEVER
//     spawns the service (design.md Decision 6, :136-144) — the pnpm
//     parallel supervisor already started it. Spawn options, if passed,
//     are ignored in dev.
//   - **Race-tolerant by construction** (tasks.md 4.8/4.9). When two
//     desktops start in parallel against a non-listening pipe, both
//     fall through to the spawn branch and both invoke
//     `child_process.spawn`. The service's PID guard ensures only one
//     of the spawned processes binds the listener; the other exits
//     code 3 (see `services/fs-sync/src/main/index.ts`). This
//     supervisor tolerates the loser's exit WITHOUT special-case code
//     because the retry-connect loop is driven ENTIRELY by
//     `net.connect` success/failure against the pipe path — we never
//     attach `.on('exit', ...)` to the spawned child, never track its
//     pid, and never reference it after `unref()`. The loser dying is
//     invisible to both supervisors; both eventually connect to the
//     winner's listener. The invariant is locked by
//     `supervisor.race.test.ts`.
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
//      measured from the start of the previous failure. Race-awareness
//      (tolerating a PID-loser's exit-3) is achieved structurally by
//      decision #3 above — the loop is connect-driven, not
//      child-lifecycle-driven — so no additional code was required for
//      tasks 4.8/4.9 beyond the test that locks the invariant.
//   6. (Decision 12) `startSupervisor` now returns `Promise<SupervisorHandle>`
//      instead of `Promise<SyncClient>`. On disconnect, the reconnect loop
//      retries with the same 5-item schedule, then geometric backoff capped
//      at 30 s (indefinitely). Dev mode NEVER re-spawns.

import * as net from "node:net";
import { spawn } from "node:child_process";

import { SyncClient, type SyncClientOptions } from "./client.js";

// ---- SupervisorHandle -------------------------------------------------------
//
// Returned by `startSupervisor`. Wraps the current live `SyncClient` and
// notifies subscribers on reconnect/disconnect. Callers read the current
// client via `getClient()` at handler invocation time rather than storing
// a stale reference — this is the "sync-client-holder" pattern.
//
// Decision 12:
//   getClient()  — returns the current connected client; mutates on reconnect
//   on("reconnect", cb)  — cb receives the fresh client
//   on("disconnect", cb) — cb receives no payload
//   dispose()  — stop reconnecting, idempotent

export interface SupervisorHandle {
  /** The current connected client. Mutates across reconnects. */
  getClient(): SyncClient;
  /** Subscribe to reconnect events. Returns an unsubscribe function. */
  on(event: "reconnect", cb: (newClient: SyncClient) => void): () => void;
  /** Subscribe to disconnect events. Returns an unsubscribe function. */
  on(event: "disconnect", cb: () => void): () => void;
  /** Stop reconnecting; idempotent. */
  dispose(): void;
}

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

/**
 * Initial 5-step retry schedule (shared by first-connect and reconnect).
 * D12-3: 25/50/100/200/400 ms, then geometric backoff capped at 30000 ms.
 */
export const RETRY_DELAYS_MS: readonly number[] = [25, 50, 100, 200, 400];

/**
 * D12-3: after the initial 5-step schedule, compute the next geometric
 * backoff from the Nth attempt. Attempt 0 = first retry after the 5-step
 * schedule has been exhausted.
 *
 * Formula: min(400 * 2^attempt, 30000)
 */
export function nextBackoff(attempt: number): number {
  return Math.min(400 * Math.pow(2, attempt + 1), 30_000);
}

/**
 * Connect to a running service at `pipePath` and return a `SupervisorHandle`
 * wrapping the `SyncClient`. If the initial connect fails with
 * ENOENT/ECONNREFUSED and the caller supplied `nodeBinary`+`servicePath`,
 * spawn a detached service and retry on a geometric-backoff schedule. On
 * unrecoverable failure, reject with a descriptive error.
 *
 * After the initial connect, the handle runs a reconnect loop (Decision 12)
 * that retries `net.connect(pipePath)` on disconnect with the same schedule,
 * then indefinite geometric backoff capped at 30 s.
 */
export async function startSupervisor(
  opts: StartSupervisorOptions,
): Promise<SupervisorHandle> {
  const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  try {
    const socket = await connectWithTimeout(opts.pipePath, timeoutMs);
    const client = new SyncClient(socket, opts.clientOptions ?? {});
    return createHandle(client, opts, timeoutMs);
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
  const client = new SyncClient(socket, opts.clientOptions ?? {});
  return createHandle(client, opts, timeoutMs);
}

// ---------------------------------------------------------------------------
// SupervisorHandle factory — wraps a SyncClient with reconnect loop
// ---------------------------------------------------------------------------

type ReconnectListener = (newClient: SyncClient) => void;
type DisconnectListener = () => void;

function createHandle(
  initialClient: SyncClient,
  opts: StartSupervisorOptions,
  timeoutMs: number,
): SupervisorHandle {
  let current = initialClient;
  let disposed = false;

  const reconnectListeners = new Set<ReconnectListener>();
  const disconnectListeners = new Set<DisconnectListener>();

  // Inner function: subscribe to the current client's disconnect event.
  // Extracted so the reconnect loop can re-subscribe after each reconnect.
  function subscribeToDisconnect(client: SyncClient): void {
    client.on("disconnect", () => {
      if (disposed) return;

      // Notify disconnect listeners
      const dSnapshot = Array.from(disconnectListeners);
      for (const cb of dSnapshot) {
        try {
          cb();
        } catch {
          // misbehaving listener must not break the reconnect flow
        }
      }

      // Start the reconnect loop
      void reconnectLoop();
    });
  }

  // Reconnect loop: retry with RETRY_DELAYS_MS first, then geometric backoff.
  // D12-3: same schedule as initial connect. No re-spawn in dev mode.
  async function reconnectLoop(): Promise<void> {
    if (disposed) return;

    let attempt = 0;
    while (!disposed) {
      const delay =
        attempt < RETRY_DELAYS_MS.length
          ? RETRY_DELAYS_MS[attempt]!
          : nextBackoff(attempt - RETRY_DELAYS_MS.length);
      await sleep(delay);
      if (disposed) return;

      try {
        const socket = await connectWithTimeout(opts.pipePath, timeoutMs);
        if (disposed) {
          socket.destroy();
          return;
        }
        const newClient = new SyncClient(socket, opts.clientOptions ?? {});
        current = newClient;
        subscribeToDisconnect(newClient);

        // Notify reconnect listeners with the fresh client
        const rSnapshot = Array.from(reconnectListeners);
        for (const cb of rSnapshot) {
          try {
            cb(newClient);
          } catch {
            // misbehaving listener must not break siblings
          }
        }
        return; // reconnect succeeded, loop exits
      } catch {
        // connect failed — continue backoff loop
        attempt++;
        console.warn(
          `supervisor: reconnect attempt ${attempt} to ${opts.pipePath} failed`,
        );
      }
    }
  }

  // Subscribe the initial client to the disconnect event
  subscribeToDisconnect(initialClient);

  const handle: SupervisorHandle = {
    getClient(): SyncClient {
      return current;
    },
    on(event: "reconnect" | "disconnect", cb: ((newClient: SyncClient) => void) | (() => void)): () => void {
      if (event === "reconnect") {
        reconnectListeners.add(cb as ReconnectListener);
        return () => {
          reconnectListeners.delete(cb as ReconnectListener);
        };
      } else {
        disconnectListeners.add(cb as DisconnectListener);
        return () => {
          disconnectListeners.delete(cb as DisconnectListener);
        };
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      reconnectListeners.clear();
      disconnectListeners.clear();
      // Destroy the current socket to clean up
      try {
        (current as unknown as { socket: net.Socket }).socket.destroy();
      } catch {
        // ignore
      }
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
 * would use ECONNREFUSED. On Windows a half-closed named pipe left over
 * by a crashed service surfaces EPIPE — the service's own health probe
 * at `services/fs-sync/src/main/signals.test.ts:213` already treats
 * EPIPE as "listener gone," so we match for consistency. We deliberately
 * do NOT catch timeouts — a timeout means "a listener MAY exist but is
 * too slow," which is a different failure mode and should not trigger
 * a spawn.
 */
function isNoListenerError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EPIPE";
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
