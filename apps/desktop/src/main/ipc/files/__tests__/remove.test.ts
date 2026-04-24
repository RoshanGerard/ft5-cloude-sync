import { describe, expect, it, vi } from "vitest";

import { SyncCommandError } from "../../../sync/client.js";

import { handleFilesRemove } from "../remove.js";

function makeFakeClient(opts?: { resolve?: unknown; reject?: unknown }) {
  const fn = vi.fn();
  if (opts?.resolve !== undefined) fn.mockResolvedValue(opts.resolve);
  else if (opts?.reject !== undefined) fn.mockRejectedValue(opts.reject);
  return { request: fn };
}

describe("handleFilesRemove — delegates to SyncClient.request('files:remove')", () => {
  it("forwards { datasourceId, paths } and maps per-path results into the files envelope", async () => {
    const results = [
      { path: "/a", ok: true as const },
      {
        path: "/b",
        ok: false as const,
        error: { tag: "other" as const, message: "locked" },
      },
    ];
    const client = makeFakeClient({ resolve: { results } });

    const result = await handleFilesRemove(
      { datasourceId: "ds-1", paths: ["/a", "/b"] },
      { syncClient: client as never },
    );

    expect(client.request).toHaveBeenCalledWith("files:remove", {
      datasourceId: "ds-1",
      paths: ["/a", "/b"],
    });
    expect(result).toEqual({ ok: true, value: { results } });
  });

  it("maps SyncCommandError (batch-level failure) into ok:false envelope", async () => {
    const client = makeFakeClient({
      reject: new SyncCommandError("files:remove", {
        tag: "other",
        message: "no credentials for datasourceId=ds-ghost",
        retryable: false,
      }),
    });
    const result = await handleFilesRemove(
      { datasourceId: "ds-ghost", paths: ["/a"] },
      { syncClient: client as never },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toContain("ds-ghost");
    }
  });
});
