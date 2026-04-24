// event-bridge — datasource error healing on job-completed.
//
// Motivation: the SQLite `datasources.error_reason` column is never reset
// in production (the pre-wire-fs-sync-service code that used to write it
// was removed in section 9, but stale rows persist and no current path
// clears them on success). Smoke of 10.9 found Google Drive and S3 cards
// showing old "auth-revoked: ..." text after successful uploads.
//
// Contract: when the bridge observes a `job-completed` event for a job
// whose `datasourceId` was captured on the earlier `job-enqueued` event
// (or from the state-seed), it MUST call
// `registry.setStatus(datasourceId, "connected")` to clear any error
// state. `job-failed` and `job-cancelled` must NOT clear — those may
// represent genuine error conditions.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventFrame } from "@ft5/ipc-contracts/sync-service";

import type { SyncClient } from "./client.js";
import {
  createSyncEventBridge,
  __resetSyncEventBridgeForTesting,
} from "./event-bridge.js";
import type { SupervisorHandle } from "./supervisor.js";

interface Harness {
  eventListeners: Array<(frame: EventFrame) => void>;
  setStatus: ReturnType<typeof vi.fn>;
  handle: SupervisorHandle;
}

function makeHarness(): Harness {
  const eventListeners: Array<(frame: EventFrame) => void> = [];

  const fakeClient = {
    onEvent: (cb: (frame: EventFrame) => void) => {
      eventListeners.push(cb);
      return () => {
        const i = eventListeners.indexOf(cb);
        if (i >= 0) eventListeners.splice(i, 1);
      };
    },
    request: vi.fn(async (method: string) => {
      if (method === "sync:subscribe-events") return {};
      if (method === "sync:list-jobs") return { jobs: [] };
      return {};
    }),
  } as unknown as SyncClient;

  const handle = {
    getClient: () => fakeClient,
    on: () => () => {
      /* no listeners installed in this test */
    },
    dispose: () => {
      /* no-op */
    },
  } as unknown as SupervisorHandle;

  return { eventListeners, setStatus: vi.fn(), handle };
}

function deliver(listeners: Array<(frame: EventFrame) => void>, frame: EventFrame): void {
  for (const cb of listeners) cb(frame);
}

describe("event-bridge — datasource error healing", () => {
  afterEach(() => __resetSyncEventBridgeForTesting());

  it("clears datasource error state when job-completed arrives", async () => {
    const h = makeHarness();
    createSyncEventBridge(h.handle, { registry: { setStatus: h.setStatus } });
    // Let the initial handshake microtask drain.
    await new Promise((r) => setTimeout(r, 0));

    const jobId = "job-1";
    const datasourceId = "ds-google-drive-1776807928068-1";

    deliver(h.eventListeners, {
      kind: "event",
      name: "job-enqueued",
      payload: {
        jobId,
        kind: "upload",
        datasourceId,
        sourcePath: "/src",
        targetPath: "/tgt",
        conflictPolicy: "overwrite",
        enqueuedAt: Date.now(),
      },
    });
    deliver(h.eventListeners, {
      kind: "event",
      name: "job-completed",
      payload: { jobId, completedAt: Date.now() },
    });

    expect(h.setStatus).toHaveBeenCalledTimes(1);
    expect(h.setStatus).toHaveBeenCalledWith(datasourceId, "connected");
  });

  it("does NOT clear on job-failed (preserves legitimate error state)", async () => {
    const h = makeHarness();
    createSyncEventBridge(h.handle, { registry: { setStatus: h.setStatus } });
    await new Promise((r) => setTimeout(r, 0));

    const jobId = "job-2";
    const datasourceId = "ds-google-drive-1776807928068-1";

    deliver(h.eventListeners, {
      kind: "event",
      name: "job-enqueued",
      payload: {
        jobId,
        kind: "upload",
        datasourceId,
        sourcePath: "/src",
        targetPath: "/tgt",
        conflictPolicy: "overwrite",
        enqueuedAt: Date.now(),
      },
    });
    deliver(h.eventListeners, {
      kind: "event",
      name: "job-failed",
      payload: {
        jobId,
        failedAt: Date.now(),
        attempt: 1,
        errorTag: "provider-error",
        errorMessage: "boom",
      },
    });

    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it("does NOT clear on job-cancelled", async () => {
    const h = makeHarness();
    createSyncEventBridge(h.handle, { registry: { setStatus: h.setStatus } });
    await new Promise((r) => setTimeout(r, 0));

    const jobId = "job-3";
    const datasourceId = "ds-google-drive-1776807928068-1";

    deliver(h.eventListeners, {
      kind: "event",
      name: "job-enqueued",
      payload: {
        jobId,
        kind: "upload",
        datasourceId,
        sourcePath: "/src",
        targetPath: "/tgt",
        conflictPolicy: "overwrite",
        enqueuedAt: Date.now(),
      },
    });
    deliver(h.eventListeners, {
      kind: "event",
      name: "job-cancelled",
      payload: { jobId, cancelledAt: Date.now() },
    });

    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it("no-ops when job-completed arrives for an unknown jobId", async () => {
    // Defensive: a job-completed for a jobId we never saw a job-enqueued
    // for (e.g. out-of-order delivery before state-seed arrived) should
    // silently skip rather than throw.
    const h = makeHarness();
    createSyncEventBridge(h.handle, { registry: { setStatus: h.setStatus } });
    await new Promise((r) => setTimeout(r, 0));

    deliver(h.eventListeners, {
      kind: "event",
      name: "job-completed",
      payload: { jobId: "job-unknown", completedAt: Date.now() },
    });

    expect(h.setStatus).not.toHaveBeenCalled();
  });
});
