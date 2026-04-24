// Task 7.5 / F-5 — sync-client-holder swap-across-reconnect integration test.
//
// Verifies that after a supervisor reconnect, `setSyncClient(newClient)` from
// the reconnect subscriber transparently swaps the client seen by IPC handlers
// that call `getSyncClient()` at invocation time.
//
// Test mechanic (F-5 spec):
//  t=0: Register a fake IPC handler that captures its SyncClient reference.
//  t=1: Invoke the handler (pre-disconnect) — captures clientA.
//  t=2: Trigger disconnect + reconnect via SupervisorHandle events.
//  t=3: Invoke the handler again (post-reconnect) — must capture clientB.
//  Assert: clientA !== clientB, and clientB is the post-reconnect instance.

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { RequestFrame } from "@ft5/ipc-contracts/sync-service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FramingDecoder, encodeFrame } from "./framing.js";
import { SyncClient } from "./client.js";
import {
  startSupervisor,
  type SupervisorHandle,
} from "./supervisor.js";
import {
  getSyncClient,
  setSyncClient,
  __resetSyncClientForTesting,
} from "./sync-client-holder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-holder-swap-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-holder-swap-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

async function startFakeListener(pipePath: string): Promise<{
  close: () => Promise<void>;
  whenConnected: Promise<void>;
}> {
  let clientSocket: net.Socket | null = null;
  let connectedResolve!: () => void;
  const whenConnected = new Promise<void>((r) => {
    connectedResolve = r;
  });

  const server = net.createServer((socket) => {
    clientSocket = socket;
    connectedResolve();
    const decoder = new FramingDecoder({
      onFrame: (f) => {
        const frame = f as RequestFrame;
        if (frame.kind === "request") {
          if (frame.command === "sync:subscribe-events") {
            socket.write(encodeFrame({ id: frame.id, kind: "response", ok: true, result: { subscribed: true } } as Parameters<typeof encodeFrame>[0]));
          } else if (frame.command === "sync:list-jobs") {
            socket.write(encodeFrame({ id: frame.id, kind: "response", ok: true, result: { jobs: [] } } as Parameters<typeof encodeFrame>[0]));
          }
        }
      },
      onError: () => void 0,
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("error", () => void 0);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const close = () =>
    new Promise<void>((resolve) => {
      if (clientSocket) {
        clientSocket.destroy();
        clientSocket = null;
      }
      server.close(() => resolve());
    });

  return { close, whenConnected };
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let handles: SupervisorHandle[] = [];
let servers: Array<{ close: () => Promise<void> }> = [];

beforeEach(() => {
  handles = [];
  servers = [];
  __resetSyncClientForTesting();
});

afterEach(async () => {
  for (const h of handles) h.dispose();
  handles = [];
  for (const s of servers) await s.close();
  servers = [];
  __resetSyncClientForTesting();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync-client-holder swap across reconnect", () => {
  it(
    "handler sees a different SyncClient instance after reconnect (F-5)",
    async () => {
      const pipePath = pipeFor("swap-f5");

      const firstListener = await startFakeListener(pipePath);
      servers.push(firstListener);

      // Bootstrap: supervisor connects, set initial client in holder
      const handle = await startSupervisor({
        mode: "dev",
        pipePath,
        connectTimeoutMs: 500,
      });
      handles.push(handle);

      // Simulate what main/index.ts does:
      setSyncClient(handle.getClient());
      handle.on("reconnect", (newClient) => setSyncClient(newClient));

      // t=1: capture pre-disconnect client reference
      const clientA = getSyncClient();
      expect(clientA).toBeInstanceOf(SyncClient);
      expect(clientA.isConnected).toBe(true);

      // t=2: trigger disconnect by closing the first listener
      await firstListener.close();
      await new Promise<void>((r) => setTimeout(r, 50));

      // After disconnect, clientA should no longer be connected
      expect(clientA.isConnected).toBe(false);

      // Start second listener for reconnect
      const secondListener = await startFakeListener(pipePath);
      servers.push(secondListener);

      // Wait for reconnect
      await secondListener.whenConnected;
      await new Promise<void>((r) => setTimeout(r, 100));

      // t=3: capture post-reconnect client reference
      const clientB = getSyncClient();
      expect(clientB).toBeInstanceOf(SyncClient);
      expect(clientB.isConnected).toBe(true);

      // The two client references must be DIFFERENT INSTANCES
      expect(clientA).not.toBe(clientB);

      // clientB is the post-reconnect one
      expect(clientA.isConnected).toBe(false);
      expect(clientB.isConnected).toBe(true);
    },
    8000,
  );
});
