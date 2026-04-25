// add-file-explorer-drag-drop-upload task 2.1 — RED test for the
// renderer-facing `files.upload` handler.
//
// The handler is a thin proxy over `SyncClient.enqueueUpload`
// (equivalent to `sync:enqueue-upload` on the wire). It MUST forward
// the renderer-supplied `{ datasourceId, sourcePath, targetPath,
// conflictPolicy }` verbatim — NO basename derivation, NO picker open,
// NO implicit overwrite. Failures come back via `toFilesErrorEnvelope`
// so tagged errors from the service (`rate-limited`, `auth-revoked`,
// etc.) keep their `retryable` / `retryAfterMs` metadata.

import { describe, expect, it, vi } from "vitest";

import type { FilesUploadRequest } from "@ft5/ipc-contracts";

import { SyncCommandError } from "../../../sync/client.js";

import { handleFilesUpload } from "../upload.js";

function makeFakeClient(opts?: {
  resolve?: unknown;
  reject?: unknown;
}): { enqueueUpload: ReturnType<typeof vi.fn> } {
  const fn = vi.fn();
  if (opts?.resolve !== undefined) fn.mockResolvedValue(opts.resolve);
  else if (opts?.reject !== undefined) fn.mockRejectedValue(opts.reject);
  else fn.mockResolvedValue({ jobId: "job-default" });
  return { enqueueUpload: fn };
}

const REQ: FilesUploadRequest = {
  datasourceId: "ds-1",
  sourcePath: "C:/mock/report.pdf",
  targetPath: "/projects/2026/report.pdf",
  conflictPolicy: "overwrite",
};

describe("handleFilesUpload — delegates to SyncClient.enqueueUpload", () => {
  it("forwards datasourceId/sourcePath/targetPath/conflictPolicy verbatim and wraps jobId in the files envelope", async () => {
    const client = makeFakeClient({ resolve: { jobId: "job_a" } });

    const result = await handleFilesUpload(REQ, {
      syncClient: client as never,
    });

    expect(client.enqueueUpload).toHaveBeenCalledTimes(1);
    expect(client.enqueueUpload).toHaveBeenCalledWith({
      datasourceId: "ds-1",
      sourcePath: "C:/mock/report.pdf",
      targetPath: "/projects/2026/report.pdf",
      conflictPolicy: "overwrite",
    });
    expect(result).toEqual({ ok: true, value: { jobId: "job_a" } });
  });

  it("forwards conflictPolicy=duplicate without mutation (no implicit overwrite default)", async () => {
    const client = makeFakeClient({ resolve: { jobId: "job_b" } });

    await handleFilesUpload(
      {
        datasourceId: "ds-2",
        sourcePath: "/home/user/a.txt",
        targetPath: "/a.txt",
        conflictPolicy: "duplicate",
      },
      { syncClient: client as never },
    );

    expect(client.enqueueUpload).toHaveBeenCalledWith({
      datasourceId: "ds-2",
      sourcePath: "/home/user/a.txt",
      targetPath: "/a.txt",
      conflictPolicy: "duplicate",
    });
  });

  it("maps a SyncCommandError rejection into ok:false envelope preserving tag/message/retryable/retryAfterMs", async () => {
    const wireError = {
      tag: "rate-limited",
      message: "too many requests",
      retryable: true,
      retryAfterMs: 5000,
    } as const;
    const client = makeFakeClient({
      reject: new SyncCommandError("sync:enqueue-upload", wireError),
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
    // effect is the enqueueUpload call and nothing else on the deps
    // object is touched.
    const client = makeFakeClient({ resolve: { jobId: "job_c" } });
    const deps = { syncClient: client as never };

    await handleFilesUpload(REQ, deps);

    expect(client.enqueueUpload).toHaveBeenCalledTimes(1);
    expect(Object.keys(deps)).toEqual(["syncClient"]);
  });
});
