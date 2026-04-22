// SyncClient disconnect + malformed-event tests.
//
// Tasks.md 3.5: verify the desktop transport client rejects every
// in-flight request with tag `service-disconnected` when the underlying
// socket closes, rejects subsequent requests the same way, and silently
// drops structurally-malformed event frames so one bad frame cannot
// crash the main process.
//
// Uses the same cross-platform unique-pipe pattern as
// `client.request-response.test.ts` so Windows named-pipes and Unix
// domain sockets work without extra config. Unlike pair 2's stub, we
// frequently need to close the server side mid-test — the stub exposes
// both a "destroy the client-side socket from the server" knob and a
// raw-bytes sender for injecting malformed frames.

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
    return `\\\\.\\pipe\\ft5-sync-client-disc-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-client-disc-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

interface StubHandle {
  readonly pipePath: string;
  readonly server: net.Server;
  readonly close: () => Promise<void>;
  readonly whenConnected: Promise<void>;
  send: (
    frame: ResponseFrame | { kind: "event"; name: string; payload: unknown },
  ) => void;
  /** Inject raw bytes (for malformed-event injection). Must include '\n'. */
  sendRaw: (bytes: string) => void;
  /** Forcibly destroy the server-side accepted socket. */
  destroyClientSocket: () => void;
}

async function startStub(
  tag: string,
  onRequest: (frame: RequestFrame, send: StubHandle["send"]) => void,
): Promise<StubHandle> {
  const pipePath = pipeFor(tag);
  let accepted: net.Socket | null = null;
  let connectedResolve!: () => void;
  const whenConnected = new Promise<void>((r) => {
    connectedResolve = r;
  });
  const server = net.createServer((socket) => {
    accepted = socket;
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
    if (!accepted) throw new Error("stub has no connected client yet");
    accepted.write(encodeFrame(frame));
  };
  const sendRaw: StubHandle["sendRaw"] = (bytes) => {
    if (!accepted) throw new Error("stub has no connected client yet");
    accepted.write(bytes);
  };
  const destroyClientSocket: StubHandle["destroyClientSocket"] = () => {
    if (accepted) {
      accepted.destroy();
      accepted = null;
    }
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
      if (accepted) {
        accepted.destroy();
        accepted = null;
      }
      server.close(() => resolve());
    });
  return {
    pipePath,
    server,
    close,
    send,
    sendRaw,
    destroyClientSocket,
    whenConnected,
  };
}

async function connectClient(pipePath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Wait until `client.isConnected` flips false or the timeout elapses. */
async function waitForDisconnect(
  client: SyncClient,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!client.isConnected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
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

describe("SyncClient disconnect handling", () => {
  it(
    "is connected at construction and flips to disconnected after the socket closes",
    { timeout: 2000 },
    async () => {
      const stub = await startStub("is-connected", () => {
        /* never replies */
      });
      stubs.push(stub);

      const socket = await connectClient(stub.pipePath);
      sockets.push(socket);

      const client = new SyncClient(socket);
      await stub.whenConnected;

      // First assertion — a missing property fails cleanly and fast,
      // giving a discriminating RED without vitest timeout.
      expect(client.isConnected).toBe(true);

      stub.destroyClientSocket();
      await waitForDisconnect(client);
      expect(client.isConnected).toBe(false);
    },
  );

  it(
    "rejects all in-flight requests with tag='service-disconnected' when the server-side socket is destroyed",
    { timeout: 2000 },
    async () => {
      const seenIds: string[] = [];
      const stub = await startStub("in-flight", (req) => {
        // Record arrival but NEVER reply — we want both requests pending
        // when the server drops the connection.
        seenIds.push(req.id);
      });
      stubs.push(stub);

      const socket = await connectClient(stub.pipePath);
      sockets.push(socket);

      const idQueue = ["r1", "r2"];
      const client = new SyncClient(socket, {
        generateId: () => {
          const next = idQueue.shift();
          if (!next) throw new Error("generator exhausted");
          return next;
        },
      });

      await stub.whenConnected;

      const pA = client.request("sync:get-status", {});
      const pB = client.request("sync:list-jobs", {});

      // Wait for both requests to reach the stub before forcing the drop
      // — otherwise we'd race against the OS-level send buffer.
      const waitArrival = async () => {
        const deadline = Date.now() + 1000;
        while (seenIds.length < 2 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      await waitArrival();
      expect(seenIds).toEqual(["r1", "r2"]);

      stub.destroyClientSocket();

      await expect(pA).rejects.toMatchObject({ tag: "service-disconnected" });
      await expect(pB).rejects.toMatchObject({ tag: "service-disconnected" });
    },
  );

  it(
    "rejects requests issued AFTER disconnect with the same tag, without writing to the socket",
    { timeout: 2000 },
    async () => {
      const stub = await startStub("post-disc", () => {
        /* never replies */
      });
      stubs.push(stub);

      const socket = await connectClient(stub.pipePath);
      sockets.push(socket);

      const client = new SyncClient(socket);
      await stub.whenConnected;

      stub.destroyClientSocket();
      await waitForDisconnect(client);

      await expect(
        client.request("sync:get-status", {}),
      ).rejects.toMatchObject({ tag: "service-disconnected" });
    },
  );

  it(
    "drops a malformed event frame silently and keeps serving subsequent requests",
    { timeout: 2000 },
    async () => {
      const stub = await startStub("malformed-event", (req, send) => {
        // Legit echo so we can verify the client survived the bad frame.
        send({
          id: req.id,
          kind: "response",
          ok: true,
          result: { echoed: "survived" },
        });
      });
      stubs.push(stub);

      const socket = await connectClient(stub.pipePath);
      sockets.push(socket);

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const client = new SyncClient(socket, { generateId: () => "m-1" });
        await stub.whenConnected;

        // Inject a syntactically valid JSON object the decoder will
        // happily deliver as a Frame, but which violates the EventFrame
        // shape: `kind: "event"` with a non-string `name`. The client
        // must not throw and must not dispatch.
        const malformed = JSON.stringify({
          kind: "event",
          name: 42, // invalid — EventFrame requires string
          payload: { anything: true },
        });
        stub.sendRaw(malformed + "\n");
        // Let the decoder process the bad frame.
        await new Promise((r) => setTimeout(r, 20));

        // Client must still be usable.
        const result = await client.request("sync:get-status", {});
        expect((result as unknown as { echoed: string }).echoed).toBe(
          "survived",
        );
        // Settle microtasks before checking unhandled bucket.
        await new Promise((r) => setTimeout(r, 10));
        expect(unhandled).toEqual([]);
        expect(client.isConnected).toBe(true);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    },
  );

  it(
    "notifies disconnect listeners registered via client.on('disconnect', cb)",
    { timeout: 2000 },
    async () => {
      const stub = await startStub("listener", () => {
        /* never replies */
      });
      stubs.push(stub);

      const socket = await connectClient(stub.pipePath);
      sockets.push(socket);

      const client = new SyncClient(socket);
      await stub.whenConnected;

      let a = 0;
      let b = 0;
      const offA = client.on("disconnect", () => {
        a++;
      });
      client.on("disconnect", () => {
        b++;
      });

      // Unsubscribe one listener BEFORE the event fires.
      offA();

      stub.destroyClientSocket();
      await waitForDisconnect(client);
      // Let listeners fire synchronously-then-microtask.
      await new Promise((r) => setTimeout(r, 10));

      expect(a).toBe(0);
      expect(b).toBe(1);
    },
  );
});
