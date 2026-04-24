// Supervisor prod-connect tests.
//
// Tasks.md 4.2: given a running fake service listening on the prod pipe,
// `startSupervisor({ mode: 'prod', pipePath })` resolves with a
// `SyncClient` WITHOUT invoking `child_process.spawn`. This is the
// connect-first half of the Option-3 supervisor (see
// `openspec/changes/wire-fs-sync-service/design.md:68-81`); the spawn
// path lands in the next TDD pair (4.4 / 4.5).
//
// Cross-platform pipe-path pattern mirrors `client.request-response.test.ts`
// — Windows named pipes and Unix domain sockets without extra config.

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncClient } from "./client.js";
import { startSupervisor, type SupervisorHandle } from "./supervisor.js";

// Partial mock of `node:child_process`: replace `spawn` with a spy so the
// test can assert zero invocations. We use `vi.mock` with an
// `importOriginal` factory because `vi.spyOn` on an ESM module namespace
// fails with "Cannot redefine property: spawn" (see Vitest ESM limits).
// Other exports (`exec`, `execFile`, etc.) pass through unchanged.
const spawnSpy = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      spawnSpy(...args);
      return (actual.spawn as unknown as (...a: unknown[]) => unknown)(
        ...args,
      );
    },
  };
});

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-supervisor-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-supervisor-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

/**
 * Minimal fake service: a `net.Server` that accepts a connection and
 * ignores whatever bytes come in. The supervisor's connect-first path
 * only needs a listener at the pipe; it does not exchange frames in
 * this task.
 */
async function startFakeService(pipePath: string): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.on("error", () => void 0);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}

let servers: net.Server[] = [];
let handles: SupervisorHandle[] = [];

beforeEach(() => {
  servers = [];
  handles = [];
  spawnSpy.mockClear();
});

afterEach(async () => {
  for (const h of handles) {
    h.dispose();
  }
  handles = [];
  for (const s of servers) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  servers = [];
  vi.restoreAllMocks();
});

describe("startSupervisor in prod mode connects to a running service without spawning", () => {
  it("returns a SupervisorHandle with a connected SyncClient and does NOT invoke child_process.spawn", async () => {
    const pipePath = pipeFor("prod-connect");
    const server = await startFakeService(pipePath);
    servers.push(server);

    const handle = await startSupervisor({ mode: "prod", pipePath });
    handles.push(handle);

    // Decision 12: startSupervisor now returns SupervisorHandle.
    // getClient() returns the current SyncClient.
    const client = handle.getClient();
    expect(client).toBeInstanceOf(SyncClient);
    expect(client.isConnected).toBe(true);
    // The connect-first path must not touch `child_process.spawn`.
    // spawnSpy is wired via the module-level `vi.mock` above.
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
