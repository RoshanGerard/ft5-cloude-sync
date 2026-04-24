// SyncClient event fan-out tests (tasks.md 3.7).
//
// Verifies the `onEvent(cb): () => void` surface:
//   1. Every subscribed listener receives every well-formed event frame.
//   2. The unsubscribe function returned by `onEvent` stops delivery.
//   3. Multiple listeners coexist — unsubscribing one leaves others
//      intact.
//
// Uses the same cross-platform unique-pipe + net.createServer stub
// pattern as `client.disconnect.test.ts` so Windows named-pipes and
// Unix domain sockets both work without config tweaks. Malformed event
// frames are exercised in `client.disconnect.test.ts`; this file
// exclusively covers the happy-path dispatch contract.

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type {
  EventFrame,
  RequestFrame,
} from "@ft5/ipc-contracts/sync-service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FramingDecoder, encodeFrame } from "./framing.js";
import { SyncClient } from "./client.js";

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-client-evt-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-client-evt-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

interface StubHandle {
  readonly pipePath: string;
  readonly server: net.Server;
  readonly close: () => Promise<void>;
  readonly whenConnected: Promise<void>;
  send: (frame: EventFrame) => void;
}

async function startStub(tag: string): Promise<StubHandle> {
  const pipePath = pipeFor(tag);
  let accepted: net.Socket | null = null;
  let connectedResolve!: () => void;
  const whenConnected = new Promise<void>((r) => {
    connectedResolve = r;
  });
  const server = net.createServer((socket) => {
    accepted = socket;
    // Decoder wired so the stub would see request frames if the test
    // ever issued one — unused in the event-dispatch tests, but keeps
    // the stub shape consistent with the disconnect suite.
    const decoder = new FramingDecoder({
      onFrame: (f) => {
        void (f as RequestFrame);
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
  return { pipePath, server, close, send, whenConnected };
}

async function connectClient(pipePath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Yield the event loop so decoder-delivered frames are dispatched. */
async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
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

describe("SyncClient event dispatch", () => {
  it(
    "delivers every well-formed event frame to every subscribed listener",
    { timeout: 2000 },
    async () => {
      const stub = await startStub("fanout");
      stubs.push(stub);

      const socket = await connectClient(stub.pipePath);
      sockets.push(socket);

      const client = new SyncClient(socket);
      await stub.whenConnected;

      const seenA: EventFrame[] = [];
      const seenB: EventFrame[] = [];
      client.onEvent((ev) => {
        seenA.push(ev);
      });
      client.onEvent((ev) => {
        seenB.push(ev);
      });

      const frames: EventFrame[] = [
        {
          kind: "event",
          name: "job-started",
          payload: { jobId: "j-1", attempt: 1, startedAt: 1_700_000_000 },
        },
        {
          kind: "event",
          name: "job-progress",
          payload: {
            jobId: "j-1",
            bytesSent: 512,
            totalBytes: 1024,
            percent: 50,
          },
        },
        {
          kind: "event",
          name: "job-completed",
          payload: { jobId: "j-1", completedAt: 1_700_000_001 },
        },
      ];
      for (const f of frames) stub.send(f);
      await tick();

      expect(seenA).toHaveLength(3);
      expect(seenB).toHaveLength(3);
      expect(seenA.map((f) => f.name)).toEqual([
        "job-started",
        "job-progress",
        "job-completed",
      ]);
      expect(seenB.map((f) => f.name)).toEqual([
        "job-started",
        "job-progress",
        "job-completed",
      ]);
      // Payload passthrough: verify the progress frame round-trips intact.
      expect(seenA[1]?.payload).toEqual({
        jobId: "j-1",
        bytesSent: 512,
        totalBytes: 1024,
        percent: 50,
      });
    },
  );

  it(
    "stops delivering events to a listener after its unsubscribe function runs",
    { timeout: 2000 },
    async () => {
      const stub = await startStub("unsub");
      stubs.push(stub);

      const socket = await connectClient(stub.pipePath);
      sockets.push(socket);

      const client = new SyncClient(socket);
      await stub.whenConnected;

      const seen: EventFrame[] = [];
      const off = client.onEvent((ev) => {
        seen.push(ev);
      });

      stub.send({
        kind: "event",
        name: "job-started",
        payload: { jobId: "j-2", attempt: 1, startedAt: 1_700_000_100 },
      });
      await tick();
      expect(seen).toHaveLength(1);

      off();

      stub.send({
        kind: "event",
        name: "job-completed",
        payload: { jobId: "j-2", completedAt: 1_700_000_101 },
      });
      await tick();

      // Listener must not fire a second time after unsubscribe.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.name).toBe("job-started");
    },
  );

  it(
    "lets multiple listeners coexist independently; unsubscribing one leaves the other receiving events",
    { timeout: 2000 },
    async () => {
      const stub = await startStub("coexist");
      stubs.push(stub);

      const socket = await connectClient(stub.pipePath);
      sockets.push(socket);

      const client = new SyncClient(socket);
      await stub.whenConnected;

      const seenA: EventFrame[] = [];
      const seenB: EventFrame[] = [];
      const offA = client.onEvent((ev) => {
        seenA.push(ev);
      });
      client.onEvent((ev) => {
        seenB.push(ev);
      });

      stub.send({
        kind: "event",
        name: "job-enqueued",
        payload: {
          jobId: "j-3",
          kind: "upload",
          datasourceId: "ds-1",
          sourcePath: "/tmp/a",
          targetPath: null,
          conflictPolicy: "overwrite",
          enqueuedAt: 1_700_000_200,
        },
      });
      await tick();
      expect(seenA).toHaveLength(1);
      expect(seenB).toHaveLength(1);

      offA();

      stub.send({
        kind: "event",
        name: "job-started",
        payload: { jobId: "j-3", attempt: 1, startedAt: 1_700_000_201 },
      });
      await tick();

      // A is unsubscribed; only B sees the second event.
      expect(seenA).toHaveLength(1);
      expect(seenB).toHaveLength(2);
      expect(seenB.map((f) => f.name)).toEqual(["job-enqueued", "job-started"]);
    },
  );
});
