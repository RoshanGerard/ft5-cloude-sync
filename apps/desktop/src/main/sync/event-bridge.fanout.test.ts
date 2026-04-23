// Task 7.3 RED — sync event-bridge fan-out tests.
//
// Verifies:
//  1. Three BrowserWindow instances all receive the same event exactly once each.
//  2. Events for an already-closed window are not sent (no crash) and the
//     window is lazily removed from the set.
//  3. Per-window registration / deregistration works correctly.

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

// Minimal SupervisorHandle stub that wraps a SyncClient for tests
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
  _destroyed: boolean;
}

function makeFakeWindow(): FakeBrowserWindow {
  const win: FakeBrowserWindow = {
    _destroyed: false,
    isDestroyed() {
      return this._destroyed;
    },
    webContents: {
      send: vi.fn(),
      isDestroyed() {
        return win._destroyed;
      },
    },
  };
  return win;
}

// ---------------------------------------------------------------------------
// Fake service stub
// ---------------------------------------------------------------------------

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-eb-fanout-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-eb-fanout-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

interface StubState {
  send: (frame: object) => void;
  close: () => Promise<void>;
  connected: Promise<void>;
}

async function startFakeService(
  pipePath: string,
  onRequest?: (command: string, id: string, send: (frame: object) => void) => void,
): Promise<StubState> {
  let clientSocket: net.Socket | null = null;
  let connectedResolve!: () => void;
  const connected = new Promise<void>((r) => {
    connectedResolve = r;
  });

  const state: StubState = {
    send: (frame) => {
      if (!clientSocket) throw new Error("no client connected");
      clientSocket.write(encodeFrame(frame as Parameters<typeof encodeFrame>[0]));
    },
    close: () => Promise.resolve(),
    connected,
  };

  const server = net.createServer((socket) => {
    clientSocket = socket;
    connectedResolve();
    const decoder = new FramingDecoder({
      onFrame: (f) => {
        const frame = f as RequestFrame;
        if (frame.kind === "request" && onRequest) {
          onRequest(frame.command, frame.id, state.send);
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
// Helpers
// ---------------------------------------------------------------------------

/** Connect a real SyncClient to the fake service at pipePath. */
async function connectClient(pipePath: string): Promise<{ client: SyncClient; socket: net.Socket }> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(pipePath);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
  const client = new SyncClient(socket);
  return { client, socket };
}

/** Auto-responding fake service: ACKs subscribe-events and list-jobs with empty jobs. */
function autoAckHandler(command: string, id: string, send: (frame: object) => void): void {
  if (command === "sync:subscribe-events") {
    send({ id, kind: "response", ok: true, result: { subscribed: true } });
  } else if (command === "sync:list-jobs") {
    send({ id, kind: "response", ok: true, result: { jobs: [] } });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSyncEventBridge — fan-out", () => {
  it(
    "three registered windows each receive the same service event exactly once",
    async () => {
      const pipePath = pipeFor("three-windows");
      const stub = await startFakeService(pipePath, autoAckHandler);
      stubs.push(stub);

      const { client, socket } = await connectClient(pipePath);
      clientSockets.push(socket);
      const bridge = createSyncEventBridge(clientAsHandle(client));
      bridges.push(bridge);

      const winA = makeFakeWindow();
      const winB = makeFakeWindow();
      const winC = makeFakeWindow();

      bridge.registerWindow(winA as unknown as import("electron").BrowserWindow);
      bridge.registerWindow(winB as unknown as import("electron").BrowserWindow);
      bridge.registerWindow(winC as unknown as import("electron").BrowserWindow);

      // Wait for handshake to complete (empty seed)
      await stub.connected;
      await new Promise<void>((r) => setTimeout(r, 30));

      // Clear the seed calls (if any) to isolate the live-event assertion
      winA.webContents.send.mockClear();
      winB.webContents.send.mockClear();
      winC.webContents.send.mockClear();

      // Push a live event from the fake service
      stub.send({
        kind: "event",
        name: "job-enqueued",
        payload: {
          jobId: "j-99",
          kind: "upload",
          datasourceId: "ds-1",
          sourcePath: "/file.txt",
          targetPath: null,
          conflictPolicy: "overwrite",
          enqueuedAt: 1000,
        },
      });

      await new Promise<void>((r) => setTimeout(r, 30));

      // Each window received the event exactly once on the sync channel
      for (const win of [winA, winB, winC]) {
        const syncCalls = win.webContents.send.mock.calls.filter(
          (c: unknown[]) => c[0] === SYNC_CHANNELS.event,
        );
        expect(syncCalls).toHaveLength(1);
        expect((syncCalls[0]![1] as { kind: string }).kind).toBe("job-enqueued");
      }
    },
    5000,
  );

  it(
    "events for an already-closed window are silently dropped without crashing",
    async () => {
      const pipePath = pipeFor("closed-window");
      const stub = await startFakeService(pipePath, autoAckHandler);
      stubs.push(stub);

      const { client, socket } = await connectClient(pipePath);
      clientSockets.push(socket);
      const bridge = createSyncEventBridge(clientAsHandle(client));
      bridges.push(bridge);

      const liveWin = makeFakeWindow();
      const deadWin = makeFakeWindow();

      bridge.registerWindow(liveWin as unknown as import("electron").BrowserWindow);
      bridge.registerWindow(deadWin as unknown as import("electron").BrowserWindow);

      // Mark one window as destroyed before any events arrive
      deadWin._destroyed = true;

      await stub.connected;
      await new Promise<void>((r) => setTimeout(r, 30));
      liveWin.webContents.send.mockClear();
      deadWin.webContents.send.mockClear();

      // Push a live event — should NOT throw even though deadWin is closed
      stub.send({
        kind: "event",
        name: "job-started",
        payload: { jobId: "j-1", attempt: 1, startedAt: 1000 },
      });

      await new Promise<void>((r) => setTimeout(r, 30));

      // Live window receives the event
      const liveCalls = liveWin.webContents.send.mock.calls.filter(
        (c: unknown[]) => c[0] === SYNC_CHANNELS.event,
      );
      expect(liveCalls).toHaveLength(1);

      // Destroyed window send was never called
      expect(deadWin.webContents.send).not.toHaveBeenCalled();
    },
    5000,
  );

  it(
    "a second event after closed-window detection still reaches live windows",
    async () => {
      const pipePath = pipeFor("post-close-fanout");
      const stub = await startFakeService(pipePath, autoAckHandler);
      stubs.push(stub);

      const { client, socket } = await connectClient(pipePath);
      clientSockets.push(socket);
      const bridge = createSyncEventBridge(clientAsHandle(client));
      bridges.push(bridge);

      const winA = makeFakeWindow();
      const winB = makeFakeWindow();

      bridge.registerWindow(winA as unknown as import("electron").BrowserWindow);
      bridge.registerWindow(winB as unknown as import("electron").BrowserWindow);

      await stub.connected;
      await new Promise<void>((r) => setTimeout(r, 30));
      winA.webContents.send.mockClear();
      winB.webContents.send.mockClear();

      // Close winA mid-stream
      winA._destroyed = true;

      stub.send({
        kind: "event",
        name: "job-completed",
        payload: { jobId: "j-1", completedAt: 1000 },
      });
      stub.send({
        kind: "event",
        name: "job-completed",
        payload: { jobId: "j-2", completedAt: 2000 },
      });

      await new Promise<void>((r) => setTimeout(r, 30));

      // winB received both events
      const winBCalls = winB.webContents.send.mock.calls.filter(
        (c: unknown[]) => c[0] === SYNC_CHANNELS.event,
      );
      expect(winBCalls).toHaveLength(2);

      // winA was destroyed so nothing was sent
      expect(winA.webContents.send).not.toHaveBeenCalled();
    },
    5000,
  );

  it(
    "dispose() stops further broadcasts to all windows",
    async () => {
      const pipePath = pipeFor("dispose-stops");
      const stub = await startFakeService(pipePath, autoAckHandler);
      stubs.push(stub);

      const { client, socket } = await connectClient(pipePath);
      clientSockets.push(socket);
      const bridge = createSyncEventBridge(clientAsHandle(client));
      // NOTE: don't push to bridges[] so afterEach doesn't double-dispose
      // We'll dispose explicitly in the test

      const win = makeFakeWindow();
      bridge.registerWindow(win as unknown as import("electron").BrowserWindow);

      await stub.connected;
      await new Promise<void>((r) => setTimeout(r, 30));
      win.webContents.send.mockClear();

      // Dispose then push an event — should not reach the window
      bridge.dispose();

      stub.send({
        kind: "event",
        name: "job-started",
        payload: { jobId: "j-x", attempt: 1, startedAt: 1000 },
      });

      await new Promise<void>((r) => setTimeout(r, 30));
      expect(win.webContents.send).not.toHaveBeenCalled();
    },
    5000,
  );
});
