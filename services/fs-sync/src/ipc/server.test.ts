import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  COMMAND_NAMES,
  type CommandHandler,
  type RequestFrame,
  type ResponseFrame,
} from "@ft5/ipc-contracts/sync-service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FramingDecoder } from "./framing.js";
import { startServer, type RunningServer, type CommandHandlers } from "./server.js";

let running: RunningServer | null = null;

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

beforeEach(() => {
  running = null;
});

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

async function connect(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function send(socket: net.Socket, frame: RequestFrame): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}

async function collectResponses(
  socket: net.Socket,
  wantIds: ReadonlyArray<string>,
  timeoutMs = 2000,
): Promise<Map<string, ResponseFrame>> {
  const out = new Map<string, ResponseFrame>();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `timeout collecting responses; got ${out.size}/${wantIds.length}`,
        ),
      );
    }, timeoutMs);
    const decoder = new FramingDecoder({
      onFrame: (f) => {
        const frame = f as ResponseFrame;
        if (frame.kind === "response" && wantIds.includes(frame.id)) {
          out.set(frame.id, frame);
          if (out.size === wantIds.length) {
            clearTimeout(timer);
            resolve(out);
          }
        }
      },
      onError: () => void 0,
    });
    socket.on("data", (chunk) => decoder.push(chunk));
  });
}

describe("IPC server — round-trip", () => {
  it("accepts a client connection, correlates request → response by id", async () => {
    const handler: CommandHandler<"sync:get-status"> = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        result: {
          version: "0.0.0",
          serviceUuid: "u-1",
          runningJobs: 0,
          queuedJobs: 0,
          waitingNetworkJobs: 0,
          monitorConnected: false,
        },
      });
    const handlers: CommandHandlers = { "sync:get-status": handler };
    const pipePath = pipeFor("rt");
    running = await startServer({ pipePath, handlers, commandNames: COMMAND_NAMES });

    const socket = await connect(pipePath);
    try {
      send(socket, {
        id: "r-1",
        kind: "request",
        command: "sync:get-status",
        params: {},
      });
      const out = await collectResponses(socket, ["r-1"]);
      expect(handler).toHaveBeenCalledTimes(1);
      const r = out.get("r-1");
      expect(r?.ok).toBe(true);
      if (r?.ok) {
        expect(r.result).toMatchObject({ version: "0.0.0", serviceUuid: "u-1" });
      }
    } finally {
      socket.destroy();
    }
  });

  it("rejects an unknown command with tag=unknown-command", async () => {
    const pipePath = pipeFor("uk");
    running = await startServer({
      pipePath,
      handlers: {},
      commandNames: COMMAND_NAMES,
    });
    const socket = await connect(pipePath);
    try {
      send(socket, {
        id: "r-2",
        kind: "request",
        command: "sync:fly-to-mars" as never,
        params: {},
      });
      const out = await collectResponses(socket, ["r-2"]);
      const r = out.get("r-2");
      expect(r?.ok).toBe(false);
      if (r && !r.ok) {
        expect(r.error.tag).toBe("unknown-command");
      }
    } finally {
      socket.destroy();
    }
  });

  it("handles two concurrent requests on the same connection (out-of-order ok)", async () => {
    const order: string[] = [];
    const handler: CommandHandler<"sync:get-status"> = async (_params, _ctx) => {
      // First request (id "a") should still be pending when the second
      // (id "b") arrives; we introduce a gate so b finishes first.
      return await new Promise((resolve) => {
        setTimeout(() => {
          order.push("a-finish");
          resolve({
            ok: true,
            result: {
              version: "a",
              serviceUuid: "u-1",
              runningJobs: 0,
              queuedJobs: 0,
              waitingNetworkJobs: 0,
              monitorConnected: false,
            },
          });
        }, 100);
      });
    };
    const handlerFast: CommandHandler<"sync:get-job"> = async () => {
      order.push("b-finish");
      return {
        ok: false,
        error: { tag: "not-found", message: "no" },
      };
    };
    const handlers: CommandHandlers = {
      "sync:get-status": handler,
      "sync:get-job": handlerFast,
    };
    const pipePath = pipeFor("cc");
    running = await startServer({ pipePath, handlers, commandNames: COMMAND_NAMES });
    const socket = await connect(pipePath);
    try {
      send(socket, {
        id: "a",
        kind: "request",
        command: "sync:get-status",
        params: {},
      });
      send(socket, {
        id: "b",
        kind: "request",
        command: "sync:get-job",
        params: { jobId: "none" },
      });
      const out = await collectResponses(socket, ["a", "b"]);
      expect(out.size).toBe(2);
      // b completed first (its handler returns synchronously-ish).
      expect(order).toEqual(["b-finish", "a-finish"]);
    } finally {
      socket.destroy();
    }
  });

  it("server.broadcast sends an event to every connected client", async () => {
    const pipePath = pipeFor("bc");
    running = await startServer({
      pipePath,
      handlers: {},
      commandNames: COMMAND_NAMES,
    });
    const a = await connect(pipePath);
    const b = await connect(pipePath);
    try {
      const seenA: string[] = [];
      const seenB: string[] = [];
      const dec = (bucket: string[]) =>
        new FramingDecoder({
          onFrame: (f) => {
            const fr = f as { kind: string; name?: string };
            if (fr.kind === "event" && fr.name) bucket.push(fr.name);
          },
          onError: () => void 0,
        });
      const da = dec(seenA);
      const db = dec(seenB);
      a.on("data", (c) => da.push(c));
      b.on("data", (c) => db.push(c));

      // Tiny delay so both sockets are registered server-side.
      await new Promise((r) => setTimeout(r, 50));
      running.broadcast({ name: "job-started", payload: { jobId: "j-1" } });
      await new Promise((r) => setTimeout(r, 50));
      expect(seenA).toContain("job-started");
      expect(seenB).toContain("job-started");
    } finally {
      a.destroy();
      b.destroy();
    }
  });
});
