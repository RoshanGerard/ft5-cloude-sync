// Task 7.5 RED — sync event-bridge reconnect tests.
//
// Verifies that after a service disconnect:
//  1. The bridge re-issues subscribe-events + list-jobs on the new connection.
//  2. A fresh sync-state-seed is emitted to registered windows.
//  3. In-flight renderer IPC calls (SyncClient.request) see
//     service-disconnected rejections — inherited from SyncClient.handleDisconnect.
//     (The bridge does NOT re-implement this; it relies on the existing behavior.)
//
// F-3: fixture reuses the net.createServer pattern from
//   supervisor.prod-connect.test.ts and supervisor.prod-spawn.test.ts.
// F-4: we assert rejection from a real SyncClient call, not a mock.
// F-5: covered by sync-client-holder.swap-across-reconnect.test.ts.
//
// Test mechanic:
//  - Start a fake listener, have startSupervisor connect.
//  - Close the listener to trigger disconnect.
//  - Re-open a NEW fake listener at the same path.
//  - Wait for the bridge to reconnect and re-issue handshake.
//  - Assert that a second sync-state-seed is emitted to registered windows.

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { RequestFrame } from "@ft5/ipc-contracts/sync-service";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { FramingDecoder, encodeFrame } from "./framing.js";
import { SyncClient, SyncDisconnectedError } from "./client.js";
import {
  startSupervisor,
  type SupervisorHandle,
} from "./supervisor.js";
import {
  createSyncEventBridge,
  __resetSyncEventBridgeForTesting,
} from "./event-bridge.js";

// ---------------------------------------------------------------------------
// Helpers — fake BrowserWindow
// ---------------------------------------------------------------------------

interface FakeBrowserWindow {
  webContents: { send: Mock };
  isDestroyed: () => boolean;
}

function makeFakeWindow(): FakeBrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  };
}

// ---------------------------------------------------------------------------
// Helpers — fake service listener
// ---------------------------------------------------------------------------

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-eb-reconnect-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-eb-reconnect-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

interface FakeListener {
  receivedCommands: string[];
  pushEvent: (name: string, payload: unknown) => void;
  close: () => Promise<void>;
  whenConnected: Promise<void>;
  /** If set, will be called instead of default auto-ACK logic */
  onRequest?: (command: string, id: string) => void;
}

/**
 * A net.createServer that auto-ACKs subscribe-events and list-jobs,
 * records received commands, and lets the test push raw events.
 */
async function startFakeListener(
  pipePath: string,
  jobsForSeed: unknown[] = [],
): Promise<FakeListener> {
  let clientSocket: net.Socket | null = null;
  let connectedResolve!: () => void;
  const whenConnected = new Promise<void>((r) => {
    connectedResolve = r;
  });

  const state: FakeListener = {
    receivedCommands: [],
    whenConnected,
    pushEvent(name, payload) {
      if (!clientSocket) return;
      clientSocket.write(encodeFrame({ kind: "event", name, payload } as Parameters<typeof encodeFrame>[0]));
    },
    close: () => Promise.resolve(),
  };

  const server = net.createServer((socket) => {
    clientSocket = socket;
    connectedResolve();
    const decoder = new FramingDecoder({
      onFrame: (f) => {
        const frame = f as RequestFrame;
        if (frame.kind !== "request") return;
        state.receivedCommands.push(frame.command);
        if (state.onRequest) {
          state.onRequest(frame.command, frame.id);
          return;
        }
        if (frame.command === "sync:subscribe-events") {
          socket.write(encodeFrame({ id: frame.id, kind: "response", ok: true, result: { subscribed: true } } as Parameters<typeof encodeFrame>[0]));
        } else if (frame.command === "sync:list-jobs") {
          socket.write(encodeFrame({
            id: frame.id,
            kind: "response",
            ok: true,
            result: { jobs: jobsForSeed },
          } as Parameters<typeof encodeFrame>[0]));
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

  state.close = () =>
    new Promise<void>((resolve) => {
      if (clientSocket) {
        clientSocket.destroy();
        clientSocket = null;
      }
      server.close(() => resolve());
    });

  return state;
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let handles: SupervisorHandle[] = [];
let servers: Array<{ close: () => Promise<void> }> = [];

beforeEach(() => {
  handles = [];
  servers = [];
  __resetSyncEventBridgeForTesting();
});

afterEach(async () => {
  for (const h of handles) h.dispose();
  handles = [];
  for (const s of servers) await s.close();
  servers = [];
  __resetSyncEventBridgeForTesting();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSyncEventBridge — reconnect", () => {
  it(
    "re-issues subscribe + list-jobs after disconnect and emits a second sync-state-seed",
    async () => {
      const pipePath = pipeFor("reconnect-seed");

      const firstJob = {
        id: "j-first", kind: "upload", datasourceId: "ds-1", sourcePath: "/a",
        targetPath: null, conflictPolicy: "overwrite", status: "running",
        attempt: 1, lastErrorTag: null, lastErrorMessage: null,
        createdAt: 0, updatedAt: 0,
      };
      const secondJob = {
        id: "j-second", kind: "upload", datasourceId: "ds-2", sourcePath: "/b",
        targetPath: null, conflictPolicy: "overwrite", status: "queued",
        attempt: 0, lastErrorTag: null, lastErrorMessage: null,
        createdAt: 0, updatedAt: 0,
      };

      // First listener — will serve the first connection
      const firstListener = await startFakeListener(pipePath, [firstJob]);
      servers.push(firstListener);

      const handle = await startSupervisor({
        mode: "dev",
        pipePath,
        connectTimeoutMs: 500,
      });
      handles.push(handle);

      const bridge = createSyncEventBridge(handle);
      const win = makeFakeWindow();
      bridge.registerWindow(win as unknown as import("electron").BrowserWindow);

      // Wait for first handshake
      await firstListener.whenConnected;
      await new Promise<void>((r) => setTimeout(r, 50));

      const firstSeedCalls = win.webContents.send.mock.calls.filter(
        (c: unknown[]) => (c[1] as { kind?: string })?.kind === "sync-state-seed",
      );
      expect(firstSeedCalls).toHaveLength(1);
      expect(
        (firstSeedCalls[0]![1] as { payload: { jobs: Array<{ id: string }> } }).payload.jobs.map((j) => j.id),
      ).toContain("j-first");

      win.webContents.send.mockClear();

      // Close first listener to trigger disconnect
      await firstListener.close();

      // Wait for disconnect to propagate
      await new Promise<void>((r) => setTimeout(r, 50));

      // Start second listener — will serve the reconnect
      const secondListener = await startFakeListener(pipePath, [secondJob]);
      servers.push(secondListener);

      // Wait for reconnect handshake
      await secondListener.whenConnected;
      await new Promise<void>((r) => setTimeout(r, 100));

      // Second sync-state-seed must have been emitted with the new job
      const secondSeedCalls = win.webContents.send.mock.calls.filter(
        (c: unknown[]) => (c[1] as { kind?: string })?.kind === "sync-state-seed",
      );
      expect(secondSeedCalls.length).toBeGreaterThanOrEqual(1);
      const secondSeedJobs = (secondSeedCalls[0]![1] as { payload: { jobs: Array<{ id: string }> } }).payload.jobs;
      expect(secondSeedJobs.map((j) => j.id)).toContain("j-second");

      // subscribe-events must have been sent on the new connection too
      expect(secondListener.receivedCommands).toContain("sync:subscribe-events");
      expect(secondListener.receivedCommands).toContain("sync:list-jobs");
      const subIdx = secondListener.receivedCommands.indexOf("sync:subscribe-events");
      const listIdx = secondListener.receivedCommands.indexOf("sync:list-jobs");
      expect(subIdx).toBeLessThan(listIdx);
    },
    8000,
  );

  it(
    "in-flight requests reject with service-disconnected when the socket closes (F-4)",
    async () => {
      const pipePath = pipeFor("inflight-reject");

      // A listener that accepts connections but does NOT respond to any requests
      // (so list-jobs hangs as an in-flight request)
      const listener = await startFakeListener(pipePath);
      listener.onRequest = () => {
        // intentionally do nothing — simulate unresponsive service
      };
      servers.push(listener);

      // Use a real SyncClient connected to the listener to test the rejection
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(pipePath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      const client = new SyncClient(socket);

      // Issue a request that will hang in-flight (no response from server)
      const inflightPromise = client.listJobs({});

      // Wait for the server to receive the connection
      await listener.whenConnected;
      await new Promise<void>((r) => setTimeout(r, 20));

      // Destroy the connection — simulate service crash
      socket.destroy();

      // The in-flight request must reject with SyncDisconnectedError (F-4:
      // inherited from SyncClient.handleDisconnect, not reimplemented here)
      await expect(inflightPromise).rejects.toBeInstanceOf(SyncDisconnectedError);

      // New request after disconnect also rejects immediately
      await expect(client.listJobs({})).rejects.toBeInstanceOf(SyncDisconnectedError);
      expect(client.isConnected).toBe(false);
    },
    5000,
  );
});
