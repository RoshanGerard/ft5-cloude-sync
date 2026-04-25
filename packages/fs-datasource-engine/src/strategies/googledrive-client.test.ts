// GoogleDriveClient strategy tests — Phase 8 of add-fs-datasource-engine.
//
// The `googleapis` SDK has no community-standard command-level mock (unlike
// `aws-sdk-client-mock` for AWS). We duck-type the subset of the SDK we use
// into a `GoogleDriveClientLike` shape and inject a factory at test time.
// Tests supply a `driveFactory` + a `fetchImpl` to the strategy's factory:
//
//   - `driveFactory(accessToken)` returns a fake `{ files, about }`-shaped
//     object; the strategy re-invokes it when it needs a freshly-authed
//     client (after a token refresh).
//   - `fetchImpl` is used for the OAuth token endpoint (authorize-code
//     exchange + refresh) AND — when the SDK's resumable-upload abstraction
//     is insufficient — for direct chunked PUTs to the resumable session URL
//     returned by Drive.
//
// Scenarios covered here mirror the tasks.md 8.2 checklist:
//   list (files.list by `parents in`, by path AND by fileId handle), upload
//   (resumable with multi-chunk fixture), delete, getMetadata, search (Drive
//   Query), authenticate (OAuth intent), refreshToken, normalizeError for
//   Drive error shapes (including 403 `rateLimitExceeded` + inner-reason
//   mapping), getQuota (about.get), and the path-ambiguity resolution
//   specific to Drive (ambiguous + ambiguousSiblings populated on the
//   resolved entry's providerMetadata).

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
  createGoogleDriveClient,
  GoogleDriveClient,
  type GoogleDriveClientLike,
} from "./googledrive-client.js";

// ---------------------------------------------------------------------------
// Fake Drive SDK — matches GoogleDriveClientLike
// ---------------------------------------------------------------------------
//
// The SDK's `drive.files.list({q, orderBy, fields, pageSize, pageToken, ...})`
// returns `{ data: { files, nextPageToken } }`. We dispatch responses by
// matching on the `q` string (or on `fileId` for `.get` / `.delete`).

interface ListResult {
  files: Array<{
    id: string;
    name: string;
    mimeType?: string;
    parents?: string[];
    size?: string | number;
    modifiedTime?: string;
    createdTime?: string;
  }>;
  nextPageToken?: string;
}

interface ListResponder {
  /** Substring matched against the `q` parameter. First match wins. */
  qMatch: string;
  handler: (params: Record<string, unknown>) => ListResult;
}
interface GetResponder {
  fileId: string;
  handler: (params: Record<string, unknown>) => unknown;
}
interface DeleteResponder {
  fileId: string;
  handler: (params: Record<string, unknown>) => unknown;
}
interface CreateResponder {
  /** Substring matched against the `requestBody.name`; `"*"` matches any. */
  nameMatch: string;
  handler: (params: Record<string, unknown>) => unknown;
}

interface FakeDriveOptions {
  lists?: ListResponder[];
  gets?: GetResponder[];
  deletes?: DeleteResponder[];
  creates?: CreateResponder[];
  about?: (params: Record<string, unknown>) => unknown;
}

function makeFakeDrive(opts: FakeDriveOptions): {
  client: GoogleDriveClientLike;
  calls: {
    list: Array<Record<string, unknown>>;
    get: Array<Record<string, unknown>>;
    delete: Array<Record<string, unknown>>;
    create: Array<Record<string, unknown>>;
    about: Array<Record<string, unknown>>;
  };
} {
  const calls = {
    list: [] as Array<Record<string, unknown>>,
    get: [] as Array<Record<string, unknown>>,
    delete: [] as Array<Record<string, unknown>>,
    create: [] as Array<Record<string, unknown>>,
    about: [] as Array<Record<string, unknown>>,
  };
  const client: GoogleDriveClientLike = {
    files: {
      async list(params) {
        calls.list.push(params);
        const q = String(params.q ?? "");
        const match = (opts.lists ?? []).find((r) => q.includes(r.qMatch));
        if (!match) {
          throw makeGaxiosError(500, "no-list-responder", "internalError", {
            message: `no list responder matched q=${q}`,
          });
        }
        return { data: match.handler(params) };
      },
      async get(params) {
        calls.get.push(params);
        const fileId = String(params.fileId ?? "");
        const match = (opts.gets ?? []).find((r) => r.fileId === fileId);
        if (!match) {
          throw makeGaxiosError(404, "no-get-responder", "notFound", {
            message: `no get responder for fileId=${fileId}`,
          });
        }
        return { data: match.handler(params) };
      },
      async delete(params) {
        calls.delete.push(params);
        const fileId = String(params.fileId ?? "");
        const match = (opts.deletes ?? []).find((r) => r.fileId === fileId);
        if (!match) {
          throw makeGaxiosError(500, "no-delete-responder", "internalError", {
            message: `no delete responder for fileId=${fileId}`,
          });
        }
        return { data: match.handler(params) };
      },
      async create(params) {
        calls.create.push(params);
        const rb = (params.requestBody ?? {}) as { name?: string };
        const wantedName = rb.name ?? "";
        const match = (opts.creates ?? []).find(
          (r) => r.nameMatch === "*" || wantedName.includes(r.nameMatch),
        );
        if (!match) {
          throw makeGaxiosError(500, "no-create-responder", "internalError", {
            message: `no create responder for name=${wantedName}`,
          });
        }
        return { data: match.handler(params) };
      },
    },
    about: {
      async get(params) {
        calls.about.push(params);
        if (!opts.about) {
          throw makeGaxiosError(500, "no-about-responder", "internalError", {
            message: `no about responder`,
          });
        }
        return { data: opts.about(params) };
      },
    },
  };
  return { client, calls };
}

/** Build a GaxiosError-shaped object for fakes. Production `googleapis` SDK
 * throws `GaxiosError` with `response.status` + `response.data.error.{code,
 * message, errors}`. `code` at the top level mirrors `response.status` as a
 * string. The strategy's `normalizeErrorImpl` MUST handle both the
 * real-SDK shape AND the reduced synthetic shapes used in some tests — the
 * tests below also pass plain objects to `normalize()` to exercise the
 * defensive reads. */
function makeGaxiosError(
  status: number,
  message: string,
  reason: string,
  extra: {
    message?: string;
    headers?: Record<string, string>;
    innerMessage?: string;
  } = {},
): Error & Record<string, unknown> {
  const err = new Error(message) as Error & Record<string, unknown>;
  err.name = "GaxiosError";
  err.code = String(status);
  err.status = status;
  err.response = {
    status,
    headers: extra.headers ?? {},
    data: {
      error: {
        code: status,
        message: extra.innerMessage ?? message,
        errors: [{ reason, message: extra.innerMessage ?? message }],
      },
    },
  };
  return err;
}

// ---------------------------------------------------------------------------
// Credentials + harness
// ---------------------------------------------------------------------------

function makeCreds(
  overrides: Partial<{
    accessToken: string;
    refreshToken: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }> = {},
): StoredCredentials {
  return {
    providerId: "google-drive",
    authResult: {
      accessToken: overrides.accessToken ?? "access-tok",
      ...(overrides.refreshToken !== undefined
        ? { refreshToken: overrides.refreshToken }
        : { refreshToken: "refresh-tok" }),
      meta: {
        clientId: overrides.clientId ?? "test-client-id",
        clientSecret: overrides.clientSecret ?? "test-client-secret",
        redirectUri:
          overrides.redirectUri ?? "http://localhost:3000/oauth/callback",
        // All default creds include the full Drive scope so every pre-existing
        // test has a sufficient-scope baseline once the sufficiency check lands.
        scope: "https://www.googleapis.com/auth/drive",
      },
    },
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * Like `makeCreds` but controls `meta.scope`.
 *
 * When `scope` is `undefined`, the returned credential has NO `meta.scope`
 * field — this is what legacy credentials look like (pre-scope-backfill).
 * When `scope` is a string, `meta.scope` is set to that value.
 */
function makeCredsWithScope(
  scope: string | undefined,
  overrides: Parameters<typeof makeCreds>[0] = {},
): StoredCredentials {
  const base = makeCreds(overrides);
  const meta = base.authResult.meta as Record<string, unknown>;
  if (scope === undefined) {
    delete meta["scope"];
  } else {
    meta["scope"] = scope;
  }
  return base;
}

/**
 * Returns a `CredentialStore` that records every `put` call.
 * `get`/`delete` are no-ops, matching the default `makeStore` behaviour.
 */
function makeSpyStore(): {
  store: CredentialStore;
  puts: Array<{ id: string; creds: StoredCredentials }>;
} {
  const puts: Array<{ id: string; creds: StoredCredentials }> = [];
  const store: CredentialStore = {
    get: async () => null,
    put: async (id, creds) => {
      puts.push({ id, creds });
    },
    delete: async () => undefined,
  };
  return { store, puts };
}

function makeStore(): CredentialStore {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  };
}

function makeHarness(options: {
  drive: GoogleDriveClientLike | ((token: string) => GoogleDriveClientLike);
  fetchImpl?: typeof fetch;
  credsOverrides?: Parameters<typeof makeCreds>[0];
  /** Pass a fully-constructed StoredCredentials to bypass makeCreds entirely. */
  creds?: StoredCredentials;
  /** Override the credential store (e.g. a spy store). Default: makeStore(). */
  store?: CredentialStore;
}): {
  bus: EventBus;
  events: Array<{ event: string; payload: unknown }>;
  client: GoogleDriveClient;
  store: CredentialStore;
} {
  const bus = createEventBus();
  const events: Array<{ event: string; payload: unknown }> = [];
  bus.subscribe((e) => {
    events.push({ event: e.event as string, payload: e.payload });
  });
  const store = options.store ?? makeStore();
  const ctx: BaseClientContext = {
    bus,
    credentialStore: store,
    providerDescriptor: providers["google-drive"],
  };
  const driveFactory =
    typeof options.drive === "function"
      ? options.drive
      : () => options.drive as GoogleDriveClientLike;
  const resolvedCreds = options.creds ?? makeCreds(options.credsOverrides ?? {});
  const client = createGoogleDriveClient(
    "ds-gd-1",
    resolvedCreds,
    ctx,
    {
      driveFactory,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    },
  ) as GoogleDriveClient;
  createdClients.push(client);
  return { bus, events, client, store };
}

const createdClients: GoogleDriveClient[] = [];

beforeEach(() => {
  /* per-test fakes */
});

afterEach(() => {
  for (const c of createdClients) {
    try {
      c.dispose();
    } catch {
      /* idempotent */
    }
  }
  createdClients.length = 0;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// listDirectory
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — listDirectory", () => {
  it("lists root by path — queries files.list with q=\"'root' in parents\" and maps each row to a DatasourceFileEntry", async () => {
    const { client, calls } = makeFakeDrive({
      lists: [
        {
          qMatch: "'root' in parents",
          handler: () => ({
            files: [
              {
                id: "folder-1",
                name: "photos",
                mimeType: "application/vnd.google-apps.folder",
                parents: ["root"],
                modifiedTime: "2024-06-01T00:00:00Z",
                createdTime: "2024-01-01T00:00:00Z",
              },
              {
                id: "file-1",
                name: "hello.txt",
                mimeType: "text/plain",
                parents: ["root"],
                size: "42",
                modifiedTime: "2024-06-02T00:00:00Z",
                createdTime: "2024-01-02T00:00:00Z",
              },
            ],
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const entries = await h.client.listDirectory({ kind: "path", path: "/" });
    expect(entries).toHaveLength(2);
    const folder = entries.find((e) => e.kind === "folder");
    expect(folder).toBeDefined();
    expect(folder!.path).toBe("/photos");
    expect(folder!.handle).toBe("folder-1");
    expect(folder!.mimeFamily).toBe("folder");
    expect(folder!.providerMetadata.fileId).toBe("folder-1");

    const file = entries.find((e) => e.kind === "file");
    expect(file).toBeDefined();
    expect(file!.path).toBe("/hello.txt");
    expect(file!.handle).toBe("file-1");
    expect(file!.size).toBe(42);
    expect(file!.mimeFamily).toBe("document");
    expect(file!.providerMetadata.fileId).toBe("file-1");
    expect(file!.providerMetadata.mimeType).toBe("text/plain");

    expect(calls.list.length).toBeGreaterThan(0);
  });

  it("lists by handle — skips path resolution round-trip and queries q=\"'<fileId>' in parents\"", async () => {
    const { client, calls } = makeFakeDrive({
      lists: [
        {
          qMatch: "'FOLDER-123' in parents",
          handler: () => ({ files: [] }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    await h.client.listDirectory({ kind: "handle", handle: "FOLDER-123" });
    // Only one list call (no path walk)
    expect(calls.list).toHaveLength(1);
    expect(String(calls.list[0]!.q)).toContain("'FOLDER-123' in parents");
  });

  it("lists by path for nested folder — walks path segment by segment with name filters", async () => {
    // /photos/2024 → 1) resolve /photos under root, 2) resolve /2024 under
    // photos' fileId, 3) list children of 2024's fileId.
    const { client, calls } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='photos'",
          handler: () => ({
            files: [
              {
                id: "photos-id",
                name: "photos",
                mimeType: "application/vnd.google-apps.folder",
                parents: ["root"],
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
        {
          qMatch: "name='2024'",
          handler: () => ({
            files: [
              {
                id: "y2024-id",
                name: "2024",
                mimeType: "application/vnd.google-apps.folder",
                parents: ["photos-id"],
                createdTime: "2024-01-02T00:00:00Z",
              },
            ],
          }),
        },
        {
          qMatch: "'y2024-id' in parents",
          handler: () => ({ files: [] }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    await h.client.listDirectory({ kind: "path", path: "/photos/2024" });
    // Must have made at least 3 list calls (two resolves + one children)
    expect(calls.list.length).toBeGreaterThanOrEqual(3);
    // Every path-resolution call must use orderBy=createdTime asc so
    // "oldest first" is deterministic (required for ambiguity detection).
    const resolveCalls = calls.list.filter((c) =>
      String(c.q ?? "").includes("name="),
    );
    expect(resolveCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of resolveCalls) {
      expect(String(c.orderBy ?? "")).toContain("createdTime");
    }
  });
});

// ---------------------------------------------------------------------------
// path ambiguity — providerMetadata.ambiguous + ambiguousSiblings
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — path ambiguity surfacing", () => {
  it("when two files share (parent, name), getMetadata picks the first (oldest by createdTime asc) and populates ambiguous + ambiguousSiblings with the OTHER fileIds", async () => {
    // /dup.txt resolves to TWO files under root; resolver returns oldest.
    const { client } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='dup.txt'",
          handler: (params) => {
            // The strategy MUST pass orderBy: "createdTime asc".
            expect(String(params.orderBy ?? "")).toContain("createdTime");
            return {
              files: [
                {
                  id: "dup-first",
                  name: "dup.txt",
                  mimeType: "text/plain",
                  parents: ["root"],
                  size: "1",
                  modifiedTime: "2024-06-01T00:00:00Z",
                  createdTime: "2024-01-01T00:00:00Z",
                },
                {
                  id: "dup-second",
                  name: "dup.txt",
                  mimeType: "text/plain",
                  parents: ["root"],
                  size: "2",
                  modifiedTime: "2024-06-02T00:00:00Z",
                  createdTime: "2024-02-01T00:00:00Z",
                },
                {
                  id: "dup-third",
                  name: "dup.txt",
                  mimeType: "text/plain",
                  parents: ["root"],
                  size: "3",
                  modifiedTime: "2024-06-03T00:00:00Z",
                  createdTime: "2024-03-01T00:00:00Z",
                },
              ],
            };
          },
        },
      ],
      gets: [
        {
          fileId: "dup-first",
          handler: () => ({
            id: "dup-first",
            name: "dup.txt",
            mimeType: "text/plain",
            parents: ["root"],
            size: "1",
            modifiedTime: "2024-06-01T00:00:00Z",
            createdTime: "2024-01-01T00:00:00Z",
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const meta = await h.client.getMetadata({ kind: "path", path: "/dup.txt" });
    expect(meta.handle).toBe("dup-first");
    // Ambiguity surfaces on the entry's providerMetadata.
    expect(meta.providerMetadata.ambiguous).toBe(true);
    expect(meta.providerMetadata.ambiguousSiblings).toEqual([
      "dup-second",
      "dup-third",
    ]);
  });

  it("cache hit on an ambiguous path re-surfaces ambiguous + ambiguousSiblings on the returned entry (regression — cache previously dropped ambiguity metadata)", async () => {
    // Resolve once (walks), then resolve again (cache hit). Both must carry ambiguity.
    let listCallCount = 0;
    const { client } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='dup.txt'",
          handler: () => {
            listCallCount += 1;
            return {
              files: [
                {
                  id: "dup-first",
                  name: "dup.txt",
                  mimeType: "text/plain",
                  parents: ["root"],
                  size: "1",
                  modifiedTime: "2024-06-01T00:00:00Z",
                  createdTime: "2024-01-01T00:00:00Z",
                },
                {
                  id: "dup-second",
                  name: "dup.txt",
                  mimeType: "text/plain",
                  parents: ["root"],
                  size: "2",
                  modifiedTime: "2024-06-02T00:00:00Z",
                  createdTime: "2024-02-01T00:00:00Z",
                },
              ],
            };
          },
        },
      ],
      gets: [
        {
          fileId: "dup-first",
          handler: () => ({
            id: "dup-first",
            name: "dup.txt",
            mimeType: "text/plain",
            parents: ["root"],
            size: "1",
            modifiedTime: "2024-06-01T00:00:00Z",
            createdTime: "2024-01-01T00:00:00Z",
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });

    const meta1 = await h.client.getMetadata({
      kind: "path",
      path: "/dup.txt",
    });
    expect(meta1.providerMetadata.ambiguous).toBe(true);
    expect(meta1.providerMetadata.ambiguousSiblings).toEqual(["dup-second"]);
    const listsAfterFirst = listCallCount;

    const meta2 = await h.client.getMetadata({
      kind: "path",
      path: "/dup.txt",
    });
    // Cache hit — no additional resolve list call for the path.
    expect(listCallCount).toBe(listsAfterFirst);
    // But ambiguity MUST still surface on the second resolution.
    expect(meta2.providerMetadata.ambiguous).toBe(true);
    expect(meta2.providerMetadata.ambiguousSiblings).toEqual(["dup-second"]);
  });

  it("cache hit on a terminal-segment cached step (partial walk) still re-surfaces ambiguity on the terminal", async () => {
    // Prime the cache by resolving /folder/dup.txt once, then clear the
    // full-path entry only (simulate full-path eviction while parent cache
    // remains) and resolve again — ambiguity must be preserved via the
    // per-step cache entry for the terminal.
    const { client } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='folder'",
          handler: () => ({
            files: [
              {
                id: "folder-id",
                name: "folder",
                mimeType: "application/vnd.google-apps.folder",
                parents: ["root"],
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
        {
          qMatch: "name='dup.txt'",
          handler: () => ({
            files: [
              {
                id: "dup-A",
                name: "dup.txt",
                mimeType: "text/plain",
                parents: ["folder-id"],
                size: "1",
                createdTime: "2024-02-01T00:00:00Z",
              },
              {
                id: "dup-B",
                name: "dup.txt",
                mimeType: "text/plain",
                parents: ["folder-id"],
                size: "2",
                createdTime: "2024-03-01T00:00:00Z",
              },
            ],
          }),
        },
      ],
      gets: [
        {
          fileId: "dup-A",
          handler: () => ({
            id: "dup-A",
            name: "dup.txt",
            mimeType: "text/plain",
            parents: ["folder-id"],
            size: "1",
            createdTime: "2024-02-01T00:00:00Z",
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    // First resolution populates cache for /folder and /folder/dup.txt.
    const meta1 = await h.client.getMetadata({
      kind: "path",
      path: "/folder/dup.txt",
    });
    expect(meta1.providerMetadata.ambiguous).toBe(true);

    // Evict only the full-path entry, keep the parent step cache entry so
    // the next resolution takes the per-step-cache branch for the terminal.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = (h.client as any).pathHandleCache as Map<string, unknown>;
    cache.delete("/folder/dup.txt");

    const meta2 = await h.client.getMetadata({
      kind: "path",
      path: "/folder/dup.txt",
    });
    expect(meta2.providerMetadata.ambiguous).toBe(true);
    expect(meta2.providerMetadata.ambiguousSiblings).toEqual(["dup-B"]);
  });

  it("after a `deleted` bus event for the ambiguous path, the next resolution re-walks and re-surfaces ambiguity from the fresh list response", async () => {
    let listCallCount = 0;
    const { client } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='dup.txt'",
          handler: () => {
            listCallCount += 1;
            return {
              files: [
                {
                  id: "dup-first",
                  name: "dup.txt",
                  mimeType: "text/plain",
                  parents: ["root"],
                  size: "1",
                  createdTime: "2024-01-01T00:00:00Z",
                },
                {
                  id: "dup-second",
                  name: "dup.txt",
                  mimeType: "text/plain",
                  parents: ["root"],
                  size: "2",
                  createdTime: "2024-02-01T00:00:00Z",
                },
              ],
            };
          },
        },
      ],
      gets: [
        {
          fileId: "dup-first",
          handler: () => ({
            id: "dup-first",
            name: "dup.txt",
            mimeType: "text/plain",
            parents: ["root"],
            size: "1",
            createdTime: "2024-01-01T00:00:00Z",
          }),
        },
      ],
      deletes: [
        {
          fileId: "dup-first",
          handler: () => ({}),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    await h.client.getMetadata({ kind: "path", path: "/dup.txt" });
    const listsAfterFirst = listCallCount;

    // Emit a deleted event for this path (via strategy's deleteFile by handle
    // to avoid the ambiguity-reject on path-form delete).
    await h.client.deleteFile({ kind: "handle", handle: "dup-first" });
    // The deleted event fires with a handle-target — cache eviction by
    // handle clears the /dup.txt entry. Trigger a fresh resolution.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = (h.client as any).pathHandleCache as Map<string, unknown>;
    // Full-path entry should be gone.
    expect(cache.get("/dup.txt")).toBeUndefined();

    const meta3 = await h.client.getMetadata({
      kind: "path",
      path: "/dup.txt",
    });
    expect(listCallCount).toBeGreaterThan(listsAfterFirst);
    expect(meta3.providerMetadata.ambiguous).toBe(true);
    expect(meta3.providerMetadata.ambiguousSiblings).toEqual(["dup-second"]);
  });

  it("when a path segment resolves uniquely, ambiguous is NOT set on the providerMetadata (presence is the signal)", async () => {
    const { client } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='unique.txt'",
          handler: () => ({
            files: [
              {
                id: "uniq-id",
                name: "unique.txt",
                mimeType: "text/plain",
                parents: ["root"],
                size: "1",
                modifiedTime: "2024-06-01T00:00:00Z",
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
      ],
      gets: [
        {
          fileId: "uniq-id",
          handler: () => ({
            id: "uniq-id",
            name: "unique.txt",
            mimeType: "text/plain",
            parents: ["root"],
            size: "1",
            modifiedTime: "2024-06-01T00:00:00Z",
            createdTime: "2024-01-01T00:00:00Z",
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const meta = await h.client.getMetadata({
      kind: "path",
      path: "/unique.txt",
    });
    expect(meta.handle).toBe("uniq-id");
    expect(meta.providerMetadata.ambiguous).toBeUndefined();
    expect(meta.providerMetadata.ambiguousSiblings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getMetadata
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — getMetadata", () => {
  it("by handle — calls files.get({fileId}) and maps the response", async () => {
    const { client, calls } = makeFakeDrive({
      gets: [
        {
          fileId: "FILE-42",
          handler: () => ({
            id: "FILE-42",
            name: "doc.md",
            mimeType: "text/markdown",
            parents: ["root"],
            size: "99",
            modifiedTime: "2024-06-05T00:00:00Z",
            createdTime: "2024-01-05T00:00:00Z",
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const meta = await h.client.getMetadata({
      kind: "handle",
      handle: "FILE-42",
    });
    expect(meta.kind).toBe("file");
    expect(meta.handle).toBe("FILE-42");
    expect(meta.size).toBe(99);
    expect(meta.mimeFamily).toBe("document");
    expect(calls.get).toHaveLength(1);
    expect(calls.get[0]!.fileId).toBe("FILE-42");
  });

  it("404 / notFound reason → DatasourceError tag 'not-found'", async () => {
    const { client } = makeFakeDrive({
      gets: [
        {
          fileId: "MISSING",
          handler: () => {
            throw makeGaxiosError(404, "File not found", "notFound");
          },
        },
      ],
    });
    const h = makeHarness({ drive: client });
    await expect(
      h.client.getMetadata({ kind: "handle", handle: "MISSING" }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof DatasourceError && e.tag === "not-found",
    );
  });
});

// ---------------------------------------------------------------------------
// deleteFile
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — deleteFile", () => {
  it("by handle — calls files.delete({fileId}) and emits `deleted`", async () => {
    const { client, calls } = makeFakeDrive({
      deletes: [
        {
          fileId: "TO-DEL",
          handler: () => ({}),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    await h.client.deleteFile({ kind: "handle", handle: "TO-DEL" });
    expect(calls.delete).toHaveLength(1);
    expect(calls.delete[0]!.fileId).toBe("TO-DEL");
    const names = h.events.map((e) => e.event);
    expect(names).toContain("deleted");
  });

  it("by PATH on an ambiguous path rejects with DatasourceError tag=conflict (data-loss guard) — all fileIds in raw.ambiguousSiblings; no delete call made", async () => {
    const { client, calls } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='dup.txt'",
          handler: () => ({
            files: [
              {
                id: "dup-A",
                name: "dup.txt",
                mimeType: "text/plain",
                parents: ["root"],
                createdTime: "2024-01-01T00:00:00Z",
              },
              {
                id: "dup-B",
                name: "dup.txt",
                mimeType: "text/plain",
                parents: ["root"],
                createdTime: "2024-02-01T00:00:00Z",
              },
            ],
          }),
        },
      ],
      deletes: [
        // A responder exists but MUST NOT be called — the ambiguity guard
        // should reject before any Drive call.
        {
          fileId: "dup-A",
          handler: () => ({}),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const err = await h.client
      .deleteFile({ kind: "path", path: "/dup.txt" })
      .then(
        () => {
          throw new Error("expected deleteFile to reject");
        },
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(DatasourceError);
    const de = err as DatasourceError<"google-drive">;
    expect(de.tag).toBe("conflict");
    expect(de.retryable).toBe(false);
    const raw = de.raw as { ambiguousSiblings?: string[] } | undefined;
    expect(raw?.ambiguousSiblings).toEqual(["dup-A", "dup-B"]);
    // No files.delete call attempted — the guard prevented it.
    expect(calls.delete).toHaveLength(0);
  });

  it("by HANDLE — even if that handle came from an ambiguous set, delete succeeds (no ambiguity guard on handle form)", async () => {
    const { client, calls } = makeFakeDrive({
      deletes: [
        {
          fileId: "dup-B",
          handler: () => ({}),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    await h.client.deleteFile({ kind: "handle", handle: "dup-B" });
    expect(calls.delete).toHaveLength(1);
    expect(calls.delete[0]!.fileId).toBe("dup-B");
  });

  it("by path — resolves path → fileId, then calls files.delete", async () => {
    const { client, calls } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='gone.txt'",
          handler: () => ({
            files: [
              {
                id: "gone-id",
                name: "gone.txt",
                mimeType: "text/plain",
                parents: ["root"],
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
      ],
      deletes: [
        {
          fileId: "gone-id",
          handler: () => ({}),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    await h.client.deleteFile({ kind: "path", path: "/gone.txt" });
    expect(calls.delete[0]!.fileId).toBe("gone-id");
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — search", () => {
  it("unscoped — files.list with q containing name contains filter", async () => {
    const { client, calls } = makeFakeDrive({
      lists: [
        {
          qMatch: "name contains 'alpha'",
          handler: () => ({
            files: [
              {
                id: "hit-1",
                name: "alpha.jpg",
                mimeType: "image/jpeg",
                parents: ["root"],
                size: "1",
                modifiedTime: "2024-06-01T00:00:00Z",
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const results = await h.client.search("alpha");
    expect(results).toHaveLength(1);
    expect(results[0]!.handle).toBe("hit-1");
    const q = String(calls.list[0]!.q ?? "");
    expect(q).toContain("name contains 'alpha'");
    // trashed=false is required so the search never returns garbage-collected items
    expect(q).toContain("trashed=false");
  });

  it("doubles embedded single-quotes in the query value (OData-like escaping)", async () => {
    const { client, calls } = makeFakeDrive({
      lists: [
        {
          // After doubling, "O'Reilly" -> "O''Reilly"
          qMatch: "O''Reilly",
          handler: () => ({ files: [] }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    await h.client.search("O'Reilly");
    const q = String(calls.list[0]!.q ?? "");
    expect(q).toContain("O''Reilly");
  });

  it("search result's synthesized `/<name>` path is NOT guaranteed re-addressable — callers MUST re-address via handle; handle-form round-trip returns the real file", async () => {
    // A file lives at /nested/folder/hit.jpg (fileId=hit-1). Search returns
    // it with path="/hit.jpg" (synthesized, not real). Re-addressing that
    // synthesized path would miss (or hit a DIFFERENT root-level file).
    // Re-addressing via handle finds the real file.
    const { client } = makeFakeDrive({
      lists: [
        {
          qMatch: "name contains 'hit'",
          handler: () => ({
            files: [
              {
                id: "hit-1",
                name: "hit.jpg",
                mimeType: "image/jpeg",
                parents: ["deep-folder-id"],
                size: "100",
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
        {
          qMatch: "name='hit.jpg'",
          handler: () => ({
            // No root-level /hit.jpg exists.
            files: [],
          }),
        },
      ],
      gets: [
        {
          fileId: "hit-1",
          handler: () => ({
            id: "hit-1",
            name: "hit.jpg",
            mimeType: "image/jpeg",
            parents: ["deep-folder-id"],
            size: "100",
            createdTime: "2024-01-01T00:00:00Z",
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const results = await h.client.search("hit");
    expect(results).toHaveLength(1);
    const entry = results[0]!;
    // Synthesized path — documented-as-not-reliable.
    expect(entry.path).toBe("/hit.jpg");
    expect(entry.handle).toBe("hit-1");

    // Path round-trip fails to find the file because no root-level
    // /hit.jpg exists — this is the documented trap that the class header
    // warns about. Callers MUST NOT rely on the synthesized path.
    await expect(
      h.client.getMetadata({ kind: "path", path: entry.path }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof DatasourceError && e.tag === "not-found",
    );

    // Handle round-trip returns the real file with the real parent chain.
    const viaHandle = await h.client.getMetadata({
      kind: "handle",
      handle: entry.handle,
    });
    expect(viaHandle.handle).toBe("hit-1");
    expect(viaHandle.providerMetadata.parents).toEqual(["deep-folder-id"]);
  });

  it("scoped — passes `'<scopeFileId>' in parents` on top of name filter", async () => {
    const { client, calls } = makeFakeDrive({
      lists: [
        {
          qMatch: "'SCOPE-ID' in parents",
          handler: () => ({ files: [] }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    await h.client.search("alpha", { kind: "handle", handle: "SCOPE-ID" });
    const q = String(calls.list[0]!.q ?? "");
    expect(q).toContain("'SCOPE-ID' in parents");
    expect(q).toContain("name contains 'alpha'");
  });
});

// ---------------------------------------------------------------------------
// authenticate — OAuth intent
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — authenticate", () => {
  it("returns an OAuth intent whose authorizeUrl targets Google's OAuth endpoint with Drive scope", async () => {
    const { client } = makeFakeDrive({});
    const h = makeHarness({
      drive: client,
      credsOverrides: {
        clientId: "app-xyz",
        redirectUri: "http://localhost/callback",
      },
    });
    const intent = (await h.client.authenticate()) as OAuthIntent;
    expect(intent.kind).toBe("oauth");
    expect(intent.authorizeUrl).toContain(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(intent.authorizeUrl).toContain("client_id=app-xyz");
    expect(intent.authorizeUrl).toContain(
      "redirect_uri=http%3A%2F%2Flocalhost%2Fcallback",
    );
    // Drive scope — full-access to files the app creates or has been granted.
    expect(intent.authorizeUrl).toContain("scope=");
    expect(intent.authorizeUrl).toContain(
      encodeURIComponent("https://www.googleapis.com/auth/drive"),
    );
    // Refresh-token request
    expect(intent.authorizeUrl).toContain("access_type=offline");
  });

  it("completeWith(code) posts to the token endpoint and returns an AuthResult", async () => {
    const { client } = makeFakeDrive({});
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
    const h = makeHarness({ drive: client, fetchImpl });
    const intent = (await h.client.authenticate()) as OAuthIntent;
    const result = await intent.completeWith("auth-code-123");
    expect(result.accessToken).toBe("new-at");
    expect(result.refreshToken).toBe("new-rt");
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(String(call[0])).toMatch(/oauth2\.googleapis\.com\/token$/);
  });
});

// ---------------------------------------------------------------------------
// refreshToken
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — refreshToken", () => {
  it("POSTs grant_type=refresh_token to oauth2.googleapis.com/token", async () => {
    const { client } = makeFakeDrive({});
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "refreshed-at",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const h = makeHarness({ drive: client, fetchImpl });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refresh = (h.client as any).refreshTokenImpl.bind(h.client);
    const result = await refresh();
    expect(result.accessToken).toBe("refreshed-at");
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(String(call[0])).toMatch(/oauth2\.googleapis\.com\/token$/);
    const body = (call[1] as { body: string }).body;
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=refresh-tok");
  });

  it("token endpoint returning invalid_grant throws DatasourceError tag 'auth-revoked'", async () => {
    const { client } = makeFakeDrive({});
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been revoked",
        }),
        { status: 400 },
      ),
    ) as unknown as typeof fetch;
    const h = makeHarness({ drive: client, fetchImpl });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refresh = (h.client as any).refreshTokenImpl.bind(h.client);
    await expect(refresh()).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DatasourceError && e.tag === "auth-revoked",
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeError — Drive taxonomy coverage
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — normalizeError taxonomy", () => {
  function normalize(
    client: GoogleDriveClient,
    raw: unknown,
  ): DatasourceError<"google-drive"> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (client as any).normalizeErrorImpl(raw);
  }

  it("401 → auth-expired", () => {
    const { client } = makeFakeDrive({});
    const h = makeHarness({ drive: client });
    expect(
      normalize(h.client, makeGaxiosError(401, "unauth", "authError")).tag,
    ).toBe("auth-expired");
    expect(normalize(h.client, { response: { status: 401 } }).tag).toBe(
      "auth-expired",
    );
  });

  it("403 rateLimitExceeded / userRateLimitExceeded → rate-limited and reads retry-after", () => {
    const { client } = makeFakeDrive({});
    const h = makeHarness({ drive: client });
    const e = normalize(
      h.client,
      makeGaxiosError(403, "rate", "rateLimitExceeded", {
        headers: { "retry-after": "5" },
      }),
    );
    expect(e.tag).toBe("rate-limited");
    expect(e.retryAfterMs).toBe(5000);
    expect(e.retryable).toBe(true);

    const u = normalize(
      h.client,
      makeGaxiosError(403, "rate", "userRateLimitExceeded"),
    );
    expect(u.tag).toBe("rate-limited");
  });

  it("403 authError / invalidCredentials → auth-revoked (non-retryable)", () => {
    const { client } = makeFakeDrive({});
    const h = makeHarness({ drive: client });
    for (const reason of ["authError", "invalidCredentials"]) {
      const e = normalize(
        h.client,
        makeGaxiosError(403, "revoked", reason),
      );
      expect(e.tag, `reason=${reason}`).toBe("auth-revoked");
      expect(e.retryable).toBe(false);
    }
  });

  it("403 quotaExceeded / dailyLimitExceeded / domainPolicy / insufficientFilePermissions → provider-error (non-retryable)", () => {
    const { client } = makeFakeDrive({});
    const h = makeHarness({ drive: client });
    for (const reason of [
      "quotaExceeded",
      "dailyLimitExceeded",
      "domainPolicy",
      "insufficientFilePermissions",
    ]) {
      const e = normalize(h.client, makeGaxiosError(403, "provider", reason));
      expect(e.tag, `reason=${reason}`).toBe("provider-error");
      expect(e.retryable).toBe(false);
    }
  });

  it("404 → not-found", () => {
    const { client } = makeFakeDrive({});
    const h = makeHarness({ drive: client });
    expect(normalize(h.client, makeGaxiosError(404, "nf", "notFound")).tag).toBe(
      "not-found",
    );
    expect(normalize(h.client, { response: { status: 404 } }).tag).toBe(
      "not-found",
    );
  });

  it("409 → conflict", () => {
    const { client } = makeFakeDrive({});
    const h = makeHarness({ drive: client });
    expect(
      normalize(h.client, makeGaxiosError(409, "dup", "conflict")).tag,
    ).toBe("conflict");
  });

  it("429 → rate-limited (with retry-after)", () => {
    const { client } = makeFakeDrive({});
    const h = makeHarness({ drive: client });
    const e = normalize(
      h.client,
      makeGaxiosError(429, "too many", "rateLimitExceeded", {
        headers: { "retry-after": "10" },
      }),
    );
    expect(e.tag).toBe("rate-limited");
    expect(e.retryAfterMs).toBe(10_000);
    expect(e.retryable).toBe(true);
  });

  it("5xx serviceUnavailable → rate-limited (transient); other 5xx → provider-error", () => {
    const { client } = makeFakeDrive({});
    const h = makeHarness({ drive: client });
    expect(
      normalize(
        h.client,
        makeGaxiosError(503, "svc", "serviceUnavailable"),
      ).tag,
    ).toBe("rate-limited");
    expect(
      normalize(h.client, makeGaxiosError(500, "ise", "internalError")).tag,
    ).toBe("provider-error");
  });

  it("network errors (ECONNRESET / ETIMEDOUT / ENOTFOUND) → network-error retryable=true", () => {
    const { client } = makeFakeDrive({});
    const h = makeHarness({ drive: client });
    expect(normalize(h.client, { code: "ECONNRESET" }).tag).toBe(
      "network-error",
    );
    expect(normalize(h.client, { code: "ETIMEDOUT" }).tag).toBe(
      "network-error",
    );
    expect(normalize(h.client, { code: "ENOTFOUND" }).tag).toBe(
      "network-error",
    );
  });

  it("unknown → provider-error", () => {
    const { client } = makeFakeDrive({});
    const h = makeHarness({ drive: client });
    expect(normalize(h.client, new Error("no idea")).tag).toBe(
      "provider-error",
    );
    expect(normalize(h.client, "string").tag).toBe("provider-error");
  });
});

// ---------------------------------------------------------------------------
// getQuota
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — getQuota", () => {
  it("calls about.get({fields: 'storageQuota'}) and returns {used, quota}", async () => {
    const { client, calls } = makeFakeDrive({
      about: () => ({
        storageQuota: { limit: "100000", usage: "42000" },
      }),
    });
    const h = makeHarness({ drive: client });
    const q = await h.client.getQuota();
    expect(q.used).toBe(42_000);
    expect(q.quota).toBe(100_000);
    expect(calls.about).toHaveLength(1);
    expect(String(calls.about[0]!.fields ?? "")).toContain("storageQuota");
  });
});

// ---------------------------------------------------------------------------
// createFile / uploadFile (resumable)
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — upload (resumable, small file)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gd-test-"));
  const smallFile = join(tmp, "small.bin");
  writeFileSync(smallFile, "small-content");

  it("creates via raw-fetch resumable session — POST for session URL, then a single PUT with the content", async () => {
    const { client } = makeFakeDrive({});
    const sessionUrl = "https://googleapis.com/upload/session/ABC";
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), ...(init ? { init } : {}) });
        // First call: session-init POST returns Location header.
        if ((init?.method ?? "").toUpperCase() === "POST") {
          return new Response("", {
            status: 200,
            headers: { Location: sessionUrl },
          });
        }
        // Second call: final PUT returns the Drive file JSON.
        return new Response(
          JSON.stringify({
            id: "UP-ID",
            name: "small.bin",
            mimeType: "application/octet-stream",
            parents: ["root"],
            size: "13",
            modifiedTime: "2024-06-01T00:00:00Z",
            createdTime: "2024-01-01T00:00:00Z",
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    const h = makeHarness({ drive: client, fetchImpl });
    const entry = await h.client.uploadFile(
      { kind: "handle", handle: "root" },
      { path: smallFile, name: "small.bin" },
    );
    expect(entry.handle).toBe("UP-ID");
    // Two fetches: session init (POST) + chunk PUT.
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
    const methods = fetchCalls.map((c) =>
      (c.init?.method ?? "").toUpperCase(),
    );
    expect(methods).toContain("POST");
    expect(methods).toContain("PUT");

    const names = h.events.map((e) => e.event);
    expect(names).toContain("uploading");
    expect(names).toContain("file-created");
  });
});

// ---------------------------------------------------------------------------
// Resumable upload — multi-chunk (≥25 MiB and exact-multiple)
// ---------------------------------------------------------------------------
//
// UPLOAD_CHUNK_BYTES = 10 MiB. Two fixtures:
//   - 25 MiB → 3 chunks (10 + 10 + 5) — exercises the trailing small-chunk
//     branch.
//   - 30 MiB → 3 chunks (10 + 10 + 10) — exercises the inner-loop isLast
//     branch where the last chunk is exactly UPLOAD_CHUNK_BYTES.

describe("GoogleDriveClient — resumable upload multi-chunk (Content-Range + isLast)", () => {
  const CHUNK = 10 * 1024 * 1024; // must stay in sync with googledrive-client.ts

  function setupMultiChunkTest(totalBytes: number, chunkCount: number) {
    const dir = mkdtempSync(join(tmpdir(), "gd-multichunk-"));
    const file = join(dir, "huge.bin");
    writeFileSync(file, Buffer.alloc(totalBytes, 0x42));

    const { client } = makeFakeDrive({});
    const sessionUrl = "https://googleapis.com/upload/session/multi";
    const fetchCalls: Array<{
      url: string;
      method: string;
      contentRange: string;
      contentLength: string;
      bodyLength: number;
    }> = [];
    let chunkIdx = 0;
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const method = (init?.method ?? "").toUpperCase();
        if (method === "POST") {
          // session init
          return new Response("", {
            status: 200,
            headers: { Location: sessionUrl },
          });
        }
        // chunk PUT
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        const body = init?.body;
        const bodyLength =
          body instanceof Uint8Array ? body.byteLength : 0;
        fetchCalls.push({
          url: String(url),
          method,
          contentRange: hdrs["Content-Range"] ?? "",
          contentLength: hdrs["Content-Length"] ?? "",
          bodyLength,
        });
        const isLast = chunkIdx === chunkCount - 1;
        chunkIdx += 1;
        if (!isLast) {
          // Interim: 308 Resume Incomplete.
          return new Response("", {
            status: 308,
            headers: { Range: `bytes=0-${chunkIdx * CHUNK - 1}` },
          });
        }
        // Final: the DriveItem JSON.
        return new Response(
          JSON.stringify({
            id: "final-id",
            name: "huge.bin",
            mimeType: "application/octet-stream",
            parents: ["root"],
            size: String(totalBytes),
            modifiedTime: "2024-06-05T00:00:00Z",
            createdTime: "2024-01-05T00:00:00Z",
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    return { file, client, fetchImpl, fetchCalls, totalBytes };
  }

  it("25 MiB → 3 chunks with trailing chunk flushed via post-loop branch; Content-Range headers match exactly", async () => {
    const total = 25 * 1024 * 1024;
    const { file, client, fetchImpl, fetchCalls, totalBytes } =
      setupMultiChunkTest(total, 3);
    try {
      const h = makeHarness({ drive: client, fetchImpl });
      const entry = await h.client.uploadFile(
        { kind: "handle", handle: "root" },
        { path: file, name: "huge.bin" },
      );
      expect(entry.handle).toBe("final-id");
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
      expect(fetchCalls[2]!.bodyLength).toBe(total - 2 * CHUNK);
    } finally {
      unlinkSync(file);
    }
  });

  it("30 MiB → 3 chunks where the last chunk is exactly UPLOAD_CHUNK_BYTES (inner-loop isLast branch)", async () => {
    const total = 30 * 1024 * 1024;
    const { file, client, fetchImpl, fetchCalls, totalBytes } =
      setupMultiChunkTest(total, 3);
    try {
      const h = makeHarness({ drive: client, fetchImpl });
      const entry = await h.client.uploadFile(
        { kind: "handle", handle: "root" },
        { path: file, name: "huge.bin" },
      );
      expect(entry.handle).toBe("final-id");
      expect(fetchCalls).toHaveLength(3);
      for (const c of fetchCalls) {
        expect(c.bodyLength).toBe(CHUNK);
      }
      expect(fetchCalls[2]!.contentRange).toBe(
        `bytes ${2 * CHUNK}-${totalBytes - 1}/${totalBytes}`,
      );
      void totalBytes;
    } finally {
      unlinkSync(file);
    }
  });
});

// ---------------------------------------------------------------------------
// cancelUpload — mid-resumable DELETE with Content-Range: bytes */<total>
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — cancelUpload (resumable session)", () => {
  it("mid-chunk cancel DELETEs session URL with Content-Range bytes */<total>; emits upload-cancelled", async () => {
    const total = 25 * 1024 * 1024;
    const dir = mkdtempSync(join(tmpdir(), "gd-cancel-"));
    const file = join(dir, "huge.bin");
    writeFileSync(file, Buffer.alloc(total, 0x77));

    const { client } = makeFakeDrive({});
    const sessionUrl = "https://googleapis.com/upload/session/cancel";
    const deleteCalls: Array<{
      url: string;
      method: string;
      contentRange: string;
    }> = [];
    let releasePut!: (resp: Response) => void;

    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        if (method === "POST") {
          return new Response("", {
            status: 200,
            headers: { Location: sessionUrl },
          });
        }
        if (method === "DELETE") {
          deleteCalls.push({
            url: String(url),
            method,
            contentRange: hdrs["Content-Range"] ?? "",
          });
          return new Response("", { status: 204 });
        }
        if (method === "PUT") {
          const signal = init?.signal;
          if (signal?.aborted) {
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          }
          return await new Promise<Response>((resolve, reject) => {
            releasePut = resolve;
            signal?.addEventListener("abort", () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            );
          });
        }
        return new Response("unexpected", { status: 500 });
      },
    ) as unknown as typeof fetch;

    try {
      const h = makeHarness({ drive: client, fetchImpl });
      const uploadPromise = h.client.uploadFile(
        { kind: "handle", handle: "root" },
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
      if (typeof releasePut === "function") {
        releasePut(new Response("", { status: 308 }));
      }

      await expect(uploadPromise).rejects.toSatisfy(
        (e: unknown) => e instanceof DatasourceError && e.tag === "cancelled",
      );

      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0]!.url).toBe(sessionUrl);
      expect(deleteCalls[0]!.method).toBe("DELETE");
      // The proposal and Drive docs both specify `bytes */<total>` on
      // cancel-DELETEs. Exact header match verifies we didn't silently drop
      // it or emit the unknown-total sentinel (`bytes */0`) here.
      expect(deleteCalls[0]!.contentRange).toBe(`bytes */${total}`);

      const names = (h.events as Array<{ event: string }>).map((e) => e.event);
      expect(names).toContain("upload-cancelled");
      expect(names).not.toContain("upload-failed");
    } finally {
      unlinkSync(file);
    }
  });
});

// ---------------------------------------------------------------------------
// LRU cache invalidation on `deleted` / `file-created`
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — path↔fileId LRU invalidation", () => {
  it("after resolving /doc.txt → fileId, a `deleted` event evicts the cached entry", async () => {
    const { client } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='doc.txt'",
          handler: () => ({
            files: [
              {
                id: "doc-id",
                name: "doc.txt",
                mimeType: "text/plain",
                parents: ["root"],
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
      ],
      gets: [
        {
          fileId: "doc-id",
          handler: () => ({
            id: "doc-id",
            name: "doc.txt",
            mimeType: "text/plain",
            parents: ["root"],
            modifiedTime: "2024-06-01T00:00:00Z",
            createdTime: "2024-01-01T00:00:00Z",
          }),
        },
      ],
      deletes: [
        {
          fileId: "doc-id",
          handler: () => ({}),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    await h.client.getMetadata({ kind: "path", path: "/doc.txt" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = (h.client as any).pathHandleCache as Map<
      string,
      { fileId: string; ambiguousSiblings?: string[] }
    >;
    expect(cache.get("/doc.txt")?.fileId).toBe("doc-id");

    await h.client.deleteFile({ kind: "path", path: "/doc.txt" });
    expect(cache.get("/doc.txt")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — dispose()", () => {
  it("overrides the base no-op — calling dispose() detaches the bus subscription", async () => {
    const { client } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='a.txt'",
          handler: () => ({
            files: [
              {
                id: "A",
                name: "a.txt",
                mimeType: "text/plain",
                parents: ["root"],
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
      ],
      gets: [
        {
          fileId: "A",
          handler: () => ({
            id: "A",
            name: "a.txt",
            mimeType: "text/plain",
            parents: ["root"],
            modifiedTime: "2024-06-01T00:00:00Z",
            createdTime: "2024-01-01T00:00:00Z",
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    await h.client.getMetadata({ kind: "path", path: "/a.txt" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = (h.client as any).pathHandleCache as Map<
      string,
      { fileId: string; ambiguousSiblings?: string[] }
    >;
    expect(cache.get("/a.txt")?.fileId).toBe("A");

    h.client.dispose();

    h.bus.emit({
      event: "deleted",
      datasourceType: "google-drive",
      datasourceId: "ds-gd-1",
      ts: Date.now(),
      payload: { target: { kind: "path", path: "/a.txt" } },
    });

    expect(cache.get("/a.txt")?.fileId).toBe("A");
  });

  it("dispose() is idempotent", () => {
    const { client } = makeFakeDrive({});
    const h = makeHarness({ drive: client });
    expect(() => {
      h.client.dispose();
      h.client.dispose();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Drive query encoding — helper
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — Drive query encoding", () => {
  it("search with value containing single-quote doubles the quote so Drive parses it as a string literal", async () => {
    const { client, calls } = makeFakeDrive({
      lists: [
        {
          qMatch: "can''t",
          handler: () => ({ files: [] }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    await h.client.search("can't");
    const q = String(calls.list[0]!.q ?? "");
    expect(q).toContain("can''t");
  });
});

// ---------------------------------------------------------------------------
// testConnection / status
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — testConnection / status", () => {
  it("testConnection resolves on about.get success", async () => {
    const { client } = makeFakeDrive({
      about: () => ({ storageQuota: { limit: "100", usage: "1" } }),
    });
    const h = makeHarness({ drive: client });
    await expect(h.client.testConnection()).resolves.toBeUndefined();
  });

  it("status returns 'connected' on about.get success", async () => {
    const { client } = makeFakeDrive({
      about: () => ({ storageQuota: { limit: "100", usage: "1" } }),
    });
    const h = makeHarness({ drive: client });
    await expect(h.client.status()).resolves.toBe("connected");
  });
});

// ---------------------------------------------------------------------------
// GoogleDriveClient — scope drift detection
// ---------------------------------------------------------------------------
//
// Guard-rail tests for the scope-sufficiency check introduced in
// fix-drive-listdirectory-scope-drift Work Unit A.
//
// These tests assert that SUFFICIENT scopes are never rejected by the check.
// The rejection branch (Work Unit B) and tokeninfo backfill (Work Unit E)
// are NOT covered here — they will add their own failing tests when those
// units land.

describe("GoogleDriveClient — scope drift detection", () => {
  it("status() with meta.scope=full drive returns 'connected' and does not call tokeninfo", async () => {
    const fakeFetch = vi.fn();
    const { client: driveClient } = makeFakeDrive({
      about: () => ({ storageQuota: { limit: "100", usage: "1" } }),
    });
    const h = makeHarness({
      drive: driveClient,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      creds: makeCredsWithScope("https://www.googleapis.com/auth/drive"),
    });
    await expect(h.client.status()).resolves.toBe("connected");
    // Sufficient scope was on the credential — no tokeninfo fetch needed.
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("status() with meta.scope='openid email <drive> profile' (multi-scope grant) returns 'connected'", async () => {
    const fakeFetch = vi.fn();
    const { client: driveClient } = makeFakeDrive({
      about: () => ({ storageQuota: { limit: "100", usage: "1" } }),
    });
    const h = makeHarness({
      drive: driveClient,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      creds: makeCredsWithScope(
        "openid email https://www.googleapis.com/auth/drive profile",
      ),
    });
    await expect(h.client.status()).resolves.toBe("connected");
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("constructor propagates meta.scope into creds.scope so status() does not fetch tokeninfo when scope is already known", async () => {
    const fakeFetch = vi.fn();
    const { client: driveClient } = makeFakeDrive({
      about: () => ({ storageQuota: { limit: "100", usage: "1" } }),
    });
    // Default makeCreds includes scope=full drive — no credsOverrides needed.
    const h = makeHarness({
      drive: driveClient,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      credsOverrides: undefined,
    });
    await expect(h.client.status()).resolves.toBe("connected");
    // Scope was on the credential at construction — no tokeninfo fetch.
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("makeCredsWithScope(undefined) produces legacy-shaped credential with no meta.scope field", () => {
    const creds = makeCredsWithScope(undefined);
    const meta = creds.authResult.meta as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(meta, "scope")).toBe(false);
  });

  it("status() rejects with auth-revoked + scope-insufficient when meta.scope is drive.file alone", async () => {
    const fakeFetch = vi.fn();
    const aboutSpy = vi.fn(() => ({ storageQuota: { limit: "100", usage: "1" } }));
    const { client } = makeFakeDrive({ about: aboutSpy });
    const h = makeHarness({
      drive: client,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      creds: makeCredsWithScope("https://www.googleapis.com/auth/drive.file"),
    });
    await expect(h.client.status()).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof DatasourceError)) return false;
      if (e.tag !== "auth-revoked") return false;
      if (e.retryable !== false) return false;
      const raw = e.raw as { kind?: string; requiredScope?: string; actualScope?: string };
      return (
        raw?.kind === "scope-insufficient" &&
        raw?.requiredScope === "https://www.googleapis.com/auth/drive" &&
        raw?.actualScope === "https://www.googleapis.com/auth/drive.file"
      );
    });
    // about.get must NOT be called when scope check fails first
    expect(aboutSpy).not.toHaveBeenCalled();
    // Also no tokeninfo fetch — scope was already on the cred
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("testConnection() rejects with auth-revoked + scope-insufficient when meta.scope is drive.readonly alone", async () => {
    const fakeFetch = vi.fn();
    const aboutSpy = vi.fn(() => ({ storageQuota: { limit: "100", usage: "1" } }));
    const { client } = makeFakeDrive({ about: aboutSpy });
    const h = makeHarness({
      drive: client,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      creds: makeCredsWithScope("https://www.googleapis.com/auth/drive.readonly"),
    });
    await expect(h.client.testConnection()).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof DatasourceError)) return false;
      if (e.tag !== "auth-revoked") return false;
      if (e.retryable !== false) return false;
      const raw = e.raw as { kind?: string; requiredScope?: string; actualScope?: string };
      return (
        raw?.kind === "scope-insufficient" &&
        raw?.requiredScope === "https://www.googleapis.com/auth/drive" &&
        raw?.actualScope === "https://www.googleapis.com/auth/drive.readonly"
      );
    });
    expect(aboutSpy).not.toHaveBeenCalled();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("status() rejects with auth-revoked + scope-insufficient when meta.scope combines drive.file and drive.readonly but not full drive", async () => {
    const fakeFetch = vi.fn();
    const aboutSpy = vi.fn(() => ({ storageQuota: { limit: "100", usage: "1" } }));
    const { client } = makeFakeDrive({ about: aboutSpy });
    const h = makeHarness({
      drive: client,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      creds: makeCredsWithScope("https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly"),
    });
    await expect(h.client.status()).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof DatasourceError)) return false;
      if (e.tag !== "auth-revoked") return false;
      if (e.retryable !== false) return false;
      const raw = e.raw as { kind?: string; requiredScope?: string; actualScope?: string };
      return (
        raw?.kind === "scope-insufficient" &&
        raw?.requiredScope === "https://www.googleapis.com/auth/drive" &&
        raw?.actualScope === "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly"
      );
    });
    expect(aboutSpy).not.toHaveBeenCalled();
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});
