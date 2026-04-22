// SyncClient request/response correlation tests.
//
// Tasks.md 3.3: verify the desktop transport client pairs responses with
// requests by id across arrival-order reordering, times out quietly, and
// silently drops responses whose id matches nothing pending. All four
// behaviours ride one shared stub server in a single describe block.
//
// We use the same cross-platform unique-pipe pattern as
// `services/fs-sync/src/ipc/server.test.ts` so Windows named-pipes and
// Unix-domain sockets work without extra config. The stub BUFFERS both
// real requests before replying — otherwise the "b then a" constraint
// degrades to "arrival order" and the test would spuriously pass.

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type {
  RequestFrame,
  ResponseFrame,
} from "@ft5/ipc-contracts/sync-service";
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

/**
 * Scripted stub server: callers register a handler that sees each inbound
 * `RequestFrame` and decides what to write back (and when). The stub owns
 * the write socket so tests can inject unknown-id responses, late
 * responses, or withhold a reply entirely.
 */
interface StubHandle {
  readonly pipePath: string;
  readonly server: net.Server;
  readonly close: () => Promise<void>;
  /** Resolves once the first client has connected server-side. */
  readonly whenConnected: Promise<void>;
  /** Write a raw frame to the first (and only) client. */
  send: (frame: ResponseFrame | { kind: "event"; name: string; payload: unknown }) => void;
}

async function startStub(
  tag: string,
  onRequest: (frame: RequestFrame, send: StubHandle["send"]) => void,
): Promise<StubHandle> {
  const pipePath = pipeFor(tag);
  let clientSocket: net.Socket | null = null;
  let connectedResolve!: () => void;
  const whenConnected = new Promise<void>((r) => {
    connectedResolve = r;
  });
  const server = net.createServer((socket) => {
    clientSocket = socket;
    const decoder = new FramingDecoder({
      onFrame: (f) => {
        if ((f as { kind: string }).kind === "request") {
          onRequest(f as RequestFrame, send);
        }
      },
      onError: () => void 0,
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("error", () => void 0);
    connectedResolve();
  });
  const send: StubHandle["send"] = (frame) => {
    if (!clientSocket) throw new Error("stub has no connected client yet");
    clientSocket.write(encodeFrame(frame));
  };
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
  return { pipePath, server, close, send, whenConnected };
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

describe("SyncClient request/response", () => {
  it("pairs two concurrent requests when the server replies in reverse order (b then a)", async () => {
    const pending = new Map<string, RequestFrame>();
    let flush: (() => void) | null = null;
    const stub = await startStub("reorder", (req, send) => {
      pending.set(req.id, req);
      if (pending.size === 2) {
        const b = pending.get("b");
        const a = pending.get("a");
        if (!a || !b) throw new Error("expected ids a and b, saw " + [...pending.keys()].join(","));
        // Reply to b FIRST, then a — exercise out-of-order correlation.
        send({
          id: b.id,
          kind: "response",
          ok: true,
          result: { echoed: "b-result" },
        });
        send({
          id: a.id,
          kind: "response",
          ok: true,
          result: { echoed: "a-result" },
        });
        flush?.();
      }
    });
    stubs.push(stub);

    const socket = await connectClient(stub.pipePath);
    sockets.push(socket);

    // Deterministic id sequence so the stub can identify requests by id.
    const idQueue = ["a", "b"];
    const client = new SyncClient(socket, {
      generateId: () => {
        const next = idQueue.shift();
        if (!next) throw new Error("generator exhausted");
        return next;
      },
    });

    const pA = client.request("sync:get-status", {});
    const pB = client.request("sync:list-jobs", {});

    // Wait until the stub has buffered both and flushed replies.
    await new Promise<void>((r) => {
      flush = r;
    });

    const [resA, resB] = await Promise.all([pA, pB]);
    // The client must pair responses by id, not by arrival order.
    expect((resA as unknown as { echoed: string }).echoed).toBe("a-result");
    expect((resB as unknown as { echoed: string }).echoed).toBe("b-result");
  });

  it("rejects a request with tag='request-timeout' when the server never replies", async () => {
    const seenIds: string[] = [];
    const stub = await startStub("timeout", (req) => {
      seenIds.push(req.id);
      // intentionally no reply
    });
    stubs.push(stub);

    const socket = await connectClient(stub.pipePath);
    sockets.push(socket);

    const client = new SyncClient(socket, {
      generateId: () => "t-1",
    });

    const start = Date.now();
    await expect(
      client.request("sync:get-status", {}, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ tag: "request-timeout" });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90); // allow small timer slack
    expect(seenIds).toEqual(["t-1"]);

    // Late arrival for an already-timed-out id must be dropped silently —
    // the client is still usable for subsequent requests.
    await stub.whenConnected;
    stub.send({
      id: "t-1",
      kind: "response",
      ok: true,
      result: { version: "late" },
    });
    // Small beat to let the decoder process the frame.
    await new Promise((r) => setTimeout(r, 20));
    // No unhandled rejection / throw reaches us — test survives.
  });

  it("silently drops a response whose id matches no pending request", async () => {
    let realRequestId: string | null = null;
    const stub = await startStub("unknown-id", (req, send) => {
      realRequestId = req.id;
      send({
        id: req.id,
        kind: "response",
        ok: true,
        result: { echoed: "ok" },
      });
    });
    stubs.push(stub);

    const socket = await connectClient(stub.pipePath);
    sockets.push(socket);

    // Capture unhandled rejections during this test; we must see none.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const client = new SyncClient(socket, {
        generateId: () => "real-1",
      });

      // Wait until the server has accepted the connection so that
      // `stub.send` has a live client-side socket to write to.
      await stub.whenConnected;

      // Inject a response whose id matches nothing pending — client
      // must drop it without throwing or registering any rejection.
      stub.send({
        id: "ghost-id-never-requested",
        kind: "response",
        ok: true,
        result: { phantom: true },
      });
      // Allow the decoder to process the stray frame before the real request.
      await new Promise((r) => setTimeout(r, 20));

      const result = await client.request("sync:get-status", {});
      expect(realRequestId).toBe("real-1");
      expect((result as unknown as { echoed: string }).echoed).toBe("ok");
      // Settle any microtasks before checking the unhandled-rejection bucket.
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rejects with SyncCommandError carrying the error tag when the server replies ok=false", async () => {
    const stub = await startStub("err", (req, send) => {
      send({
        id: req.id,
        kind: "response",
        ok: false,
        error: { tag: "not-found", message: "no such job" },
      });
    });
    stubs.push(stub);

    const socket = await connectClient(stub.pipePath);
    sockets.push(socket);

    const client = new SyncClient(socket, { generateId: () => "e-1" });
    await expect(
      client.request("sync:get-job", { jobId: "missing" }),
    ).rejects.toMatchObject({ tag: "not-found", command: "sync:get-job" });
  });
});
