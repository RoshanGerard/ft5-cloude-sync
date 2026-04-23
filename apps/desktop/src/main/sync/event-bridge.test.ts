// Task 7.1 RED — sync event-bridge handshake test.
//
// On supervisor start the bridge must:
//  1. Send `sync:subscribe-events` THEN `sync:list-jobs` on the same
//     connection, in that order.
//  2. Emit a `{ kind: 'sync-state-seed', payload: { jobs } }` event via
//     `SYNC_CHANNELS.event` to every registered `BrowserWindow`, where
//     `jobs` is filtered to `status ∈ ['running','queued','waiting-network']`.
//
// F-2 buffering: the bridge buffers the seed until at least one window is
// registered, then delivers to that window. Newly-registered windows after
// the first delivery do NOT receive a replayed seed.
//
// Fixture pattern: same `startStub` / `FramingDecoder` pattern from
// `client.request-response.test.ts` — a `net.createServer` that parses
// inbound frames and can respond with scripted frames.

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { RequestFrame } from "@ft5/ipc-contracts/sync-service";
import { SYNC_CHANNELS } from "@ft5/ipc-contracts/sync-service-desktop";
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
import { SyncClient } from "./client.js";
import {
  createSyncEventBridge,
  __resetSyncEventBridgeForTesting,
  type SyncEventBridgeHandle,
} from "./event-bridge.js";
import type { SupervisorHandle } from "./supervisor.js";

// ---------------------------------------------------------------------------
// Minimal SupervisorHandle stub wrapping a SyncClient
// (for tests that control the client directly)
// ---------------------------------------------------------------------------
function clientAsHandle(client: SyncClient): SupervisorHandle {
  const reconnectListeners = new Set<(c: SyncClient) => void>();
  const disconnectListeners = new Set<() => void>();
  return {
    getClient: () => client,
    on(event: "reconnect" | "disconnect", cb: ((c?: SyncClient) => void)): () => void {
      if (event === "reconnect") {
        reconnectListeners.add(cb as (c: SyncClient) => void);
        return () => reconnectListeners.delete(cb as (c: SyncClient) => void);
      }
      disconnectListeners.add(cb as () => void);
      return () => disconnectListeners.delete(cb as () => void);
    },
    dispose() { /* no-op in tests */ },
  };
}

// ---------------------------------------------------------------------------
// Fake BrowserWindow
// ---------------------------------------------------------------------------

interface FakeWebContents {
  send: Mock;
  isDestroyed: () => boolean;
}

interface FakeBrowserWindow {
  webContents: FakeWebContents;
  isDestroyed: () => boolean;
}

function makeFakeWindow(destroyed = false): FakeBrowserWindow {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      send: vi.fn(),
      isDestroyed: () => destroyed,
    },
  };
}

// ---------------------------------------------------------------------------
// Fake service stub
// ---------------------------------------------------------------------------

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-eb-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-eb-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

interface StubState {
  receivedCommands: string[];
  clientSocket: net.Socket | null;
  send: (frame: object) => void;
  close: () => Promise<void>;
}

/**
 * Start a fake service stub on `pipePath`. The stub:
 *  - Records every inbound request command in `receivedCommands`
 *  - Calls `onRequest(cmd, params, send)` so the test can script responses
 *  - Exposes `send()` to push frames from the test side
 */
async function startFakeService(
  pipePath: string,
  onRequest: (
    command: string,
    params: unknown,
    id: string,
    send: (frame: object) => void,
  ) => void,
): Promise<StubState> {
  const state: StubState = {
    receivedCommands: [],
    clientSocket: null,
    send: () => {
      throw new Error("no client connected yet");
    },
    close: () => Promise.resolve(),
  };

  const server = net.createServer((socket) => {
    state.clientSocket = socket;
    state.send = (frame) => socket.write(encodeFrame(frame as Parameters<typeof encodeFrame>[0]));
    const decoder = new FramingDecoder({
      onFrame: (f) => {
        const frame = f as RequestFrame;
        if (frame.kind === "request") {
          state.receivedCommands.push(frame.command);
          onRequest(frame.command, frame.params, frame.id, state.send);
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
      if (state.clientSocket) {
        state.clientSocket.destroy();
        state.clientSocket = null;
      }
      server.close(() => resolve());
    });

  return state;
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let stubs: Array<{ close: () => Promise<void> }> = [];
let bridges: SyncEventBridgeHandle[] = [];
let clientSockets: net.Socket[] = [];

beforeEach(() => {
  stubs = [];
  bridges = [];
  clientSockets = [];
  __resetSyncEventBridgeForTesting();
});

afterEach(async () => {
  for (const b of bridges) b.dispose();
  bridges = [];
  for (const cs of clientSockets) cs.destroy();
  clientSockets = [];
  for (const s of stubs) await s.close();
  stubs = [];
  __resetSyncEventBridgeForTesting();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSyncEventBridge — handshake ordering and seed emission", () => {
  it(
    "sends subscribe-events BEFORE list-jobs on the same connection",
    async () => {
      const pipePath = pipeFor("handshake-order");

      // Resolve promise when both commands have been received and
      // the list-jobs response has been sent.
      let resolveHandshake!: () => void;
      const handshakeDone = new Promise<void>((r) => {
        resolveHandshake = r;
      });

      const stub = await startFakeService(pipePath, (command, _params, id, send) => {
        if (command === "sync:subscribe-events") {
          send({ id, kind: "response", ok: true, result: { subscribed: true } });
        } else if (command === "sync:list-jobs") {
          send({
            id,
            kind: "response",
            ok: true,
            result: {
              jobs: [
                {
                  id: "job-1",
                  kind: "upload",
                  datasourceId: "ds-1",
                  sourcePath: "/foo",
                  targetPath: null,
                  conflictPolicy: "overwrite",
                  status: "running",
                  attempt: 1,
                  lastErrorTag: null,
                  lastErrorMessage: null,
                  createdAt: 0,
                  updatedAt: 0,
                },
                {
                  id: "job-2",
                  kind: "upload",
                  datasourceId: "ds-2",
                  sourcePath: "/bar",
                  targetPath: null,
                  conflictPolicy: "overwrite",
                  status: "completed", // should be filtered out
                  attempt: 1,
                  lastErrorTag: null,
                  lastErrorMessage: null,
                  createdAt: 0,
                  updatedAt: 0,
                },
              ],
            },
          });
          resolveHandshake();
        }
      });
      stubs.push(stub);

      // Connect a real SyncClient
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(pipePath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      clientSockets.push(socket);
      const client = new SyncClient(socket);

      const bridge = createSyncEventBridge(clientAsHandle(client));
      bridges.push(bridge);

      await handshakeDone;

      // subscribe-events must come BEFORE list-jobs
      const subIdx = stub.receivedCommands.indexOf("sync:subscribe-events");
      const listIdx = stub.receivedCommands.indexOf("sync:list-jobs");
      expect(subIdx).toBeGreaterThanOrEqual(0);
      expect(listIdx).toBeGreaterThanOrEqual(0);
      expect(subIdx).toBeLessThan(listIdx);
    },
    5000,
  );

  it(
    "list-jobs response is filtered to running/queued/waiting-network before seed",
    async () => {
      const pipePath = pipeFor("seed-filter");

      let resolveHandshake!: () => void;
      const handshakeDone = new Promise<void>((r) => {
        resolveHandshake = r;
      });

      const stub = await startFakeService(pipePath, (command, _params, id, send) => {
        if (command === "sync:subscribe-events") {
          send({ id, kind: "response", ok: true, result: { subscribed: true } });
        } else if (command === "sync:list-jobs") {
          send({
            id,
            kind: "response",
            ok: true,
            result: {
              jobs: [
                { id: "j-running", kind: "upload", datasourceId: "ds-1", sourcePath: "/a", targetPath: null, conflictPolicy: "overwrite", status: "running", attempt: 1, lastErrorTag: null, lastErrorMessage: null, createdAt: 0, updatedAt: 0 },
                { id: "j-queued", kind: "upload", datasourceId: "ds-2", sourcePath: "/b", targetPath: null, conflictPolicy: "overwrite", status: "queued", attempt: 0, lastErrorTag: null, lastErrorMessage: null, createdAt: 0, updatedAt: 0 },
                { id: "j-waiting", kind: "sync", datasourceId: "ds-3", sourcePath: "/c", targetPath: null, conflictPolicy: "overwrite", status: "waiting-network", attempt: 1, lastErrorTag: null, lastErrorMessage: null, createdAt: 0, updatedAt: 0 },
                { id: "j-completed", kind: "upload", datasourceId: "ds-4", sourcePath: "/d", targetPath: null, conflictPolicy: "overwrite", status: "completed", attempt: 1, lastErrorTag: null, lastErrorMessage: null, createdAt: 0, updatedAt: 0 },
                { id: "j-failed", kind: "upload", datasourceId: "ds-5", sourcePath: "/e", targetPath: null, conflictPolicy: "overwrite", status: "failed", attempt: 1, lastErrorTag: "err", lastErrorMessage: "x", createdAt: 0, updatedAt: 0 },
                { id: "j-cancelled", kind: "upload", datasourceId: "ds-6", sourcePath: "/f", targetPath: null, conflictPolicy: "overwrite", status: "cancelled", attempt: 1, lastErrorTag: null, lastErrorMessage: null, createdAt: 0, updatedAt: 0 },
              ],
            },
          });
          resolveHandshake();
        }
      });
      stubs.push(stub);

      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(pipePath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      clientSockets.push(socket);
      const client = new SyncClient(socket);
      const bridge = createSyncEventBridge(clientAsHandle(client));
      bridges.push(bridge);

      const win = makeFakeWindow();
      bridge.registerWindow(win as unknown as import("electron").BrowserWindow);

      await handshakeDone;

      // Wait for the microtask/tick that delivers the seed
      await new Promise<void>((r) => setTimeout(r, 10));

      expect(win.webContents.send).toHaveBeenCalledTimes(1);
      const [channel, event] = win.webContents.send.mock.calls[0]!;
      expect(channel).toBe(SYNC_CHANNELS.event);
      expect(event).toMatchObject({ kind: "sync-state-seed" });
      const jobs: Array<{ id: string }> = (event as { payload: { jobs: Array<{ id: string }> } }).payload.jobs;
      expect(jobs.map((j) => j.id)).toEqual(
        expect.arrayContaining(["j-running", "j-queued", "j-waiting"]),
      );
      expect(jobs.some((j) => j.id === "j-completed")).toBe(false);
      expect(jobs.some((j) => j.id === "j-failed")).toBe(false);
      expect(jobs.some((j) => j.id === "j-cancelled")).toBe(false);
    },
    5000,
  );

  it(
    "F-2: buffers seed until a window is registered, then delivers to that window",
    async () => {
      const pipePath = pipeFor("buffered-seed");

      let resolveHandshake!: () => void;
      const handshakeDone = new Promise<void>((r) => {
        resolveHandshake = r;
      });

      const stub = await startFakeService(pipePath, (command, _params, id, send) => {
        if (command === "sync:subscribe-events") {
          send({ id, kind: "response", ok: true, result: { subscribed: true } });
        } else if (command === "sync:list-jobs") {
          send({
            id,
            kind: "response",
            ok: true,
            result: {
              jobs: [
                { id: "j1", kind: "upload", datasourceId: "ds-1", sourcePath: "/x", targetPath: null, conflictPolicy: "overwrite", status: "running", attempt: 1, lastErrorTag: null, lastErrorMessage: null, createdAt: 0, updatedAt: 0 },
              ],
            },
          });
          resolveHandshake();
        }
      });
      stubs.push(stub);

      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(pipePath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      clientSockets.push(socket);
      const client = new SyncClient(socket);
      const bridge = createSyncEventBridge(clientAsHandle(client));
      bridges.push(bridge);

      // Wait for handshake to complete BEFORE registering any window
      await handshakeDone;
      await new Promise<void>((r) => setTimeout(r, 20)); // settle

      // No window registered yet — nothing sent
      const earlyWin = makeFakeWindow();
      // Don't register it yet; just verify there's no send

      // Now register the window AFTER the handshake
      const win = makeFakeWindow();
      bridge.registerWindow(win as unknown as import("electron").BrowserWindow);

      // Seed should be delivered to the newly-registered window
      await new Promise<void>((r) => setTimeout(r, 20));
      expect(win.webContents.send).toHaveBeenCalledTimes(1);
      const [channel, event] = win.webContents.send.mock.calls[0]!;
      expect(channel).toBe(SYNC_CHANNELS.event);
      expect(event).toMatchObject({ kind: "sync-state-seed" });

      // A second window registered after first delivery does NOT get the seed
      const lateWin = makeFakeWindow();
      bridge.registerWindow(lateWin as unknown as import("electron").BrowserWindow);
      await new Promise<void>((r) => setTimeout(r, 20));
      // lateWin should NOT have received the seed replay
      const seedCalls = lateWin.webContents.send.mock.calls.filter(
        (c: unknown[]) => (c[1] as { kind?: string })?.kind === "sync-state-seed",
      );
      expect(seedCalls).toHaveLength(0);

      // earlyWin was never registered, so it received nothing
      expect(earlyWin.webContents.send).not.toHaveBeenCalled();
    },
    5000,
  );
});
