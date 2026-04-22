// Supervisor dev-mode tests.
//
// Tasks.md 4.6 / 4.7: in dev mode the supervisor MUST NOT spawn the
// service. The dev loop relies on `pnpm -r --parallel` to have already
// started the service (see
// `openspec/changes/wire-fs-sync-service/design.md:136-144`, Decision 6).
// If the initial `net.connect(pipePath)` fails, the supervisor rejects
// with a user-visible error naming `pnpm dev`. Spawn paths (if even
// supplied) are ignored in dev.
//
// Cross-platform pipe-path pattern mirrors `supervisor.prod-spawn.test.ts`.
//
// `child_process.spawn` is **fully stubbed** here so a programmer
// mistake that wires the spawn branch into dev mode would be caught by
// these tests instead of forking a real Node process.

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncClient } from "./client.js";
import { startSupervisor } from "./supervisor.js";

interface FakeChild {
  pid: number;
  unref: ReturnType<typeof vi.fn>;
  killed: boolean;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
}

const hoisted = vi.hoisted(() => {
  const spawnedChildren: {
    pid: number;
    unref: ReturnType<typeof vi.fn>;
    killed: boolean;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
  }[] = [];
  const spawnMock = vi.fn(() => {
    const child = {
      pid: 54321 + spawnedChildren.length,
      unref: vi.fn(),
      killed: false,
      on: vi.fn(),
      once: vi.fn(),
    };
    spawnedChildren.push(child);
    return child;
  });
  return { spawnMock, spawnedChildren };
});
const { spawnMock, spawnedChildren } = hoisted as {
  spawnMock: ReturnType<typeof vi.fn>;
  spawnedChildren: FakeChild[];
};

vi.mock("node:child_process", () => ({
  spawn: hoisted.spawnMock,
}));

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-supervisor-dev-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-supervisor-dev-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

async function startFakeService(pipePath: string): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.on("error", () => void 0);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}

let servers: net.Server[] = [];
let clients: SyncClient[] = [];

beforeEach(() => {
  servers = [];
  clients = [];
  spawnedChildren.length = 0;
  spawnMock.mockClear();
});

afterEach(async () => {
  for (const c of clients) {
    (c as unknown as { socket: net.Socket }).socket.destroy();
  }
  clients = [];
  for (const s of servers) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  servers = [];
  vi.restoreAllMocks();
});

describe("startSupervisor in dev mode does not spawn the service", () => {
  it("in dev mode, rejects without spawning when the pipe is unreachable", async () => {
    const pipePath = pipeFor("dev-unreachable");

    // Deliberately pass spawn paths too — they must be ignored in dev.
    const nodeBinary =
      process.platform === "win32"
        ? "C:\\fake\\node.exe"
        : "/fake/path/to/node";
    const servicePath = "/fake/path/to/service.js";

    await expect(
      startSupervisor({
        mode: "dev",
        pipePath,
        nodeBinary,
        servicePath,
      }),
    ).rejects.toThrow(/pnpm dev/);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnedChildren).toHaveLength(0);
  });

  it("in dev mode, connects normally when the service is running", async () => {
    const pipePath = pipeFor("dev-happy");
    const server = await startFakeService(pipePath);
    servers.push(server);

    const client = await startSupervisor({ mode: "dev", pipePath });
    clients.push(client);

    expect(client).toBeInstanceOf(SyncClient);
    expect(client.isConnected).toBe(true);
    // Dev mode must never spawn, even on the happy path.
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
