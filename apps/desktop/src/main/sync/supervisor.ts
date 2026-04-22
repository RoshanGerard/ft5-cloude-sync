// Supervisor — desktop-side bring-up of a connection to fs-sync-service.
//
// Design: `openspec/changes/wire-fs-sync-service/design.md:68-81`
// (Decision 2 — connect-or-spawn-detached, Option 3).
//
// Scope of THIS module today (tasks.md 4.3 — connect-first only):
//   - attempt `net.connect(pipePath)` with a bounded timeout
//   - on success, hand the socket to a new `SyncClient` and resolve
//   - on failure, reject — spawn/retry/dev-mode branches land in the
//     next TDD pairs (4.4 / 4.5 spawn path, 4.6 / 4.7 dev mode,
//     4.8 / 4.9 race-tolerant retry)
//
// Design decisions made at this step:
//   1. `pipePath` is a PARAMETER on `StartSupervisorOptions`. The
//      supervisor stays pure wrt path resolution; the production caller
//      (task 4.10 in `main/index.ts`) will resolve it from a small
//      desktop-side mirror of `services/fs-sync/src/env/paths.ts`. A
//      direct cross-workspace import from a desktop app into a service
//      source would be architecturally ugly and complicates typing.
//   2. Connect timeout defaults to 2000 ms. This is distinct from the
//      per-request timeouts the `SyncClient` manages — here it only
//      bounds the TCP/pipe handshake.
//   3. The `spawn` path is NOT wired in this module yet. Task 4.2's
//      test spies on `child_process.spawn` and asserts zero calls; the
//      supervisor simply doesn't import it. Task 4.4 will introduce
//      the spawn branch alongside its RED test.

import * as net from "node:net";

import { SyncClient, type SyncClientOptions } from "./client.js";

export interface StartSupervisorOptions {
  readonly mode: "prod" | "dev";
  readonly pipePath: string;
  /** Passed through to the `SyncClient` constructor. */
  readonly clientOptions?: SyncClientOptions;
  /** Overrides the default 2000 ms connect-timeout (tests / tuning). */
  readonly connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 2000;

/**
 * Connect to a running service at `pipePath` and return a wrapped
 * `SyncClient`. Rejects on ENOENT / ECONNREFUSED / timeout. The caller
 * (task 4.4+) will own the spawn-fallback path.
 */
export async function startSupervisor(
  opts: StartSupervisorOptions,
): Promise<SyncClient> {
  const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const socket = await connectWithTimeout(opts.pipePath, timeoutMs);
  return new SyncClient(socket, opts.clientOptions ?? {});
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
