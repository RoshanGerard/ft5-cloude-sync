// Supervisor race-tolerance test.
//
// Tasks.md 4.8 / 4.9. Two desktop supervisors start in parallel against
// the same non-listening pipe. Neither finds a service, both fall through
// to the spawn branch, both invoke the (stubbed) `child_process.spawn`.
// In the real system, the service's PID guard would make one of the two
// actually-spawned services exit with code 3 (see
// `services/fs-sync/src/main/index.ts` — AlreadyRunningError → exit 3);
// the winner binds the listener; the loser dies without ever listening.
//
// The invariant this test locks:
//   **Both supervisor promises resolve with connected clients pointing
//   at the winning server** — in particular, the supervisor whose
//   spawned child loses the PID race MUST NOT reject because its child
//   exited with code 3. The retry-connect loop is driven entirely by
//   `net.connect` success/failure against the pipe path and is
//   intentionally indifferent to the spawned child's lifecycle (see
//   `openspec/changes/wire-fs-sync-service/design.md:79` — "does not
//   maintain a reference to the spawned process").
//
// Mechanic of the simulation. `node:child_process` is fully stubbed;
// the fake children are `EventEmitter`s carrying just the surface the
// supervisor touches (`pid`, `unref`, `killed`, plus `on`/`once` from
// the EventEmitter). After both supervisors have spawned, the test
// brings up a real `net.createServer` on the pipe path (simulating
// the PID-winner binding its listener) and concurrently emits `'exit'`
// code 3 on one fake child (simulating the PID-loser dying). If the
// supervisor naively tracked the spawned child and reacted to its exit,
// the loser's promise would reject; the connect-driven design means it
// does not.
//
// Cross-platform pipe-path pattern mirrors `supervisor.prod-spawn.test.ts`.

import { EventEmitter } from "node:events";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncClient } from "./client.js";
import { startSupervisor } from "./supervisor.js";

interface FakeChild extends EventEmitter {
  pid: number;
  unref: ReturnType<typeof vi.fn>;
  killed: boolean;
}

const hoisted = vi.hoisted(() => {
  // Runtime `require` — EventEmitter is used inside the hoisted factory
  // where top-of-file ESM imports from the test file are NOT visible at
  // factory execution time. `vi.hoisted` runs before imports resolve.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");

  const spawnedChildren: (InstanceType<typeof EE> & {
    pid: number;
    unref: ReturnType<typeof vi.fn>;
    killed: boolean;
  })[] = [];

  const spawnMock = vi.fn(() => {
    const child = new EE() as InstanceType<typeof EE> & {
      pid: number;
      unref: ReturnType<typeof vi.fn>;
      killed: boolean;
    };
    child.pid = 67890 + spawnedChildren.length;
    child.unref = vi.fn();
    child.killed = false;
    spawnedChildren.push(child);
    return child;
  });

  return { spawnMock, spawnedChildren };
});

const { spawnMock, spawnedChildren } = hoisted as unknown as {
  spawnMock: ReturnType<typeof vi.fn>;
  spawnedChildren: FakeChild[];
};

// Full replacement — mirrors supervisor.prod-spawn.test.ts. No passthrough.
vi.mock("node:child_process", () => ({
  spawn: hoisted.spawnMock,
}));

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-supervisor-race-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-supervisor-race-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
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

describe("startSupervisor race-tolerance at startup", () => {
  it(
    "two parallel supervisors both resolve when one spawned child loses the PID race and exits code 3",
    async () => {
      const pipePath = pipeFor("parallel-spawn");
      const nodeBinary =
        process.platform === "win32"
          ? "C:\\fake\\node.exe"
          : "/fake/path/to/node";
      const servicePath = "/fake/path/to/service.js";

      // Simulate the PID-winner binding its listener partway through
      // the retry schedule (25/50/100/200/400 ms cumulative 25/75/175/
      // 375/775). At t=80 ms both supervisors are mid-retry. Also
      // emit `'exit'` code 3 on the second spawned fake child — the
      // PID-loser dying. The supervisor's retry loop must NOT react
      // to the child exit; it must keep polling the pipe and succeed.
      setTimeout(() => {
        void startFakeService(pipePath).then((s) => servers.push(s));
        // Trigger exit on the loser. Use a nextTick so the server-bind
        // has strictly started before the exit emission, mirroring the
        // real PID-guard sequence (winner begins binding, loser hits
        // the guard and exits).
        queueMicrotask(() => {
          const loser = spawnedChildren[1];
          if (loser) loser.emit("exit", 3, null);
        });
      }, 80);

      const [clientA, clientB] = await Promise.all([
        startSupervisor({
          mode: "prod",
          pipePath,
          nodeBinary,
          servicePath,
        }),
        startSupervisor({
          mode: "prod",
          pipePath,
          nodeBinary,
          servicePath,
        }),
      ]);
      clients.push(clientA, clientB);

      // Both supervisors resolved with working clients pointing at the
      // (single) winning listener. This is the core race invariant.
      expect(clientA).toBeInstanceOf(SyncClient);
      expect(clientB).toBeInstanceOf(SyncClient);
      expect(clientA.isConnected).toBe(true);
      expect(clientB.isConnected).toBe(true);

      // Both supervisors independently hit the spawn branch — the test
      // wouldn't be exercising the race mechanic otherwise.
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(spawnedChildren).toHaveLength(2);

      // Exactly one real server came up (the PID-winner). The loser's
      // spawn stub never bound anything because we only call
      // `startFakeService` once above.
      expect(servers).toHaveLength(1);

      // The loser's fake-child exit fired without the supervisor
      // treating it as fatal — confirmed transitively by the resolved
      // Promise.all above, but make the child state assertion explicit
      // to lock the "supervisor never killed/tracked its child" invariant.
      expect(spawnedChildren[0]!.killed).toBe(false);
      expect(spawnedChildren[1]!.killed).toBe(false);
      expect(spawnedChildren[0]!.unref).toHaveBeenCalledTimes(1);
      expect(spawnedChildren[1]!.unref).toHaveBeenCalledTimes(1);
    },
    5000,
  );
});
