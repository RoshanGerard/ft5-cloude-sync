// IPC bind-failure path. When stages 1-10 of bootstrap succeed but stage 11
// (`ipcServer.listen`) fails to bind the socket / pipe, the service must:
//   1. surface the failure as a dedicated `IpcBindError` so `index.ts` can
//      map it to the spec's exit code 5 (distinct from `AlreadyRunningError`
//      → 3 and `DatabaseIntegrityError` → 4);
//   2. release the PID guard acquired in stage 4 so a subsequent retry isn't
//      blocked by a stale PID file;
//   3. emit an observable "ipc-bind-failed" log line so operators can diagnose
//      the root cause from the service log alone.
//
// Spec: tasks.md 2.5 / 2.6 (wire-fs-sync-service).
//
// How the bind failure is forced:
//   - Unix: point `socketPath` at a file inside a directory that doesn't
//     exist. `net.createServer().listen(path)` then emits ENOENT and the
//     `server.once("error", reject)` hook in `ipc/server.ts#startServer`
//     rejects.
//   - Windows: pre-bind a named pipe in the test, then pass the same pipe
//     path to bootstrap. The OS returns EADDRINUSE on the second listen.

import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrap } from "./bootstrap.js";

let scratchDir: string;
let blocker: net.Server | null = null;
let badSocketPath = "";

function uniquePipeTag(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function preBindWindowsPipe(pipePath: string): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

beforeEach(async () => {
  scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ft5-sync-ipcbind-"));
  if (process.platform === "win32") {
    // Reserve a named pipe that bootstrap will collide with on listen().
    badSocketPath = `\\\\.\\pipe\\ft5-sync-bind-fail-${uniquePipeTag()}`;
    blocker = await preBindWindowsPipe(badSocketPath);
  } else {
    // Point at a path inside a directory we deliberately never create.
    badSocketPath = path.join(scratchDir, "no-such-subdir", "sync.sock");
    blocker = null;
  }
});

afterEach(async () => {
  try {
    if (blocker) {
      await new Promise<void>((resolve) => blocker!.close(() => resolve()));
    }
  } finally {
    blocker = null;
    try {
      await fsp.rm(scratchDir, { recursive: true, force: true });
    } catch {
      /* tolerated */
    }
  }
});

describe("bootstrap ipc-bind-failure", () => {
  it("rejects with IpcBindError, releases the PID guard, and logs 'ipc-bind-failed'", async () => {
    const pidPath = path.join(scratchDir, "service-dev.pid");
    const logger = {
      info: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>(),
      error: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>(),
    };

    // Acceptance: bootstrap rejects. We assert on the thrown error's .name
    // rather than importing the class so the RED failure is a clean
    // "expected IpcBindError, received Error" diff (no import-time TypeError
    // if the class doesn't exist yet).
    await expect(
      bootstrap({
        dev: true,
        dataDir: scratchDir,
        pidPath,
        dbPath: path.join(scratchDir, "sync.db"),
        socketPath: badSocketPath,
        credentialsPath: path.join(scratchDir, "credentials.json"),
        logger,
      }),
    ).rejects.toMatchObject({ name: "IpcBindError" });

    // Stage 4 (acquire-pid-guard) must succeed, and the subsequent stage-11
    // failure must release it. A leftover PID file would block the next
    // restart with a spurious AlreadyRunningError.
    expect(
      await fsp
        .stat(pidPath)
        .then(() => true)
        .catch(() => false),
      `PID file at ${pidPath} should be cleaned up after ipc-bind failure`,
    ).toBe(false);

    // Observability: an "ipc-bind-failed" log line fires via the injected
    // logger. We assert on the exact message string — it's the contract the
    // operator runbook will grep for.
    expect(logger.error).toHaveBeenCalledWith(
      "ipc-bind-failed",
      expect.objectContaining({ socketPath: badSocketPath }),
    );
  });
});
