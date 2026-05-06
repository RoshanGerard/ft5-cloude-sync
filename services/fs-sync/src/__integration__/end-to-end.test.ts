// End-to-end integration: spins the full service stack (DB + migrations +
// event bus + command handlers + scheduler + executors + IPC server), then
// drives it through an in-process IPC client. Covers the six scenarios
// enumerated in phase 21 of tasks.md as a single suite so the wiring
// itself is the thing being verified; per-module behaviour is covered by
// the phase-specific unit test files.

import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCommandHandlers } from "../commands/handlers.js";
import { applyMigrations } from "../db/migrations.js";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import {
  COMMAND_NAMES,
  type RequestFrame,
  type ResponseFrame,
} from "@ft5/ipc-contracts/sync-service";
import { buildUploadExecutor } from "../executors/upload.js";
import { buildMirrorSyncExecutor } from "../executors/mirror-sync.js";
import { FramingDecoder } from "../ipc/framing.js";
import { startServer, type RunningServer } from "../ipc/server.js";
import { createSubscriptionRegistry } from "../ipc/subscriptions.js";
import { JobRepository } from "../jobs/repository.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { recoverRunningJobs } from "../startup/recovery.js";

let cleanup: string[] = [];
let db: Database.Database;
let bus: EventBus;
let server: RunningServer | null = null;
let scheduler: Scheduler | null = null;

function pipeFor(tag: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-int-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return path.join(
    os.tmpdir(),
    `ft5-sync-int-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

function scratchDb(): string {
  const f = path.join(
    os.tmpdir(),
    `ft5-sync-int-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  cleanup.push(f);
  return f;
}

beforeEach(() => {
  const file = scratchDb();
  db = new Database(file);
  applyMigrations(db);
  bus = createEventBus();
  server = null;
  scheduler = null;
});

afterEach(async () => {
  try {
    if (scheduler) await scheduler.stop();
    if (server) await server.close();
  } finally {
    try {
      db.close();
    } catch {
      /* tolerated */
    }
    for (const f of cleanup) {
      try {
        await fsp.rm(f, { recursive: true, force: true });
      } catch {
        /* tolerated */
      }
    }
    cleanup = [];
  }
});

function fakeClient() {
  return {
    type: "amazon-s3",
    datasourceId: "ds-1",
    uploadFile: vi.fn(async (parent: unknown) => ({
      id: `remote-${Math.random().toString(36).slice(2)}`,
      name: "x",
      path: (parent as { path: string }).path,
      size: 0,
      kind: "file" as const,
    })),
    deleteFile: vi.fn(async () => void 0),
  };
}

async function wireService(opts: {
  fakeResolveClient?: () => Promise<unknown>;
  allowParallel?: boolean;
}): Promise<{ pipePath: string }> {
  const pipePath = pipeFor("svc");
  const resolveClient = opts.fakeResolveClient ?? (async () => fakeClient());

  const uploadExec = buildUploadExecutor({
    factory: {} as never,
    resolveClient: resolveClient as never,
  });
  const mirrorExec = buildMirrorSyncExecutor({
    db,
    resolveClient: resolveClient as never,
    hashFile: async () => "fake-hash",
  });
  scheduler = new Scheduler(db, {
    executors: { upload: uploadExec, sync: mirrorExec },
    bus,
    pollIntervalMs: 20,
    allowParallel: opts.allowParallel ?? true,
  });
  scheduler.start();

  const registry = createSubscriptionRegistry();
  registry.attachBus(bus);

  const baseHandlers = buildCommandHandlers({
    db,
    bus,
    serviceVersion: "test",
    serviceUuid: "svc-uuid",
  });
  // Wire the sync:subscribe-events / unsubscribe to the registry.
  const handlers = {
    ...baseHandlers,
    "sync:subscribe-events": async (
      _params: unknown,
      ctx: { connection: { id: number; closed: boolean; sendEvent: (e: { name: string; payload: unknown }) => void } },
    ) => {
      registry.subscribe(ctx.connection);
      return { ok: true as const, result: { subscribed: true as const } };
    },
    "sync:unsubscribe-events": async (
      _params: unknown,
      ctx: { connection: { id: number; closed: boolean; sendEvent: (e: { name: string; payload: unknown }) => void } },
    ) => {
      registry.unsubscribe(ctx.connection);
      return { ok: true as const, result: { unsubscribed: true as const } };
    },
  };

  server = await startServer({
    pipePath,
    handlers: handlers as never,
    commandNames: COMMAND_NAMES,
  });
  return { pipePath };
}

async function connect(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(path);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

interface RoundTrip {
  readonly socket: net.Socket;
  send(frame: RequestFrame): void;
  waitFor(id: string, timeoutMs?: number): Promise<ResponseFrame>;
  events(names: ReadonlyArray<string>, timeoutMs?: number): Promise<ReadonlyArray<{ name: string; payload: unknown }>>;
  close(): void;
}

function client(socket: net.Socket): RoundTrip {
  const responses = new Map<string, ResponseFrame>();
  const eventLog: Array<{ name: string; payload: unknown }> = [];
  const decoder = new FramingDecoder({
    onFrame: (f) => {
      const frame = f as { kind: string };
      if (frame.kind === "response") {
        const r = f as ResponseFrame;
        responses.set(r.id, r);
      } else if (frame.kind === "event") {
        eventLog.push(f as { name: string; payload: unknown });
      }
    },
    onError: () => void 0,
  });
  socket.on("data", (c) => decoder.push(c));

  return {
    socket,
    send(frame) {
      socket.write(`${JSON.stringify(frame)}\n`);
    },
    async waitFor(id, timeoutMs = 5000) {
      const t0 = Date.now();
      while (!responses.has(id)) {
        if (Date.now() - t0 > timeoutMs) {
          throw new Error(`timeout waiting for response id=${id}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return responses.get(id)!;
    },
    async events(names, timeoutMs = 3000) {
      const t0 = Date.now();
      while (true) {
        const seen = eventLog.filter((e) => names.includes(e.name));
        if (seen.length >= names.length) return seen;
        if (Date.now() - t0 > timeoutMs) {
          return seen; // return partial
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close() {
      socket.destroy();
    },
  };
}

// migrate-upload-orchestration-out-of-engine §11 — the previous
// `end-to-end: upload` describe block exercised the legacy
// `sync:enqueue-upload` → scheduler → `UploadJobExecutor` → job-completed
// pipeline. That pipeline was deleted in chunk F: single-file uploads
// now flow through the `files:upload` direct-RPC handler, bypassing the
// scheduler entirely. End-to-end coverage for the new path lives in
// `services/fs-sync/src/commands/__tests__/files-upload.test.ts`
// (handler-level, with a fake `DatasourceClient`) and the desktop-side
// `apps/desktop/src/main/ipc/files/__tests__/upload.test.ts` (RPC-bridge
// level). No scheduler integration test is needed for the new path
// because the scheduler is no longer in the upload critical path.

describe("end-to-end: dedup", () => {
  it("concurrent enqueue-mirror for same (datasourceId, sourcePath) rejects second", async () => {
    const { pipePath } = await wireService({});
    const sock = await connect(pipePath);
    const cli = client(sock);
    try {
      cli.send({
        id: "a",
        kind: "request",
        command: "sync:enqueue-mirror",
        params: {
          datasourceId: "ds-1",
          sourcePath: "/tmp/pics",
        },
      });
      cli.send({
        id: "b",
        kind: "request",
        command: "sync:enqueue-mirror",
        params: {
          datasourceId: "ds-1",
          sourcePath: "/tmp/pics",
        },
      });

      const [ra, rb] = await Promise.all([cli.waitFor("a"), cli.waitFor("b")]);

      // Exactly one succeeds.
      const successes = [ra, rb].filter((r) => r.ok);
      const failures = [ra, rb].filter((r) => !r.ok);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      if (!failures[0]?.ok) {
        expect(failures[0]?.error.tag).toBe("sync-already-running");
      }
    } finally {
      cli.close();
    }
  });
});

describe("end-to-end: source-unavailable", () => {
  it("mirror against a nonexistent path fails with zero remote calls", async () => {
    const fc = fakeClient();
    const { pipePath } = await wireService({
      fakeResolveClient: async () => fc,
    });
    const sock = await connect(pipePath);
    const cli = client(sock);
    try {
      cli.send({
        id: "enq",
        kind: "request",
        command: "sync:enqueue-mirror",
        params: {
          datasourceId: "ds-1",
          sourcePath: "/does/not/exist/on/this/machine",
        },
      });
      cli.send({
        id: "sub",
        kind: "request",
        command: "sync:subscribe-events",
        params: {},
      });
      const enq = await cli.waitFor("enq");
      if (!enq.ok) throw new Error("enqueue-mirror failed unexpectedly");
      await cli.waitFor("sub");

      // Wait for job-failed to land.
      const events = await cli.events(["source-unavailable"], 4000);
      const names = events.map((e) => e.name);
      expect(names).toContain("source-unavailable");
      expect(fc.uploadFile).not.toHaveBeenCalled();
      expect(fc.deleteFile).not.toHaveBeenCalled();
    } finally {
      cli.close();
    }
  });
});

describe("end-to-end: crash recovery", () => {
  it("recoverRunningJobs re-queues status='running' rows with attempt++ and lastErrorTag='service-restart'", () => {
    // Simulate crash: put a row into 'running' directly via the repo (no
    // scheduler running), then run the recovery pass as startup would.
    const repo = new JobRepository(db);
    repo.insert({
      id: "crashed",
      kind: "upload",
      datasourceId: "ds",
      sourcePath: "/x",
      targetPath: "/y",
      conflictPolicy: "overwrite",
    });
    repo.transition("crashed", "running", { incrementAttempt: true });

    const recovered = recoverRunningJobs(db);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ jobId: "crashed" });

    const after = repo.getById("crashed");
    expect(after).toMatchObject({
      status: "queued",
      attempt: 2,
      lastErrorTag: "service-restart",
    });
  });
});
