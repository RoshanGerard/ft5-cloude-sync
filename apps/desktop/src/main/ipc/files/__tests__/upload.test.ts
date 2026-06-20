// migrate-upload-orchestration-out-of-engine §13.5 — tests for the
// renderer-facing `files.upload` handler post chunk-D direct-RPC cutover.
//
// The handler is now a thin proxy over `SyncClient.request("files:upload",
// req)` (parallel to `files:download`). It MUST forward the renderer-
// supplied `{ datasourceId, sourcePath, targetPath, conflictPolicy }`
// verbatim, surface the service's `{ uploadJobId }` as `value.jobId`
// (the `FilesUploadValue.jobId` field is the canonical service-minted
// upload job id post-migration — see `packages/ipc-contracts/src/files.ts`
// `FilesUploadValue.jobId` JSDoc), and route service rejections through
// `toFilesErrorEnvelope`. The previous chunk's wiring went through
// `SyncClient.enqueueUpload` (the queue-based `sync:enqueue-upload`
// command); both the desktop wrapper and the service-side dispatcher
// were deleted in chunk F.

import { describe, expect, it, vi } from "vitest";

import { FilesErrorTag } from "@ft5/ipc-contracts";
import type { FilesUploadRequest } from "@ft5/ipc-contracts";

import { SyncCommandError } from "../../../sync/client.js";

import { handleFilesUpload } from "../upload.js";

function makeFakeClient(opts?: {
  resolve?: unknown;
  reject?: unknown;
}): { request: ReturnType<typeof vi.fn> } {
  const fn = vi.fn();
  if (opts?.resolve !== undefined) fn.mockResolvedValue(opts.resolve);
  else if (opts?.reject !== undefined) fn.mockRejectedValue(opts.reject);
  else fn.mockResolvedValue({ uploadJobId: "job-default" });
  return { request: fn };
}

const REQ: FilesUploadRequest = {
  datasourceId: "ds-1",
  sourcePath: "C:/mock/report.pdf",
  targetPath: "/projects/2026/report.pdf",
  conflictPolicy: "overwrite",
};

describe("handleFilesUpload — direct RPC over SyncClient.request", () => {
  it("forwards datasourceId/sourcePath/targetPath/conflictPolicy verbatim and wraps the service-minted uploadJobId in the files envelope", async () => {
    const client = makeFakeClient({ resolve: { uploadJobId: "u_a" } });

    const result = await handleFilesUpload(REQ, {
      syncClient: client as never,
    });

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith("files:upload", {
      datasourceId: "ds-1",
      sourcePath: "C:/mock/report.pdf",
      targetPath: "/projects/2026/report.pdf",
      conflictPolicy: "overwrite",
    });
    expect(result).toEqual({ ok: true, value: { jobId: "u_a" } });
  });

  it("forwards conflictPolicy=duplicate without mutation (no implicit overwrite default)", async () => {
    const client = makeFakeClient({ resolve: { uploadJobId: "u_b" } });

    await handleFilesUpload(
      {
        datasourceId: "ds-2",
        sourcePath: "/home/user/a.txt",
        targetPath: "/a.txt",
        conflictPolicy: "duplicate",
      },
      { syncClient: client as never },
    );

    expect(client.request).toHaveBeenCalledWith("files:upload", {
      datasourceId: "ds-2",
      sourcePath: "/home/user/a.txt",
      targetPath: "/a.txt",
      conflictPolicy: "duplicate",
    });
  });

  it("maps a SyncCommandError rejection into ok:false envelope preserving tag/message/retryable/retryAfterMs", async () => {
    const wireError = {
      tag: FilesErrorTag.RateLimited,
      message: "too many requests",
      retryable: true,
      retryAfterMs: 5000,
    } as const;
    const client = makeFakeClient({
      reject: new SyncCommandError("files:upload", wireError),
    });

    const result = await handleFilesUpload(REQ, {
      syncClient: client as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("rate-limited");
      expect(result.error.message).toBe("too many requests");
      expect(result.error.retryable).toBe(true);
      expect(result.error.retryAfterMs).toBe(5000);
    }
  });

  it("maps a SyncCommandError with tag:'conflict' from the concurrent-target guard, preserving existingUploadJobId + existingPath for the renderer toast", async () => {
    // Decision 10 — `files:upload` rejects a SECOND request to an
    // in-flight `(datasourceId, targetPath)` BEFORE minting the second
    // job. The wire error envelope carries `existingUploadJobId` (the
    // first job's id) and `existingPath` (the disputed target). The
    // desktop bridge MUST forward both so the renderer's Sonner error
    // toast can point at the existing upload's toast. See
    // packages/ipc-contracts/src/sync-service/commands.ts
    // `FilesCommandErrorShape.existingUploadJobId`.
    const wireError = {
      tag: FilesErrorTag.Conflict,
      message: "An upload to this path is already in progress",
      retryable: false,
      existingUploadJobId: "u-first",
      existingPath: "/projects/2026/report.pdf",
    } as const;
    const client = makeFakeClient({
      reject: new SyncCommandError("files:upload", wireError),
    });

    const result = await handleFilesUpload(REQ, {
      syncClient: client as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("conflict");
      expect(result.error.existingUploadJobId).toBe("u-first");
      expect(result.error.existingPath).toBe("/projects/2026/report.pdf");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("maps a SyncCommandError with tag:'cancelled' from a mid-flight cancel reply", async () => {
    // The service handler replies with `tag: "cancelled"` AFTER an
    // in-flight upload is aborted via `sync:cancel-upload`. Round-trips
    // through the same envelope as the rest of the files surface.
    const wireError = {
      tag: FilesErrorTag.Cancelled,
      message: "upload cancelled",
      retryable: false,
    } as const;
    const client = makeFakeClient({
      reject: new SyncCommandError("files:upload", wireError),
    });

    const result = await handleFilesUpload(REQ, {
      syncClient: client as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("cancelled");
      expect(result.error.message).toBe("upload cancelled");
    }
  });

  it("maps a non-SyncCommandError rejection into ok:false with tag:'other'", async () => {
    const client = makeFakeClient({ reject: new Error("pipe broken") });

    const result = await handleFilesUpload(REQ, {
      syncClient: client as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toBe("pipe broken");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("does NOT open a file picker — the renderer supplies sourcePath directly", async () => {
    // The `FilesUploadDeps` surface only exposes `syncClient`. A test
    // that tries to inject a `showOpenDialog` stub should fail at the
    // type level; at runtime the handler must complete without calling
    // any picker. We assert the latter by verifying the ONLY side
    // effect is the request call and nothing else on the deps object
    // is touched.
    const client = makeFakeClient({ resolve: { uploadJobId: "u_c" } });
    const deps = { syncClient: client as never };

    await handleFilesUpload(REQ, deps);

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(Object.keys(deps)).toEqual(["syncClient"]);
  });
});
