import { describe, expect, it, vi } from "vitest";

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import type { DatasourceFileEntry, DatasourceType } from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

import { makeFilesStatHandler } from "./files-stat.js";

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

const engineEntry: DatasourceFileEntry<"google-drive"> = {
  handle: "h-report",
  kind: "file",
  name: "report.pdf",
  path: "/reports/report.pdf",
  size: 2048,
  mimeFamily: "document",
  modifiedAt: Date.parse("2026-04-01T00:00:00.000Z"),
  providerMetadata: {},
};

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

describe("files:stat handler", () => {
  it("happy path maps engine FileMetadata → UI FileEntry and returns ok:true", async () => {
    const getMetadata = vi.fn().mockResolvedValue(engineEntry);
    const handler = makeFilesStatHandler({
      resolveClient: async () => makeFakeClient({ getMetadata }),
    });

    const result = await handler(
      { datasourceId: "ds-1", path: "/reports/report.pdf" },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.entry.id).toBe("h-report");
      expect(result.result.entry.name).toBe("report.pdf");
      expect(result.result.entry.parentPath).toBe("/reports");
      expect(result.result.entry.modifiedAt).toBe("2026-04-01T00:00:00.000Z");
    }
    expect(getMetadata).toHaveBeenCalledWith({
      kind: "path",
      path: "/reports/report.pdf",
    });
  });

  it("not-found engine error maps to tag:'other' (engine 'not-found' is not in the 4-tag UI vocab)", async () => {
    const handler = makeFilesStatHandler({
      resolveClient: async () =>
        makeFakeClient({
          getMetadata: vi.fn().mockRejectedValue(
            new DatasourceError({
              tag: "not-found",
              datasourceType: "google-drive",
              datasourceId: "ds-1",
              retryable: false,
              message: "no file at /missing.pdf",
            }),
          ),
        }),
    });

    const result = await handler(
      { datasourceId: "ds-1", path: "/missing.pdf" },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toContain("/missing.pdf");
    }
  });
});
