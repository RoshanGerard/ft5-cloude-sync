// wire-fs-sync-service task 5.5 — handleSyncEnqueueUpload [RED]
//
// Pure identity proxy over `SyncClient.enqueueUpload`. The renderer
// response type is flat `{ jobId: string }` — NOT a discriminated
// union — so any wire error (the only documented one is
// `validation-error`) propagates as a thrown `SyncCommandError`
// unchanged. The handler adds no structured error wrapping.

import { describe, expect, it, vi } from "vitest";

import type { SyncEnqueueUploadRequest } from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../../sync/client.js";
import { SyncCommandError } from "../../../sync/client.js";
import { handleSyncEnqueueUpload } from "../enqueue-upload.js";

function makeFakeClient(
  impl: (params: SyncEnqueueUploadRequest) => Promise<unknown>,
): { client: SyncClient; enqueueUpload: ReturnType<typeof vi.fn> } {
  const enqueueUpload = vi.fn(impl);
  const client = { enqueueUpload } as unknown as SyncClient;
  return { client, enqueueUpload };
}

describe("handleSyncEnqueueUpload", () => {
  it("proxies all request fields through and returns the wire jobId", async () => {
    const { client, enqueueUpload } = makeFakeClient(async () => ({
      jobId: "job-123",
    }));
    const req: SyncEnqueueUploadRequest = {
      datasourceId: "ds-1",
      sourcePath: "/home/user/file.txt",
      targetPath: "/remote/file.txt",
      conflictPolicy: "overwrite",
    };

    const res = await handleSyncEnqueueUpload(req, client);

    expect(enqueueUpload).toHaveBeenCalledTimes(1);
    expect(enqueueUpload).toHaveBeenCalledWith(req);
    expect(res).toEqual({ jobId: "job-123" });
  });

  it("re-throws wire errors unchanged (no structured response wrapping)", async () => {
    const err = new SyncCommandError("sync:enqueue-upload", {
      tag: "validation-error",
      message: "sourcePath must be absolute",
    });
    const { client } = makeFakeClient(async () => {
      throw err;
    });
    const req: SyncEnqueueUploadRequest = {
      datasourceId: "ds-1",
      sourcePath: "relative/bad.txt",
      targetPath: "/remote/file.txt",
      conflictPolicy: "skip",
    };

    await expect(handleSyncEnqueueUpload(req, client)).rejects.toBe(err);
  });

  it("passes through each supported conflictPolicy value", async () => {
    const { client, enqueueUpload } = makeFakeClient(async () => ({
      jobId: "job-x",
    }));

    for (const policy of ["overwrite", "duplicate", "skip"] as const) {
      await handleSyncEnqueueUpload(
        {
          datasourceId: "ds-1",
          sourcePath: "/a",
          targetPath: "/b",
          conflictPolicy: policy,
        },
        client,
      );
    }

    expect(enqueueUpload).toHaveBeenCalledTimes(3);
    expect(enqueueUpload.mock.calls.map(([c]) => c.conflictPolicy)).toEqual([
      "overwrite",
      "duplicate",
      "skip",
    ]);
  });
});
