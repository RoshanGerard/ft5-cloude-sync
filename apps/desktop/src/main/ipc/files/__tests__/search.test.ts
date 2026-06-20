import { FilesErrorTag } from "@ft5/ipc-contracts";
import { describe, expect, it, vi } from "vitest";

import { SyncCommandError } from "../../../sync/client.js";

import { handleFilesSearch } from "../search.js";

function makeFakeClient(opts?: { resolve?: unknown; reject?: unknown }) {
  const fn = vi.fn();
  if (opts?.resolve !== undefined) fn.mockResolvedValue(opts.resolve);
  else if (opts?.reject !== undefined) fn.mockRejectedValue(opts.reject);
  return { request: fn };
}

describe("handleFilesSearch — delegates to SyncClient.request('files:search')", () => {
  it("forwards { datasourceId, query, path } and maps ok result into the files envelope", async () => {
    const entries: never[] = [];
    const client = makeFakeClient({
      resolve: { entries, truncated: false },
    });

    const result = await handleFilesSearch(
      { datasourceId: "ds-1", query: "notes", path: "/projects" },
      { syncClient: client as never },
    );

    expect(client.request).toHaveBeenCalledWith("files:search", {
      datasourceId: "ds-1",
      query: "notes",
      path: "/projects",
    });
    expect(result).toEqual({
      ok: true,
      value: { entries: [], truncated: false },
    });
  });

  it("maps SyncCommandError(disconnected) into ok:false envelope with retryable:true", async () => {
    const client = makeFakeClient({
      reject: new SyncCommandError("files:search", {
        tag: FilesErrorTag.Disconnected,
        message: "ECONNREFUSED",
        retryable: true,
      }),
    });
    const result = await handleFilesSearch(
      { datasourceId: "ds-1", query: "x", path: "/" },
      { syncClient: client as never },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("disconnected");
      expect(result.error.retryable).toBe(true);
    }
  });
});
