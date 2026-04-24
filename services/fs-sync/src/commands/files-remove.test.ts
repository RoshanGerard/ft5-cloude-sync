import { describe, expect, it, vi } from "vitest";

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import type { DatasourceFileEntry, DatasourceType } from "@ft5/ipc-contracts";
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

function makeEngineEntry(
  path: string,
  kind: "file" | "folder" = "file",
): DatasourceFileEntry<"google-drive"> {
  return {
    handle: `h-${path}`,
    kind,
    name: path.split("/").pop() ?? "",
    path,
    size: kind === "file" ? 100 : undefined,
    mimeFamily: kind === "folder" ? "folder" : "other",
    modifiedAt: Date.parse("2026-04-01T00:00:00.000Z"),
    providerMetadata: {},
  };
}

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

describe("files:remove handler", () => {
  it("single-path success returns ok:true with results[0].ok:true", async () => {
    const client = makeFakeClient({
      getMetadata: vi.fn().mockResolvedValue(makeEngineEntry("/a.txt")),
      deleteFile: vi.fn().mockResolvedValue(undefined),
    });
    const handler = makeFilesRemoveHandler({ resolveClient: async () => client });

    const result = await handler(
      { datasourceId: "ds-1", paths: ["/a.txt"] },
      ctx,
    );

    expect(result).toEqual({
      ok: true,
      result: { results: [{ path: "/a.txt", ok: true }] },
    });
    expect(client.deleteFile).toHaveBeenCalledWith({ kind: "path", path: "/a.txt" });
    expect(client.deleteDirectory).not.toHaveBeenCalled();
  });

  it("directory entry dispatches to deleteDirectory (which engines unconditionally reject with 'unsupported') and surfaces a per-path error", async () => {
    // Real engines throw DatasourceError{ tag: "unsupported" } for every
    // deleteDirectory call — see BaseClient.deleteDirectory. Here we mock
    // the contracted rejection so the test matches production behavior; the
    // handler should dispatch to deleteDirectory (not deleteFile) and the
    // per-path result should be ok:false with tag "other" (the files error
    // mapping collapses "unsupported" → "other").
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
    const client = makeFakeClient({
      getMetadata: vi.fn().mockResolvedValue(makeEngineEntry("/folder", "folder")),
      deleteDirectory,
    });
    const handler = makeFilesRemoveHandler({ resolveClient: async () => client });

    const result = await handler(
      { datasourceId: "ds-1", paths: ["/folder"] },
      ctx,
    );

    expect(client.deleteDirectory).toHaveBeenCalledWith({
      kind: "path",
      path: "/folder",
    });
    expect(client.deleteFile).not.toHaveBeenCalled();
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

  it("single-path failure (engine throws rate-limited) returns per-path error", async () => {
    const client = makeFakeClient({
      getMetadata: vi.fn().mockResolvedValue(makeEngineEntry("/a.txt")),
      deleteFile: vi.fn().mockRejectedValue(
        new DatasourceError({
          tag: "rate-limited",
          datasourceType: "google-drive",
          datasourceId: "ds-1",
          retryable: true,
          retryAfterMs: 15000,
          message: "provider throttled",
        }),
      ),
    });
    const handler = makeFilesRemoveHandler({ resolveClient: async () => client });

    const result = await handler(
      { datasourceId: "ds-1", paths: ["/a.txt"] },
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

  it("multi-path partial failure: results array preserves per-path outcome in order", async () => {
    let call = 0;
    const getMetadata = vi.fn().mockImplementation(async () => {
      return makeEngineEntry("/" + String(call++));
    });
    const deleteFile = vi.fn().mockImplementation(async (target: { path: string }) => {
      // Succeed for /a and /c; fail for /b.
      if (target.path === "/b") {
        throw new DatasourceError({
          tag: "provider-error",
          datasourceType: "google-drive",
          datasourceId: "ds-1",
          retryable: false,
          message: "file locked",
        });
      }
    });
    const client = makeFakeClient({ getMetadata, deleteFile });
    const handler = makeFilesRemoveHandler({ resolveClient: async () => client });

    const result = await handler(
      { datasourceId: "ds-1", paths: ["/a", "/b", "/c"] },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.results).toHaveLength(3);
      expect(result.result.results[0]).toEqual({ path: "/a", ok: true });
      const r1 = result.result.results[1];
      expect(r1.ok).toBe(false);
      if (!r1.ok) {
        expect(r1.error.tag).toBe("other");
        expect(r1.error.message).toBe("file locked");
      }
      expect(result.result.results[2]).toEqual({ path: "/c", ok: true });
    }
  });

  it("resolveClient throws → envelope-level ok:false with tag:'other'", async () => {
    const handler = makeFilesRemoveHandler({
      resolveClient: async () => {
        throw new Error("no credentials for datasourceId=ds-ghost");
      },
    });

    const result = await handler(
      { datasourceId: "ds-ghost", paths: ["/a.txt"] },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toContain("ds-ghost");
    }
  });

  it("empty paths returns ok:true with empty results (no engine calls)", async () => {
    const client = makeFakeClient();
    const handler = makeFilesRemoveHandler({ resolveClient: async () => client });

    const result = await handler({ datasourceId: "ds-1", paths: [] }, ctx);

    expect(result).toEqual({ ok: true, result: { results: [] } });
    expect(client.getMetadata).not.toHaveBeenCalled();
    expect(client.deleteFile).not.toHaveBeenCalled();
  });
});
