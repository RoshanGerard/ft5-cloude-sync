// Confirms that a retry after a network-error starts the upload over from
// byte 0 — there is no startOffset / uploadId parameter, and the retry
// invocation of client.uploadFile receives the same shape as the first
// attempt. Resumable-upload session APIs are a follow-up engine change;
// this test encodes the v1 policy "Full re-upload on network retry".
//
// See openspec/changes/add-fs-engine-cancellation/ (and any follow-up
// engine-side cancellation/resume change) for the future path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DatasourceError } from "@ft5/fs-datasource-engine";

import { createEventBus, type EventBus } from "../events/event-bus.js";
import type { Executor, ExecutorCtx } from "../scheduler/scheduler.js";

import { buildUploadExecutor } from "./upload.js";

let bus: EventBus;

beforeEach(() => {
  bus = createEventBus();
});
afterEach(() => {
  /* noop */
});

function ctxFor(attempt: number): ExecutorCtx {
  return {
    job: {
      id: "j-1",
      kind: "upload",
      datasourceId: "ds-1",
      sourcePath: "/local/big.bin",
      targetPath: "/remote/big.bin",
      conflictPolicy: "overwrite",
      status: "running",
      attempt,
      lastErrorTag: null,
      lastErrorMessage: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    signal: new AbortController().signal,
    bus,
  };
}

describe("upload resume-after-network policy", () => {
  it("retry invocation passes identical params to uploadFile (no startOffset, no uploadId)", async () => {
    const calls: Array<[unknown, unknown]> = [];
    const client = {
      uploadFile: vi.fn(async (parent: unknown, file: unknown) => {
        calls.push([parent, file]);
        if (calls.length === 1) {
          throw new DatasourceError({
            tag: "network-error",
            message: "DNS at 50%",
            retryable: true,
            datasourceId: "ds-1",
            datasourceType: "amazon-s3",
          });
        }
        return {
          id: "remote-1",
          name: "big.bin",
          path: "/remote/big.bin",
          size: 1024,
          kind: "file" as const,
        };
      }),
    };

    const executor: Executor = buildUploadExecutor({
      factory: {} as never,
      resolveClient: async () => client as never,
    });

    // Attempt 1 → fails with network-error → outcome='waiting-network'
    const first = await executor(ctxFor(1));
    expect(first.outcome).toBe("waiting-network");

    // Attempt 2 → second invocation of the fake client resolves normally.
    const second = await executor(ctxFor(2));
    expect(second.outcome).toBe("completed");

    expect(calls).toHaveLength(2);
    // Same Target + file params on both invocations.
    expect(calls[0]).toEqual(calls[1]);
    // The file descriptor passed to uploadFile has ONLY `path` — no
    // `startOffset` / `uploadId` / resume-session keys.
    const filePart = (calls[1] as [unknown, Record<string, unknown>])[1];
    expect(Object.keys(filePart).sort()).toEqual(["path"]);
  });
});
