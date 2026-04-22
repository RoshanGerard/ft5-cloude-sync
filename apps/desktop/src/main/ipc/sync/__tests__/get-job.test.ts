// wire-fs-sync-service task 5.3 — handleSyncGetJob [RED]
//
// The renderer-facing response type is `{ job: JobSummary | null }`
// but the wire command result is `{ job: JobSummary }` and surfaces
// "job not found" as a thrown `SyncCommandError` with tag `not-found`.
// The handler therefore:
//   - on happy path, returns `{ job: wire.job }`
//   - on `not-found`, catches and returns `{ job: null }`
//   - on any other error, re-throws so the IPC layer surfaces it

import { describe, expect, it, vi } from "vitest";

import type { JobSummary } from "@ft5/ipc-contracts/sync-service";
import type { SyncGetJobRequest } from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../../sync/client.js";
import { SyncCommandError } from "../../../sync/client.js";
import { handleSyncGetJob } from "../get-job.js";

function job(partial: Partial<JobSummary> & Pick<JobSummary, "id">): JobSummary {
  return {
    kind: "sync",
    datasourceId: "ds-default",
    sourcePath: "/src",
    targetPath: null,
    conflictPolicy: "skip",
    status: "running",
    attempt: 0,
    lastErrorTag: null,
    lastErrorMessage: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function makeFakeClient(impl: (params: { jobId: string }) => Promise<unknown>): {
  client: SyncClient;
  getJob: ReturnType<typeof vi.fn>;
} {
  const getJob = vi.fn(impl);
  const client = { getJob } as unknown as SyncClient;
  return { client, getJob };
}

describe("handleSyncGetJob", () => {
  it("proxies to client.getJob with the wire params and returns the job", async () => {
    const found = job({ id: "j-1", datasourceId: "ds-1" });
    const { client, getJob } = makeFakeClient(async () => ({ job: found }));
    const req: SyncGetJobRequest = { jobId: "j-1" };

    const res = await handleSyncGetJob(req, client);

    expect(getJob).toHaveBeenCalledTimes(1);
    expect(getJob).toHaveBeenCalledWith({ jobId: "j-1" });
    expect(res).toEqual({ job: found });
  });

  it("returns { job: null } when the client rejects with tag 'not-found'", async () => {
    const { client } = makeFakeClient(async () => {
      throw new SyncCommandError("sync:get-job", {
        tag: "not-found",
        message: "job j-missing not found",
      });
    });

    const res = await handleSyncGetJob({ jobId: "j-missing" }, client);

    expect(res).toEqual({ job: null });
  });

  it("re-throws errors whose tag is not 'not-found'", async () => {
    const err = new SyncCommandError("sync:get-job", {
      tag: "validation-error",
      message: "jobId must be a non-empty string",
    });
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(handleSyncGetJob({ jobId: "" }, client)).rejects.toBe(err);
  });

  it("re-throws non-SyncCommandError failures unchanged (e.g. disconnected)", async () => {
    const err = new Error("service-disconnected");
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(handleSyncGetJob({ jobId: "j-1" }, client)).rejects.toBe(err);
  });
});
