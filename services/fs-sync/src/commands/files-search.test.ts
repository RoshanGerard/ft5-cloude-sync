import { describe, expect, it, vi } from "vitest";

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import type { DatasourceFileEntry, DatasourceType } from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

import { makeFilesSearchHandler } from "./files-search.js";

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
    refreshCredentials: vi
      .fn()
      .mockResolvedValue({ accessToken: "new", refreshToken: "r" }),
    ...overrides,
  } as DatasourceClient<DatasourceType>;
}

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

describe("files:search handler", () => {
  it("forwards scope to engine as { kind: 'path', path: <currentPath> } and maps hits to UI FileEntry", async () => {
    const hit: DatasourceFileEntry<"google-drive"> = {
      handle: "h-budget",
      kind: "file",
      name: "budget.xlsx",
      path: "/projects/budget.xlsx",
      size: 4096,
      mimeFamily: "document",
      modifiedAt: Date.parse("2026-04-02T00:00:00.000Z"),
      providerMetadata: {},
    };
    const search = vi.fn().mockResolvedValue([hit]);
    const handler = makeFilesSearchHandler({
      resolveClient: async () => makeFakeClient({ search }),
    });

    const result = await handler(
      { datasourceId: "ds-1", query: "budget", path: "/projects" },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.truncated).toBe(false);
      expect(result.result.entries).toHaveLength(1);
      expect(result.result.entries[0]!.id).toBe("h-budget");
      expect(result.result.entries[0]!.name).toBe("budget.xlsx");
    }
    expect(search).toHaveBeenCalledWith("budget", {
      kind: "path",
      path: "/projects",
    });
  });

  it("auth-expired once then succeeds → refreshCredentials called exactly once, search returns (withAuthRefresh)", async () => {
    // migrate-engine-retry-policy-to-consumer §3.3 — handler-owned
    // refresh-once/retry-once. RED before the wrap, GREEN after.
    const hit: DatasourceFileEntry<"google-drive"> = {
      handle: "h-after",
      kind: "file",
      name: "after.xlsx",
      path: "/projects/after.xlsx",
      size: 4096,
      mimeFamily: "document",
      modifiedAt: Date.parse("2026-04-02T00:00:00.000Z"),
      providerMetadata: {},
    };
    const search = vi
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
      .mockResolvedValueOnce([hit]);
    const refreshCredentials = vi
      .fn()
      .mockResolvedValue({ accessToken: "new", refreshToken: "r" });
    const handler = makeFilesSearchHandler({
      resolveClient: async () => makeFakeClient({ search, refreshCredentials }),
    });

    const result = await handler(
      { datasourceId: "ds-1", query: "budget", path: "/projects" },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.entries).toHaveLength(1);
      expect(result.result.entries[0]!.id).toBe("h-after");
    }
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("engine auth-revoked becomes ok:false with tag:'auth-revoked'", async () => {
    const handler = makeFilesSearchHandler({
      resolveClient: async () =>
        makeFakeClient({
          search: vi.fn().mockRejectedValue(
            new DatasourceError({
              tag: "auth-revoked",
              datasourceType: "onedrive",
              datasourceId: "ds-1",
              retryable: false,
              message: "token revoked",
            }),
          ),
        }),
    });

    const result = await handler(
      { datasourceId: "ds-1", query: "x", path: "/" },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("auth-revoked");
    }
  });
});
