// SyncClient socket.write synchronous-throw cleanup.
//
// Regression coverage for the pending-entry + timer leak that exists when
// `socket.write` throws synchronously (e.g., destroyed-between-check-and-
// write race on Windows named pipes). Without cleanup the entry lingers
// in the internal pending map until either the timer fires or the socket
// disconnect reaper runs — a real leak window with observable
// side-effects (a late timer firing reject() on an already-settled promise).
//
// The test drives the error with a stubbed write; other tests cover the
// real-socket happy path.

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SyncClient } from "./client.js";

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-client-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-client-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

async function startNullServer(pipePath: string): Promise<net.Server> {
  const server = net.createServer(() => void 0);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}

async function connectClient(pipePath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

let servers: net.Server[] = [];
let sockets: net.Socket[] = [];

beforeEach(() => {
  servers = [];
  sockets = [];
});

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets = [];
  for (const sv of servers) await new Promise<void>((r) => sv.close(() => r()));
  servers = [];
});

describe("SyncClient socket.write synchronous throw", () => {
  it("rejects the request and leaves pending empty when socket.write throws", async () => {
    const pipePath = pipeFor("write-throw");
    const server = await startNullServer(pipePath);
    servers.push(server);

    const socket = await connectClient(pipePath);
    sockets.push(socket);

    // Replace .write with a synchronous thrower. We only need this on the
    // first call; subsequent internal writes (unlikely here) would also
    // throw, which is fine for this test's scope.
    const writeError = new Error("destroyed");
    (socket as unknown as { write: (...args: unknown[]) => boolean }).write =
      () => {
        throw writeError;
      };

    const client = new SyncClient(socket, { generateId: () => "wx-1" });

    await expect(client.request("sync:get-status", {})).rejects.toBe(writeError);

    // Critical assertion: the pending entry for "wx-1" must NOT linger.
    // If it did, a late response or timer fire would find an already-settled
    // promise. Observable via the `pendingCount` test-visible getter.
    expect(client.pendingCount).toBe(0);

    // Settle microtasks and give any stale timer a window to misbehave;
    // the request used the default (undefined) timeout, so there is no
    // timer to fire — but a future regression that introduced one would
    // reveal itself as an unhandled rejection here.
    await new Promise((r) => setTimeout(r, 20));
  });

  it("cleans up the timer too when socket.write throws on a request with timeoutMs", async () => {
    const pipePath = pipeFor("write-throw-timer");
    const server = await startNullServer(pipePath);
    servers.push(server);

    const socket = await connectClient(pipePath);
    sockets.push(socket);

    (socket as unknown as { write: (...args: unknown[]) => boolean }).write =
      () => {
        throw new Error("destroyed");
      };

    const client = new SyncClient(socket, { generateId: () => "wx-2" });

    // Trap unhandled rejections: if the timer fires on an already-rejected
    // promise, the second `reject(...)` call is a no-op, but any BUG that
    // caused a fresh reject path would surface here.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        client.request("sync:get-status", {}, { timeoutMs: 50 }),
      ).rejects.toMatchObject({ message: "destroyed" });

      expect(client.pendingCount).toBe(0);

      // Wait past the 50 ms timeout window — a leaked timer would fire here.
      await new Promise((r) => setTimeout(r, 80));
      expect(unhandled).toEqual([]);
      // Still zero: the cleanup on throw must have cleared the timer too.
      expect(client.pendingCount).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
