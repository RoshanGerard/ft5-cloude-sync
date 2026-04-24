// wire-fs-sync-service task 5.9 — handleSyncCancelJob [RED]
//
// Near-identity proxy over `SyncClient.cancelJob`. The renderer
// response type is a discriminated union:
//   `{ cancelled: true } | { error: NotCancelableErrorShape }`
//
// Only `not-cancelable` is the known-fallible outcome that must
// surface as a structured `{ error }` response. Any other error
// (`not-found`, service-disconnected, …) re-throws so the IPC
// layer surfaces it.

import { describe, expect, it, vi } from "vitest";

import type { SyncCancelJobRequest } from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../../sync/client.js";
import { SyncCommandError } from "../../../sync/client.js";
import { handleSyncCancelJob } from "../cancel-job.js";

function makeFakeClient(
  impl: (params: SyncCancelJobRequest) => Promise<unknown>,
): { client: SyncClient; cancelJob: ReturnType<typeof vi.fn> } {
  const cancelJob = vi.fn(impl);
  const client = { cancelJob } as unknown as SyncClient;
  return { client, cancelJob };
}

describe("handleSyncCancelJob", () => {
  it("proxies to client.cancelJob with the wire params and returns { cancelled: true }", async () => {
    const { client, cancelJob } = makeFakeClient(async () => ({
      cancelled: true,
    }));
    const req: SyncCancelJobRequest = { jobId: "j-1" };

    const res = await handleSyncCancelJob(req, client);

    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(cancelJob).toHaveBeenCalledWith({ jobId: "j-1" });
    expect(res).toEqual({ cancelled: true });
  });

  it("returns structured { error } on not-cancelable without throwing", async () => {
    const errorShape = {
      tag: "not-cancelable" as const,
      message: "job j-1 is already completed",
    };
    const { client } = makeFakeClient(async () => {
      throw new SyncCommandError("sync:cancel-job", errorShape);
    });

    const res = await handleSyncCancelJob({ jobId: "j-1" }, client);

    expect(res).toHaveProperty("error");
    if (!("error" in res)) throw new Error("expected error branch");
    expect(res.error.tag).toBe("not-cancelable");
    expect(typeof res.error.message).toBe("string");
  });

  it("re-throws not-found (not a renderer-observable fallible outcome for cancel)", async () => {
    const err = new SyncCommandError("sync:cancel-job", {
      tag: "not-found",
      message: "job j-missing does not exist",
    });
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncCancelJob({ jobId: "j-missing" }, client),
    ).rejects.toBe(err);
  });

  it("re-throws non-SyncCommandError failures (e.g. service-disconnected)", async () => {
    const err = new Error("service-disconnected");
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(handleSyncCancelJob({ jobId: "j-1" }, client)).rejects.toBe(
      err,
    );
  });
});
