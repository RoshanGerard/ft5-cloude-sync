import { describe, expect, it, vi } from "vitest";

import type { FileEntry } from "@ft5/ipc-contracts";

import { SyncCommandError } from "../../../sync/client.js";

import { handleFilesRename } from "../rename.js";

// Stand-in for a SyncClient — only `request` is exercised by rename.ts.
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

const SAMPLE_ENTRY: FileEntry = {
  id: "ds-1::/documents/renamed.pdf",
  kind: "file",
  name: "renamed.pdf",
  path: "/documents/renamed.pdf",
  parentPath: "/documents",
  size: 1024,
  mimeFamily: "document",
  mimeType: "application/pdf",
  modifiedAt: "2026-04-01T00:00:00.000Z",
  createdAt: "2026-04-01T00:00:00.000Z",
  providerMetadata: {},
};

describe("handleFilesRename — delegates to SyncClient.request('files:rename')", () => {
  it("forwards { datasourceId, path, newName, conflictPolicy } and maps ok result into the files envelope", async () => {
    const client = makeFakeClient({ resolve: { entry: SAMPLE_ENTRY } });

    const result = await handleFilesRename(
      {
        datasourceId: "ds-1",
        path: "/documents/original.pdf",
        newName: "renamed.pdf",
        conflictPolicy: "fail",
      },
      { syncClient: client as never },
    );

    expect(client.request).toHaveBeenCalledWith("files:rename", {
      datasourceId: "ds-1",
      path: "/documents/original.pdf",
      newName: "renamed.pdf",
      conflictPolicy: "fail",
    });
    expect(result).toEqual({ ok: true, value: { entry: SAMPLE_ENTRY } });
  });

  it("maps SyncCommandError(conflict) rejection into ok:false envelope preserving tag/message/retryable", async () => {
    const wireError = {
      tag: "other",
      message: "conflict: a file with that name already exists",
      retryable: false,
    } as const;
    const client = makeFakeClient({
      reject: new SyncCommandError("files:rename", wireError),
    });

    const result = await handleFilesRename(
      {
        datasourceId: "ds-1",
        path: "/documents/original.pdf",
        newName: "renamed.pdf",
        conflictPolicy: "fail",
      },
      { syncClient: client as never },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toMatch(/conflict/i);
      expect(result.error.retryable).toBe(false);
    }
  });

  it("maps non-SyncCommandError rejection into ok:false with tag:'other'", async () => {
    const client = makeFakeClient({ reject: new Error("pipe broken") });

    const result = await handleFilesRename(
      {
        datasourceId: "ds-1",
        path: "/documents/original.pdf",
        newName: "renamed.pdf",
        conflictPolicy: "fail",
      },
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
