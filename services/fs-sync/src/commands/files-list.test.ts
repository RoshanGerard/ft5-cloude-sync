import { describe, expect, it, vi } from "vitest";

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import type { DatasourceFileEntry, DatasourceType } from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

import { makeFilesListHandler } from "./files-list.js";

function makeFakeClient(
  overrides: Partial<DatasourceClient<DatasourceType>> = {},
): DatasourceClient<DatasourceType> {
  // Returns a structurally-typed client stub. Only the methods exercised
  // by `files:list` (listDirectory) need real impls; the rest are no-op
  // placeholders so the cast is safe under readonly + full interface.
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
  overrides: Partial<DatasourceFileEntry<"google-drive">> = {},
): DatasourceFileEntry<"google-drive"> {
  return {
    handle: "h1",
    kind: "file",
    name: "file.txt",
    path: "/file.txt",
    size: 10,
    mimeFamily: "document",
    modifiedAt: Date.parse("2026-04-01T00:00:00.000Z"),
    providerMetadata: {},
    ...overrides,
  };
}

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

describe("files:list handler", () => {
  it("happy path maps engine DatasourceFileEntry[] → UI FileEntry[] and returns ok:true with truncated:false", async () => {
    const engineEntry = makeEngineEntry({
      handle: "h-alpha",
      name: "alpha.txt",
      path: "/foo/alpha.txt",
      kind: "file",
    });
    const listDirectory = vi.fn().mockResolvedValue([engineEntry]);
    const client = makeFakeClient({ listDirectory });
    const handler = makeFilesListHandler({
      resolveClient: async () => client,
    });

    const result = await handler(
      { datasourceId: "ds-1", path: "/foo" },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.truncated).toBe(false);
      expect(result.result.entries).toHaveLength(1);
      const mapped = result.result.entries[0]!;
      expect(mapped.id).toBe("h-alpha");
      expect(mapped.kind).toBe("file");
      expect(mapped.name).toBe("alpha.txt");
      expect(mapped.path).toBe("/foo/alpha.txt");
      expect(mapped.parentPath).toBe("/foo");
      expect(mapped.size).toBe(10);
      expect(mapped.modifiedAt).toBe("2026-04-01T00:00:00.000Z");
    }
    expect(listDirectory).toHaveBeenCalledWith({ kind: "path", path: "/foo" });
  });

  it("auth-revoked engine error returns ok:false with tag:'auth-revoked' retryable:false", async () => {
    const client = makeFakeClient({
      listDirectory: vi.fn().mockRejectedValue(
        new DatasourceError({
          tag: "auth-revoked",
          datasourceType: "google-drive",
          datasourceId: "ds-1",
          retryable: false,
          message: "token revoked",
        }),
      ),
    });
    const handler = makeFilesListHandler({
      resolveClient: async () => client,
    });

    const result = await handler({ datasourceId: "ds-1", path: "/" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("auth-revoked");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("unknown datasourceId (resolveClient throws) returns ok:false with tag:'other'", async () => {
    const handler = makeFilesListHandler({
      resolveClient: async () => {
        throw new Error("no credentials for datasourceId=ds-ghost");
      },
    });

    const result = await handler({ datasourceId: "ds-ghost", path: "/" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toContain("ds-ghost");
    }
  });

  it("network-error from engine maps to tag:'disconnected' retryable:true", async () => {
    const client = makeFakeClient({
      listDirectory: vi.fn().mockRejectedValue(
        new DatasourceError({
          tag: "network-error",
          datasourceType: "google-drive",
          datasourceId: "ds-1",
          retryable: true,
          message: "ENOTFOUND",
        }),
      ),
    });
    const handler = makeFilesListHandler({
      resolveClient: async () => client,
    });

    const result = await handler({ datasourceId: "ds-1", path: "/" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("disconnected");
      expect(result.error.retryable).toBe(true);
    }
  });
});
