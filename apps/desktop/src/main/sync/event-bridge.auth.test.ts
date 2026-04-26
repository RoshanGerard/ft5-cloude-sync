// implement-datasource-onboarding §16 — bridge subscriptions for
// `oauth-open-url` + `credential-persisted` (bridge-only events) and
// pass-through forwarding for the renderer-bound `auth-*` family.
//
// Spec refs:
//   - openspec/changes/implement-datasource-onboarding/specs/datasources-ui/spec.md
//     §"Desktop main-process bridge translates service authenticate events into local actions"
//   - design.md Decision 6 (browser-open A1), Decision 7 (event taxonomy),
//     Decision 8 (registry stays in desktop temporarily, idempotent add)
//
// Test shape mirrors the existing `event-bridge.fanout.test.ts` pattern:
// boot a fake service over a named pipe, connect a real `SyncClient`, wrap
// it in a minimal `SupervisorHandle`, push event frames from the fake
// service, and assert observable side effects.

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { DatasourceSummary } from "@ft5/ipc-contracts";
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
  type BridgeRegistry,
} from "./event-bridge.js";
import type { SupervisorHandle } from "./supervisor.js";

// ---------------------------------------------------------------------------
// Test plumbing (mirrors event-bridge.fanout.test.ts)
// ---------------------------------------------------------------------------

function clientAsHandle(client: SyncClient): SupervisorHandle {
  const reconnectListeners = new Set<(c: SyncClient) => void>();
  const disconnectListeners = new Set<() => void>();
  return {
    getClient: () => client,
    on: ((...args: unknown[]) => {
      const [event, cb] = args as [
        "reconnect" | "disconnect",
        (c?: SyncClient) => void,
      ];
      if (event === "reconnect") {
        reconnectListeners.add(cb as (c: SyncClient) => void);
        return () => reconnectListeners.delete(cb as (c: SyncClient) => void);
      }
      disconnectListeners.add(cb as () => void);
      return () => disconnectListeners.delete(cb as () => void);
    }) as SupervisorHandle["on"],
    dispose() {
      /* no-op in tests */
    },
  };
}

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

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-eb-auth-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-eb-auth-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

interface StubState {
  send: (frame: object) => void;
  close: () => Promise<void>;
  connected: Promise<void>;
}

async function startFakeService(
  pipePath: string,
  onRequest?: (
    command: string,
    id: string,
    send: (frame: object) => void,
  ) => void,
): Promise<StubState> {
  let clientSocket: net.Socket | null = null;
  let connectedResolve!: () => void;
  const connected = new Promise<void>((r) => {
    connectedResolve = r;
  });

  const state: StubState = {
    send: (frame) => {
      if (!clientSocket) throw new Error("no client connected");
      clientSocket.write(
        encodeFrame(frame as Parameters<typeof encodeFrame>[0]),
      );
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

function autoAckHandler(
  command: string,
  id: string,
  send: (frame: object) => void,
): void {
  if (command === "sync:subscribe-events") {
    send({ id, kind: "response", ok: true, result: { subscribed: true } });
  } else if (command === "sync:list-jobs") {
    send({ id, kind: "response", ok: true, result: { jobs: [] } });
  }
}

async function connectClient(
  pipePath: string,
): Promise<{ client: SyncClient; socket: net.Socket }> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(pipePath);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
  const client = new SyncClient(socket);
  return { client, socket };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_SUMMARY: DatasourceSummary = {
  id: "ds-google-drive-abc",
  displayName: "My Drive",
  providerId: "google-drive",
  status: "connected",
  lastSyncAt: null,
  itemCount: 0,
  errorKind: null,
};

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

describe("createSyncEventBridge — auth-event subscriptions (§16)", () => {
  it(
    "calls injected shell.openExternal exactly once on `oauth-open-url`; renderer-window subscriber is NOT called for the bridge-only event",
    async () => {
      const pipePath = pipeFor("oauth-open-url");
      const stub = await startFakeService(pipePath, autoAckHandler);
      stubs.push(stub);

      const { client, socket } = await connectClient(pipePath);
      clientSockets.push(socket);

      const openExternal = vi.fn(async (_url: string) => undefined);
      const registry: BridgeRegistry = {
        setStatus: vi.fn(),
        add: vi.fn(),
      };
      const bridge = createSyncEventBridge(clientAsHandle(client), {
        registry,
        openExternal,
      });
      bridges.push(bridge);

      const win = makeFakeWindow();
      bridge.registerWindow(win as unknown as import("electron").BrowserWindow);

      await stub.connected;
      await new Promise<void>((r) => setTimeout(r, 30));
      win.webContents.send.mockClear();

      stub.send({
        kind: "event",
        name: "oauth-open-url",
        payload: {
          correlationId: "corr-1",
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?abc",
        },
      });

      await new Promise<void>((r) => setTimeout(r, 30));

      // shell.openExternal called once with the URL
      expect(openExternal).toHaveBeenCalledTimes(1);
      expect(openExternal).toHaveBeenCalledWith(
        "https://accounts.google.com/o/oauth2/v2/auth?abc",
      );

      // The renderer window MUST NOT receive `oauth-open-url`
      const syncCalls = win.webContents.send.mock.calls.filter(
        (c: unknown[]) =>
          c[0] === SYNC_CHANNELS.event &&
          (c[1] as { kind: string }).kind === "oauth-open-url",
      );
      expect(syncCalls).toHaveLength(0);
    },
    5000,
  );

  it(
    "calls injected registry.add exactly once on `credential-persisted`; renderer-window subscriber is NOT called for the bridge-only event",
    async () => {
      const pipePath = pipeFor("credential-persisted");
      const stub = await startFakeService(pipePath, autoAckHandler);
      stubs.push(stub);

      const { client, socket } = await connectClient(pipePath);
      clientSockets.push(socket);

      const openExternal = vi.fn(async () => undefined);
      const registryAdd = vi.fn();
      const registry: BridgeRegistry = {
        setStatus: vi.fn(),
        add: registryAdd,
      };
      const bridge = createSyncEventBridge(clientAsHandle(client), {
        registry,
        openExternal,
      });
      bridges.push(bridge);

      const win = makeFakeWindow();
      bridge.registerWindow(win as unknown as import("electron").BrowserWindow);

      await stub.connected;
      await new Promise<void>((r) => setTimeout(r, 30));
      win.webContents.send.mockClear();

      stub.send({
        kind: "event",
        name: "credential-persisted",
        payload: {
          correlationId: "corr-2",
          datasourceId: FIXTURE_SUMMARY.id,
          summary: FIXTURE_SUMMARY,
        },
      });

      await new Promise<void>((r) => setTimeout(r, 30));

      // registry.add called once with the supplied summary
      expect(registryAdd).toHaveBeenCalledTimes(1);
      expect(registryAdd).toHaveBeenCalledWith(FIXTURE_SUMMARY);

      // The renderer window MUST NOT receive `credential-persisted`
      const syncCalls = win.webContents.send.mock.calls.filter(
        (c: unknown[]) =>
          c[0] === SYNC_CHANNELS.event &&
          (c[1] as { kind: string }).kind === "credential-persisted",
      );
      expect(syncCalls).toHaveLength(0);
    },
    5000,
  );

  it(
    "forwards `auth-completed` to the renderer-window subscriber unchanged AND does NOT call registry.add for it (the paired credential-persisted handles that)",
    async () => {
      const pipePath = pipeFor("auth-completed-forward");
      const stub = await startFakeService(pipePath, autoAckHandler);
      stubs.push(stub);

      const { client, socket } = await connectClient(pipePath);
      clientSockets.push(socket);

      const openExternal = vi.fn(async () => undefined);
      const registryAdd = vi.fn();
      const registry: BridgeRegistry = {
        setStatus: vi.fn(),
        add: registryAdd,
      };
      const bridge = createSyncEventBridge(clientAsHandle(client), {
        registry,
        openExternal,
      });
      bridges.push(bridge);

      const win = makeFakeWindow();
      bridge.registerWindow(win as unknown as import("electron").BrowserWindow);

      await stub.connected;
      await new Promise<void>((r) => setTimeout(r, 30));
      win.webContents.send.mockClear();

      stub.send({
        kind: "event",
        name: "auth-completed",
        payload: {
          correlationId: "corr-3",
          datasourceId: FIXTURE_SUMMARY.id,
          summary: FIXTURE_SUMMARY,
        },
      });

      await new Promise<void>((r) => setTimeout(r, 30));

      // Renderer-window subscriber receives `auth-completed` verbatim on SYNC_CHANNELS.event
      const syncCalls = win.webContents.send.mock.calls.filter(
        (c: unknown[]) =>
          c[0] === SYNC_CHANNELS.event &&
          (c[1] as { kind: string }).kind === "auth-completed",
      );
      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0]![1]).toEqual({
        kind: "auth-completed",
        payload: {
          correlationId: "corr-3",
          datasourceId: FIXTURE_SUMMARY.id,
          summary: FIXTURE_SUMMARY,
        },
      });

      // The bridge MUST NOT call registry.add for `auth-completed` —
      // the paired `credential-persisted` is the bridge-only event that
      // does that, per design.md Decision 7 + Decision 8.
      expect(registryAdd).not.toHaveBeenCalled();
    },
    5000,
  );
});
