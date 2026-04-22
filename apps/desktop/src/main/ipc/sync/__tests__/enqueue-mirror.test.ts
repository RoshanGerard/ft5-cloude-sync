// wire-fs-sync-service task 5.7 — handleSyncEnqueueMirror [RED]
//
// Near-identity proxy over `SyncClient.enqueueMirror`. The renderer
// response type is a discriminated union:
//   `{ jobId } | { error: SyncAlreadyRunningErrorShape }`
//
// `sync-already-running` is a known-fallible outcome and must surface
// as a structured `{ error }` response, NOT as a thrown rejection.
// Any other error (`validation-error`, service-disconnected, …)
// re-throws so the IPC layer surfaces it.
//
// `conflictPolicy` is optional with `exactOptionalPropertyTypes` on —
// the handler must omit the key entirely when absent, not pass
// `conflictPolicy: undefined`.

import { describe, expect, it, vi } from "vitest";

import type { SyncEnqueueMirrorRequest } from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../../sync/client.js";
import { SyncCommandError } from "../../../sync/client.js";
import { handleSyncEnqueueMirror } from "../enqueue-mirror.js";

function makeFakeClient(
  impl: (params: SyncEnqueueMirrorRequest) => Promise<unknown>,
): { client: SyncClient; enqueueMirror: ReturnType<typeof vi.fn> } {
  const enqueueMirror = vi.fn(impl);
  const client = { enqueueMirror } as unknown as SyncClient;
  return { client, enqueueMirror };
}

describe("handleSyncEnqueueMirror", () => {
  it("proxies all request fields through and returns the wire jobId", async () => {
    const { client, enqueueMirror } = makeFakeClient(async () => ({
      jobId: "mirror-1",
    }));
    const req: SyncEnqueueMirrorRequest = {
      datasourceId: "ds-1",
      sourcePath: "/home/user/mirror",
      conflictPolicy: "overwrite",
    };

    const res = await handleSyncEnqueueMirror(req, client);

    expect(enqueueMirror).toHaveBeenCalledTimes(1);
    expect(enqueueMirror).toHaveBeenCalledWith({
      datasourceId: "ds-1",
      sourcePath: "/home/user/mirror",
      conflictPolicy: "overwrite",
    });
    expect(res).toEqual({ jobId: "mirror-1" });
  });

  it("omits conflictPolicy key entirely when the request does not include it", async () => {
    // exactOptionalPropertyTypes — we must NOT forward
    // `{ conflictPolicy: undefined }`.
    const { client, enqueueMirror } = makeFakeClient(async () => ({
      jobId: "mirror-2",
    }));
    const req: SyncEnqueueMirrorRequest = {
      datasourceId: "ds-1",
      sourcePath: "/home/user/mirror",
    };

    await handleSyncEnqueueMirror(req, client);

    expect(enqueueMirror).toHaveBeenCalledTimes(1);
    const [params] = enqueueMirror.mock.calls[0]!;
    expect(params).toEqual({
      datasourceId: "ds-1",
      sourcePath: "/home/user/mirror",
    });
    expect("conflictPolicy" in params).toBe(false);
  });

  it("returns structured { error } on sync-already-running without throwing", async () => {
    const errorShape = {
      tag: "sync-already-running" as const,
      message: "a sync job is already running for ds-1:/mirror",
      details: {
        existingJobId: "existing-job-42",
        datasourceId: "ds-1",
        sourcePath: "/mirror",
      },
    };
    const { client } = makeFakeClient(async () => {
      throw new SyncCommandError("sync:enqueue-mirror", errorShape);
    });
    const req: SyncEnqueueMirrorRequest = {
      datasourceId: "ds-1",
      sourcePath: "/mirror",
    };

    const res = await handleSyncEnqueueMirror(req, client);

    expect(res).toHaveProperty("error");
    if (!("error" in res)) throw new Error("expected error branch");
    expect(res.error.tag).toBe("sync-already-running");
    expect(res.error.details).toEqual(errorShape.details);
    expect(typeof res.error.message).toBe("string");
  });

  it("re-throws validation-error (not a renderer-observable fallible outcome)", async () => {
    const err = new SyncCommandError("sync:enqueue-mirror", {
      tag: "validation-error",
      message: "sourcePath must be absolute",
    });
    const { client } = makeFakeClient(async () => {
      throw err;
    });
    const req: SyncEnqueueMirrorRequest = {
      datasourceId: "ds-1",
      sourcePath: "relative/bad",
    };

    await expect(handleSyncEnqueueMirror(req, client)).rejects.toBe(err);
  });

  it("re-throws non-SyncCommandError failures (e.g. service-disconnected)", async () => {
    const err = new Error("service-disconnected");
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncEnqueueMirror(
        { datasourceId: "ds-1", sourcePath: "/a" },
        client,
      ),
    ).rejects.toBe(err);
  });
});
