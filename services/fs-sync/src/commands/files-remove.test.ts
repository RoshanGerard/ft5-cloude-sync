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
    delete: vi.fn(),
    getQuota: vi.fn(),
    refreshCredentials: vi
      .fn()
      .mockResolvedValue({ accessToken: "new", refreshToken: "r" }),
    ...overrides,
  } as DatasourceClient<DatasourceType>;
}

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

describe("files:remove handler", () => {
  it("single-target file: dispatches delete by handle with entryKind 'file' and returns ok:true with results[0].ok:true", async () => {
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const client = makeFakeClient({ delete: deleteSpy });
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
    // Unified delete(target, entryKind) — a file target passes "file".
    expect(deleteSpy).toHaveBeenCalledWith(
      { kind: "handle", handle: "h-a-1" },
      "file",
    );
    expect(client.getMetadata).not.toHaveBeenCalled();
  });

  it("single-target directory: dispatches delete by handle with entryKind 'directory' (which engines unconditionally reject with 'unsupported') and surfaces a per-target error", async () => {
    // Real engines throw DatasourceError{ tag: "unsupported" } for every
    // delete(target, "directory") call — see BaseClient.delete. Here we mock
    // the contracted rejection so the test matches production behavior.
    // The files error mapping collapses "unsupported" → "other".
    const deleteSpy = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: "unsupported",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: false,
        raw: "disabled-for-product-stability",
        message: "directory delete is disabled for product stability",
      }),
    );
    const client = makeFakeClient({ delete: deleteSpy });
    const handler = makeFilesRemoveHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-1",
        targets: [{ path: "/folder", handle: "h-folder", kind: "directory" }],
      },
      ctx,
    );

    expect(deleteSpy).toHaveBeenCalledWith(
      { kind: "handle", handle: "h-folder" },
      "directory",
    );
    expect(client.getMetadata).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.results).toHaveLength(1);
      const r0 = result.result.results[0];
      expect(r0.ok).toBe(false);
      if (!r0.ok) {
        expect(r0.error.tag).toBe("other");
        expect(r0.error.message).toBe(
          "directory delete is disabled for product stability",
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
    const deleteSpy = vi.fn().mockImplementation(async (target: { handle: string }) => {
      deletedHandles.push(target.handle);
    });
    const client = makeFakeClient({ delete: deleteSpy });
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

  it("file delete: auth-expired once then succeeds → refreshCredentials called exactly once, delete retries and target succeeds (withAuthRefresh)", async () => {
    // migrate-engine-retry-policy-to-consumer §3.4 — each per-target delete
    // owns its own refresh-once/retry-once. RED before the wrap (the first
    // auth-expired surfaces raw → per-target error), GREEN after (refresh +
    // retry → results[0].ok:true).
    const deleteSpy = vi
      .fn()
      .mockRejectedValueOnce(
        new DatasourceError({
          tag: "auth-expired",
          datasourceType: "google-drive",
          datasourceId: "ds-1",
          retryable: false,
          message: "token expired",
        }),
      )
      .mockResolvedValueOnce(undefined);
    const refreshCredentials = vi
      .fn()
      .mockResolvedValue({ accessToken: "new", refreshToken: "r" });
    const client = makeFakeClient({ delete: deleteSpy, refreshCredentials });
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
      expect(result.result.results).toEqual([
        { path: "/a.txt", handle: "h-a", ok: true },
      ]);
    }
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
  });

  it("single-target failure (engine throws rate-limited) returns per-target error", async () => {
    const deleteSpy = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: "rate-limited",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: true,
        retryAfterMs: 15000,
        message: "provider throttled",
      }),
    );
    const client = makeFakeClient({ delete: deleteSpy });
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
    const deleteSpy = vi.fn().mockImplementation(async (target: { handle: string }) => {
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
    const client = makeFakeClient({ delete: deleteSpy });
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
    expect(client.delete).not.toHaveBeenCalled();
    expect(client.getMetadata).not.toHaveBeenCalled();
  });
});
