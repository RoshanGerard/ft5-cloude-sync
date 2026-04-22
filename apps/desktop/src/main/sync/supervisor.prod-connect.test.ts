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

import * as child_process from "node:child_process";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncClient } from "./client.js";
import { startSupervisor } from "./supervisor.js";

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
let clients: SyncClient[] = [];

beforeEach(() => {
  servers = [];
  clients = [];
});

afterEach(async () => {
  for (const c of clients) {
    // SyncClient owns the socket; destroying it is enough for teardown.
    (c as unknown as { socket: net.Socket }).socket.destroy();
  }
  clients = [];
  for (const s of servers) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  servers = [];
  vi.restoreAllMocks();
});

describe("startSupervisor in prod mode connects to a running service without spawning", () => {
  it("returns a SyncClient and does NOT invoke child_process.spawn", async () => {
    const pipePath = pipeFor("prod-connect");
    const server = await startFakeService(pipePath);
    servers.push(server);

    // Spy BEFORE startSupervisor so any spawn call (there must be none in
    // the connect-first path) is captured. We assert zero invocations.
    const spawnSpy = vi.spyOn(child_process, "spawn");

    const client = await startSupervisor({ mode: "prod", pipePath });
    clients.push(client);

    expect(client).toBeInstanceOf(SyncClient);
    expect(client.isConnected).toBe(true);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
