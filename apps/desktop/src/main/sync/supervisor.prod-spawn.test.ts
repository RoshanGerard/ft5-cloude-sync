// Supervisor prod-spawn tests.
//
// Tasks.md 4.4: when the initial `net.connect(pipePath)` fails (no service
// listening), the supervisor spawns the service as a detached child via
// `child_process.spawn(nodeBinary, [servicePath], { detached: true,
// stdio: 'ignore' })`, calls `unref()` on the returned handle, and then
// polls `net.connect(pipePath)` with a geometric backoff schedule
// (25/50/100/200/400 ms) for up to 5 attempts. On success it resolves
// with a `SyncClient`; on all-retries-fail it rejects with a fatal
// error naming the pipe path.
//
// Cross-platform pipe-path pattern mirrors `supervisor.prod-connect.test.ts`.
//
// `child_process.spawn` is **fully stubbed** here — unlike the
// prod-connect test (which passes-through to the real spawn since no
// calls are expected), this test would fork real Node processes on
// every run if we let `spawn` through. The stub returns a fake
// ChildProcess carrying just the surface the supervisor touches
// (`pid`, `unref`, `killed`).

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

// `vi.mock` factories are hoisted above local `const` declarations, so
// sharing state between factory and tests requires `vi.hoisted`. See
// https://vitest.dev/api/vi.html#vi-hoisted.
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
      pid: 12345 + spawnedChildren.length,
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

// Full replacement of `node:child_process` — no `importOriginal` passthrough.
// The supervisor under test touches only `spawn`. If it starts using other
// members, widen this stub.
vi.mock("node:child_process", () => ({
  spawn: hoisted.spawnMock,
}));

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-supervisor-spawn-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-supervisor-spawn-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
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

describe("startSupervisor in prod mode spawns the service when no listener is present", () => {
  it("spawns once with detached+stdio:'ignore', unrefs, and resolves once a retry connects", async () => {
    const pipePath = pipeFor("spawn-then-connect");
    const nodeBinary =
      process.platform === "win32"
        ? "C:\\fake\\node.exe"
        : "/fake/path/to/node";
    const servicePath = "/fake/path/to/service.js";

    // Simulate the spawned service coming online partway through the
    // retry schedule. 120 ms is after attempts 1 (t=25) + 2 (t=75) would
    // fail, before attempt 3 (t=175) fires — i.e. we exercise the loop.
    setTimeout(() => {
      void startFakeService(pipePath).then((s) => servers.push(s));
    }, 120);

    const client = await startSupervisor({
      mode: "prod",
      pipePath,
      nodeBinary,
      servicePath,
    });
    clients.push(client);

    expect(client).toBeInstanceOf(SyncClient);
    expect(client.isConnected).toBe(true);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [calledCommand, calledArgs, calledOptions] = spawnMock.mock.calls[0]!;
    expect(calledCommand).toBe(nodeBinary);
    expect(calledArgs).toEqual([servicePath]);
    expect(calledOptions).toEqual(
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );

    expect(spawnedChildren).toHaveLength(1);
    expect(spawnedChildren[0]!.unref).toHaveBeenCalledTimes(1);
    // Supervisor must not have killed the child; detach + unref severs
    // the handle and the service outlives the app by design.
    expect(spawnedChildren[0]!.killed).toBe(false);
  });

  it("rejects with a fatal error after 5 failed retries when the service never comes online", async () => {
    const pipePath = pipeFor("spawn-exhaust");
    const nodeBinary =
      process.platform === "win32"
        ? "C:\\fake\\node.exe"
        : "/fake/path/to/node";
    const servicePath = "/fake/path/to/service.js";

    const started = Date.now();
    await expect(
      startSupervisor({
        mode: "prod",
        pipePath,
        nodeBinary,
        servicePath,
      }),
    ).rejects.toThrow(new RegExp(pipePath.replace(/\\/g, "\\\\")));
    const elapsed = Date.now() - started;

    // Geometric schedule 25+50+100+200+400 = 775 ms of intentional waits.
    // Add connect-attempt overhead per round; the aggregate floor is
    // well under a second in a happy CI. Allow slack upward for scheduler
    // jitter but assert a lower bound so a broken schedule (e.g. all-at-once
    // retries) fails loudly.
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThanOrEqual(3000);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnedChildren).toHaveLength(1);
    expect(spawnedChildren[0]!.unref).toHaveBeenCalledTimes(1);
    expect(spawnedChildren[0]!.killed).toBe(false);
  });

  it("rejects with a clear error when the initial connect fails and no nodeBinary/servicePath were provided", async () => {
    const pipePath = pipeFor("spawn-opt-out");

    await expect(
      startSupervisor({ mode: "prod", pipePath }),
    ).rejects.toThrow(/nodeBinary|servicePath/);

    expect(spawnMock).not.toHaveBeenCalled();
  });
});
