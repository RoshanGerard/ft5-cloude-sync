import { FilesErrorTag } from "@ft5/ipc-contracts";
import { describe, expect, it, vi } from "vitest";

import { SyncCommandError } from "../../../sync/client.js";

import { handleFilesStat } from "../stat.js";

function makeFakeClient(opts?: { resolve?: unknown; reject?: unknown }) {
  const fn = vi.fn();
  if (opts?.resolve !== undefined) fn.mockResolvedValue(opts.resolve);
  else if (opts?.reject !== undefined) fn.mockRejectedValue(opts.reject);
  return { request: fn };
}

describe("handleFilesStat — delegates to SyncClient.request('files:stat')", () => {
  it("forwards { datasourceId, path } and maps ok result into the files envelope", async () => {
    const entry = {
      id: "h-x",
      kind: "file",
      name: "x.txt",
      path: "/x.txt",
      parentPath: "/",
      size: 1,
      mimeFamily: "text",
      mimeType: null,
      modifiedAt: "2026-04-01T00:00:00.000Z",
      createdAt: null,
      providerMetadata: {},
    } as const;
    const client = makeFakeClient({ resolve: { entry } });

    const result = await handleFilesStat(
      { datasourceId: "ds-1", path: "/x.txt" },
      { syncClient: client as never },
    );

    expect(client.request).toHaveBeenCalledWith("files:stat", {
      datasourceId: "ds-1",
      path: "/x.txt",
    });
    expect(result).toEqual({ ok: true, value: { entry } });
  });

  it("maps SyncCommandError(auth-revoked) into ok:false envelope", async () => {
    const client = makeFakeClient({
      reject: new SyncCommandError("files:stat", {
        tag: FilesErrorTag.AuthRevoked,
        message: "reconnect required",
        retryable: false,
      }),
    });
    const result = await handleFilesStat(
      { datasourceId: "ds-1", path: "/x.txt" },
      { syncClient: client as never },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("auth-revoked");
      expect(result.error.retryable).toBe(false);
    }
  });
});
