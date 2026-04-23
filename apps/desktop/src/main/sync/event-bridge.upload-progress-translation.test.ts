// Task 7.7 RED — sync event-bridge upload-progress translation tests.
//
// Verifies that the bridge translates wire `job-progress` events for
// UPLOAD jobs into `DatasourcesUploadProgressEvent` on
// `DATASOURCES_CHANNELS.uploadProgress`.
//
// Key translation rules:
//  - Wire `bytesSent` → renderer `bytesUploaded`
//  - Wire `totalBytes` → renderer `bytesTotal`
//  - `transactionId: jobId` (identity mapping)
//  - `status: 'uploading'` (always, for in-progress events)
//  - Only upload jobs trigger uploadProgress; sync/mirror jobs do NOT
//  - Job kind is tracked via `job-enqueued` events (no `kind` in job-progress)
//  - Eviction: terminal events (job-completed/failed/cancelled) remove from
//    the jobKinds map
//
// Correct field names (from actual DatasourcesUploadProgressEvent type):
//   bytesUploaded (NOT sentBytes), bytesTotal (NOT totalBytes in context)
//
// totalBytes === null: wire may send null for unknown total; bridge emits 0.

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { RequestFrame } from "@ft5/ipc-contracts/sync-service";
import {
  DATASOURCES_CHANNELS,
  type DatasourcesUploadProgressEvent,
} from "@ft5/ipc-contracts";
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
// Helpers
// ---------------------------------------------------------------------------

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-eb-prog-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-eb-prog-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

function makeFakeWindow(): {
  webContents: { send: Mock };
  isDestroyed: () => boolean;
} {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  };
}

// Minimal SupervisorHandle stub wrapping a SyncClient
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
    dispose() { /* no-op */ },
  };
}

interface FakeListenerState {
  send: (frame: object) => void;
  close: () => Promise<void>;
}

async function startAutoAckListener(pipePath: string): Promise<FakeListenerState> {
  let clientSocket: net.Socket | null = null;
  const state: FakeListenerState = {
    send: (frame) => {
      if (!clientSocket) return;
      clientSocket.write(encodeFrame(frame as Parameters<typeof encodeFrame>[0]));
    },
    close: () => Promise.resolve(),
  };

  const server = net.createServer((socket) => {
    clientSocket = socket;
    const decoder = new FramingDecoder({
      onFrame: (f) => {
        const frame = f as RequestFrame;
        if (frame.kind !== "request") return;
        if (frame.command === "sync:subscribe-events") {
          socket.write(encodeFrame({ id: frame.id, kind: "response", ok: true, result: { subscribed: true } } as Parameters<typeof encodeFrame>[0]));
        } else if (frame.command === "sync:list-jobs") {
          socket.write(encodeFrame({ id: frame.id, kind: "response", ok: true, result: { jobs: [] } } as Parameters<typeof encodeFrame>[0]));
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
      if (clientSocket) { clientSocket.destroy(); clientSocket = null; }
      server.close(() => resolve());
    });

  return state;
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let servers: FakeListenerState[] = [];
let bridges: SyncEventBridgeHandle[] = [];
let clientSockets: net.Socket[] = [];

beforeEach(() => {
  servers = [];
  bridges = [];
  clientSockets = [];
  __resetSyncEventBridgeForTesting();
});

afterEach(async () => {
  for (const b of bridges) b.dispose();
  bridges = [];
  for (const cs of clientSockets) cs.destroy();
  clientSockets = [];
  for (const s of servers) await s.close();
  servers = [];
  __resetSyncEventBridgeForTesting();
});

async function setup(tag: string): Promise<{
  stub: FakeListenerState;
  client: SyncClient;
  bridge: SyncEventBridgeHandle;
  win: ReturnType<typeof makeFakeWindow>;
}> {
  const pipePath = pipeFor(tag);
  const stub = await startAutoAckListener(pipePath);
  servers.push(stub);

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

  // Wait for handshake
  await new Promise<void>((r) => setTimeout(r, 30));
  win.webContents.send.mockClear();

  return { stub, client, bridge, win };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSyncEventBridge — upload-progress translation", () => {
  it(
    "translates job-progress for an upload job to DatasourcesUploadProgressEvent",
    async () => {
      const { stub, win } = await setup("basic-translate");

      // First, enqueue an upload job so the bridge knows its kind
      stub.send({
        kind: "event",
        name: "job-enqueued",
        payload: {
          jobId: "j-upload-1",
          kind: "upload",
          datasourceId: "ds-1",
          sourcePath: "/file.txt",
          targetPath: null,
          conflictPolicy: "overwrite",
          enqueuedAt: 1000,
        },
      });
      await new Promise<void>((r) => setTimeout(r, 20));
      win.webContents.send.mockClear();

      // Now send a job-progress event
      stub.send({
        kind: "event",
        name: "job-progress",
        payload: {
          jobId: "j-upload-1",
          bytesSent: 1024,
          totalBytes: 4096,
          percent: 25,
        },
      });
      await new Promise<void>((r) => setTimeout(r, 20));

      // Should have received on uploadProgress channel
      const progressCalls = win.webContents.send.mock.calls.filter(
        (c: unknown[]) => c[0] === DATASOURCES_CHANNELS.uploadProgress,
      );
      expect(progressCalls).toHaveLength(1);
      const event = progressCalls[0]![1] as DatasourcesUploadProgressEvent;
      expect(event.transactionId).toBe("j-upload-1");
      expect(event.bytesUploaded).toBe(1024);
      expect(event.bytesTotal).toBe(4096);
      expect(event.status).toBe("uploading");
    },
    5000,
  );

  it(
    "does NOT emit uploadProgress for sync/mirror job-progress events",
    async () => {
      const { stub, win } = await setup("no-mirror-progress");

      // Enqueue a sync job
      stub.send({
        kind: "event",
        name: "job-enqueued",
        payload: {
          jobId: "j-sync-1",
          kind: "sync",
          datasourceId: "ds-1",
          sourcePath: "/folder",
          targetPath: null,
          conflictPolicy: "overwrite",
          enqueuedAt: 1000,
        },
      });
      await new Promise<void>((r) => setTimeout(r, 20));
      win.webContents.send.mockClear();

      // Send a job-progress for the sync job
      stub.send({
        kind: "event",
        name: "job-progress",
        payload: {
          jobId: "j-sync-1",
          bytesSent: 500,
          totalBytes: 1000,
          percent: 50,
        },
      });
      await new Promise<void>((r) => setTimeout(r, 20));

      // Should NOT have received on uploadProgress channel
      const progressCalls = win.webContents.send.mock.calls.filter(
        (c: unknown[]) => c[0] === DATASOURCES_CHANNELS.uploadProgress,
      );
      expect(progressCalls).toHaveLength(0);

      // But should still have received the event on SYNC_CHANNELS.event
      const syncCalls = win.webContents.send.mock.calls.filter(
        (c: unknown[]) => c[0] !== DATASOURCES_CHANNELS.uploadProgress,
      );
      expect(syncCalls.length).toBeGreaterThan(0);
    },
    5000,
  );

  it(
    "does NOT emit uploadProgress for a job-progress where job kind is unknown",
    async () => {
      const { stub, win } = await setup("unknown-kind");

      // Send job-progress WITHOUT a prior job-enqueued (unknown kind)
      stub.send({
        kind: "event",
        name: "job-progress",
        payload: {
          jobId: "j-unknown",
          bytesSent: 100,
          totalBytes: 200,
          percent: 50,
        },
      });
      await new Promise<void>((r) => setTimeout(r, 20));

      const progressCalls = win.webContents.send.mock.calls.filter(
        (c: unknown[]) => c[0] === DATASOURCES_CHANNELS.uploadProgress,
      );
      expect(progressCalls).toHaveLength(0);
    },
    5000,
  );

  it(
    "handles totalBytes: null gracefully (emits 0 for bytesTotal)",
    async () => {
      const { stub, win } = await setup("null-total");

      stub.send({
        kind: "event",
        name: "job-enqueued",
        payload: {
          jobId: "j-null-total",
          kind: "upload",
          datasourceId: "ds-1",
          sourcePath: "/file.txt",
          targetPath: null,
          conflictPolicy: "overwrite",
          enqueuedAt: 1000,
        },
      });
      await new Promise<void>((r) => setTimeout(r, 20));
      win.webContents.send.mockClear();

      stub.send({
        kind: "event",
        name: "job-progress",
        payload: {
          jobId: "j-null-total",
          bytesSent: 512,
          totalBytes: null,
          percent: null,
        },
      });
      await new Promise<void>((r) => setTimeout(r, 20));

      const progressCalls = win.webContents.send.mock.calls.filter(
        (c: unknown[]) => c[0] === DATASOURCES_CHANNELS.uploadProgress,
      );
      expect(progressCalls).toHaveLength(1);
      const event = progressCalls[0]![1] as DatasourcesUploadProgressEvent;
      expect(event.bytesUploaded).toBe(512);
      expect(event.bytesTotal).toBe(0); // null coerced to 0
      expect(event.status).toBe("uploading");
    },
    5000,
  );

  it(
    "job-kind map is seeded from state-seed jobs — progress works without prior job-enqueued",
    async () => {
      const pipePath = pipeFor("seeded-map");
      // Start a listener that returns a running upload job in list-jobs
      let clientSocket: net.Socket | null = null;
      const server = net.createServer((socket) => {
        clientSocket = socket;
        const decoder = new FramingDecoder({
          onFrame: (f) => {
            const frame = f as RequestFrame;
            if (frame.kind !== "request") return;
            if (frame.command === "sync:subscribe-events") {
              socket.write(encodeFrame({ id: frame.id, kind: "response", ok: true, result: { subscribed: true } } as Parameters<typeof encodeFrame>[0]));
            } else if (frame.command === "sync:list-jobs") {
              socket.write(encodeFrame({
                id: frame.id,
                kind: "response",
                ok: true,
                result: {
                  jobs: [{
                    id: "j-seeded-upload",
                    kind: "upload",
                    datasourceId: "ds-1",
                    sourcePath: "/file.txt",
                    targetPath: null,
                    conflictPolicy: "overwrite",
                    status: "running",
                    attempt: 1,
                    lastErrorTag: null,
                    lastErrorMessage: null,
                    createdAt: 0,
                    updatedAt: 0,
                  }],
                },
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

      const stubState = {
        send: (frame: object) => {
          if (!clientSocket) return;
          clientSocket.write(encodeFrame(frame as Parameters<typeof encodeFrame>[0]));
        },
        close: () => new Promise<void>((r) => {
          if (clientSocket) { clientSocket.destroy(); clientSocket = null; }
          server.close(() => r());
        }),
      };
      servers.push(stubState);

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

      // Wait for handshake with the seeded running job
      await new Promise<void>((r) => setTimeout(r, 50));
      win.webContents.send.mockClear();

      // Send a job-progress WITHOUT a prior job-enqueued event
      // (the bridge should have seeded the kind from list-jobs)
      stubState.send({
        kind: "event",
        name: "job-progress",
        payload: {
          jobId: "j-seeded-upload",
          bytesSent: 256,
          totalBytes: 1024,
          percent: 25,
        },
      });
      await new Promise<void>((r) => setTimeout(r, 30));

      const progressCalls = win.webContents.send.mock.calls.filter(
        (c: unknown[]) => c[0] === DATASOURCES_CHANNELS.uploadProgress,
      );
      expect(progressCalls).toHaveLength(1);
      const event = progressCalls[0]![1] as DatasourcesUploadProgressEvent;
      expect(event.transactionId).toBe("j-seeded-upload");
      expect(event.bytesUploaded).toBe(256);
      expect(event.bytesTotal).toBe(1024);
    },
    5000,
  );
});
