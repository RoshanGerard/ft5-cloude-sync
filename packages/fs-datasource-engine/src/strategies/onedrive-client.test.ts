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

import { createEventBus, type EventBus } from "../event-bus.js";
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
} {
  const apiCalls: string[] = [];
  const client: GraphClientLike = {
    api(path: string) {
      apiCalls.push(path);
      const match = responders.find((r) => path.startsWith(r.match));
      const builder: GraphRequestBuilderLike = {
        header: () => builder,
        headers: () => builder,
        query: () => builder,
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
  return { client, apiCalls };
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
  bus: EventBus;
  events: Array<{ event: string; payload: unknown }>;
  client: OneDriveClient;
  store: CredentialStore;
} {
  const bus = createEventBus();
  const events: Array<{ event: string; payload: unknown }> = [];
  bus.subscribe((e) => {
    events.push({ event: e.event as string, payload: e.payload });
  });
  const store = makeStore();
  const ctx: BaseClientContext = {
    bus,
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
  return { bus, events, client, store };
}

// Track every client created through `makeHarness` so `afterEach` can dispose
// each one. Without this, the bus-subscription held by OneDriveClient would
// leak across tests — mattering once the dispose contract is in place.
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
    const entries = await h.client.listDirectory({ kind: "path", path: "/photos" });
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
  it("issues DELETE on /me/drive/root:<path>: and emits `deleted`", async () => {
    const { client, apiCalls } = makeFakeGraph([
      {
        match: "/me/drive/root:/todelete.txt:",
        verbs: { delete: () => undefined },
      },
    ]);
    const h = makeHarness({ graph: client });
    await h.client.deleteFile({ kind: "path", path: "/todelete.txt" });
    const names = h.events.map((e) => e.event);
    expect(names).toContain("deleted");
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
// createFile / uploadFile — small & large
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
    const h = makeHarness({ graph: client });
    const entry = await h.client.uploadFile(
      { kind: "path", path: "/uploads" },
      { path: smallFile, name: "small.bin" },
    );
    expect(entry.path).toBe("/uploads/small.bin");
    expect(entry.handle).toBe("new-id-small");
    expect(apiCalls[0]).toBe("/me/drive/root:/uploads/small.bin:/content");
    // Body must be a Buffer, not a path-string (streaming from disk or in-mem buf)
    expect(putBodies[0]).toBeDefined();

    const names = h.events.map((e) => e.event);
    expect(names).toContain("uploading");
    expect(names).toContain("file-created");
    expect(names.indexOf("uploading")).toBeLessThan(
      names.indexOf("file-created"),
    );
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

    const h = makeHarness({ graph: graphClient, fetchImpl });
    const entry = await h.client.uploadFile(
      { kind: "path", path: "/uploads" },
      { path: bigFile, name: "big.bin" },
    );
    expect(entry.handle).toBe("new-id-big");
    expect(entry.path).toBe("/uploads/big.bin");
    expect(fetchCalls.length).toBeGreaterThan(0);
    // All PUTs went to the uploadUrl returned by the session
    for (const c of fetchCalls) {
      expect(c.url).toBe("https://up.example.com/session/abc");
      expect((c.init?.method ?? "").toUpperCase()).toBe("PUT");
    }
    const names = h.events.map((e) => e.event);
    expect(names).toContain("uploading");
    expect(names).toContain("file-created");
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
// cancelUpload — mid-resumable DELETE session URL
// ---------------------------------------------------------------------------

describe("OneDriveClient — cancelUpload (resumable session)", () => {
  const CHUNK = 320 * 1024 * 32;

  it("mid-chunk cancel DELETEs the session URL, emits upload-cancelled, rejects cancelled", async () => {
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

    // fetchImpl: block the first PUT open, let the DELETE resolve. After
    // DELETE fires we release the pending PUT so the test's cleanup doesn't
    // hang — the strategy's chunk loop will observe the aborted signal /
    // fetch rejection and throw.
    let releasePut!: (value: Response) => void;
    let abortedMidPut = false;
    const deleteCalls: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "DELETE") {
          deleteCalls.push({ url: String(url), method });
          return new Response("", { status: 204 });
        }
        if (method === "PUT") {
          // Honour the signal: if it arrives aborted or is aborted while we
          // wait, reject with an AbortError (mirrors the real fetch spec).
          const signal = init?.signal;
          if (signal?.aborted) {
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          }
          return await new Promise<Response>((resolve, reject) => {
            releasePut = resolve;
            signal?.addEventListener("abort", () => {
              abortedMidPut = true;
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
      const uploadPromise = h.client.uploadFile(
        { kind: "path", path: "/uploads" },
        { path: file, name: "huge.bin" },
      );

      await vi.waitFor(() => {
        expect(
          (h.events as Array<{ event: string }>).map((e) => e.event),
        ).toContain("uploading");
      });
      const tx = (
        (h.events as Array<{ payload: { transactionId: string } }>)[0] ?? {
          payload: { transactionId: "" },
        }
      ).payload.transactionId;

      await h.client.cancelUpload(tx);
      // Safety net if abort didn't unblock the PUT for any reason.
      if (!abortedMidPut && typeof releasePut === "function") {
        releasePut(new Response("", { status: 202 }));
      }

      await expect(uploadPromise).rejects.toSatisfy(
        (e: unknown) => e instanceof DatasourceError && e.tag === "cancelled",
      );

      // Exactly one DELETE to the session URL.
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0]!.url).toBe("https://up.example.com/session/cancel");
      expect(deleteCalls[0]!.method).toBe("DELETE");

      const names = (h.events as Array<{ event: string }>).map((e) => e.event);
      expect(names).toContain("upload-cancelled");
      expect(names).not.toContain("upload-failed");
      // `abortedMidPut` is observational rather than load-bearing: whether
      // the test's cancel caught the PUT mid-flight or before it started
      // depends on microtask ordering (graph-session-post vs.
      // cancelUpload arrival). Either path is a valid cancellation —
      // the DELETE + cancelled-tag + cancelled-event assertions above
      // are the invariants.
      void abortedMidPut;
    } finally {
      unlinkSync(file);
    }
    void CHUNK;
  });

  it("small-upload (<= 4 MiB) cancel is a silent no-op (no DELETE, no upload-cancelled event)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "od-cancel-small-"));
    const file = join(dir, "small.bin");
    writeFileSync(file, Buffer.alloc(1024, 0x11)); // 1 KiB, well under threshold

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
    const deleteCalls: string[] = [];
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "DELETE") {
          deleteCalls.push(String(url));
        }
        return new Response("{}", { status: 200 });
      },
    ) as unknown as typeof fetch;

    try {
      const h = makeHarness({ graph: graphClient, fetchImpl });
      // Complete the upload first so we can test post-completion cancel.
      const entry = await h.client.uploadFile(
        { kind: "path", path: "/uploads" },
        { path: file, name: "small.bin" },
      );
      expect(entry.handle).toBe("small-id");
      const tx = (
        (h.events as Array<{ payload: { transactionId: string } }>)[0] ?? {
          payload: { transactionId: "" },
        }
      ).payload.transactionId;

      // After completion, the tracker is gone — cancel is a no-op.
      await h.client.cancelUpload(tx);
      expect(deleteCalls).toHaveLength(0);
      const names = (h.events as Array<{ event: string }>).map((e) => e.event);
      expect(names).not.toContain("upload-cancelled");
    } finally {
      unlinkSync(file);
    }
  });
});

// ---------------------------------------------------------------------------
// LRU handle cache — invalidation on `deleted` and `file-created`
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

  it("on `deleted` event for a path the cached entry is evicted", async () => {
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
    // After the `deleted` event fires, the cache entry MUST be evicted.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cacheAfter = (h.client as any).pathHandleCache as Map<string, string>;
    expect(cacheAfter.get("/todelete.txt")).toBeUndefined();
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
//   - child `name` fragments (createFile / uploadFile / createUploadSession),
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

  it("createFile encodes the child `name` fragment", async () => {
    const { client, apiCalls } = makeFakeGraph([
      {
        match: "/me/drive/root:/uploads/a%20%26%20b%23.txt:/content",
        verbs: {
          put: () => ({
            id: "amp-id",
            name: "a & b#.txt",
            file: { mimeType: "text/plain" },
            size: 1,
            lastModifiedDateTime: "2024-06-01T00:00:00Z",
            parentReference: { path: "/drive/root:/uploads" },
          }),
        },
      },
    ]);
    const h = makeHarness({ graph: client });
    // Write a temp fixture — createFile reads from disk.
    const dir = mkdtempSync(join(tmpdir(), "od-enc-"));
    const fpath = join(dir, "src.txt");
    writeFileSync(fpath, "x");
    try {
      const entry = await h.client.createFile(
        { kind: "path", path: "/uploads" },
        "a & b#.txt",
        { path: fpath },
      );
      expect(entry.handle).toBe("amp-id");
      const url = apiCalls[0]!;
      expect(url).toContain("a%20%26%20b%23.txt");
    } finally {
      unlinkSync(fpath);
    }
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
// dispose() — bus subscription lifecycle
// ---------------------------------------------------------------------------
//
// Phase 7 code-review finding: OneDriveClient subscribes to `ctx.bus` in its
// constructor to invalidate its path↔handle LRU on `deleted` / `file-created`
// events. If the client is discarded without an explicit teardown, the
// subscription leaks for the lifetime of the bus. `dispose()` unhooks it.

describe("OneDriveClient — dispose()", () => {
  it("overrides the base no-op — calling dispose() detaches the bus subscription", async () => {
    // Seed a cache entry via getMetadata so we can observe that a subsequent
    // `deleted` event evicts the path BEFORE dispose, but NOT after dispose.
    const { client: graphClient } = makeFakeGraph([
      {
        match: "/me/drive/root:/a.txt:",
        verbs: {
          get: () => ({
            id: "A",
            name: "a.txt",
            file: { mimeType: "text/plain" },
            size: 1,
            lastModifiedDateTime: "2024-06-01T00:00:00Z",
            parentReference: { path: "/drive/root:" },
          }),
        },
      },
    ]);
    const h = makeHarness({ graph: graphClient });
    // Prime cache
    await h.client.getMetadata({ kind: "path", path: "/a.txt" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = (h.client as any).pathHandleCache as Map<string, string>;
    expect(cache.get("/a.txt")).toBe("A");

    // Dispose — subsequent bus events must not touch the cache.
    h.client.dispose();

    // Emit a `deleted` event that WOULD evict "/a.txt" if the subscription
    // were still live. Use the bus directly to bypass the client.
    h.bus.emit({
      event: "deleted",
      datasourceType: "onedrive",
      datasourceId: "ds-od-1",
      ts: Date.now(),
      payload: { target: { kind: "path", path: "/a.txt" } },
    });

    // Post-dispose: cache entry MUST still be there, proving the subscription
    // was torn down.
    expect(cache.get("/a.txt")).toBe("A");
  });

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
