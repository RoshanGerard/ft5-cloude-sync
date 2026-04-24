import { describe, expect, it, vi } from "vitest";

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import type { DatasourceType } from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

import { makeFilesRemoveHandler } from "./files-remove.js";

function makeFakeClient(
  overrides: Partial<DatasourceClient<DatasourceType>> = {},
): DatasourceClient<DatasourceType> {
  return {
    type: "google-drive",
    datasourceId: "ds-test",
    status: vi.fn(),
    testConnection: vi.fn(),
    authenticate: vi.fn(),
    listDirectory: vi.fn(),
    search: vi.fn(),
    getMetadata: vi.fn(),
    createFile: vi.fn(),
    uploadFile: vi.fn(),
    cancelUpload: vi.fn(),
    deleteFile: vi.fn(),
    deleteDirectory: vi.fn(),
    getQuota: vi.fn(),
    ...overrides,
  } as DatasourceClient<DatasourceType>;
}

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

describe("files:remove handler", () => {
  it("single-target file: dispatches deleteFile by handle and returns ok:true with results[0].ok:true", async () => {
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const client = makeFakeClient({ deleteFile });
    const handler = makeFilesRemoveHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-1",
        targets: [{ path: "/a.txt", handle: "h-a-1", kind: "file" }],
      },
      ctx,
    );

    expect(result).toEqual({
      ok: true,
      result: { results: [{ path: "/a.txt", handle: "h-a-1", ok: true }] },
    });
    // Authoritative addressing: handle, not path. Skips getMetadata.
    expect(deleteFile).toHaveBeenCalledWith({ kind: "handle", handle: "h-a-1" });
    expect(client.getMetadata).not.toHaveBeenCalled();
    expect(client.deleteDirectory).not.toHaveBeenCalled();
  });

  it("single-target directory: dispatches deleteDirectory by handle (which engines unconditionally reject with 'unsupported') and surfaces a per-target error", async () => {
    // Real engines throw DatasourceError{ tag: "unsupported" } for every
    // deleteDirectory call — see BaseClient.deleteDirectory. Here we mock
    // the contracted rejection so the test matches production behavior.
    // The files error mapping collapses "unsupported" → "other".
    const deleteDirectory = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: "unsupported",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: false,
        raw: "disabled-for-product-stability",
        message: "deleteDirectory is disabled for product stability",
      }),
    );
    const client = makeFakeClient({ deleteDirectory });
    const handler = makeFilesRemoveHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-1",
        targets: [{ path: "/folder", handle: "h-folder", kind: "directory" }],
      },
      ctx,
    );

    expect(deleteDirectory).toHaveBeenCalledWith({
      kind: "handle",
      handle: "h-folder",
    });
    expect(client.deleteFile).not.toHaveBeenCalled();
    expect(client.getMetadata).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.results).toHaveLength(1);
      const r0 = result.result.results[0];
      expect(r0.ok).toBe(false);
      if (!r0.ok) {
        expect(r0.error.tag).toBe("other");
        expect(r0.error.message).toBe(
          "deleteDirectory is disabled for product stability",
        );
      }
    }
  });

  it("ambiguous-path scenario: two files with identical path but distinct handles both delete without a 'multiple files at this path' error", async () => {
    // Regression guard for the Drive duplicate-name bug that motivated
    // this handler shape. Before the handle-based rewrite, the handler
    // called `getMetadata({ kind: "path", path })` first, which Drive
    // rejects with "Ambiguous path - multiple files at this path" when
    // two files share a path. With handle addressing, each target
    // deletes cleanly.
    const deletedHandles: string[] = [];
    const deleteFile = vi.fn().mockImplementation(async (target: { handle: string }) => {
      deletedHandles.push(target.handle);
    });
    const client = makeFakeClient({ deleteFile });
    const handler = makeFilesRemoveHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-1",
        targets: [
          { path: "/acme.txt", handle: "h-acme-1", kind: "file" },
          { path: "/acme.txt", handle: "h-acme-2", kind: "file" },
        ],
      },
      ctx,
    );

    expect(deletedHandles).toEqual(["h-acme-1", "h-acme-2"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.results).toEqual([
        { path: "/acme.txt", handle: "h-acme-1", ok: true },
        { path: "/acme.txt", handle: "h-acme-2", ok: true },
      ]);
    }
  });

  it("single-target failure (engine throws rate-limited) returns per-target error", async () => {
    const deleteFile = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: "rate-limited",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: true,
        retryAfterMs: 15000,
        message: "provider throttled",
      }),
    );
    const client = makeFakeClient({ deleteFile });
    const handler = makeFilesRemoveHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-1",
        targets: [{ path: "/a.txt", handle: "h-a", kind: "file" }],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.results).toHaveLength(1);
      const r0 = result.result.results[0];
      expect(r0.ok).toBe(false);
      if (!r0.ok) {
        expect(r0.error.tag).toBe("rate-limited");
        expect(r0.error.message).toBe("provider throttled");
      }
    }
  });

  it("multi-target partial failure: results array preserves per-target outcome in order", async () => {
    const deleteFile = vi.fn().mockImplementation(async (target: { handle: string }) => {
      // Succeed for h-a and h-c; fail for h-b.
      if (target.handle === "h-b") {
        throw new DatasourceError({
          tag: "provider-error",
          datasourceType: "google-drive",
          datasourceId: "ds-1",
          retryable: false,
          message: "file locked",
        });
      }
    });
    const client = makeFakeClient({ deleteFile });
    const handler = makeFilesRemoveHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-1",
        targets: [
          { path: "/a", handle: "h-a", kind: "file" },
          { path: "/b", handle: "h-b", kind: "file" },
          { path: "/c", handle: "h-c", kind: "file" },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.results).toHaveLength(3);
      expect(result.result.results[0]).toEqual({ path: "/a", handle: "h-a", ok: true });
      const r1 = result.result.results[1];
      expect(r1.ok).toBe(false);
      if (!r1.ok) {
        expect(r1.error.tag).toBe("other");
        expect(r1.error.message).toBe("file locked");
      }
      expect(result.result.results[2]).toEqual({ path: "/c", handle: "h-c", ok: true });
    }
  });

  it("resolveClient throws → envelope-level ok:false with tag:'other'", async () => {
    const handler = makeFilesRemoveHandler({
      resolveClient: async () => {
        throw new Error("no credentials for datasourceId=ds-ghost");
      },
    });

    const result = await handler(
      {
        datasourceId: "ds-ghost",
        targets: [{ path: "/a.txt", handle: "h-a", kind: "file" }],
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toContain("ds-ghost");
    }
  });

  it("empty targets returns ok:true with empty results (no engine calls)", async () => {
    const client = makeFakeClient();
    const handler = makeFilesRemoveHandler({ resolveClient: async () => client });

    const result = await handler(
      { datasourceId: "ds-1", targets: [] },
      ctx,
    );

    expect(result).toEqual({ ok: true, result: { results: [] } });
    expect(client.deleteFile).not.toHaveBeenCalled();
    expect(client.deleteDirectory).not.toHaveBeenCalled();
    expect(client.getMetadata).not.toHaveBeenCalled();
  });
});
