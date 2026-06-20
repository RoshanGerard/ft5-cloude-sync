import { afterEach, describe, expect, it, vi } from "vitest";

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
    delete: vi.fn(),
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

// Engine `listDirectory` return shape (post add-engine-listdirectory-pagination):
// `{ entries, nextCursor }` (was a flat array). Helper keeps the test fixtures
// terse.
function page(
  entries: DatasourceFileEntry<"google-drive">[],
  nextCursor: string | null,
): { entries: DatasourceFileEntry<"google-drive">[]; nextCursor: string | null } {
  return { entries, nextCursor };
}

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("files:list handler", () => {
  it("first-page request omits cursor + pageSize; maps entries and surfaces nextCursor with truncated derived true", async () => {
    const engineEntry = makeEngineEntry({
      handle: "h-alpha",
      name: "alpha.txt",
      path: "/foo/alpha.txt",
      kind: "file",
    });
    const listDirectory = vi
      .fn()
      .mockResolvedValue(page([engineEntry], "tokA"));
    const client = makeFakeClient({ listDirectory });
    const handler = makeFilesListHandler({
      resolveClient: async () => client,
    });

    const result = await handler({ datasourceId: "ds-1", path: "/foo" }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // truncated is DERIVED — nextCursor !== null → true.
      expect(result.result.truncated).toBe(true);
      expect(result.result.nextCursor).toBe("tokA");
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
    // The options object carries cursor + pageSize, both undefined on the
    // first page (spec scenario "First-page request omits cursor and pageSize").
    expect(listDirectory).toHaveBeenCalledWith(
      { kind: "path", path: "/foo" },
      { cursor: undefined, pageSize: undefined },
    );
  });

  it("next-page request forwards cursor + pageSize; nextCursor null → truncated derived false", async () => {
    const engineEntry = makeEngineEntry({ handle: "h-last", name: "last.txt" });
    const listDirectory = vi
      .fn()
      .mockResolvedValue(page([engineEntry], null));
    const client = makeFakeClient({ listDirectory });
    const handler = makeFilesListHandler({ resolveClient: async () => client });

    const result = await handler(
      { datasourceId: "ds-1", path: "/foo", cursor: "tokA", pageSize: 500 },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.truncated).toBe(false);
      expect(result.result.nextCursor).toBeNull();
      expect(result.result.entries).toHaveLength(1);
    }
    expect(listDirectory).toHaveBeenCalledWith(
      { kind: "path", path: "/foo" },
      { cursor: "tokA", pageSize: 500 },
    );
  });

  it("auth-expired once then succeeds → refreshCredentials called exactly once, list returns (inner withAuthRefresh)", async () => {
    // migrate-engine-retry-policy-to-consumer §3.1 — the engine no longer
    // auto-refreshes; the handler wraps the engine call in `withAuthRefresh`
    // (the INNER ring; the env-retry loop is the OUTER ring). A stale-but-
    // refreshable token refreshes once and retries before any error surfaces.
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
      .mockResolvedValueOnce(page([engineEntry], null));
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
      expect(result.result.nextCursor).toBeNull();
    }
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(listDirectory).toHaveBeenCalledTimes(2);
  });

  it("auth-revoked engine error returns ok:false with tag:'auth-revoked' retryable:false (no env-retry)", async () => {
    const listDirectory = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: "auth-revoked",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: false,
        message: "token revoked",
      }),
    );
    const client = makeFakeClient({ listDirectory });
    const handler = makeFilesListHandler({
      resolveClient: async () => client,
    });

    const result = await handler({ datasourceId: "ds-1", path: "/" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("auth-revoked");
      expect(result.error.retryable).toBe(false);
    }
    // auth-revoked is NOT in the env-retry set → exactly one call, no back-off.
    expect(listDirectory).toHaveBeenCalledTimes(1);
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
    // `<InvalidDatasourceState>` can render.
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

  it("network-error from engine (single, non-retried via fake-timer flush) maps to tag:'disconnected' retryable:true", async () => {
    // Sanity guard for the engine network-error → wire `disconnected`
    // mapping. Network-error is `retryable: true`, so the env-retry loop
    // WILL re-attempt; this test injects it on every attempt and asserts
    // the terminal mapping (full timing covered by the exhaustion test).
    vi.useFakeTimers();
    const listDirectory = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: "network-error",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: true,
        message: "ENOTFOUND",
      }),
    );
    const client = makeFakeClient({ listDirectory });
    const handler = makeFilesListHandler({
      resolveClient: async () => client,
    });

    const pending = handler({ datasourceId: "ds-1", path: "/" }, ctx);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Engine `network-error` collapses to wire `disconnected` via
      // normalizeFilesError — the retry PREDICATE inspects the raw engine
      // tag, but the surfaced envelope carries the normalized wire tag.
      expect(result.error.tag).toBe("disconnected");
      expect(result.error.retryable).toBe(true);
    }
  });

  // ---- add-engine-listdirectory-pagination §6 env-retry scenarios --------

  it("transient network failure retries up to 4 attempts (2s/5s/7s) then succeeds", async () => {
    // Spec scenario "Transient network failure retries up to 4 attempts".
    vi.useFakeTimers();
    const engineEntry = makeEngineEntry({ handle: "h-ok", name: "ok.txt" });
    const netErr = () =>
      new DatasourceError({
        tag: "network-error",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: true,
        message: "ECONNRESET",
      });
    const listDirectory = vi
      .fn()
      .mockRejectedValueOnce(netErr())
      .mockRejectedValueOnce(netErr())
      .mockRejectedValueOnce(netErr())
      .mockResolvedValueOnce(page([engineEntry], null));
    const client = makeFakeClient({ listDirectory });
    const handler = makeFilesListHandler({ resolveClient: async () => client });

    const pending = handler({ datasourceId: "ds-1", path: "/" }, ctx);

    // Attempt 1 rejects synchronously-ish; advance the scheduled back-offs.
    // 2000ms before attempt 2, then 5000ms before attempt 3, then 7000ms
    // before attempt 4. Cumulative wall-time = 14_000ms.
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(7000);
    const result = await pending;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.entries).toHaveLength(1);
      expect(result.result.entries[0]!.id).toBe("h-ok");
      expect(result.result.nextCursor).toBeNull();
      expect(result.result.truncated).toBe(false);
    }
    expect(listDirectory).toHaveBeenCalledTimes(4);
    // Cumulative advancement was exactly 14s.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exhausted retries surface the last error (engine network-error → wire disconnected); 4 calls; no exhausted-retries tag", async () => {
    // Spec scenario "Exhausted retries surface the last error".
    vi.useFakeTimers();
    const listDirectory = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: "network-error",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: true,
        message: "ETIMEDOUT",
      }),
    );
    const client = makeFakeClient({ listDirectory });
    const handler = makeFilesListHandler({ resolveClient: async () => client });

    const pending = handler({ datasourceId: "ds-1", path: "/" }, ctx);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("disconnected");
      expect(result.error.retryable).toBe(true);
      // No new tag introduced.
      expect(result.error.tag).not.toBe("exhausted-retries");
    }
    expect(listDirectory).toHaveBeenCalledTimes(4);
  });

  it("rate-limited honors retryAfterMs when greater than scheduled back-off (max)", async () => {
    // Spec scenario "Rate-limited honors retryAfterMs when greater than
    // scheduled back-off": retryAfterMs=8000 > scheduled 2000 → wait 8000ms.
    vi.useFakeTimers();
    const engineEntry = makeEngineEntry({ handle: "h-rl", name: "rl.txt" });
    const listDirectory = vi
      .fn()
      .mockRejectedValueOnce(
        new DatasourceError({
          tag: "rate-limited",
          datasourceType: "google-drive",
          datasourceId: "ds-1",
          retryable: true,
          retryAfterMs: 8000,
          message: "429 Too Many Requests",
        }),
      )
      .mockResolvedValueOnce(page([engineEntry], null));
    const client = makeFakeClient({ listDirectory });
    const handler = makeFilesListHandler({ resolveClient: async () => client });

    const pending = handler({ datasourceId: "ds-1", path: "/" }, ctx);

    // Advancing only the scheduled 2000ms must NOT fire attempt 2 — the
    // honored wait is max(8000, 2000) = 8000ms.
    await vi.advanceTimersByTimeAsync(2000);
    expect(listDirectory).toHaveBeenCalledTimes(1);
    // Advance the remaining 6000ms to reach the 8000ms total → attempt 2.
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.entries[0]!.id).toBe("h-rl");
    }
    expect(listDirectory).toHaveBeenCalledTimes(2);
  });

  it("non-retryable provider-error (malformed cursor) returns immediately — one call, no back-off", async () => {
    // Spec scenario "Non-retryable `provider-error` (malformed cursor)
    // returns immediately". `provider-error` IS in the retry-tag set, but
    // `retryable: false` short-circuits the loop. Engine `provider-error`
    // collapses to wire `other` via normalizeFilesError.
    vi.useFakeTimers();
    const listDirectory = vi.fn().mockRejectedValue(
      new DatasourceError({
        tag: "provider-error",
        datasourceType: "onedrive",
        datasourceId: "ds-1",
        retryable: false,
        message: "malformed @odata.nextLink",
      }),
    );
    const client = makeFakeClient({ listDirectory });
    const handler = makeFilesListHandler({ resolveClient: async () => client });

    const pending = handler(
      { datasourceId: "ds-1", path: "/", cursor: "not-a-graph-url" },
      ctx,
    );
    // Flush any pending timers — there should be none (no back-off scheduled).
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.retryable).toBe(false);
    }
    expect(listDirectory).toHaveBeenCalledTimes(1);
  });
});
