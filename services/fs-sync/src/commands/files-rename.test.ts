import { describe, expect, it, vi } from "vitest";

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import type { DatasourceFileEntry, DatasourceType } from "@ft5/ipc-contracts";
import { DatasourceError, DatasourceErrorTag } from "@ft5/ipc-contracts";

import { makeFilesRenameHandler } from "./files-rename.js";

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
    rename: vi.fn(),
    downloadFile: vi.fn(),
    getQuota: vi.fn(),
    refreshCredentials: vi
      .fn()
      .mockResolvedValue({ accessToken: "new", refreshToken: "r" }),
    ...overrides,
  } as unknown as DatasourceClient<DatasourceType>;
}

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

const renamedEngineEntry: DatasourceFileEntry<"google-drive"> = {
  handle: "h-bar",
  kind: "file",
  name: "bar.pdf",
  path: "/parent/bar.pdf",
  size: 4096,
  mimeFamily: "document",
  modifiedAt: Date.parse("2026-04-28T00:00:00.000Z"),
  providerMetadata: {},
};

describe("files:rename handler", () => {
  it("happy path: forwards (target, newName, conflictPolicy) to client.rename and projects entry to FileEntry", async () => {
    const rename = vi.fn().mockResolvedValue(renamedEngineEntry);
    const client = makeFakeClient({ rename });
    const handler = makeFilesRenameHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-1",
        path: "/parent/foo.pdf",
        newName: "bar.pdf",
        conflictPolicy: "fail",
      },
      ctx,
    );

    // The handler MUST address by path when no handle is supplied (request
    // shape: `{ path }` only — kind is NOT carried per design.md Decision 1).
    expect(rename).toHaveBeenCalledWith(
      { kind: "path", path: "/parent/foo.pdf" },
      "bar.pdf",
      "fail",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Projection: engine `DatasourceFileEntry` → wire `FileEntry`.
      expect(result.result.entry.id).toBe("h-bar");
      expect(result.result.entry.kind).toBe("file");
      expect(result.result.entry.name).toBe("bar.pdf");
      expect(result.result.entry.path).toBe("/parent/bar.pdf");
      expect(result.result.entry.parentPath).toBe("/parent");
      expect(result.result.entry.modifiedAt).toBe("2026-04-28T00:00:00.000Z");
    }
  });

  it("addresses by handle when the request supplies one (handle-first per files-remove convention)", async () => {
    const rename = vi.fn().mockResolvedValue(renamedEngineEntry);
    const client = makeFakeClient({ rename });
    const handler = makeFilesRenameHandler({ resolveClient: async () => client });

    await handler(
      {
        datasourceId: "ds-1",
        path: "/parent/foo.pdf",
        handle: "h-foo",
        newName: "bar.pdf",
        conflictPolicy: "fail",
      },
      ctx,
    );

    expect(rename).toHaveBeenCalledWith(
      { kind: "handle", handle: "h-foo" },
      "bar.pdf",
      "fail",
    );
  });

  it("the handler does NOT inspect or carry `kind` (Decision 1) — request literal carries only path / handle / newName / conflictPolicy", async () => {
    const rename = vi.fn().mockResolvedValue(renamedEngineEntry);
    const client = makeFakeClient({ rename });
    const handler = makeFilesRenameHandler({ resolveClient: async () => client });

    // Compile-time invariant: the request shape has no `kind` field. The
    // strategy resolves kind within its own provider context.
    const request = {
      datasourceId: "ds-1",
      path: "/parent/foo.pdf",
      newName: "bar.pdf",
      conflictPolicy: "fail" as const,
    };
    // @ts-expect-error — proving `kind` is not part of the params shape
    request.kind = "file";

    await handler(request, ctx);
    // Forward call inspects only path/handle for target construction; the
    // engine call carries no kind beyond the Target discriminator.
    const callArgs = rename.mock.calls[0];
    expect(callArgs?.[0]).toEqual({ kind: "path", path: "/parent/foo.pdf" });
  });

  it("conflict (engine tag === 'conflict') maps to envelope error tag:'conflict' with existingPath", async () => {
    const rename = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: DatasourceErrorTag.Conflict,
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: false,
        raw: { existingPath: "/parent/bar.pdf" },
        message: "name already exists at /parent/bar.pdf",
      }),
    );
    const client = makeFakeClient({ rename });
    const handler = makeFilesRenameHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-1",
        path: "/parent/foo.pdf",
        newName: "bar.pdf",
        conflictPolicy: "fail",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Per design.md Decision 7 + spec.md scenario "Rename conflict
      // re-prompts via ConflictResolutionDialog": the envelope MUST carry
      // both `tag: "conflict"` and the colliding sibling path on
      // `existingPath` so the renderer's dialog can prompt the user with
      // the exact path.
      expect(result.error.tag).toBe("conflict");
      expect(result.error.message).toBe("name already exists at /parent/bar.pdf");
      expect(result.error.retryable).toBe(false);
      expect(result.error.existingPath).toBe("/parent/bar.pdf");
    }
  });

  it("unsupported (engine tag === 'unsupported') collapses to envelope tag:'other' with the strategy's message", async () => {
    const rename = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: DatasourceErrorTag.Unsupported,
        datasourceType: "amazon-s3",
        datasourceId: "ds-1",
        retryable: false,
        message: "S3 folder rename is not supported in this version",
      }),
    );
    const client = makeFakeClient({ rename });
    const handler = makeFilesRenameHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-1",
        path: "/backups",
        newName: "archive",
        conflictPolicy: "fail",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toBe(
        "S3 folder rename is not supported in this version",
      );
      expect(result.error.retryable).toBe(false);
    }
  });

  it("auth-expired once then succeeds → refreshCredentials called exactly once, rename retries and returns (withAuthRefresh)", async () => {
    // migrate-engine-retry-policy-to-consumer §3.5 — handler-owned
    // refresh-once/retry-once. The engine no longer auto-refreshes; the
    // handler wraps `client.rename` in `withAuthRefresh`. RED before the wrap
    // (raw auth-expired → ok:false), GREEN after (refresh + retry → ok:true).
    const rename = vi
      .fn()
      .mockRejectedValueOnce(
        new DatasourceError({
          tag: DatasourceErrorTag.AuthExpired,
          datasourceType: "onedrive",
          datasourceId: "ds-1",
          retryable: false,
          message: "token expired",
        }),
      )
      .mockResolvedValueOnce(renamedEngineEntry);
    const refreshCredentials = vi
      .fn()
      .mockResolvedValue({ accessToken: "new", refreshToken: "r" });
    const client = makeFakeClient({ rename, refreshCredentials });
    const handler = makeFilesRenameHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-1",
        path: "/parent/foo.pdf",
        newName: "bar.pdf",
        conflictPolicy: "fail",
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.entry.id).toBe("h-bar");
    }
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it("auth-expired AGAIN after refresh (dead token) → refreshCredentials called once, rename called twice, collapses to tag:'auth-revoked'", async () => {
    // Dead-token guard. `withAuthRefresh` refreshes ONCE then retries; a
    // second auth-expired propagates (no second refresh) and the handler's
    // catch normalizes it to the single user-facing reconnect tag
    // `auth-revoked`. The call-count assertions are load-bearing: without
    // them a tag-only check would pass even if the `withAuthRefresh` wrap
    // were absent (the engine surfaces auth-expired raw → also auth-revoked),
    // producing a false green. (Replaces the former always-reject
    // auth-expired→auth-revoked case, which had exactly that blind spot.)
    const rename = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: DatasourceErrorTag.AuthExpired,
        datasourceType: "onedrive",
        datasourceId: "ds-1",
        retryable: false,
        message: "token expired",
      }),
    );
    const refreshCredentials = vi
      .fn()
      .mockResolvedValue({ accessToken: "new", refreshToken: "r" });
    const client = makeFakeClient({ rename, refreshCredentials });
    const handler = makeFilesRenameHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-1",
        path: "/foo",
        newName: "bar",
        conflictPolicy: "fail",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("auth-revoked");
    }
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it("rate-limited preserves retryAfterMs and retryable:true", async () => {
    const rename = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: DatasourceErrorTag.RateLimited,
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: true,
        retryAfterMs: 30000,
        message: "too many requests",
      }),
    );
    const client = makeFakeClient({ rename });
    const handler = makeFilesRenameHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-1",
        path: "/foo.pdf",
        newName: "bar.pdf",
        conflictPolicy: "fail",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("rate-limited");
      expect(result.error.retryable).toBe(true);
      expect(result.error.retryAfterMs).toBe(30000);
    }
  });

  it("network-error maps to tag:'disconnected' (matches normalizeFilesError contract)", async () => {
    const rename = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: DatasourceErrorTag.NetworkError,
        datasourceType: "amazon-s3",
        datasourceId: "ds-1",
        retryable: true,
        message: "ECONNRESET",
      }),
    );
    const client = makeFakeClient({ rename });
    const handler = makeFilesRenameHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-1",
        path: "/foo.pdf",
        newName: "bar.pdf",
        conflictPolicy: "fail",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("disconnected");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("invalid-datasource passes through as tag:'invalid-datasource' (renderer renders <InvalidDatasourceState>)", async () => {
    const rename = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: DatasourceErrorTag.InvalidDatasource,
        datasourceType: "google-drive",
        datasourceId: "ds-misconfigured",
        retryable: false,
        message: "Credentials are missing — reconnect this datasource",
      }),
    );
    const client = makeFakeClient({ rename });
    const handler = makeFilesRenameHandler({ resolveClient: async () => client });

    const result = await handler(
      {
        datasourceId: "ds-misconfigured",
        path: "/foo.pdf",
        newName: "bar.pdf",
        conflictPolicy: "fail",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("invalid-datasource");
    }
  });

  it("resolveClient throws → envelope-level ok:false with tag:'other'", async () => {
    const handler = makeFilesRenameHandler({
      resolveClient: async () => {
        throw new Error("no credentials for datasourceId=ds-ghost");
      },
    });

    const result = await handler(
      {
        datasourceId: "ds-ghost",
        path: "/foo.pdf",
        newName: "bar.pdf",
        conflictPolicy: "fail",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toContain("ds-ghost");
    }
  });

  it("forwards conflictPolicy verbatim — 'overwrite' goes through unchanged so the strategy can drive its sibling-delete path", async () => {
    const rename = vi.fn().mockResolvedValue(renamedEngineEntry);
    const client = makeFakeClient({ rename });
    const handler = makeFilesRenameHandler({ resolveClient: async () => client });

    await handler(
      {
        datasourceId: "ds-1",
        path: "/parent/foo.pdf",
        newName: "bar.pdf",
        conflictPolicy: "overwrite",
      },
      ctx,
    );

    expect(rename).toHaveBeenCalledWith(
      { kind: "path", path: "/parent/foo.pdf" },
      "bar.pdf",
      "overwrite",
    );
  });

  it("forwards conflictPolicy 'keep-both' verbatim", async () => {
    const rename = vi.fn().mockResolvedValue(renamedEngineEntry);
    const client = makeFakeClient({ rename });
    const handler = makeFilesRenameHandler({ resolveClient: async () => client });

    await handler(
      {
        datasourceId: "ds-1",
        path: "/parent/foo.pdf",
        newName: "bar.pdf",
        conflictPolicy: "keep-both",
      },
      ctx,
    );

    expect(rename).toHaveBeenCalledWith(
      { kind: "path", path: "/parent/foo.pdf" },
      "bar.pdf",
      "keep-both",
    );
  });
});
