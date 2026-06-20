// OneDriveClient strategy tests — Phase 7 of add-fs-datasource-engine.
//
// The Microsoft Graph SDK (`@microsoft/microsoft-graph-client`) has no
// community-standard command-level mock akin to `aws-sdk-client-mock`. The
// accepted pattern is constructor-injection + a plain test double that
// implements the fluent `client.api(path).<verb>()` chain. Tests supply a
// `graphFactory` + a `fetchImpl` to the factory function:
//
//   - `graphFactory(token)` returns the fake Graph client; the strategy
//     re-invokes it when it needs a freshly-authed client (after a token
//     refresh).
//   - `fetchImpl` is used for the large-file resumable-upload PUTs (which go
//     to an `uploadUrl` returned by `/createUploadSession`, NOT through the
//     Graph client) AND for the OAuth token-refresh request to
//     `https://login.microsoftonline.com/.../oauth2/v2.0/token`.
//
// Scenarios covered here mirror the tasks.md 7.2 checklist:
//   list (by path and by drive-item-id handle), upload (resumable-session
//   for >4MB, simple PUT for smaller), delete, getMetadata, search (Graph
//   `search(q='...')` endpoint), authenticate (OAuth intent), refreshToken,
//   normalizeError for Graph error codes, and getQuota against `/me/drive`.

import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  OAuthIntent,
  StoredCredentials,
} from "@ft5/ipc-contracts";
import { DatasourceError, providers } from "@ft5/ipc-contracts";

import type { BaseClientContext, CredentialStore } from "../base-client.js";
import {
  createOneDriveClient,
  OneDriveClient,
  type GraphClientLike,
  type GraphRequestBuilderLike,
} from "./onedrive-client.js";

// ---------------------------------------------------------------------------
// Fake Graph client
// ---------------------------------------------------------------------------

interface VerbResponder {
  get?: (...args: unknown[]) => unknown;
  post?: (body?: unknown) => unknown;
  put?: (body?: unknown) => unknown;
  patch?: (body?: unknown) => unknown;
  delete?: (...args: unknown[]) => unknown;
}

/**
 * Construct a fake `GraphClientLike`. `responders` is a path -> verb-map:
 * the first path that matches via `startsWith` (prefix semantics) wins.
 * Values are either plain objects (resolved as the response) or callables
 * that may throw to simulate an SDK rejection.
 */
function makeFakeGraph(
  responders: Array<{ match: string; verbs: VerbResponder }>,
): {
  client: GraphClientLike;
  apiCalls: string[];
  /**
   * Records every `.query(values)` call as `{ path, values }` so pagination
   * tests can assert `$top` forwarding (add-engine-listdirectory-pagination
   * §3.2). The real `@microsoft/microsoft-graph-client` forwards query
   * parameters via `.query()`; the previous no-op fake discarded them.
   */
  queryCalls: Array<{ path: string; values: Record<string, unknown> }>;
} {
  const apiCalls: string[] = [];
  const queryCalls: Array<{ path: string; values: Record<string, unknown> }> =
    [];
  const client: GraphClientLike = {
    api(path: string) {
      apiCalls.push(path);
      const match = responders.find((r) => path.startsWith(r.match));
      const builder: GraphRequestBuilderLike = {
        header: () => builder,
        headers: () => builder,
        query: (values: Record<string, unknown>) => {
          queryCalls.push({ path, values });
          return builder;
        },
        select: () => builder,
        expand: () => builder,
        async get() {
          if (!match?.verbs.get) {
            throw Object.assign(new Error("no-get-responder-for " + path), {
              statusCode: 500,
            });
          }
          const r = match.verbs.get();
          return r;
        },
        async post(body?: unknown) {
          if (!match?.verbs.post) {
            throw Object.assign(new Error("no-post-responder-for " + path), {
              statusCode: 500,
            });
          }
          return match.verbs.post(body);
        },
        async put(body?: unknown) {
          if (!match?.verbs.put) {
            throw Object.assign(new Error("no-put-responder-for " + path), {
              statusCode: 500,
            });
          }
          return match.verbs.put(body);
        },
        async patch(body?: unknown) {
          if (!match?.verbs.patch) {
            throw Object.assign(new Error("no-patch-responder-for " + path), {
              statusCode: 500,
            });
          }
          return match.verbs.patch(body);
        },
        async delete() {
          if (!match?.verbs.delete) {
            throw Object.assign(new Error("no-delete-responder-for " + path), {
              statusCode: 500,
            });
          }
          return match.verbs.delete();
        },
      };
      return builder;
    },
  };
  return { client, apiCalls, queryCalls };
}

// ---------------------------------------------------------------------------
// Credentials + harness
// ---------------------------------------------------------------------------

function makeCreds(
  overrides: Partial<{
    accessToken: string;
    refreshToken: string;
    clientId: string;
    tenantId: string;
    redirectUri: string;
  }> = {},
): StoredCredentials {
  return {
    providerId: "onedrive",
    authResult: {
      accessToken: overrides.accessToken ?? "access-tok",
      ...(overrides.refreshToken !== undefined
        ? { refreshToken: overrides.refreshToken }
        : { refreshToken: "refresh-tok" }),
      meta: {
        clientId: overrides.clientId ?? "test-client-id",
        tenantId: overrides.tenantId ?? "common",
        redirectUri:
          overrides.redirectUri ?? "http://localhost:3000/oauth/callback",
      },
    },
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeStore(): CredentialStore {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  };
}

function makeHarness(options: {
  graph: GraphClientLike | ((token: string) => GraphClientLike);
  fetchImpl?: typeof fetch;
  credsOverrides?: Parameters<typeof makeCreds>[0];
}): {
  client: OneDriveClient;
  store: CredentialStore;
} {
  const store = makeStore();
  const ctx: BaseClientContext = {
    credentialStore: store,
    providerDescriptor: providers.onedrive,
  };
  const graphFactory =
    typeof options.graph === "function"
      ? options.graph
      : () => options.graph as GraphClientLike;
  const client = createOneDriveClient(
    "ds-od-1",
    makeCreds(options.credsOverrides ?? {}),
    ctx,
    {
      graphFactory,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    },
  ) as OneDriveClient;
  createdClients.push(client);
  return { client, store };
}

// Track every client created through `makeHarness` so `afterEach` can dispose
// each one. `dispose()` is a contract-stable no-op post
// migrate-engine-events-to-consumer (no bus subscription to release), but the
// loop keeps the dispose-idempotency contract exercised across the suite.
const createdClients: OneDriveClient[] = [];

beforeEach(() => {
  // No global state; fakes are per-test.
});

afterEach(() => {
  for (const c of createdClients) {
    try {
      c.dispose();
    } catch {
      // ignore — dispose must be idempotent, and a throwing subclass is the
      // bug the contract prevents.
    }
  }
  createdClients.length = 0;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// listDirectory
// ---------------------------------------------------------------------------

describe("OneDriveClient — listDirectory", () => {
  it("lists by path — addresses /me/drive/root:<path>:/children and maps response to DatasourceFileEntry", async () => {
    const { client, apiCalls } = (() => {
      const { client, apiCalls } = makeFakeGraph([
        {
          match: "/me/drive/root:/photos:/children",
          verbs: {
            get: () => ({
              value: [
                {
                  id: "drive-item-folder-1",
                  name: "2024",
                  folder: { childCount: 3 },
                  lastModifiedDateTime: "2024-06-01T00:00:00Z",
                  parentReference: { path: "/drive/root:/photos" },
                },
                {
                  id: "drive-item-file-1",
                  name: "hero.jpg",
                  file: { mimeType: "image/jpeg" },
                  size: 123,
                  lastModifiedDateTime: "2024-06-02T00:00:00Z",
                  parentReference: { path: "/drive/root:/photos" },
                },
              ],
            }),
          },
        },
      ]);
      return { client, apiCalls };
    })();
    const h = makeHarness({ graph: client });
    const { entries } = await h.client.listDirectory({ kind: "path", path: "/photos" });
    expect(entries).toHaveLength(2);
    const folder = entries.find((e) => e.kind === "folder");
    expect(folder).toBeDefined();
    expect(folder!.path).toBe("/photos/2024");
    expect(folder!.handle).toBe("drive-item-folder-1");
    expect(folder!.name).toBe("2024");
    expect(folder!.mimeFamily).toBe("folder");

    const file = entries.find((e) => e.kind === "file");
    expect(file).toBeDefined();
    expect(file!.path).toBe("/photos/hero.jpg");
    expect(file!.handle).toBe("drive-item-file-1");
    expect(file!.size).toBe(123);
    expect(file!.mimeFamily).toBe("image");

    expect(apiCalls[0]).toBe("/me/drive/root:/photos:/children");
  });

  it("lists root by path — addresses /me/drive/root/children", async () => {
    const { client, apiCalls } = makeFakeGraph([
      {
        match: "/me/drive/root/children",
        verbs: { get: () => ({ value: [] }) },
      },
    ]);
    const h = makeHarness({ graph: client });
    await h.client.listDirectory({ kind: "path", path: "/" });
    expect(apiCalls[0]).toBe("/me/drive/root/children");
  });

  it("lists by handle — addresses /me/drive/items/<id>/children (no path resolution round-trip)", async () => {
    const { client, apiCalls } = makeFakeGraph([
      {
        match: "/me/drive/items/ITEM-123/children",
        verbs: { get: () => ({ value: [] }) },
      },
    ]);
    const h = makeHarness({ graph: client });
    await h.client.listDirectory({ kind: "handle", handle: "ITEM-123" });
    expect(apiCalls).toEqual(["/me/drive/items/ITEM-123/children"]);
  });

  // -------------------------------------------------------------------------
  // add-engine-listdirectory-pagination §3 — cursor pagination
  // -------------------------------------------------------------------------

  it("first page with default page size: no $top query, uses Graph default, nextCursor null when no @odata.nextLink", async () => {
    const { client, apiCalls, queryCalls } = makeFakeGraph([
      {
        match: "/me/drive/root/children",
        verbs: { get: () => ({ value: [] }) },
      },
    ]);
    const h = makeHarness({ graph: client });
    const result = await h.client.listDirectory({ kind: "path", path: "/" });

    expect(apiCalls[0]).toBe("/me/drive/root/children");
    // No pageSize → no $top forwarded (Graph default paging, §3.2).
    expect(queryCalls).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("first page with pageSize: forwards $top via .query()", async () => {
    const { client, queryCalls } = makeFakeGraph([
      {
        match: "/me/drive/root/children",
        verbs: { get: () => ({ value: [] }) },
      },
    ]);
    const h = makeHarness({ graph: client });
    await h.client.listDirectory({ kind: "path", path: "/" }, { pageSize: 200 });

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]!.values).toEqual({ $top: 200 });
  });

  it("clamps pageSize above the Graph $top ceiling (5000 → 999)", async () => {
    const { client, queryCalls } = makeFakeGraph([
      {
        match: "/me/drive/root/children",
        verbs: { get: () => ({ value: [] }) },
      },
    ]);
    const h = makeHarness({ graph: client });
    await h.client.listDirectory({ kind: "path", path: "/" }, { pageSize: 5000 });

    expect(queryCalls[0]!.values).toEqual({ $top: 999 });
  });

  it("surfaces @odata.nextLink as nextCursor when present", async () => {
    const nextLink =
      "https://graph.microsoft.com/v1.0/me/drive/root/children?$top=200&$skiptoken=ABC";
    const { client } = makeFakeGraph([
      {
        match: "/me/drive/root/children",
        verbs: {
          get: () => ({ value: [], "@odata.nextLink": nextLink }),
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    const result = await h.client.listDirectory({ kind: "path", path: "/" });
    expect(result.nextCursor).toBe(nextLink);
  });

  it("next page: passes a valid @odata.nextLink directly to .api(cursor) WITHOUT re-attaching $top", async () => {
    const cursor =
      "https://graph.microsoft.com/v1.0/me/drive/root/children?$top=200&$skiptoken=ABC";
    const { client, apiCalls, queryCalls } = makeFakeGraph([
      {
        match: "https://graph.microsoft.com/v1.0/",
        verbs: { get: () => ({ value: [] }) },
      },
    ]);
    const h = makeHarness({ graph: client });
    const result = await h.client.listDirectory(
      { kind: "path", path: "/" },
      { cursor, pageSize: 200 },
    );

    // The opaque nextLink is passed verbatim to .api().
    expect(apiCalls).toEqual([cursor]);
    // $top is already baked into the nextLink URL — do NOT re-attach it (§3.4).
    expect(queryCalls).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("next page with an invalid cursor prefix throws (engine 'provider-error', wire 'other') and issues NO network call (§3.3)", async () => {
    const { client, apiCalls } = makeFakeGraph([
      {
        match: "/me/drive/root/children",
        verbs: { get: () => ({ value: [] }) },
      },
    ]);
    const h = makeHarness({ graph: client });
    // Design §3.3 / Decision 8 specify the wire tag `"other"`, but `"other"`
    // is not an engine `DatasourceErrorTag` member — the engine throws
    // `provider-error`, which the wire layer collapses to `"other"`. We assert
    // the engine-layer tag here.
    await expect(
      h.client.listDirectory(
        { kind: "path", path: "/" },
        { cursor: "https://evil.example.com/v1.0/me/drive/root/children" },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof DatasourceError && e.tag === "provider-error",
    );
    // The guard fires BEFORE any Graph call.
    expect(apiCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getMetadata
// ---------------------------------------------------------------------------

describe("OneDriveClient — getMetadata", () => {
  it("addresses /me/drive/root:<path>: and maps response", async () => {
    const { client } = makeFakeGraph([
      {
        match: "/me/drive/root:/docs/readme.md:",
        verbs: {
          get: () => ({
            id: "readme-id",
            name: "readme.md",
            file: { mimeType: "text/markdown" },
            size: 42,
            lastModifiedDateTime: "2024-06-05T00:00:00Z",
            parentReference: { path: "/drive/root:/docs" },
          }),
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    const meta = await h.client.getMetadata({
      kind: "path",
      path: "/docs/readme.md",
    });
    expect(meta.kind).toBe("file");
    expect(meta.size).toBe(42);
    expect(meta.handle).toBe("readme-id");
    expect(meta.mimeFamily).toBe("document");
  });

  it("404/itemNotFound throws DatasourceError tag 'not-found'", async () => {
    const { client } = makeFakeGraph([
      {
        match: "/me/drive/root:/nope.txt:",
        verbs: {
          get: () => {
            throw Object.assign(new Error("itemNotFound"), {
              code: "itemNotFound",
              statusCode: 404,
            });
          },
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    await expect(
      h.client.getMetadata({ kind: "path", path: "/nope.txt" }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof DatasourceError && e.tag === "not-found",
    );
  });
});

// ---------------------------------------------------------------------------
// deleteFile
// ---------------------------------------------------------------------------

describe("OneDriveClient — deleteFile", () => {
  it("issues DELETE on /me/drive/root:<path>: and resolves to void", async () => {
    const { client, apiCalls } = makeFakeGraph([
      {
        match: "/me/drive/root:/todelete.txt:",
        verbs: { delete: () => undefined },
      },
    ]);
    const h = makeHarness({ graph: client });
    await expect(
      h.client.deleteFile({ kind: "path", path: "/todelete.txt" }),
    ).resolves.toBeUndefined();
    expect(apiCalls[0]).toBe("/me/drive/root:/todelete.txt:");
  });

  it("deleteFile by handle issues DELETE on /me/drive/items/<id>", async () => {
    const { client, apiCalls } = makeFakeGraph([
      {
        match: "/me/drive/items/ITEM-DEL",
        verbs: { delete: () => undefined },
      },
    ]);
    const h = makeHarness({ graph: client });
    await h.client.deleteFile({ kind: "handle", handle: "ITEM-DEL" });
    expect(apiCalls[0]).toBe("/me/drive/items/ITEM-DEL");
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe("OneDriveClient — search", () => {
  it("hits /me/drive/root/search(q='<query>') and maps the result set", async () => {
    const { client, apiCalls } = makeFakeGraph([
      {
        match: "/me/drive/root/search",
        verbs: {
          get: () => ({
            value: [
              {
                id: "hit-1",
                name: "alpha.jpg",
                file: { mimeType: "image/jpeg" },
                size: 1,
                lastModifiedDateTime: "2024-01-01T00:00:00Z",
                parentReference: { path: "/drive/root:/photos" },
              },
            ],
          }),
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    const results = await h.client.search("alpha");
    expect(results).toHaveLength(1);
    expect(results[0]!.handle).toBe("hit-1");
    expect(apiCalls[0]).toBe("/me/drive/root/search(q='alpha')");
  });

  it("search with scope addresses the scope path — /me/drive/root:<scope>:/search(q='...')", async () => {
    const { client, apiCalls } = makeFakeGraph([
      {
        match: "/me/drive/root:/photos:/search",
        verbs: { get: () => ({ value: [] }) },
      },
    ]);
    const h = makeHarness({ graph: client });
    await h.client.search("alpha", { kind: "path", path: "/photos" });
    expect(apiCalls[0]).toBe("/me/drive/root:/photos:/search(q='alpha')");
  });
});

// ---------------------------------------------------------------------------
// authenticate — OAuth intent
// ---------------------------------------------------------------------------

describe("OneDriveClient — authenticate", () => {
  it("returns an OAuth intent whose authorizeUrl contains client_id, redirect_uri, and scope", async () => {
    const { client } = makeFakeGraph([]);
    const h = makeHarness({
      graph: client,
      credsOverrides: {
        clientId: "app-xyz",
        tenantId: "tenant-42",
        redirectUri: "http://localhost/callback",
      },
    });
    const intent = (await h.client.authenticate()) as OAuthIntent;
    expect(intent.kind).toBe("oauth");
    expect(intent.authorizeUrl).toContain(
      "https://login.microsoftonline.com/tenant-42/oauth2/v2.0/authorize",
    );
    expect(intent.authorizeUrl).toContain("client_id=app-xyz");
    expect(intent.authorizeUrl).toContain(
      "redirect_uri=http%3A%2F%2Flocalhost%2Fcallback",
    );
    // Microsoft scopes for file read/write/offline access
    expect(intent.authorizeUrl).toContain("scope=");
    expect(intent.authorizeUrl).toContain("offline_access");
  });

  it("completeWith(code) posts to the token endpoint and returns an AuthResult", async () => {
    const { client } = makeFakeGraph([]);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "new-at",
          refresh_token: "new-rt",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const h = makeHarness({ graph: client, fetchImpl });
    const intent = (await h.client.authenticate()) as OAuthIntent;
    const result = await intent.completeWith("auth-code-123");
    expect(result.accessToken).toBe("new-at");
    expect(result.refreshToken).toBe("new-rt");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatch(
      /oauth2\/v2\.0\/token$/,
    );
  });
});

// ---------------------------------------------------------------------------
// refreshToken
// ---------------------------------------------------------------------------

describe("OneDriveClient — refreshToken", () => {
  it("POSTs grant_type=refresh_token to the token endpoint and returns the new AuthResult", async () => {
    const { client } = makeFakeGraph([]);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "refreshed-at",
          refresh_token: "refreshed-rt",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const h = makeHarness({ graph: client, fetchImpl });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refresh = (h.client as any).refreshTokenImpl.bind(h.client);
    const result = await refresh();
    expect(result.accessToken).toBe("refreshed-at");
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(call[0])).toMatch(/oauth2\/v2\.0\/token$/);
    // Body contains grant_type=refresh_token
    const body = (call[1] as { body: string }).body;
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=refresh-tok");
  });

  it("token endpoint returning invalid_grant throws DatasourceError tag 'auth-revoked'", async () => {
    const { client } = makeFakeGraph([]);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "bad" }),
        { status: 400 },
      ),
    ) as unknown as typeof fetch;
    const h = makeHarness({ graph: client, fetchImpl });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refresh = (h.client as any).refreshTokenImpl.bind(h.client);
    await expect(refresh()).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DatasourceError && e.tag === "auth-revoked",
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeError — Graph taxonomy coverage
// ---------------------------------------------------------------------------

describe("OneDriveClient — normalizeError taxonomy", () => {
  function normalize(
    client: OneDriveClient,
    raw: unknown,
  ): DatasourceError<"onedrive"> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (client as any).normalizeErrorImpl(raw);
  }

  it("InvalidAuthenticationToken / 401 → auth-expired", () => {
    const { client } = makeFakeGraph([]);
    const h = makeHarness({ graph: client });
    expect(
      normalize(h.client, { code: "InvalidAuthenticationToken", statusCode: 401 })
        .tag,
    ).toBe("auth-expired");
    expect(normalize(h.client, { statusCode: 401 }).tag).toBe("auth-expired");
  });

  it("unauthorized_client / invalid_grant → auth-revoked", () => {
    const { client } = makeFakeGraph([]);
    const h = makeHarness({ graph: client });
    expect(normalize(h.client, { code: "unauthorized_client" }).tag).toBe(
      "auth-revoked",
    );
    expect(normalize(h.client, { code: "invalid_grant" }).tag).toBe(
      "auth-revoked",
    );
  });

  it("itemNotFound / 404 → not-found", () => {
    const { client } = makeFakeGraph([]);
    const h = makeHarness({ graph: client });
    expect(normalize(h.client, { code: "itemNotFound" }).tag).toBe("not-found");
    expect(normalize(h.client, { statusCode: 404 }).tag).toBe("not-found");
  });

  it("nameAlreadyExists / 409 → conflict", () => {
    const { client } = makeFakeGraph([]);
    const h = makeHarness({ graph: client });
    expect(normalize(h.client, { code: "nameAlreadyExists" }).tag).toBe(
      "conflict",
    );
    expect(normalize(h.client, { statusCode: 409 }).tag).toBe("conflict");
  });

  it("activityLimitReached / 429 → rate-limited and reads retry-after header", () => {
    const { client } = makeFakeGraph([]);
    const h = makeHarness({ graph: client });
    const e = normalize(h.client, {
      code: "activityLimitReached",
      statusCode: 429,
      headers: { "retry-after": "7" },
    });
    expect(e.tag).toBe("rate-limited");
    expect(e.retryAfterMs).toBe(7000);
    expect(e.retryable).toBe(true);
  });

  it("network errors (ECONNRESET / ETIMEDOUT / NetworkError) → network-error retryable=true", () => {
    const { client } = makeFakeGraph([]);
    const h = makeHarness({ graph: client });
    expect(normalize(h.client, { code: "ECONNRESET" }).tag).toBe("network-error");
    expect(normalize(h.client, { code: "ETIMEDOUT" }).tag).toBe("network-error");
    expect(
      normalize(h.client, { name: "FetchError", message: "fetch failed" }).tag,
    ).toBe("network-error");
  });

  it("unknown → provider-error", () => {
    const { client } = makeFakeGraph([]);
    const h = makeHarness({ graph: client });
    expect(normalize(h.client, new Error("no idea")).tag).toBe("provider-error");
    expect(normalize(h.client, "just a string").tag).toBe("provider-error");
  });

  // -------------------------------------------------------------------------
  // Issue 4 — quotaLimitReached and accessDenied / 403
  // -------------------------------------------------------------------------

  it("quotaLimitReached → provider-error (non-retryable) and raw is preserved", () => {
    // The 8-tag taxonomy has no `quota-exceeded` slot. We map storage-quota
    // errors to `provider-error` with `retryable: false` — taxonomy expansion
    // is tracked as a follow-up, see the phase-7 review report.
    const { client } = makeFakeGraph([]);
    const h = makeHarness({ graph: client });
    const raw = {
      code: "quotaLimitReached",
      statusCode: 507,
      message: "drive-full",
    };
    const e = normalize(h.client, raw);
    expect(e.tag).toBe("provider-error");
    expect(e.retryable).toBe(false);
    expect(e.raw).toEqual(raw);
  });

  it("403 accessDenied with inner code `unauthenticated` / `invalidAuthenticationToken` / `revoked` → auth-revoked", () => {
    const { client } = makeFakeGraph([]);
    const h = makeHarness({ graph: client });
    // Graph returns 403 with an inner error code when consent is revoked.
    for (const innerCode of [
      "unauthenticated",
      "invalidAuthenticationToken",
      "revoked",
    ]) {
      const e = normalize(h.client, {
        statusCode: 403,
        code: "accessDenied",
        body: { error: { code: innerCode, message: "consent revoked" } },
      });
      expect(e.tag, `inner=${innerCode}`).toBe("auth-revoked");
      expect(e.retryable).toBe(false);
    }
  });

  it("403 accessDenied without a revoked-consent inner code → provider-error (non-retryable)", () => {
    const { client } = makeFakeGraph([]);
    const h = makeHarness({ graph: client });
    const e = normalize(h.client, {
      statusCode: 403,
      code: "accessDenied",
      message: "sharing-policy-denied",
    });
    expect(e.tag).toBe("provider-error");
    expect(e.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getQuota
// ---------------------------------------------------------------------------

describe("OneDriveClient — getQuota", () => {
  it("reads /me/drive and returns {used, quota} from the response", async () => {
    const { client } = makeFakeGraph([
      {
        match: "/me/drive",
        verbs: {
          get: () => ({
            quota: { total: 100_000, used: 42_000 },
          }),
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    const q = await h.client.getQuota();
    expect(q.used).toBe(42_000);
    expect(q.quota).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// uploadFile — small & large
// ---------------------------------------------------------------------------

describe("OneDriveClient — upload (simple PUT for <= 4MB)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "od-test-"));
  const smallFile = join(tmp, "small.bin");
  writeFileSync(smallFile, "small-content-fits-in-memory");

  it("PUTs to /me/drive/root:<parent>/<name>:/content and returns the created entry", async () => {
    const putBodies: unknown[] = [];
    const { client, apiCalls } = makeFakeGraph([
      {
        match: "/me/drive/root:/uploads/small.bin:/content",
        verbs: {
          put: (body) => {
            putBodies.push(body);
            return {
              id: "new-id-small",
              name: "small.bin",
              file: { mimeType: "application/octet-stream" },
              size: 28,
              lastModifiedDateTime: "2024-06-05T00:00:00Z",
              parentReference: { path: "/drive/root:/uploads" },
            };
          },
        },
      },
    ]);
    const onProgress = vi.fn<(loaded: number, total: number) => void>();
    const h = makeHarness({ graph: client });
    const entry = await h.client.uploadFile(
      { kind: "path", path: "/uploads" },
      { path: smallFile, name: "small.bin" },
      { onProgress },
    );
    expect(entry.path).toBe("/uploads/small.bin");
    expect(entry.handle).toBe("new-id-small");
    expect(apiCalls[0]).toBe("/me/drive/root:/uploads/small.bin:/content");
    // Body must be a Buffer, not a path-string (streaming from disk or in-mem buf)
    expect(putBodies[0]).toBeDefined();

    // The consumer's onProgress was invoked with monotonic loaded values.
    // Progress is the sole observable channel — the engine emits no events
    // (the bus was removed in migrate-engine-events-to-consumer).
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("OneDriveClient — upload (resumable session for > 4MB)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "od-test-big-"));
  const bigFile = join(tmp, "big.bin");
  // 5 MB of data -> triggers resumable-session path
  writeFileSync(bigFile, Buffer.alloc(5 * 1024 * 1024, 0x41));

  it("POSTs /createUploadSession then PUTs chunks to uploadUrl via fetch; emits progress", async () => {
    const { client: graphClient } = makeFakeGraph([
      {
        match: "/me/drive/root:/uploads/big.bin:/createUploadSession",
        verbs: {
          post: () => ({
            uploadUrl: "https://up.example.com/session/abc",
            expirationDateTime: "2099-01-01T00:00:00Z",
          }),
        },
      },
    ]);

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    // For a 5 MiB file with ~10 MiB chunk size, this is a single-chunk
    // upload; each call just returns the final-response body.
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({
          id: "new-id-big",
          name: "big.bin",
          file: { mimeType: "application/octet-stream" },
          size: 5 * 1024 * 1024,
          lastModifiedDateTime: "2024-06-05T00:00:00Z",
          parentReference: { path: "/drive/root:/uploads" },
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;

    const onProgress = vi.fn<(loaded: number, total: number) => void>();
    const h = makeHarness({ graph: graphClient, fetchImpl });
    const entry = await h.client.uploadFile(
      { kind: "path", path: "/uploads" },
      { path: bigFile, name: "big.bin" },
      { onProgress },
    );
    expect(entry.handle).toBe("new-id-big");
    expect(entry.path).toBe("/uploads/big.bin");
    expect(fetchCalls.length).toBeGreaterThan(0);
    // All PUTs went to the uploadUrl returned by the session
    for (const c of fetchCalls) {
      expect(c.url).toBe("https://up.example.com/session/abc");
      expect((c.init?.method ?? "").toUpperCase()).toBe("PUT");
    }

    // Progress is the sole observable channel — the engine emits no events
    // (the bus was removed in migrate-engine-events-to-consumer).
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Resumable upload — multi-chunk coverage (Phase 7 code-review Issue 1)
// ---------------------------------------------------------------------------
//
// UPLOAD_CHUNK_BYTES = 320 KiB * 32 = 10 MiB (10_485_760 bytes). Two fixtures:
//   - 25 MiB → 3 chunks (10 + 10 + 5) — exercises the TRAILING-`if
//     (pending.length > 0)` branch for the final small chunk.
//   - 30 MiB → 3 chunks (10 + 10 + 10) — exercises the INNER-LOOP
//     `isLast=true` branch where the last chunk is exactly UPLOAD_CHUNK_BYTES.

describe("OneDriveClient — resumable upload multi-chunk (Content-Range + isLast)", () => {
  const CHUNK = 320 * 1024 * 32; // must stay in sync with onedrive-client.ts

  function setupMultiChunkTest(totalBytes: number, expectedChunks: number[]) {
    const dir = mkdtempSync(join(tmpdir(), "od-multichunk-"));
    const file = join(dir, "huge.bin");
    writeFileSync(file, Buffer.alloc(totalBytes, 0x42));

    const { client: graphClient } = makeFakeGraph([
      {
        match: "/me/drive/root:/uploads/huge.bin:/createUploadSession",
        verbs: {
          post: () => ({
            uploadUrl: "https://up.example.com/session/multichunk",
            expirationDateTime: "2099-01-01T00:00:00Z",
          }),
        },
      },
    ]);

    const fetchCalls: Array<{
      url: string;
      method: string;
      contentRange: string;
      contentLength: string;
      bodyLength: number;
    }> = [];
    let callIdx = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body;
      const bodyLength = body instanceof Uint8Array ? body.byteLength : 0;
      fetchCalls.push({
        url: String(url),
        method: (init?.method ?? "").toUpperCase(),
        contentRange: hdrs["Content-Range"] ?? "",
        contentLength: hdrs["Content-Length"] ?? "",
        bodyLength,
      });
      const isLast = callIdx === expectedChunks.length - 1;
      callIdx += 1;
      // Interim chunks return 202 Accepted with no DriveItem; final returns
      // 201 Created with the DriveItem JSON. The strategy only parses the
      // final response.
      if (!isLast) {
        return new Response(
          JSON.stringify({ nextExpectedRanges: [`${callIdx * CHUNK}-`] }),
          { status: 202 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "final-id-last-response",
          name: "huge.bin",
          file: { mimeType: "application/octet-stream" },
          size: totalBytes,
          lastModifiedDateTime: "2024-06-05T00:00:00Z",
          parentReference: { path: "/drive/root:/uploads" },
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;

    return { file, dir, graphClient, fetchImpl, fetchCalls, totalBytes };
  }

  it("25 MiB → 3 chunks with the trailing chunk flushed via the post-loop branch; Content-Range headers match exactly and final entry carries the last response's driveItemId", async () => {
    const total = 25 * 1024 * 1024; // 26_214_400
    const expected = [CHUNK, CHUNK, total - 2 * CHUNK]; // [10 MiB, 10 MiB, 5 MiB]
    const { file, graphClient, fetchImpl, fetchCalls, totalBytes } =
      setupMultiChunkTest(total, expected);
    try {
      const h = makeHarness({ graph: graphClient, fetchImpl });
      const entry = await h.client.uploadFile(
        { kind: "path", path: "/uploads" },
        { path: file, name: "huge.bin" },
      );

      expect(entry.handle).toBe("final-id-last-response");
      expect(entry.path).toBe("/uploads/huge.bin");
      expect(fetchCalls).toHaveLength(3);

      // Every PUT targets the uploadUrl and is a PUT.
      for (const c of fetchCalls) {
        expect(c.url).toBe("https://up.example.com/session/multichunk");
        expect(c.method).toBe("PUT");
      }

      // Content-Range headers.
      expect(fetchCalls[0]!.contentRange).toBe(
        `bytes 0-${CHUNK - 1}/${totalBytes}`,
      );
      expect(fetchCalls[1]!.contentRange).toBe(
        `bytes ${CHUNK}-${2 * CHUNK - 1}/${totalBytes}`,
      );
      expect(fetchCalls[2]!.contentRange).toBe(
        `bytes ${2 * CHUNK}-${totalBytes - 1}/${totalBytes}`,
      );

      // Per-chunk Content-Length + body length
      expect(fetchCalls[0]!.contentLength).toBe(String(CHUNK));
      expect(fetchCalls[1]!.contentLength).toBe(String(CHUNK));
      expect(fetchCalls[2]!.contentLength).toBe(String(total - 2 * CHUNK));
      expect(fetchCalls[0]!.bodyLength).toBe(CHUNK);
      expect(fetchCalls[1]!.bodyLength).toBe(CHUNK);
      expect(fetchCalls[2]!.bodyLength).toBe(total - 2 * CHUNK);
    } finally {
      unlinkSync(file);
    }
  });

  it("30 MiB → 3 chunks where the last chunk is exactly UPLOAD_CHUNK_BYTES (inner-loop isLast branch)", async () => {
    const total = 30 * 1024 * 1024; // 31_457_280 — exact multiple of CHUNK
    const expected = [CHUNK, CHUNK, CHUNK];
    const { file, graphClient, fetchImpl, fetchCalls, totalBytes } =
      setupMultiChunkTest(total, expected);
    try {
      const h = makeHarness({ graph: graphClient, fetchImpl });
      const entry = await h.client.uploadFile(
        { kind: "path", path: "/uploads" },
        { path: file, name: "huge.bin" },
      );

      expect(entry.handle).toBe("final-id-last-response");
      expect(fetchCalls).toHaveLength(3);
      expect(fetchCalls[0]!.contentRange).toBe(
        `bytes 0-${CHUNK - 1}/${totalBytes}`,
      );
      expect(fetchCalls[1]!.contentRange).toBe(
        `bytes ${CHUNK}-${2 * CHUNK - 1}/${totalBytes}`,
      );
      expect(fetchCalls[2]!.contentRange).toBe(
        `bytes ${2 * CHUNK}-${totalBytes - 1}/${totalBytes}`,
      );
      for (const c of fetchCalls) {
        expect(c.bodyLength).toBe(CHUNK);
      }
    } finally {
      unlinkSync(file);
    }
  });
});

// ---------------------------------------------------------------------------
// AbortSignal-driven cancel — mid-resumable DELETE against a fresh
// AbortController (5s timeout); small-upload post-resolve abort branch
// ---------------------------------------------------------------------------

describe("OneDriveClient — signal-driven cancel (resumable session)", () => {
  const CHUNK = 320 * 1024 * 32;

  it("mid-chunk abort DELETEs the session URL with a fresh AbortController (NOT the user signal); rejects cancelled", async () => {
    const total = 25 * 1024 * 1024; // 25 MiB — forces resumable path
    const dir = mkdtempSync(join(tmpdir(), "od-cancel-"));
    const file = join(dir, "huge.bin");
    writeFileSync(file, Buffer.alloc(total, 0x42));

    const { client: graphClient } = makeFakeGraph([
      {
        match: "/me/drive/root:/uploads/huge.bin:/createUploadSession",
        verbs: {
          post: () => ({
            uploadUrl: "https://up.example.com/session/cancel",
            expirationDateTime: "2099-01-01T00:00:00Z",
          }),
        },
      },
    ]);

    const deleteCalls: Array<{
      url: string;
      method: string;
      signal?: AbortSignal | null;
    }> = [];
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "DELETE") {
          deleteCalls.push({
            url: String(_url),
            method,
            signal: init?.signal ?? null,
          });
          return new Response(null, { status: 204 });
        }
        if (method === "PUT") {
          const signal = init?.signal;
          if (signal?.aborted) {
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          }
          return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              );
            });
          });
        }
        return new Response("unexpected", { status: 500 });
      },
    ) as unknown as typeof fetch;

    try {
      const h = makeHarness({ graph: graphClient, fetchImpl });
      const controller = new AbortController();
      const uploadPromise = h.client.uploadFile(
        { kind: "path", path: "/uploads" },
        { path: file, name: "huge.bin" },
        { signal: controller.signal },
      );

      // Wait for the strategy to issue at least one chunk PUT — that
      // guarantees the abort listener is wired up.
      await vi.waitFor(() => {
        const methods = fetchImpl.mock.calls.map((c) => {
          const init = c[1] as RequestInit | undefined;
          return (init?.method ?? "").toUpperCase();
        });
        expect(methods).toContain("PUT");
      });

      controller.abort();

      await expect(uploadPromise).rejects.toSatisfy(
        (e: unknown) => e instanceof DatasourceError && e.tag === "cancelled",
      );

      // Exactly one DELETE to the session URL — issued against a FRESH
      // AbortController (NOT the user's signal). Forwarding the user's
      // signal would abort the cleanup itself, leaving the session
      // orphaned on Graph's side.
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0]!.url).toBe("https://up.example.com/session/cancel");
      expect(deleteCalls[0]!.method).toBe("DELETE");
      expect(deleteCalls[0]!.signal).not.toBe(controller.signal);
    } finally {
      unlinkSync(file);
    }
    void CHUNK;
  });

  it("small-upload post-resolve abort branch: signal aborts after Graph SDK PUT settled, strategy rejects cancelled", async () => {
    // The Graph SDK's `.put()` does not honor AbortSignal cleanly. The
    // strategy's contract (per migrate-upload-orchestration-out-of-engine
    // Decision 2) is to branch on `options.signal?.aborted` post-resolve
    // and reject with `tag: "cancelled"` to preserve cancellation
    // semantics on this code path.
    const dir = mkdtempSync(join(tmpdir(), "od-cancel-small-"));
    const file = join(dir, "small.bin");
    writeFileSync(file, Buffer.alloc(1024, 0x11)); // 1 KiB, under 4 MiB

    const { client: graphClient } = makeFakeGraph([
      {
        match: "/me/drive/root:/uploads/small.bin:/content",
        verbs: {
          put: () => ({
            id: "small-id",
            name: "small.bin",
            file: { mimeType: "application/octet-stream" },
            size: 1024,
            lastModifiedDateTime: "2024-06-05T00:00:00Z",
            parentReference: { path: "/drive/root:/uploads" },
          }),
        },
      },
    ]);
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;

    try {
      const h = makeHarness({ graph: graphClient, fetchImpl });
      const controller = new AbortController();
      // Pre-abort the controller so the post-resolve branch fires
      // synchronously when the Graph SDK PUT returns.
      controller.abort();

      await expect(
        h.client.uploadFile(
          { kind: "path", path: "/uploads" },
          { path: file, name: "small.bin" },
          { signal: controller.signal },
        ),
      ).rejects.toSatisfy(
        (e: unknown) => e instanceof DatasourceError && e.tag === "cancelled",
      );
    } finally {
      unlinkSync(file);
    }
  });
});

// ---------------------------------------------------------------------------
// LRU handle cache — invalidation on `deleted` (post-migrate-upload-
// orchestration-out-of-engine: the `file-created` arm was removed; upload
// success populates the cache internally inside `doUploadFileImpl`).
// ---------------------------------------------------------------------------

describe("OneDriveClient — path↔handle LRU invalidation", () => {
  it("resolves a path → driveItemId and the second call addresses /items/<id> (not /root:/<path>)", async () => {
    // Prime BOTH addressing variants so the test can tell which one the
    // second call used. Without the cache, the strategy would re-address by
    // path; with the cache, it short-circuits to `/items/<id>`.
    const { client, apiCalls } = makeFakeGraph([
      {
        match: "/me/drive/root:/docs/readme.md:",
        verbs: {
          get: () => ({
            id: "cached-id",
            name: "readme.md",
            file: { mimeType: "text/markdown" },
            size: 10,
            lastModifiedDateTime: "2024-06-01T00:00:00Z",
            parentReference: { path: "/drive/root:/docs" },
          }),
        },
      },
      {
        match: "/me/drive/items/cached-id",
        verbs: {
          get: () => ({
            id: "cached-id",
            name: "readme.md",
            file: { mimeType: "text/markdown" },
            size: 10,
            lastModifiedDateTime: "2024-06-01T00:00:00Z",
            parentReference: { path: "/drive/root:/docs" },
          }),
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    await h.client.getMetadata({ kind: "path", path: "/docs/readme.md" });
    await h.client.getMetadata({ kind: "path", path: "/docs/readme.md" });
    // First call used the path endpoint; second should route to /items/<id>.
    expect(apiCalls[0]).toBe("/me/drive/root:/docs/readme.md:");
    expect(apiCalls[1]).toBe("/me/drive/items/cached-id");
  });

  it("deleteFile of a cached path evicts the cached entry (inline eviction)", async () => {
    // The seed getMetadata resolves via path; the cached delete then routes
    // via /items/<id>. Prime both addressing forms.
    const { client: graphClient } = makeFakeGraph([
      {
        match: "/me/drive/root:/todelete.txt:",
        verbs: {
          get: () => ({
            id: "reborn-id",
            name: "todelete.txt",
            file: { mimeType: "text/plain" },
            size: 1,
            lastModifiedDateTime: "2024-06-01T00:00:00Z",
            parentReference: { path: "/drive/root:" },
          }),
        },
      },
      {
        match: "/me/drive/items/reborn-id",
        verbs: { delete: () => undefined },
      },
    ]);
    const h = makeHarness({ graph: graphClient });
    // Seed the cache
    await h.client.getMetadata({ kind: "path", path: "/todelete.txt" });
    // Verify the handle exists prior to delete
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cacheBefore = (h.client as any).pathHandleCache as Map<string, string>;
    expect(cacheBefore.get("/todelete.txt")).toBeDefined();

    await h.client.deleteFile({ kind: "path", path: "/todelete.txt" });
    // After deleteFile, the cached entry MUST be evicted (inline eviction —
    // no `deleted` bus event drives it; migrate-engine-cache-invalidation).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cacheAfter = (h.client as any).pathHandleCache as Map<string, string>;
    expect(cacheAfter.get("/todelete.txt")).toBeUndefined();
  });

  it("rename evicts the OLD cached path (migrate-engine-cache-invalidation)", async () => {
    const { client: graphClient } = makeFakeGraph([
      {
        match: "/me/drive/root:/old.txt:",
        verbs: {
          get: () => ({
            id: "FILE-X",
            name: "old.txt",
            file: { mimeType: "text/plain" },
            size: 12,
            lastModifiedDateTime: "2024-06-01T00:00:00Z",
            parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
          }),
        },
      },
      {
        match: "/me/drive/items/FILE-X",
        verbs: {
          get: () => ({
            id: "FILE-X",
            name: "old.txt",
            file: { mimeType: "text/plain" },
            size: 12,
            lastModifiedDateTime: "2024-06-01T00:00:00Z",
            parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
          }),
          patch: () => ({
            id: "FILE-X",
            name: "new.txt",
            file: { mimeType: "text/plain" },
            size: 12,
            lastModifiedDateTime: "2024-06-02T00:00:00Z",
            parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
          }),
        },
      },
      {
        match:
          "/me/drive/items/PARENT-ROOT/children?$filter=name%20eq%20'new.txt'",
        verbs: { get: () => ({ value: [] }) },
      },
    ]);
    const h = makeHarness({ graph: graphClient });
    await h.client.getMetadata({ kind: "path", path: "/old.txt" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = (h.client as any).pathHandleCache as Map<string, string>;
    expect(cache.get("/old.txt")).toBe("FILE-X");
    await h.client.rename({ kind: "path", path: "/old.txt" }, "new.txt", "fail");
    expect(cache.get("/old.txt")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// URL encoding — path segments, child names, and OData query values
// ---------------------------------------------------------------------------
//
// Phase 7 code-review Issue 2: `@microsoft/microsoft-graph-client` v3.0.7
// does URL joining/normalization in `GraphRequestUtil` but does NOT
// percent-encode path segments passed to `.api(path)`. Encoding is the
// strategy's responsibility. Characters like `#`, `?`, `&`, `%`, `+`, and
// space MUST be percent-encoded in:
//   - path segments (root-addressed reads/mutates),
//   - child `name` fragments (uploadFile / createUploadSession),
//   - OData `search(q='<v>')` values (after the embedded-quote doubling).
//
// The resumable-upload URL returned by Graph from `/createUploadSession` is
// already fully-formed — the strategy must NOT encode it.

describe("OneDriveClient — URL encoding", () => {
  it("getMetadata path segments are percent-encoded (space / # / & / + / %)", async () => {
    const rawPath = "/mix & match/file with # spaces + %.txt";
    const { client, apiCalls } = makeFakeGraph([
      {
        // Match on the literal encoded prefix — `#` and space and `&` MUST
        // be percent-encoded so they do not act as a URL fragment or
        // query separator.
        match: "/me/drive/root:/mix%20%26%20match",
        verbs: {
          get: () => ({
            id: "ok",
            name: "file with # spaces + %.txt",
            file: { mimeType: "text/plain" },
            size: 1,
            lastModifiedDateTime: "2024-06-01T00:00:00Z",
            parentReference: { path: "/drive/root:/mix & match" },
          }),
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    await h.client.getMetadata({ kind: "path", path: rawPath });
    const used = apiCalls[0]!;
    expect(used).toContain("%20"); // space
    expect(used).toContain("%23"); // #
    expect(used).toContain("%26"); // &
    expect(used).toContain("%2B"); // +
    expect(used).toContain("%25"); // %
    // The forward-slash separator must NOT be encoded.
    expect(used).toContain("/mix%20%26%20match/");
  });

  it("search encodes the OData query value (space / & / #) AFTER single-quote doubling", async () => {
    const { client, apiCalls } = makeFakeGraph([
      {
        match: "/me/drive/root/search",
        verbs: { get: () => ({ value: [] }) },
      },
    ]);
    const h = makeHarness({ graph: client });
    // Query has a single quote, ampersand, hash, space, plus — each must be
    // handled. The single quote is doubled for OData; URL-unsafe chars are
    // percent-encoded so the surrounding URL is unambiguous. `'` itself is
    // an RFC 3986 unreserved mark and stays literal after encoding (OData
    // sees `''` which it treats as an embedded single-quote).
    await h.client.search("it's a & b #x+y");
    const url = apiCalls[0]!;
    // OData quote-doubling is preserved (encodeURIComponent leaves `'` literal)
    expect(url).toContain("''");
    // Ampersand + hash must be encoded so they don't terminate the URL.
    expect(url).toContain("%26");
    expect(url).toContain("%23");
    // Space and plus must be encoded (plus especially — unencoded `+` means
    // space in application/x-www-form-urlencoded contexts, risking
    // ambiguity)
    expect(url).toContain("%20");
    expect(url).toContain("%2B");
    // And the literal raw chars must NOT appear unencoded inside the q=... body.
    // (Extract everything between `q='` and `')` and verify.)
    const qMatch = /search\(q='([^)]*)'\)/.exec(url);
    expect(qMatch).not.toBeNull();
    const qBody = qMatch![1]!;
    expect(qBody.includes(" ")).toBe(false);
    expect(qBody.includes("&")).toBe(false);
    expect(qBody.includes("#")).toBe(false);
    expect(qBody.includes("+")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------
//
// The engine event bus was removed in migrate-engine-events-to-consumer, and
// the constructor bus self-subscription was already removed by
// migrate-engine-cache-invalidation (cache eviction is inline in the mutating
// ops — doDeleteFileImpl / doRenameImpl). `dispose()` is therefore a
// contract-stable no-op; the only surviving contract is its idempotency.
// (Inline-eviction behavior is exercised by the LRU-invalidation describe
// above and by the shared strategy-contract suite.)

describe("OneDriveClient — dispose()", () => {
  it("dispose() is idempotent — calling twice does not throw", () => {
    const { client: graphClient } = makeFakeGraph([]);
    const h = makeHarness({ graph: graphClient });
    expect(() => {
      h.client.dispose();
      h.client.dispose();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// testConnection / status
// ---------------------------------------------------------------------------

describe("OneDriveClient — testConnection / status", () => {
  it("testConnection resolves on /me/drive success", async () => {
    const { client } = makeFakeGraph([
      {
        match: "/me/drive",
        verbs: { get: () => ({ id: "drive-id" }) },
      },
    ]);
    const h = makeHarness({ graph: client });
    await expect(h.client.testConnection()).resolves.toBeUndefined();
  });

  it("status returns 'connected' on /me/drive success", async () => {
    const { client } = makeFakeGraph([
      {
        match: "/me/drive",
        verbs: { get: () => ({ id: "drive-id" }) },
      },
    ]);
    const h = makeHarness({ graph: client });
    await expect(h.client.status()).resolves.toBe("connected");
  });
});

// ---------------------------------------------------------------------------
// rename — PATCH /me/drive/items/{id} with body {name}
// (add-engine-rename-download §8.1-§8.4, §8.8)
// ---------------------------------------------------------------------------
//
// Graph treats files and folders uniformly via the `driveItem` resource:
// `PATCH /me/drive/items/{id}` with body `{ name }` renames either kind.
// `kind` on the returned entry is read from the response's `folder` vs `file`
// facet (presence of `folder` → folder; otherwise file).
//
// Sibling-collision pre-check uses `?$filter=name eq '<encoded>'` on the
// parent's children — embedded directly in the api path so the test fake's
// prefix matcher captures it cleanly (mirrors the search test pattern).
//
// File-overwrite explicit deletion: when `conflictPolicy: "overwrite"` on a
// FILE, the strategy deletes the colliding sibling directly via
// `DELETE /me/drive/items/{siblingId}` BEFORE the PATCH — bypassing the public
// `deleteFile` wrapper so no `deleted` bus event fires (single-step UX per
// design.md Decision 7; same convention as Drive §7.4-§7.6).
//
// Directory-overwrite refusal mirrors Drive §7.5/§7.6 verbatim — the
// strategy probes the target's `folder` facet and throws `unsupported`
// before any PATCH is issued.

describe("OneDriveClient — doRenameImpl (PATCH /me/drive/items, kind via folder/file facet)", () => {
  it("renames a file via PATCH and resolves with the renamed entry (kind='file')", async () => {
    const patchBodies: unknown[] = [];
    const { client, apiCalls } = makeFakeGraph([
      // Path resolution for /old.txt
      {
        match: "/me/drive/root:/old.txt:",
        verbs: {
          get: () => ({
            id: "FILE-X",
            name: "old.txt",
            file: { mimeType: "text/plain" },
            size: 12,
            lastModifiedDateTime: "2024-06-01T00:00:00Z",
            parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
          }),
        },
      },
      // Sibling pre-check on `fail`: no existing sibling (children $filter).
      {
        match: "/me/drive/items/PARENT-ROOT/children?$filter=name%20eq%20'new.txt'",
        verbs: { get: () => ({ value: [] }) },
      },
      // PATCH on the resolved id.
      {
        match: "/me/drive/items/FILE-X",
        verbs: {
          patch: (body) => {
            patchBodies.push(body);
            return {
              id: "FILE-X",
              name: "new.txt",
              file: { mimeType: "text/plain" },
              size: 12,
              lastModifiedDateTime: "2024-06-02T00:00:00Z",
              parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
            };
          },
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    const entry = await h.client.rename(
      { kind: "path", path: "/old.txt" },
      "new.txt",
      "fail",
    );
    expect(entry.handle).toBe("FILE-X");
    expect(entry.name).toBe("new.txt");
    expect(entry.kind).toBe("file");
    expect(entry.mimeFamily).toBe("document");
    expect(entry.providerMetadata.driveItemId).toBe("FILE-X");
    // PATCH body carries the new name only.
    expect(patchBodies).toHaveLength(1);
    expect(patchBodies[0]).toMatchObject({ name: "new.txt" });
    // PATCH issued on the items/<id> URL.
    expect(apiCalls.some((u) => u === "/me/drive/items/FILE-X")).toBe(true);
  });

  it("renames a folder via PATCH — same uniform call shape; kind='folder' from response folder facet", async () => {
    const { client } = makeFakeGraph([
      {
        match: "/me/drive/root:/photos:",
        verbs: {
          get: () => ({
            id: "FOLDER-Y",
            name: "photos",
            folder: { childCount: 4 },
            lastModifiedDateTime: "2024-06-01T00:00:00Z",
            parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
          }),
        },
      },
      {
        match: "/me/drive/items/PARENT-ROOT/children?$filter=name%20eq%20'pictures'",
        verbs: { get: () => ({ value: [] }) },
      },
      {
        match: "/me/drive/items/FOLDER-Y",
        verbs: {
          patch: () => ({
            id: "FOLDER-Y",
            name: "pictures",
            folder: { childCount: 4 },
            lastModifiedDateTime: "2024-06-02T00:00:00Z",
            parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
          }),
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    const entry = await h.client.rename(
      { kind: "path", path: "/photos" },
      "pictures",
      "fail",
    );
    expect(entry.kind).toBe("folder");
    expect(entry.mimeFamily).toBe("folder");
    expect(entry.name).toBe("pictures");
  });
});

describe("OneDriveClient — doRenameImpl sibling-collision pre-check on `fail`", () => {
  it("issues a children $filter query before PATCH; if results, throws conflict { existingPath }", async () => {
    const patchCalls: unknown[] = [];
    const { client } = makeFakeGraph([
      {
        match: "/me/drive/root:/foo.txt:",
        verbs: {
          get: () => ({
            id: "FOO-ID",
            name: "foo.txt",
            file: { mimeType: "text/plain" },
            parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
          }),
        },
      },
      // Sibling-list query finds an existing /bar.txt
      {
        match: "/me/drive/items/PARENT-ROOT/children?$filter=name%20eq%20'bar.txt'",
        verbs: {
          get: () => ({
            value: [
              {
                id: "BAR-EXISTING",
                name: "bar.txt",
                file: { mimeType: "text/plain" },
                parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
              },
            ],
          }),
        },
      },
      // If the strategy issues PATCH the test will not see the throw expected.
      {
        match: "/me/drive/items/FOO-ID",
        verbs: {
          patch: (body) => {
            patchCalls.push(body);
            return {};
          },
        },
      },
    ]);
    const h = makeHarness({ graph: client });

    let caught: unknown;
    try {
      await h.client.rename(
        { kind: "path", path: "/foo.txt" },
        "bar.txt",
        "fail",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<"onedrive">;
    expect(err.tag).toBe("conflict");
    expect((err.raw as { existingPath?: string }).existingPath).toBe("/bar.txt");
    // No PATCH issued — pre-check short-circuited the rename.
    expect(patchCalls).toHaveLength(0);
  });
});

describe("OneDriveClient — doRenameImpl `overwrite` on a file deletes the colliding sibling", () => {
  it("when policy='overwrite' AND a sibling with the new name exists, deletes that sibling (via direct DELETE) THEN issues PATCH; resolves with the renamed entry", async () => {
    const deleteCalls: string[] = [];
    const patchCalls: unknown[] = [];
    const { client, apiCalls } = makeFakeGraph([
      // Path resolution for /old.txt
      {
        match: "/me/drive/root:/old.txt:",
        verbs: {
          get: () => ({
            id: "OLD-FILE",
            name: "old.txt",
            file: { mimeType: "text/plain" },
            parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
          }),
        },
      },
      // Pre-rename folder-facet probe — existing item is a file (no folder facet).
      // Resolves on the same /items/OLD-FILE URL but as a `get` rather than `patch`.
      {
        match: "/me/drive/items/OLD-FILE",
        verbs: {
          get: () => ({
            id: "OLD-FILE",
            file: { mimeType: "text/plain" },
          }),
          patch: (body) => {
            patchCalls.push(body);
            return {
              id: "OLD-FILE",
              name: "new.txt",
              file: { mimeType: "text/plain" },
              parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
            };
          },
        },
      },
      // Sibling list returns the colliding sibling.
      {
        match: "/me/drive/items/PARENT-ROOT/children?$filter=name%20eq%20'new.txt'",
        verbs: {
          get: () => ({
            value: [
              {
                id: "EXISTING-NEW",
                name: "new.txt",
                file: { mimeType: "text/plain" },
                parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
              },
            ],
          }),
        },
      },
      // Direct DELETE on the colliding sibling.
      {
        match: "/me/drive/items/EXISTING-NEW",
        verbs: {
          delete: () => {
            deleteCalls.push("EXISTING-NEW");
            return undefined;
          },
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    const entry = await h.client.rename(
      { kind: "path", path: "/old.txt" },
      "new.txt",
      "overwrite",
    );
    expect(entry.handle).toBe("OLD-FILE");
    expect(entry.name).toBe("new.txt");
    expect(deleteCalls).toEqual(["EXISTING-NEW"]);
    expect(patchCalls).toHaveLength(1);
    // The strategy-internal sibling cleanup issues a direct DELETE on the
    // colliding sibling URL (NOT via the public deleteFile primitive). The
    // engine emits no events at all post migrate-engine-events-to-consumer;
    // the direct DELETE is verified via deleteCalls / apiCalls below.
    expect(apiCalls.some((u) => u === "/me/drive/items/EXISTING-NEW")).toBe(
      true,
    );
  });
});

describe("OneDriveClient — doRenameImpl directory-overwrite refusal", () => {
  it("when target's folder facet is set AND policy === 'overwrite', throws unsupported with the spec-required message; no PATCH issued", async () => {
    const patchCalls: unknown[] = [];
    const { client } = makeFakeGraph([
      {
        match: "/me/drive/root:/photos:",
        verbs: {
          get: () => ({
            id: "FOLDER-Z",
            name: "photos",
            folder: { childCount: 1 },
            parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
          }),
        },
      },
      {
        match: "/me/drive/items/FOLDER-Z",
        verbs: {
          // Pre-rename folder-facet probe — returns a folder facet.
          get: () => ({
            id: "FOLDER-Z",
            folder: { childCount: 1 },
          }),
          patch: (body) => {
            patchCalls.push(body);
            return {};
          },
        },
      },
    ]);
    const h = makeHarness({ graph: client });

    let caught: unknown;
    try {
      await h.client.rename(
        { kind: "path", path: "/photos" },
        "pictures",
        "overwrite",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<"onedrive">;
    expect(err.tag).toBe("unsupported");
    expect(err.message).toBe(
      "directory rename with conflictPolicy 'overwrite' is not supported (would require recursive replacement)",
    );
    expect(patchCalls).toHaveLength(0);
  });
});

describe("OneDriveClient — doRenameImpl Graph 409 race normalizes to conflict", () => {
  it("if a race made the §8.2 pre-check pass but PATCH errors with 409, the strategy rejects with tag:conflict", async () => {
    // Pre-check passes (no children); PATCH fails with 409 (e.g., another
    // client created /bar.txt between the pre-check and the PATCH).
    const { client } = makeFakeGraph([
      {
        match: "/me/drive/root:/old.txt:",
        verbs: {
          get: () => ({
            id: "FILE-X",
            name: "old.txt",
            file: { mimeType: "text/plain" },
            parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
          }),
        },
      },
      {
        match: "/me/drive/items/PARENT-ROOT/children?$filter=name%20eq%20'bar.txt'",
        verbs: { get: () => ({ value: [] }) },
      },
      {
        match: "/me/drive/items/FILE-X",
        verbs: {
          patch: () => {
            throw Object.assign(new Error("nameAlreadyExists"), {
              code: "nameAlreadyExists",
              statusCode: 409,
            });
          },
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    let caught: unknown;
    try {
      await h.client.rename(
        { kind: "path", path: "/old.txt" },
        "bar.txt",
        "fail",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    expect((caught as DatasourceError<"onedrive">).tag).toBe("conflict");
  });
});

describe("OneDriveClient — doRenameImpl `keep-both` policy retries with suffix until success", () => {
  it("first sibling-list collides for `bar.pdf`, second collides for `bar-2.pdf`, third returns empty for `bar-3.pdf`; then PATCH with name='bar-3.pdf'; resolves with the suffixed entry", async () => {
    const patchBodies: unknown[] = [];
    const { client } = makeFakeGraph([
      {
        match: "/me/drive/root:/foo.pdf:",
        verbs: {
          get: () => ({
            id: "FOO-FILE",
            name: "foo.pdf",
            file: { mimeType: "application/pdf" },
            parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
          }),
        },
      },
      // bar.pdf collides
      {
        match: "/me/drive/items/PARENT-ROOT/children?$filter=name%20eq%20'bar.pdf'",
        verbs: {
          get: () => ({
            value: [
              {
                id: "BAR-EXISTING",
                name: "bar.pdf",
                file: { mimeType: "application/pdf" },
                parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
              },
            ],
          }),
        },
      },
      // bar-2.pdf collides
      {
        match: "/me/drive/items/PARENT-ROOT/children?$filter=name%20eq%20'bar-2.pdf'",
        verbs: {
          get: () => ({
            value: [
              {
                id: "BAR2-EXISTING",
                name: "bar-2.pdf",
                file: { mimeType: "application/pdf" },
                parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
              },
            ],
          }),
        },
      },
      // bar-3.pdf is free
      {
        match: "/me/drive/items/PARENT-ROOT/children?$filter=name%20eq%20'bar-3.pdf'",
        verbs: { get: () => ({ value: [] }) },
      },
      {
        match: "/me/drive/items/FOO-FILE",
        verbs: {
          patch: (body) => {
            patchBodies.push(body);
            return {
              id: "FOO-FILE",
              name: "bar-3.pdf",
              file: { mimeType: "application/pdf" },
              parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
            };
          },
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    const entry = await h.client.rename(
      { kind: "path", path: "/foo.pdf" },
      "bar.pdf",
      "keep-both",
    );
    expect(entry.name).toBe("bar-3.pdf");
    expect(entry.handle).toBe("FOO-FILE");
    expect(patchBodies).toHaveLength(1);
    expect(patchBodies[0]).toMatchObject({ name: "bar-3.pdf" });
  });

  it("after 99 collisions (newName + suffixes 2..99), throws DatasourceError { tag:'provider-error', message:'exhausted keep-both attempts' }; no PATCH issued", async () => {
    let listCalls = 0;
    const patchCalls: unknown[] = [];
    const { client } = makeFakeGraph([
      // Path resolution for /foo.pdf
      {
        match: "/me/drive/root:/foo.pdf:",
        verbs: {
          get: () => ({
            id: "FOO-FILE",
            name: "foo.pdf",
            file: { mimeType: "application/pdf" },
            parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
          }),
        },
      },
      // Catch-all collision responder for every $filter children query.
      {
        match: "/me/drive/items/PARENT-ROOT/children",
        verbs: {
          get: () => {
            listCalls++;
            return {
              value: [
                {
                  id: `COLLIDER-${listCalls}`,
                  name: "collide",
                  file: { mimeType: "application/pdf" },
                  parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
                },
              ],
            };
          },
        },
      },
      {
        match: "/me/drive/items/FOO-FILE",
        verbs: {
          patch: (body) => {
            patchCalls.push(body);
            return {};
          },
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    let caught: unknown;
    try {
      await h.client.rename(
        { kind: "path", path: "/foo.pdf" },
        "bar.pdf",
        "keep-both",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<"onedrive">;
    // Engine taxonomy uses `provider-error` for exhaustion (no `"other"`
    // tag exists in `DatasourceErrorTag`); the wire layer collapses
    // provider-error → tag: "other" before the renderer sees it.
    expect(err.tag).toBe("provider-error");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe("exhausted keep-both attempts");
    expect(listCalls).toBe(99);
    expect(patchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// downloadFile — fetch-based GET /me/drive/items/{id}/content stream
// (add-engine-rename-download §8.5-§8.7)
// ---------------------------------------------------------------------------
//
// OneDrive downloads use raw `fetch` against the Graph SDK's URL-equivalent
// `/me/drive/items/{id}/content`, NOT the Graph SDK fluent chain (the SDK's
// `.api(...).get()` returns a parsed JSON response, not a Node `Readable` /
// `ReadableStream`). The strategy converts the Web ReadableStream returned by
// `fetch` to a Node `Readable` via `Readable.fromWeb(...)`, wraps it in a
// `Transform` so byte counting is inline (mirrors Drive §7.7 — `Transform`
// avoids the timing race a `PassThrough` + `data` listener would introduce).
//
// The Transform's `_transform` invokes `options.onProgress(loaded, total)` per
// chunk — the SOLE progress channel. The engine emits no download events (the
// bus was removed in migrate-engine-events-to-consumer); the consumer (fs-sync)
// owns terminal handling off its own pipe-to-disk path. Mid-stream provider
// errors surface as a stream `error` carrying a normalized `DatasourceError`.

describe("OneDriveClient — doDownloadFileImpl (fetch /me/drive/items/{id}/content stream)", () => {
  it("calls fetch on /me/drive/items/<id>/content; resolves with stream + contentLength; onProgress fires with the final loaded byte count", async () => {
    const fixture = Buffer.from("hello-world-bytes");
    const { client: graphClient } = makeFakeGraph([
      // Path resolution for /hello.txt
      {
        match: "/me/drive/root:/hello.txt:",
        verbs: {
          get: () => ({
            id: "DL-ID",
            name: "hello.txt",
            file: { mimeType: "text/plain" },
            size: fixture.length,
            parentReference: { path: "/drive/root:", id: "PARENT-ROOT" },
          }),
        },
      },
    ]);
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(fixture, {
        status: 200,
        headers: { "content-length": String(fixture.length) },
      });
    }) as unknown as typeof fetch;
    const h = makeHarness({ graph: graphClient, fetchImpl });
    const progressTicks: Array<{ loaded: number; total: number | null }> = [];
    const result = await h.client.downloadFile(
      { kind: "path", path: "/hello.txt" },
      { onProgress: (loaded, total) => progressTicks.push({ loaded, total }) },
    );
    expect(result.contentLength).toBe(fixture.length);
    expect(result.contentRange).toBeUndefined();
    // Drain the stream so the inline byte-counting Transform fires onProgress.
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      result.stream.on("data", (c: Buffer) => chunks.push(c));
      result.stream.on("end", () => resolve());
      result.stream.on("error", reject);
    });
    expect(Buffer.concat(chunks).toString()).toBe(fixture.toString());
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain("/me/drive/items/DL-ID/content");

    // Progress is the sole observable channel — onProgress fired ≥1 time and
    // the final loaded equals the byte count (the engine emits no events).
    expect(progressTicks.length).toBeGreaterThanOrEqual(1);
    expect(progressTicks[progressTicks.length - 1]!.loaded).toBe(fixture.length);
  });

  it("forwards options.rangeStart > 0 as a Range:bytes=<n>- header into fetch and parses Content-Range from the 206 response", async () => {
    const partial = Buffer.from("PARTIAL");
    const total = 1024;
    const start = 16;
    const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      fetchCalls.push({ url: String(url), headers: hdrs });
      return new Response(partial, {
        status: 206,
        headers: {
          "content-length": String(partial.length),
          "content-range": `bytes ${start}-${start + partial.length - 1}/${total}`,
        },
      });
    }) as unknown as typeof fetch;
    const { client: graphClient } = makeFakeGraph([]);
    const h = makeHarness({ graph: graphClient, fetchImpl });
    const result = await h.client.downloadFile(
      { kind: "handle", handle: "RANGE-ID" },
      { rangeStart: start },
    );
    expect(result.contentLength).toBe(partial.length);
    expect(result.contentRange).toEqual({
      start,
      end: start + partial.length - 1,
      total,
    });
    // Drain to completion.
    await new Promise<void>((resolve, reject) => {
      result.stream.on("data", () => {});
      result.stream.on("end", () => resolve());
      result.stream.on("error", reject);
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.headers.Range).toBe(`bytes=${start}-`);
  });
});

describe("OneDriveClient — doDownloadFileImpl AbortSignal forwarding", () => {
  it("aborting the consumer signal errors the stream after the first chunk; onProgress reports up to the bytes seen at abort time (and below total)", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const sig = init?.signal as AbortSignal | undefined;
      // Build a Web ReadableStream that pushes one chunk then awaits abort.
      const body = new ReadableStream<Uint8Array>({
        start(controller2) {
          // Push first chunk synchronously.
          controller2.enqueue(new Uint8Array(2048));
        },
        pull(controller2) {
          // Await abort; reject the pull to error the stream.
          return new Promise<void>((_resolve, reject) => {
            sig?.addEventListener("abort", () => {
              const err = Object.assign(new Error("aborted"), {
                name: "AbortError",
              });
              try {
                controller2.error(err);
              } catch {
                // ignore
              }
              reject(err);
            });
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-length": "16384" },
      });
    }) as unknown as typeof fetch;
    const { client: graphClient } = makeFakeGraph([]);
    const h = makeHarness({ graph: graphClient, fetchImpl });
    const progressTicks: Array<{ loaded: number; total: number | null }> = [];
    const result = await h.client.downloadFile(
      { kind: "handle", handle: "CANCEL-ID" },
      {
        signal: controller.signal,
        onProgress: (loaded, total) => progressTicks.push({ loaded, total }),
      },
    );
    let bytesSeen = 0;
    let streamErrored = false;
    await new Promise<void>((resolve) => {
      result.stream.on("data", (c: Buffer) => {
        bytesSeen += c.length;
        if (bytesSeen >= 2048) controller.abort();
      });
      result.stream.on("error", () => {
        streamErrored = true;
        resolve();
      });
      result.stream.on("end", () => resolve());
    });
    // On abort the source stream errors → the byte-counting Transform is
    // destroyed with the normalized error → the consumer sees a stream
    // `error`. The engine emits no events; fs-sync classifies the cancel from
    // its own AbortController state.
    expect(streamErrored).toBe(true);
    // onProgress observed at least the first chunk and never exceeded it (the
    // source blocked on the abort after 2048 bytes; total advertised 16384).
    expect(progressTicks.length).toBeGreaterThanOrEqual(1);
    const lastTick = progressTicks[progressTicks.length - 1]!;
    expect(lastTick.loaded).toBeGreaterThanOrEqual(2048);
    expect(lastTick.loaded).toBeLessThan(16384);
  });
});

describe("OneDriveClient — doDownloadFileImpl mid-stream 401 → auth-expired stream error", () => {
  it("normalizes a mid-stream Graph 401 to tag:auth-expired; the stream surfaces a DatasourceError with that tag", async () => {
    const fetchImpl = vi.fn(async () => {
      // Push one chunk so byte counting runs once, then synthesize a
      // mid-stream 401 by erroring the underlying ReadableStream with a
      // Graph-shaped 401 error. The strategy's normalizeErrorImpl maps this
      // to tag:auth-expired; the byte-counting Transform is destroyed with
      // that normalized error, so the consumer's stream `error` listener
      // receives a DatasourceError tagged auth-expired.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(512));
          setTimeout(() => {
            const err401 = Object.assign(new Error("auth-expired-mid-stream"), {
              statusCode: 401,
              code: "InvalidAuthenticationToken",
            });
            try {
              controller.error(err401);
            } catch {
              // ignore
            }
          }, 5);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-length": "8192" },
      });
    }) as unknown as typeof fetch;
    const { client: graphClient } = makeFakeGraph([]);
    const h = makeHarness({ graph: graphClient, fetchImpl });
    const result = await h.client.downloadFile({
      kind: "handle",
      handle: "401-ID",
    });
    let caught: unknown;
    await new Promise<void>((resolve) => {
      result.stream.on("data", () => {});
      result.stream.on("end", () => resolve());
      result.stream.on("error", (err) => {
        caught = err;
        resolve();
      });
    });
    // The mid-stream 401 surfaces as a normalized DatasourceError on the
    // stream `error` event — directly assertable now that the engine no
    // longer routes it through a `download-failed` bus event.
    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<"onedrive">;
    expect(err.tag).toBe("auth-expired");
    expect(err.datasourceType).toBe("onedrive");
    expect(err.datasourceId).toBe("ds-od-1");
  });
});

// ---------------------------------------------------------------------------
// AbortError normalization (added by §8.6 — defensive branch in normalizeErrorImpl)
// ---------------------------------------------------------------------------
describe("OneDriveClient — normalizeError AbortError → cancelled", () => {
  it("AbortError name maps to tag:cancelled (not network-error)", () => {
    const { client } = makeFakeGraph([]);
    const h = makeHarness({ graph: client });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const normalize = (h.client as any).normalizeErrorImpl.bind(h.client);
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const out = normalize(err) as DatasourceError<"onedrive">;
    expect(out.tag).toBe("cancelled");
    expect(out.retryable).toBe(false);
  });
});
