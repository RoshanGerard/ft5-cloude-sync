import { describe, expect, it, vi } from "vitest";

import type { FilesListResponse } from "@ft5/ipc-contracts";

import { SyncCommandError } from "../../../sync/client.js";

import { handleFilesList } from "../list.js";

// Stand-in for a SyncClient — only `request` is exercised by list.ts.
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

describe("handleFilesList — delegates to SyncClient.request('files:list')", () => {
  it("forwards { datasourceId, path } and maps ok result into the files envelope", async () => {
    const entries = [
      {
        id: "h-alpha",
        kind: "file",
        name: "alpha.txt",
        path: "/alpha.txt",
        parentPath: "/",
        size: 10,
        mimeFamily: "text",
        mimeType: null,
        modifiedAt: "2026-04-01T00:00:00.000Z",
        createdAt: null,
        providerMetadata: {},
      },
    ] as const;
    const client = makeFakeClient({
      resolve: { entries, truncated: false },
    });

    const result: FilesListResponse = await handleFilesList(
      { datasourceId: "ds-1", path: "/" },
      { syncClient: client as never },
    );

    expect(client.request).toHaveBeenCalledWith("files:list", {
      datasourceId: "ds-1",
      path: "/",
    });
    expect(result).toEqual({
      ok: true,
      value: { entries, truncated: false },
    });
  });

  it("maps SyncCommandError rejection into ok:false envelope preserving tag/message/retryable/retryAfterMs", async () => {
    const wireError = {
      tag: "rate-limited",
      message: "too many requests",
      retryable: true,
      retryAfterMs: 5000,
    } as const;
    const client = makeFakeClient({
      reject: new SyncCommandError("files:list", wireError),
    });

    const result = await handleFilesList(
      { datasourceId: "ds-1", path: "/" },
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
    const client = makeFakeClient({ reject: new Error("pipe broken") });

    const result = await handleFilesList(
      { datasourceId: "ds-1", path: "/" },
      { syncClient: client as never },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toBe("pipe broken");
      expect(result.error.retryable).toBe(false);
    }
  });
});
