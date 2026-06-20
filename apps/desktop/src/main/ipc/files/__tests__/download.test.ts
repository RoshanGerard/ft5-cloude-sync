import { FilesErrorTag } from "@ft5/ipc-contracts";
import { describe, expect, it, vi } from "vitest";

import { SyncCommandError } from "../../../sync/client.js";

import { handleFilesDownload } from "../download.js";

// Stand-in for a SyncClient — only `request` is exercised by download.ts.
type FakeSyncClient = {
  request: ReturnType<typeof vi.fn>;
};

function makeFakeClient(opts?: {
  resolve?: unknown;
  reject?: unknown;
}): FakeSyncClient {
  const fn = vi.fn();
  if (opts?.resolve !== undefined) fn.mockResolvedValue(opts.resolve);
  else if (opts?.reject !== undefined) fn.mockRejectedValue(opts.reject);
  return { request: fn };
}

describe("handleFilesDownload — delegates to SyncClient.request('files:download')", () => {
  it("forwards { datasourceId, path, toPath } and maps ok result into the files envelope", async () => {
    const client = makeFakeClient({
      resolve: { savedPath: "C:/Users/me/Downloads/report.pdf", bytes: 1024 },
    });

    const result = await handleFilesDownload(
      {
        datasourceId: "ds-1",
        path: "/documents/report.pdf",
        toPath: "C:/Users/me/Downloads/report.pdf",
      },
      { syncClient: client as never },
    );

    expect(client.request).toHaveBeenCalledWith("files:download", {
      datasourceId: "ds-1",
      path: "/documents/report.pdf",
      toPath: "C:/Users/me/Downloads/report.pdf",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        savedPath: "C:/Users/me/Downloads/report.pdf",
        bytes: 1024,
      },
    });
  });

  it("maps SyncCommandError(rate-limited) rejection into ok:false envelope preserving tag/message/retryable/retryAfterMs", async () => {
    const wireError = {
      tag: FilesErrorTag.RateLimited,
      message: "too many requests",
      retryable: true,
      retryAfterMs: 5000,
    } as const;
    const client = makeFakeClient({
      reject: new SyncCommandError("files:download", wireError),
    });

    const result = await handleFilesDownload(
      {
        datasourceId: "ds-1",
        path: "/documents/report.pdf",
        toPath: "C:/Users/me/Downloads/report.pdf",
      },
      { syncClient: client as never },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("rate-limited");
      expect(result.error.message).toBe("too many requests");
      expect(result.error.retryable).toBe(true);
      expect(result.error.retryAfterMs).toBe(5000);
    }
  });

  it("maps non-SyncCommandError rejection into ok:false with tag:'other'", async () => {
    const client = makeFakeClient({ reject: new Error("disk full") });

    const result = await handleFilesDownload(
      {
        datasourceId: "ds-1",
        path: "/documents/report.pdf",
        toPath: "C:/Users/me/Downloads/report.pdf",
      },
      { syncClient: client as never },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toBe("disk full");
      expect(result.error.retryable).toBe(false);
    }
  });
});
