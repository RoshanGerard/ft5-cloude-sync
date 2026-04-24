// SyncClient typed method wrappers.
//
// Task 3.4 says `SyncClient` exposes typed methods per `SYNC_CHANNELS`;
// task 5.1's RED test language literally calls `syncClient.listJobs(params)`.
// The wrappers are thin delegates that issue the right wire `command` and
// return the wire result. Any translation (e.g., derivedSyncingDatasourceIds)
// belongs in the main-process IPC handler, not here.
//
// Each wrapper is verified by driving it against a stub server that echoes
// the incoming `command` string back in the response payload — this proves
// the wrapper mapped to the correct wire name without coupling the test to
// any internal frame layout beyond the public Request/Response shapes.

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type {
  CommandName,
  RequestFrame,
  ResponseFrame,
} from "@ft5/ipc-contracts/sync-service";
import { SYNC_CHANNELS } from "@ft5/ipc-contracts/sync-service-desktop";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FramingDecoder, encodeFrame } from "./framing.js";
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

interface StubHandle {
  readonly pipePath: string;
  readonly server: net.Server;
  readonly close: () => Promise<void>;
  readonly firstRequest: Promise<RequestFrame>;
}

async function startEchoStub(tag: string): Promise<StubHandle> {
  const pipePath = pipeFor(tag);
  let requestResolve!: (frame: RequestFrame) => void;
  const firstRequest = new Promise<RequestFrame>((r) => {
    requestResolve = r;
  });
  let clientSocket: net.Socket | null = null;
  const server = net.createServer((socket) => {
    clientSocket = socket;
    const decoder = new FramingDecoder({
      onFrame: (f) => {
        if ((f as { kind: string }).kind === "request") {
          const req = f as RequestFrame;
          requestResolve(req);
          // Echo the command string back so the test can verify which
          // wire name the wrapper issued.
          const response: ResponseFrame = {
            id: req.id,
            kind: "response",
            ok: true,
            // The result shape varies per command but every consumer of
            // this stub only inspects the `.echoedCommand` field, which
            // is safe to add — the client does not validate result
            // shape at this layer.
            result: { echoedCommand: req.command } as unknown as never,
          };
          socket.write(encodeFrame(response));
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
  return { pipePath, server, close, firstRequest };
}

async function connectClient(pipePath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

let stubs: StubHandle[] = [];
let sockets: net.Socket[] = [];

beforeEach(() => {
  stubs = [];
  sockets = [];
});

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets = [];
  for (const st of stubs) await st.close();
  stubs = [];
});

// One row per wrapper method. The `invoke` closure calls the wrapper with
// dummy-but-shape-correct params; the test only checks which wire command
// was emitted, not the result payload shape.
const wrappers: ReadonlyArray<{
  readonly method: string;
  readonly expectedCommand: CommandName;
  readonly invoke: (c: SyncClient) => Promise<unknown>;
}> = [
  {
    method: "listJobs",
    expectedCommand: SYNC_CHANNELS.listJobs,
    invoke: (c) => c.listJobs({}),
  },
  {
    method: "getJob",
    expectedCommand: SYNC_CHANNELS.getJob,
    invoke: (c) => c.getJob({ jobId: "j-1" }),
  },
  {
    method: "enqueueUpload",
    expectedCommand: SYNC_CHANNELS.enqueueUpload,
    invoke: (c) =>
      c.enqueueUpload({
        datasourceId: "ds-1",
        sourcePath: "/tmp/x",
        targetPath: "/x",
        conflictPolicy: "overwrite",
      }),
  },
  {
    method: "enqueueMirror",
    expectedCommand: SYNC_CHANNELS.enqueueMirror,
    invoke: (c) => c.enqueueMirror({ datasourceId: "ds-1", sourcePath: "/tmp/x" }),
  },
  {
    method: "cancelJob",
    expectedCommand: SYNC_CHANNELS.cancelJob,
    invoke: (c) => c.cancelJob({ jobId: "j-1" }),
  },
  {
    method: "authenticateStart",
    expectedCommand: SYNC_CHANNELS.authenticateStart,
    invoke: (c) =>
      c.authenticateStart({
        datasourceId: "ds-1",
        type: "amazon-s3",
      }),
  },
  {
    method: "authenticateComplete",
    expectedCommand: SYNC_CHANNELS.authenticateComplete,
    invoke: (c) =>
      c.authenticateComplete({
        correlationId: "corr-1",
        completion: { kind: "oauth", code: "noop" },
      }),
  },
  {
    method: "getStatus",
    expectedCommand: SYNC_CHANNELS.getStatus,
    invoke: (c) => c.getStatus({}),
  },
  {
    method: "getRetryPolicy",
    expectedCommand: SYNC_CHANNELS.getRetryPolicy,
    invoke: (c) => c.getRetryPolicy({ scope: "global" }),
  },
  {
    method: "setRetryPolicy",
    expectedCommand: SYNC_CHANNELS.setRetryPolicy,
    invoke: (c) =>
      c.setRetryPolicy({
        scope: "global",
        maxAttempts: 3,
        backoffMs: 1000,
        backoffStrategy: "exponential",
      }),
  },
];

describe("SyncClient typed method wrappers", () => {
  for (const { method, expectedCommand, invoke } of wrappers) {
    it(`${method} issues wire command ${expectedCommand}`, async () => {
      const stub = await startEchoStub(`typed-${method}`);
      stubs.push(stub);

      const socket = await connectClient(stub.pipePath);
      sockets.push(socket);

      const client = new SyncClient(socket, {
        generateId: () => `id-${method}`,
      });

      const result = (await invoke(client)) as { echoedCommand: string };
      const req = await stub.firstRequest;
      expect(req.command).toBe(expectedCommand);
      expect(result.echoedCommand).toBe(expectedCommand);
    });
  }
});
