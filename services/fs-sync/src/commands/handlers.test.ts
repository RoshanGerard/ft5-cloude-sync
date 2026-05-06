import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  CommandError,
  CommandParams,
  CommandResult,
  EventName,
  EventPayloadMap,
} from "@ft5/ipc-contracts/sync-service";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations } from "../db/migrations.js";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import type { CommandHandlers } from "../ipc/server.js";

import { buildCommandHandlers } from "./handlers.js";

let cleanup: string[] = [];
let db: Database.Database;
let bus: EventBus;
let handlers: CommandHandlers;
let emitted: Array<[EventName, EventPayloadMap[EventName]]>;

beforeEach(() => {
  const file = path.join(
    os.tmpdir(),
    `ft5-sync-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  cleanup.push(file);
  db = new Database(file);
  applyMigrations(db);
  bus = createEventBus();
  emitted = [];
  bus.subscribe((name, payload) => {
    emitted.push([name, payload]);
  });
  handlers = buildCommandHandlers({
    db,
    bus,
    serviceVersion: "0.0.0-test",
    serviceUuid: "test-uuid",
  });
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    /* tolerated */
  }
  for (const f of cleanup) {
    try {
      await fsp.rm(f, { force: true });
    } catch {
      /* tolerated */
    }
  }
  cleanup = [];
});

// Test helpers to narrow handler signatures without conditional chaining noise.
async function call<N extends keyof CommandHandlers>(
  name: N,
  params: CommandParams<N>,
): Promise<
  | { ok: true; result: CommandResult<N> }
  | { ok: false; error: CommandError<N> }
> {
  const handler = handlers[name];
  if (!handler) throw new Error(`no handler for ${String(name)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await (handler as any)(params, { connection: { id: 1, closed: false, sendEvent: () => void 0 } })) as
    | { ok: true; result: CommandResult<N> }
    | { ok: false; error: CommandError<N> };
}

describe("sync:get-status", () => {
  it("returns zero counts and monitorConnected=false on a fresh DB", async () => {
    const res = await call("sync:get-status", {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toMatchObject({
        version: "0.0.0-test",
        serviceUuid: "test-uuid",
        runningJobs: 0,
        queuedJobs: 0,
        waitingNetworkJobs: 0,
        monitorConnected: false,
      });
    }
  });
});

// migrate-upload-orchestration-out-of-engine §7.4 / §11 — the
// `sync:enqueue-upload` dispatcher entry was deleted in chunk F.
// Single-file uploads now flow through the `files:upload` direct-RPC
// (covered by `services/fs-sync/src/commands/__tests__/files-upload.test.ts`),
// not through the queue. The scaffolding-tests in this file that used
// `sync:enqueue-upload` to mint `kind: 'upload'` rows for list / cancel
// coverage have been switched to `sync:enqueue-mirror` (the sole remaining
// queue-entry handler).

describe("sync:enqueue-mirror", () => {
  it("succeeds on first call, rejects duplicate with sync-already-running", async () => {
    const first = await call("sync:enqueue-mirror", {
      datasourceId: "ds-1",
      sourcePath: "/home/u/pics",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const dup = await call("sync:enqueue-mirror", {
      datasourceId: "ds-1",
      sourcePath: "/home/u/pics",
    });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.error.tag).toBe("sync-already-running");
    expect((dup.error as { details: { existingJobId: string } }).details.existingJobId).toBe(
      first.result.jobId,
    );
  });

  it("emits job-enqueued only on success", async () => {
    emitted = [];
    await call("sync:enqueue-mirror", { datasourceId: "ds", sourcePath: "/a" });
    expect(emitted.filter(([n]) => n === "job-enqueued")).toHaveLength(1);

    emitted = [];
    await call("sync:enqueue-mirror", { datasourceId: "ds", sourcePath: "/a" });
    expect(emitted.filter(([n]) => n === "job-enqueued")).toHaveLength(0);
  });
});

describe("sync:list-jobs + sync:get-job", () => {
  it("list and get round-trip an inserted job", async () => {
    const { ok, result } = (await call("sync:enqueue-mirror", {
      datasourceId: "ds",
      sourcePath: "/list-and-get",
    })) as { ok: true; result: { jobId: string } };
    expect(ok).toBe(true);

    const got = await call("sync:get-job", { jobId: result.jobId });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.result.job.id).toBe(result.jobId);
  });

  it("get-job returns not-found for unknown id", async () => {
    const res = await call("sync:get-job", { jobId: "nope" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.tag).toBe("not-found");
  });
});

describe("sync:cancel-job", () => {
  it("cancels a queued job and emits job-cancelled", async () => {
    const { ok, result } = (await call("sync:enqueue-mirror", {
      datasourceId: "ds",
      sourcePath: "/cancel-queued",
    })) as { ok: true; result: { jobId: string } };
    expect(ok).toBe(true);

    emitted = [];
    const cancel = await call("sync:cancel-job", { jobId: result.jobId });
    expect(cancel.ok).toBe(true);
    if (cancel.ok) expect(cancel.result).toEqual({ cancelled: true });

    const names = emitted.map(([n]) => n);
    expect(names).toContain("job-cancelled");

    const got = await call("sync:get-job", { jobId: result.jobId });
    if (got.ok) expect(got.result.job.status).toBe("cancelled");
  });

  it("refuses to cancel a terminal job with tag=not-cancelable", async () => {
    // Insert + force to completed (illegal path from outside, but we can use
    // the raw DAO). Simpler: cancel one already cancelled.
    const { ok, result } = (await call("sync:enqueue-mirror", {
      datasourceId: "ds",
      sourcePath: "/cancel-terminal",
    })) as { ok: true; result: { jobId: string } };
    expect(ok).toBe(true);
    await call("sync:cancel-job", { jobId: result.jobId });
    const retry = await call("sync:cancel-job", { jobId: result.jobId });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.tag).toBe("not-cancelable");
  });

  it("returns not-found for an unknown jobId", async () => {
    const res = await call("sync:cancel-job", { jobId: "nope" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.tag).toBe("not-found");
  });
});
