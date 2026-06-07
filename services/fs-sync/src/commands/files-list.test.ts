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
    refreshCredentials: vi
      .fn()
      .mockResolvedValue({ accessToken: "new", refreshToken: "r" }),
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

  it("auth-expired once then succeeds → refreshCredentials called exactly once, list returns (withAuthRefresh)", async () => {
    // migrate-engine-retry-policy-to-consumer §3.1 — the engine no longer
    // auto-refreshes; the handler wraps the engine call in `withAuthRefresh`
    // so a stale-but-refreshable token refreshes once and retries before any
    // error surfaces. RED before the wrap (the first auth-expired surfaces
    // raw → ok:false), GREEN after (refresh + retry → ok:true).
    const engineEntry = makeEngineEntry({ handle: "h-after", name: "after.txt" });
    const listDirectory = vi
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
      .mockResolvedValueOnce([engineEntry]);
    const refreshCredentials = vi
      .fn()
      .mockResolvedValue({ accessToken: "new", refreshToken: "r" });
    const client = makeFakeClient({ listDirectory, refreshCredentials });
    const handler = makeFilesListHandler({ resolveClient: async () => client });

    const result = await handler({ datasourceId: "ds-1", path: "/foo" }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.entries).toHaveLength(1);
      expect(result.result.entries[0]!.id).toBe("h-after");
    }
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(listDirectory).toHaveBeenCalledTimes(2);
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

  it("unknown datasourceId (resolveClient throws plain Error) returns ok:false with tag:'other'", async () => {
    // Regression guard — historic behavior for non-DatasourceError
    // throws stays unchanged after the new `invalid-datasource` branch
    // lands in normalizeFilesError (per add-invalid-datasource-state §6).
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

  it("missing-credentials (resolveClient throws DatasourceError tag='invalid-datasource') returns ok:false with tag:'invalid-datasource' (Decision 2)", async () => {
    // Per add-invalid-datasource-state §6.4 — when `resolveClient`
    // surfaces missing credentials as the typed
    // `DatasourceError({ tag: "invalid-datasource" })`, the
    // `files:list` handler's existing `try/catch → normalizeFilesError`
    // path propagates the new tag end-to-end so the renderer's
    // `<InvalidDatasourceState>` can render. Verifies the spec's
    // "no per-command handler should need changes" claim (§5.5).
    const handler = makeFilesListHandler({
      resolveClient: async () => {
        throw new DatasourceError({
          tag: "invalid-datasource",
          datasourceType: "google-drive",
          datasourceId: "ds-misconfigured",
          retryable: false,
          raw: "no-credentials-registered",
          message: "Credentials are missing — reconnect this datasource",
        });
      },
    });

    const result = await handler(
      { datasourceId: "ds-misconfigured", path: "/" },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("invalid-datasource");
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toMatch(/missing/i);
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
