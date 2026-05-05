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

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  OAuthIntent,
  StoredCredentials,
} from "@ft5/ipc-contracts";
import { DatasourceError, providers } from "@ft5/ipc-contracts";

import { createEventBus, type EventBus } from "../event-bus.js";
import type { BaseClientContext, CredentialStore } from "../base-client.js";
import {
  appendExtensionIfMissing,
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
/**
 * `update` matcher for `files.update({ fileId, requestBody: { name } })`.
 * The fake matches on `fileId`; the handler may inspect `requestBody.name`
 * (or the full params bag) and returns the updated DriveFile shape.
 */
interface UpdateResponder {
  fileId: string;
  handler: (params: Record<string, unknown>) => unknown;
}
/**
 * `get` for the media-download path: `files.get({fileId, alt: "media"},
 * {responseType: "stream", headers, signal})`. The fake matches on `fileId`
 * and the presence of `alt === "media"` in the params bag, then invokes the
 * handler with the original params + the optional 2nd argument so tests
 * can assert e.g. `Range` / `signal` forwarding. Returns a Node Readable +
 * a `headers` map (Drive's stream response surface).
 */
interface GetStreamResponder {
  fileId: string;
  handler: (
    params: Record<string, unknown>,
    options: Record<string, unknown> | undefined,
  ) => { stream: Readable; headers: Record<string, string> };
}

interface FakeDriveOptions {
  lists?: ListResponder[];
  gets?: GetResponder[];
  /** Stream-mode responders (alt === "media"). Matched by fileId before metadata `gets`. */
  getStreams?: GetStreamResponder[];
  deletes?: DeleteResponder[];
  creates?: CreateResponder[];
  updates?: UpdateResponder[];
  about?: (params: Record<string, unknown>) => unknown;
}

function makeFakeDrive(opts: FakeDriveOptions): {
  client: GoogleDriveClientLike;
  calls: {
    list: Array<Record<string, unknown>>;
    get: Array<{ params: Record<string, unknown>; options?: Record<string, unknown> }>;
    delete: Array<Record<string, unknown>>;
    create: Array<Record<string, unknown>>;
    update: Array<Record<string, unknown>>;
    about: Array<Record<string, unknown>>;
  };
} {
  const calls = {
    list: [] as Array<Record<string, unknown>>,
    get: [] as Array<{
      params: Record<string, unknown>;
      options?: Record<string, unknown>;
    }>,
    delete: [] as Array<Record<string, unknown>>,
    create: [] as Array<Record<string, unknown>>,
    update: [] as Array<Record<string, unknown>>,
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
      async get(params, options) {
        calls.get.push({ params, ...(options !== undefined ? { options } : {}) });
        const fileId = String(params.fileId ?? "");
        // Stream-mode dispatch: `alt: "media"` distinguishes a download from a
        // metadata fetch. Stream responders are checked first so a fileId
        // with both flavours can host both responder kinds in the same fake.
        if (params.alt === "media") {
          const streamMatch = (opts.getStreams ?? []).find(
            (r) => r.fileId === fileId,
          );
          if (!streamMatch) {
            throw makeGaxiosError(404, "no-get-stream-responder", "notFound", {
              message: `no streaming get responder for fileId=${fileId}`,
            });
          }
          const { stream, headers } = streamMatch.handler(params, options);
          return { data: stream, headers };
        }
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
      async update(params) {
        calls.update.push(params);
        const fileId = String(params.fileId ?? "");
        const match = (opts.updates ?? []).find((r) => r.fileId === fileId);
        if (!match) {
          throw makeGaxiosError(500, "no-update-responder", "internalError", {
            message: `no update responder for fileId=${fileId}`,
          });
        }
        return { data: match.handler(params) as DriveFile };
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

// Local re-declaration of the DriveFile shape so the test fake's `update`
// handler can return a typed value without re-importing the strategy's
// internal type. Mirrors the production `DriveFile` interface.
interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  size?: string | number;
  modifiedTime?: string;
  createdTime?: string;
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
  codeVerifierFactory?: () => string;
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
      ...(options.codeVerifierFactory
        ? { codeVerifierFactory: options.codeVerifierFactory }
        : {}),
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
    expect(calls.get[0]!.params.fileId).toBe("FILE-42");
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
// PKCE (RFC 7636, S256) — add-drive-oauth-browser-consent, Group 3
// ---------------------------------------------------------------------------
//
// The authorize URL carries `code_challenge_method=S256` + a `code_challenge`
// derived from a freshly-generated `code_verifier`. The verifier is captured
// inside the `completeWith` closure and threaded into the token exchange as
// a `code_verifier` form field. A test-only `codeVerifier` property on the
// returned intent lets tests inspect the verifier that the implementation
// generated; it must NEVER appear in any persisted or logged surface.

describe("GoogleDriveClient — authenticate (PKCE S256)", () => {
  /**
   * Capturing verifier factory. Returns a factory that records every
   * emitted verifier into `captured`. Each call MUST return a fresh value
   * — we generate 48 random bytes just like the production default, so
   * the "fresh per call" test exercises real entropy flow.
   */
  function makeCapturingVerifierFactory(): {
    factory: () => string;
    captured: string[];
  } {
    const captured: string[] = [];
    return {
      captured,
      factory: () => {
        // 48 bytes of entropy → base64url (64 chars, no padding) — same
        // shape the production default produces.
        const v = randomBytes(48).toString("base64url");
        captured.push(v);
        return v;
      },
    };
  }

  function base64urlSha256(input: string): string {
    return createHash("sha256").update(input).digest("base64url");
  }

  it("Authorize URL carries S256 challenge parameters", async () => {
    const { client } = makeFakeDrive({});
    const { factory, captured } = makeCapturingVerifierFactory();
    const h = makeHarness({ drive: client, codeVerifierFactory: factory });
    const intent = (await h.client.authenticate()) as OAuthIntent;
    const url = new URL(intent.authorizeUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = url.searchParams.get("code_challenge");
    expect(typeof challenge).toBe("string");
    // Challenge is base64url-encoded SHA256 → 43 chars, no padding.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Factory was called exactly once — the verifier captured is the one
    // the authorize URL's challenge is derived from.
    expect(captured).toHaveLength(1);
    const verifier = captured[0]!;
    // Verifier shape: 48 bytes base64url → 64 URL-safe chars.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(challenge).toBe(base64urlSha256(verifier));
  });

  it("Verifier threads into the token exchange", async () => {
    const { client } = makeFakeDrive({});
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "pkce-at",
          refresh_token: "pkce-rt",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const { factory, captured } = makeCapturingVerifierFactory();
    const h = makeHarness({
      drive: client,
      fetchImpl,
      codeVerifierFactory: factory,
    });
    const intent = (await h.client.authenticate()) as OAuthIntent;
    expect(captured).toHaveLength(1);
    const verifier = captured[0]!;
    await intent.completeWith("auth-code-abc");
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(String(call[0])).toMatch(/oauth2\.googleapis\.com\/token$/);
    const body = String((call[1] as { body: string }).body);
    const form = new URLSearchParams(body);
    const codeVerifierValues = form.getAll("code_verifier");
    // Exactly one code_verifier field; value matches the captured verifier
    // — which in turn matches the authorize URL's challenge.
    expect(codeVerifierValues).toHaveLength(1);
    expect(codeVerifierValues[0]).toBe(verifier);
    const authorizeChallenge = new URL(intent.authorizeUrl).searchParams.get(
      "code_challenge",
    );
    expect(authorizeChallenge).toBe(base64urlSha256(verifier));
  });

  it("Fresh verifier per call", async () => {
    const { client } = makeFakeDrive({});
    const { factory, captured } = makeCapturingVerifierFactory();
    const h = makeHarness({ drive: client, codeVerifierFactory: factory });
    const intent1 = (await h.client.authenticate()) as OAuthIntent;
    const intent2 = (await h.client.authenticate()) as OAuthIntent;
    expect(captured).toHaveLength(2);
    expect(captured[0]).not.toBe(captured[1]);
    const challenge1 = new URL(intent1.authorizeUrl).searchParams.get(
      "code_challenge",
    );
    const challenge2 = new URL(intent2.authorizeUrl).searchParams.get(
      "code_challenge",
    );
    expect(challenge1).toBeTruthy();
    expect(challenge2).toBeTruthy();
    expect(challenge1).not.toBe(challenge2);
    // Challenges are the SHA256(verifier) of the respective calls.
    expect(challenge1).toBe(base64urlSha256(captured[0]!));
    expect(challenge2).toBe(base64urlSha256(captured[1]!));
  });

  it("Verifier is never stored or logged", async () => {
    const { client } = makeFakeDrive({});
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "pkce-at-2",
          refresh_token: "pkce-rt-2",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const { factory, captured } = makeCapturingVerifierFactory();
    const h = makeHarness({
      drive: client,
      fetchImpl,
      codeVerifierFactory: factory,
    });
    const intent = (await h.client.authenticate()) as OAuthIntent;
    expect(captured).toHaveLength(1);
    const verifier = captured[0]!;
    const authResult = await intent.completeWith("auth-code-xyz");
    // The AuthResult returned from the completeWith closure MUST NOT
    // contain the verifier at any nesting depth.
    expect(JSON.stringify(authResult)).not.toContain(verifier);
    // A StoredCredentials built from that AuthResult (mirroring what
    // CredentialStore.put would persist) MUST also not contain it.
    const stored: StoredCredentials = {
      providerId: "google-drive",
      authResult,
      createdAt: 0,
      updatedAt: 0,
    };
    expect(JSON.stringify(stored)).not.toContain(verifier);
    // authResult.meta round-trips only OAuth config, not secrets.
    expect(JSON.stringify(authResult.meta ?? {})).not.toContain(verifier);
    // The OAuth intent object itself must not leak the verifier as a
    // property — the implementation keeps it in a closure only.
    expect(JSON.stringify(intent)).not.toContain(verifier);
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
// uploadFile (resumable)
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

  it("token exchange copies the issued scope from the token-endpoint response onto AuthResult.meta.scope and creds.scope", async () => {
    const { client: drive } = makeFakeDrive({
      about: () => ({ storageQuota: { limit: "100", usage: "1" } }),
    });
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "exchanged-at",
          refresh_token: "exchanged-rt",
          scope: "https://www.googleapis.com/auth/drive openid email",
          expires_in: 3599,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const h = makeHarness({ drive, fetchImpl });
    const intent = (await h.client.authenticate()) as OAuthIntent;
    const result = await intent.completeWith("auth-code-xyz");
    expect((result.meta as Record<string, unknown>).scope).toBe(
      "https://www.googleapis.com/auth/drive openid email",
    );
    // The in-memory creds must also reflect the issued scope, not the seeded one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((h.client as any).creds.scope).toBe(
      "https://www.googleapis.com/auth/drive openid email",
    );
  });

  it("refreshToken copies the issued scope from the refresh response onto AuthResult.meta.scope and creds.scope", async () => {
    const { client: drive } = makeFakeDrive({});
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "refreshed-at",
          scope: "https://www.googleapis.com/auth/drive",
          expires_in: 3599,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const h = makeHarness({
      drive,
      fetchImpl,
      // Seed with a scope value distinct from the refresh response so that the
      // creds.scope assertion below is load-bearing: if parseTokenResponse
      // skips writing scope onto creds, creds.scope stays "drive.file" and
      // the assertion catches the regression.
      creds: makeCredsWithScope("https://www.googleapis.com/auth/drive.file"),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refresh = (h.client as any).refreshTokenImpl.bind(h.client);
    const result = await refresh();
    expect((result.meta as Record<string, unknown>).scope).toBe(
      "https://www.googleapis.com/auth/drive",
    );
    // The in-memory creds must also reflect the issued scope from the refresh response.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((h.client as any).creds.scope).toBe(
      "https://www.googleapis.com/auth/drive",
    );
  });

  it("token response without a scope field leaves creds.scope unchanged on the seeded value", async () => {
    const { client: drive } = makeFakeDrive({});
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "exchanged-at",
          refresh_token: "exchanged-rt",
          expires_in: 3599,
          // Note: no `scope` field returned
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const h = makeHarness({
      drive,
      fetchImpl,
      creds: makeCredsWithScope("https://www.googleapis.com/auth/drive"),
    });
    const intent = (await h.client.authenticate()) as OAuthIntent;
    const result = await intent.completeWith("auth-code-no-scope");
    // result.meta.scope should be omitted (not undefined-assigned) when the
    // response did not return one
    expect((result.meta as Record<string, unknown>).scope).toBeUndefined();
    // The previously-seeded creds.scope must NOT have been overwritten with undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((h.client as any).creds.scope).toBe(
      "https://www.googleapis.com/auth/drive",
    );
  });

  it("status() with scope-insufficient credentials emits a single status-changed event carrying error=auth-revoked, and does NOT emit authentication-failed", async () => {
    const fakeFetch = vi.fn();
    const aboutSpy = vi.fn();
    const { client } = makeFakeDrive({ about: aboutSpy });
    const h = makeHarness({
      drive: client,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      creds: makeCredsWithScope("https://www.googleapis.com/auth/drive.file"),
    });
    // Snapshot event count after construction, before calling status().
    const eventsBefore = h.events.length;
    await expect(h.client.status()).rejects.toBeInstanceOf(DatasourceError);
    const eventsAfter = h.events.slice(eventsBefore);
    // Positive assertion: exactly one status-changed event carrying error=auth-revoked.
    const statusChangedEvents = eventsAfter.filter((e) => e.event === "status-changed");
    expect(statusChangedEvents).toHaveLength(1);
    const payload = statusChangedEvents[0]!.payload as { status?: string; error?: string };
    expect(payload.status).toBe("error");
    expect(payload.error).toBe("auth-revoked");
    // Negative assertion: no authentication-failed event on this path.
    const authFailedEvents = eventsAfter.filter((e) => e.event === "authentication-failed");
    expect(authFailedEvents).toHaveLength(0);
    // about.get must NOT be called when scope check fails first.
    expect(aboutSpy).not.toHaveBeenCalled();
  });

  it("status() with no meta.scope calls tokeninfo, persists the issued scope, then surfaces scope-insufficient when the issued scope is narrow", async () => {
    const aboutSpy = vi.fn(() => ({ storageQuota: { limit: "100", usage: "1" } }));
    const { client: drive } = makeFakeDrive({ about: aboutSpy });
    let tokeninfoCalls = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/tokeninfo")) {
        tokeninfoCalls += 1;
        return new Response(
          JSON.stringify({ scope: "https://www.googleapis.com/auth/drive.file" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch URL: ${u}`);
    }) as unknown as typeof fetch;
    const { store, puts } = makeSpyStore();
    // Seed the store so put-driven read-modify-write has something to read.
    const seedCreds = makeCredsWithScope(undefined); // legacy — no meta.scope
    store.get = async () => seedCreds;
    const h = makeHarness({
      drive,
      fetchImpl,
      creds: seedCreds,
      store,
    });
    // First status(): backfill + sufficiency check fails for narrow scope
    await expect(h.client.status()).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof DatasourceError)) return false;
      if (e.tag !== "auth-revoked") return false;
      const raw = e.raw as { kind?: string; actualScope?: string };
      return (
        raw?.kind === "scope-insufficient" &&
        raw?.actualScope === "https://www.googleapis.com/auth/drive.file"
      );
    });
    // tokeninfo was called exactly once
    expect(tokeninfoCalls).toBe(1);
    // The credential store's put was called once with meta.scope set
    expect(puts).toHaveLength(1);
    expect(
      (puts[0]!.creds.authResult.meta as Record<string, unknown>).scope,
    ).toBe("https://www.googleapis.com/auth/drive.file");
    // about.get NOT called — scope check stops first
    expect(aboutSpy).not.toHaveBeenCalled();
    // Second status(): no tokeninfo, no put — uses cached creds.scope
    await expect(h.client.status()).rejects.toBeInstanceOf(DatasourceError);
    expect(tokeninfoCalls).toBe(1); // unchanged
    expect(puts).toHaveLength(1); // unchanged
  });

  it("status() with no meta.scope and invalid_token from tokeninfo rejects with auth-revoked and does not persist", async () => {
    const aboutSpy = vi.fn(() => ({ storageQuota: { limit: "100", usage: "1" } }));
    const { client: drive } = makeFakeDrive({ about: aboutSpy });
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: "invalid_token", error_description: "Invalid Value" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const { store, puts } = makeSpyStore();
    const seedCreds = makeCredsWithScope(undefined);
    store.get = async () => seedCreds;
    const h = makeHarness({ drive, fetchImpl, creds: seedCreds, store });
    await expect(h.client.status()).rejects.toSatisfy((e: unknown) =>
      e instanceof DatasourceError && e.tag === "auth-revoked" && e.retryable === false,
    );
    expect(puts).toHaveLength(0);
    expect(aboutSpy).not.toHaveBeenCalled();
  });

  it("status() with no meta.scope and a network error from tokeninfo rejects with network-error, does not persist, and re-attempts on the next status()", async () => {
    const aboutSpy = vi.fn(() => ({ storageQuota: { limit: "100", usage: "1" } }));
    const { client: drive } = makeFakeDrive({ about: aboutSpy });
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      const err = new Error("connect ECONNRESET") as Error & Record<string, unknown>;
      err.code = "ECONNRESET";
      err.name = "FetchError";
      throw err;
    }) as unknown as typeof fetch;
    const { store, puts } = makeSpyStore();
    const seedCreds = makeCredsWithScope(undefined);
    store.get = async () => seedCreds;
    const h = makeHarness({ drive, fetchImpl, creds: seedCreds, store });
    await expect(h.client.status()).rejects.toSatisfy((e: unknown) =>
      e instanceof DatasourceError && e.tag === "network-error",
    );
    expect(puts).toHaveLength(0);
    // Next call retries the tokeninfo fetch (no caching of failed backfill)
    await expect(h.client.status()).rejects.toSatisfy((e: unknown) =>
      e instanceof DatasourceError && e.tag === "network-error",
    );
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// rename — files.update for both files and folders
// (add-engine-rename-download §7.1-§7.6)
// ---------------------------------------------------------------------------
//
// Drive's `files.update({fileId, requestBody: { name }})` is uniform across
// files and folders. The strategy reads the response's `mimeType` to populate
// `kind` ("folder" iff mime === "application/vnd.google-apps.folder").
//
// `conflictPolicy` semantics, strategy-side per design.md Decision 1:
//   - "fail"      → pre-check siblings via files.list({q: "name='<new>'"});
//                   throw conflict { existingPath } if any.
//   - "overwrite" → pre-fetch target's mimeType; if folder, refuse with
//                   `tag: "unsupported"` per "directory rename refusal" rule.
//                   On a file: skip the sibling pre-check (S3-style overwrite).
//   - "keep-both" → §4 base-class delegates the suffix-retry loop to the
//                   strategy; tested separately under §7.x if covered.

describe("GoogleDriveClient — doRenameImpl (files.update, kind via mimeType)", () => {
  it("renames a file via drive.files.update and emits one entry-renamed event with kind='file' from the post-rename mimeType", async () => {
    const { client, calls } = makeFakeDrive({
      lists: [
        // Path resolution: /old.txt
        {
          qMatch: "name='old.txt'",
          handler: () => ({
            files: [
              {
                id: "FILE-X",
                name: "old.txt",
                mimeType: "text/plain",
                parents: ["root"],
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
        // Sibling pre-check on `fail`: no existing sibling.
        {
          qMatch: "name='new.txt'",
          handler: () => ({ files: [] }),
        },
      ],
      updates: [
        {
          fileId: "FILE-X",
          handler: (params) => {
            const rb = (params.requestBody ?? {}) as { name?: string };
            expect(rb.name).toBe("new.txt");
            return {
              id: "FILE-X",
              name: "new.txt",
              mimeType: "text/plain",
              parents: ["root"],
              size: "12",
              modifiedTime: "2024-06-02T00:00:00Z",
              createdTime: "2024-01-01T00:00:00Z",
            };
          },
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const entry = await h.client.rename(
      { kind: "path", path: "/old.txt" },
      "new.txt",
      "fail",
    );
    expect(entry.handle).toBe("FILE-X");
    expect(entry.name).toBe("new.txt");
    expect(entry.kind).toBe("file");
    expect(entry.mimeFamily).toBe("document");
    expect(entry.providerMetadata.fileId).toBe("FILE-X");
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]!.fileId).toBe("FILE-X");

    const renames = h.events.filter((e) => e.event === "entry-renamed");
    expect(renames).toHaveLength(1);
    expect(h.events.some((e) => e.event === "delete-failed")).toBe(false);
  });

  it("renames a folder via drive.files.update — same uniform call shape; kind='folder' from the post-rename mimeType", async () => {
    const { client, calls } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='photos'",
          handler: () => ({
            files: [
              {
                id: "FOLDER-Y",
                name: "photos",
                mimeType: "application/vnd.google-apps.folder",
                parents: ["root"],
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
        {
          qMatch: "name='pictures'",
          handler: () => ({ files: [] }),
        },
      ],
      updates: [
        {
          fileId: "FOLDER-Y",
          handler: () => ({
            id: "FOLDER-Y",
            name: "pictures",
            mimeType: "application/vnd.google-apps.folder",
            parents: ["root"],
            modifiedTime: "2024-06-02T00:00:00Z",
            createdTime: "2024-01-01T00:00:00Z",
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const entry = await h.client.rename(
      { kind: "path", path: "/photos" },
      "pictures",
      "fail",
    );
    expect(entry.kind).toBe("folder");
    expect(entry.mimeFamily).toBe("folder");
    expect(entry.name).toBe("pictures");
    expect(calls.update).toHaveLength(1);
  });
});

describe("GoogleDriveClient — doRenameImpl sibling-collision pre-check on `fail`", () => {
  it("issues a files.list({q: \"name='<new>' and '<parent>' in parents and trashed=false\"}) before the update; if results, throws conflict { existingPath }", async () => {
    const { client, calls } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='foo.txt'",
          handler: () => ({
            files: [
              {
                id: "FOO-ID",
                name: "foo.txt",
                mimeType: "text/plain",
                parents: ["root"],
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
        // Sibling check finds an existing /bar.txt
        {
          qMatch: "name='bar.txt'",
          handler: () => ({
            files: [
              {
                id: "BAR-EXISTING",
                name: "bar.txt",
                mimeType: "text/plain",
                parents: ["root"],
                createdTime: "2024-02-01T00:00:00Z",
              },
            ],
          }),
        },
      ],
      // No `updates` responder — if the strategy issues files.update the fake
      // throws (the test would still pass on rejection, but checking that
      // calls.update is empty is the behavioral assertion).
    });
    const h = makeHarness({ drive: client });

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
    const err = caught as DatasourceError<"google-drive">;
    expect(err.tag).toBe("conflict");
    // raw carries the existingPath so the consumer can populate the
    // FilesErrorEnvelope { existingPath } at the wire layer.
    expect((err.raw as { existingPath?: string }).existingPath).toBe(
      "/bar.txt",
    );
    // No update issued — pre-check short-circuited the rename.
    expect(calls.update).toHaveLength(0);

    // Failure-path bus emission goes through delete-failed { via: rename }.
    const failures = h.events.filter((e) => e.event === "delete-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toMatchObject({
      tag: "conflict",
      via: "rename",
    });
  });
});

describe("GoogleDriveClient — doRenameImpl `overwrite` on a file deletes the colliding sibling", () => {
  it("when policy='overwrite' AND a sibling with the new name exists in the same parent, deletes that sibling (via direct files.delete — no `deleted` bus emission) THEN issues files.update; bus observes one entry-renamed and zero `deleted` events", async () => {
    // Per design.md Decision 1 + base-client doRenameImpl JSDoc + §4.6:
    // strategy-side overwrite-on-file performs sibling-deletion (without
    // emitting a `deleted` bus event — that primitive is internal cleanup,
    // NOT a public deletion) THEN renames. Drive permits ambiguous siblings
    // by default (see class header); without this step, rename + overwrite
    // would silently create a duplicate name in the same parent.
    const { client, calls } = makeFakeDrive({
      lists: [
        // Path resolution: /old.txt
        {
          qMatch: "name='old.txt'",
          handler: () => ({
            files: [
              {
                id: "OLD-FILE",
                name: "old.txt",
                mimeType: "text/plain",
                parents: ["root"],
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
        // Sibling-list for the new name: returns ONE colliding sibling.
        {
          qMatch: "name='new.txt'",
          handler: () => ({
            files: [
              {
                id: "EXISTING-NEW",
                name: "new.txt",
                mimeType: "text/plain",
                parents: ["root"],
                createdTime: "2024-02-01T00:00:00Z",
              },
            ],
          }),
        },
      ],
      gets: [
        // Pre-rename mimeType probe on the overwrite path.
        {
          fileId: "OLD-FILE",
          handler: () => ({ id: "OLD-FILE", mimeType: "text/plain" }),
        },
      ],
      deletes: [
        {
          fileId: "EXISTING-NEW",
          handler: () => ({}),
        },
      ],
      updates: [
        {
          fileId: "OLD-FILE",
          handler: () => ({
            id: "OLD-FILE",
            name: "new.txt",
            mimeType: "text/plain",
            parents: ["root"],
            modifiedTime: "2024-06-02T00:00:00Z",
            createdTime: "2024-01-01T00:00:00Z",
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const entry = await h.client.rename(
      { kind: "path", path: "/old.txt" },
      "new.txt",
      "overwrite",
    );
    expect(entry.handle).toBe("OLD-FILE");
    expect(entry.name).toBe("new.txt");
    expect(calls.delete).toHaveLength(1);
    expect(calls.delete[0]!.fileId).toBe("EXISTING-NEW");
    expect(calls.update).toHaveLength(1);

    // No `deleted` event — the strategy-internal sibling cleanup MUST NOT
    // emit a public deletion (per the engine-wide convention that
    // primitives don't emit; only the public `deleteFile` wrapper does).
    expect(h.events.some((e) => e.event === "deleted")).toBe(false);
    const renames = h.events.filter((e) => e.event === "entry-renamed");
    expect(renames).toHaveLength(1);
  });
});

describe("GoogleDriveClient — doRenameImpl directory-overwrite refusal", () => {
  it("when target.mimeType === folder mime AND policy === 'overwrite', throws unsupported with the spec-required message; no update call issued", async () => {
    const { client, calls } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='photos'",
          handler: () => ({
            files: [
              {
                id: "FOLDER-Z",
                name: "photos",
                mimeType: "application/vnd.google-apps.folder",
                parents: ["root"],
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
      ],
      gets: [
        {
          // Pre-rename mimeType fetch on overwrite path.
          fileId: "FOLDER-Z",
          handler: () => ({
            id: "FOLDER-Z",
            mimeType: "application/vnd.google-apps.folder",
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });

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
    const err = caught as DatasourceError<"google-drive">;
    expect(err.tag).toBe("unsupported");
    expect(err.message).toBe(
      "directory rename with conflictPolicy 'overwrite' is not supported (would require recursive replacement)",
    );
    expect(calls.update).toHaveLength(0);

    // Unsupported is silent on the bus — no delete-failed event for this
    // refusal path (per the engine-wide convention).
    expect(h.events.some((e) => e.event === "delete-failed")).toBe(false);
    expect(h.events.some((e) => e.event === "entry-renamed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rename — `keep-both` policy: suffix-retry loop (§7.13-§7.14)
// ---------------------------------------------------------------------------
//
// Strategy-side suffix-retry loop per design.md Decision 1. The strategy
// issues a sibling-list query for the candidate name (starting with the
// original `newName`); on collision, retries with `<base>-2.<ext>`,
// `<base>-3.<ext>`, ..., preserving the file extension across attempts.
// The original counts as attempt #1, so suffixes 2..99 cover up to 99
// total attempts. On exhaustion (99 collisions), throws
// `DatasourceError { tag: "provider-error", message: "exhausted keep-both
// attempts" }` — the engine taxonomy at
// `packages/ipc-contracts/src/fs-datasource-engine.ts:400-413` lacks an
// `"other"` tag, so `provider-error` is the canonical no-better-tag
// engine-side value; the wire-layer (`services/fs-sync/src/commands/
// files-error-mapping.ts`) collapses it to `tag: "other"` before the
// renderer sees the error. Spec scenario at
// `specs/fs-datasource-engine/spec.md:191-193` describes the user-visible
// shape.
//
// Extension preservation uses the path-style basename / extname split:
// `foo.pdf` → base `foo`, ext `.pdf` → candidate `foo-2.pdf`.
// Extensionless names like `Makefile` → base `Makefile`, ext `""` →
// candidate `Makefile-2`.

describe("GoogleDriveClient — doRenameImpl `keep-both` policy retries with suffix until success", () => {
  it("first sibling-list collides for `bar.pdf`, second collides for `bar-2.pdf`, third returns empty for `bar-3.pdf`; then files.update with name='bar-3.pdf'; bus emits one entry-renamed with to.name='bar-3.pdf'", async () => {
    const { client, calls } = makeFakeDrive({
      lists: [
        // Path resolution: /foo.pdf
        {
          qMatch: "name='foo.pdf'",
          handler: () => ({
            files: [
              {
                id: "FOO-FILE",
                name: "foo.pdf",
                mimeType: "application/pdf",
                parents: ["root"],
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
        // Sibling check: bar.pdf collides.
        {
          qMatch: "name='bar.pdf'",
          handler: () => ({
            files: [
              {
                id: "BAR-EXISTING",
                name: "bar.pdf",
                mimeType: "application/pdf",
                parents: ["root"],
                createdTime: "2024-02-01T00:00:00Z",
              },
            ],
          }),
        },
        // Sibling check: bar-2.pdf collides.
        {
          qMatch: "name='bar-2.pdf'",
          handler: () => ({
            files: [
              {
                id: "BAR2-EXISTING",
                name: "bar-2.pdf",
                mimeType: "application/pdf",
                parents: ["root"],
                createdTime: "2024-02-02T00:00:00Z",
              },
            ],
          }),
        },
        // Sibling check: bar-3.pdf is free.
        {
          qMatch: "name='bar-3.pdf'",
          handler: () => ({ files: [] }),
        },
      ],
      updates: [
        {
          fileId: "FOO-FILE",
          handler: (params) => {
            const rb = (params.requestBody ?? {}) as { name?: string };
            expect(rb.name).toBe("bar-3.pdf");
            return {
              id: "FOO-FILE",
              name: "bar-3.pdf",
              mimeType: "application/pdf",
              parents: ["root"],
              size: "12",
              modifiedTime: "2024-06-02T00:00:00Z",
              createdTime: "2024-01-01T00:00:00Z",
            };
          },
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const entry = await h.client.rename(
      { kind: "path", path: "/foo.pdf" },
      "bar.pdf",
      "keep-both",
    );
    expect(entry.name).toBe("bar-3.pdf");
    expect(entry.handle).toBe("FOO-FILE");
    // Exactly one update call — the loop only fires update on the first
    // collision-free candidate.
    expect(calls.update).toHaveLength(1);
    expect(
      (calls.update[0]!.requestBody as { name?: string } | undefined)?.name,
    ).toBe("bar-3.pdf");

    const renames = h.events.filter((e) => e.event === "entry-renamed");
    expect(renames).toHaveLength(1);
    expect(
      (renames[0]!.payload as { to?: { name?: string } }).to?.name,
    ).toBe("bar-3.pdf");
    expect(h.events.some((e) => e.event === "delete-failed")).toBe(false);
  });

  it("after 99 collisions (newName + suffixes 2..99), throws DatasourceError { tag: 'provider-error', message: 'exhausted keep-both attempts' } (wire-layer collapses provider-error → 'other' downstream); no files.update issued", async () => {
    // The fake's lookup uses substring matching on the q parameter — when
    // every sibling query returns a collision, no list responder needs to
    // be name-specific. A single permissive responder that matches the
    // shared `'root' in parents and trashed=false` substring covers every
    // sibling-check call. Path resolution for /foo.pdf still needs its own
    // handler keyed on `name='foo.pdf'` first (substring match grabs the
    // first responder; we list it first so resolution wins).
    let listCalls = 0;
    const { client, calls } = makeFakeDrive({
      lists: [
        // Path resolution: /foo.pdf — must come first (substring would
        // otherwise be eaten by the catch-all). The catch-all below uses
        // the broader `' in parents and trashed=false'` substring so it
        // doesn't cannibalize this one's `name='foo.pdf'` query first.
        {
          qMatch: "name='foo.pdf'",
          handler: () => {
            // Path resolution counts ONCE; subsequent `name='foo.pdf'`
            // queries from the keep-both loop won't happen because the
            // candidate names progress to `foo-2.pdf` etc. We don't use
            // `foo.pdf` as the new name — we use `bar.pdf` — so the
            // path-resolution handler fires exactly once.
            return {
              files: [
                {
                  id: "FOO-FILE",
                  name: "foo.pdf",
                  mimeType: "application/pdf",
                  parents: ["root"],
                  createdTime: "2024-01-01T00:00:00Z",
                },
              ],
            };
          },
        },
        // Catch-all collision responder for every sibling-check query.
        {
          qMatch: "in parents and trashed=false",
          handler: () => {
            listCalls++;
            return {
              files: [
                {
                  id: `COLLIDER-${listCalls}`,
                  name: "collide",
                  mimeType: "application/pdf",
                  parents: ["root"],
                  createdTime: "2024-02-01T00:00:00Z",
                },
              ],
            };
          },
        },
      ],
    });
    const h = makeHarness({ drive: client });

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
    const err = caught as DatasourceError<"google-drive">;
    // Engine taxonomy uses `provider-error` for exhaustion (no `"other"`
    // tag exists in `DatasourceErrorTag`); the wire layer's
    // `normalizeFilesError` (services/fs-sync) maps provider-error →
    // tag: "other" before the renderer sees it.
    expect(err.tag).toBe("provider-error");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe("exhausted keep-both attempts");
    // 99 collision-check calls (newName + suffixes 2..99 = 99 candidates).
    expect(listCalls).toBe(99);
    // No update issued — every candidate collided.
    expect(calls.update).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// downloadFile — files.get({alt: "media"}, {responseType: "stream", ...})
// (add-engine-rename-download §7.7-§7.12)
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — doDownloadFileImpl (files.get alt=media stream)", () => {
  it("calls files.get({fileId, alt:'media'}, {responseType:'stream', signal}) and resolves with stream + contentLength + bus emits downloading + file-downloaded", async () => {
    const fixture = Buffer.from("hello-world-bytes");
    const { client, calls } = makeFakeDrive({
      lists: [
        {
          qMatch: "name='hello.txt'",
          handler: () => ({
            files: [
              {
                id: "DL-ID",
                name: "hello.txt",
                mimeType: "text/plain",
                parents: ["root"],
                size: String(fixture.length),
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        },
      ],
      // Post-archive (2026-04-28): the strategy issues a metadata
      // pre-fetch (`fields: "mimeType"` post-smoke-2) before the
      // alt=media stream call to detect Google Apps files. The fake
      // routes non-`alt=media` `files.get` calls to this matcher.
      gets: [
        {
          fileId: "DL-ID",
          handler: () => ({
            id: "DL-ID",
            name: "hello.txt",
            mimeType: "text/plain",
          }),
        },
      ],
      getStreams: [
        {
          fileId: "DL-ID",
          handler: (params, options) => {
            // alt: media + responseType stream are the contract per task §7.7.
            expect(params.alt).toBe("media");
            expect(options?.responseType).toBe("stream");
            const stream = new Readable({
              read() {
                this.push(fixture);
                this.push(null);
              },
            });
            return {
              stream,
              headers: {
                "content-length": String(fixture.length),
              },
            };
          },
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const result = await h.client.downloadFile({
      kind: "path",
      path: "/hello.txt",
    });
    expect(result.contentLength).toBe(fixture.length);
    expect(result.contentRange).toBeUndefined();
    // Drain the stream so the base's `end` listener fires `file-downloaded`.
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      result.stream.on("data", (c: Buffer) => chunks.push(c));
      result.stream.on("end", () => resolve());
      result.stream.on("error", reject);
    });
    expect(Buffer.concat(chunks).toString()).toBe(fixture.toString());
    // Two `files.get` calls now: (1) metadata pre-fetch for Google
    // Apps detection (`fields: "mimeType"` post-smoke-2; the per-file
    // name was dropped from the user copy so we no longer fetch it);
    // (2) the alt=media stream call. The metadata call must NOT carry
    // `alt=media`.
    expect(calls.get).toHaveLength(2);
    expect(calls.get[0]!.params.fileId).toBe("DL-ID");
    expect(calls.get[0]!.params.alt).toBeUndefined();
    expect(calls.get[0]!.params.fields).toBe("mimeType");
    expect(calls.get[1]!.params.fileId).toBe("DL-ID");
    expect(calls.get[1]!.params.alt).toBe("media");

    const downloadings = h.events.filter((e) => e.event === "downloading");
    const downloaded = h.events.filter((e) => e.event === "file-downloaded");
    expect(downloadings.length).toBeGreaterThanOrEqual(1);
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]!.payload).toMatchObject({
      path: "/hello.txt",
      bytes: fixture.length,
    });
    expect(h.events.some((e) => e.event === "download-failed")).toBe(false);
    expect(h.events.some((e) => e.event === "download-cancelled")).toBe(false);
  });

  it("forwards options.rangeStart > 0 as a Range:bytes=<n>- header into the SDK call and parses Content-Range from the 206 response", async () => {
    const partial = Buffer.from("PARTIAL");
    const total = 1024;
    const start = 16;
    const { client, calls } = makeFakeDrive({
      // Metadata pre-fetch for Google Apps detection — see test (1)
      // above for the rationale.
      gets: [
        {
          fileId: "RANGE-ID",
          handler: () => ({
            id: "RANGE-ID",
            name: "range-fixture.bin",
            mimeType: "application/octet-stream",
          }),
        },
      ],
      getStreams: [
        {
          fileId: "RANGE-ID",
          handler: (_params, options) => {
            const headers =
              (options?.headers ?? {}) as Record<string, string>;
            expect(headers.Range).toBe(`bytes=${start}-`);
            const stream = new Readable({
              read() {
                this.push(partial);
                this.push(null);
              },
            });
            return {
              stream,
              headers: {
                "content-length": String(partial.length),
                "content-range": `bytes ${start}-${start + partial.length - 1}/${total}`,
              },
            };
          },
        },
      ],
    });
    const h = makeHarness({ drive: client });
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
    // Drain so the base emits file-downloaded.
    await new Promise<void>((resolve, reject) => {
      result.stream.on("data", () => {});
      result.stream.on("end", () => resolve());
      result.stream.on("error", reject);
    });
    // Two `files.get` calls (metadata + alt=media) per the post-archive
    // Google Apps detection pre-fetch.
    expect(calls.get).toHaveLength(2);
  });
});

describe("GoogleDriveClient — doDownloadFileImpl AbortSignal forwarding", () => {
  it("aborting the consumer signal makes the SDK reject AbortError; bus emits exactly one download-cancelled with the byte counts at abort time; no download-failed", async () => {
    const controller = new AbortController();
    const { client } = makeFakeDrive({
      gets: [
        {
          fileId: "CANCEL-ID",
          handler: () => ({
            id: "CANCEL-ID",
            name: "cancel-fixture.bin",
            mimeType: "application/octet-stream",
          }),
        },
      ],
      getStreams: [
        {
          fileId: "CANCEL-ID",
          handler: (_params, options) => {
            const sig = options?.signal as AbortSignal | undefined;
            const stream = new Readable({ read() {} });
            // Wire the abort listener BEFORE pushing data: pushing is
            // synchronous so the consumer's data handler (which fires
            // controller.abort()) runs inside `push()` — if the abort
            // listener were registered after `push()`, it would miss
            // an already-aborted signal because EventTarget does not
            // back-fire for `addEventListener` after `abort()`.
            if (sig) {
              sig.addEventListener("abort", () => {
                stream.destroy(
                  Object.assign(new Error("aborted"), {
                    name: "AbortError",
                  }),
                );
              });
            }
            // First chunk lands so byte counts are non-zero at abort time.
            setImmediate(() => {
              stream.push(Buffer.alloc(2048));
            });
            return {
              stream,
              headers: { "content-length": "16384" },
            };
          },
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const result = await h.client.downloadFile(
      { kind: "handle", handle: "CANCEL-ID" },
      { signal: controller.signal },
    );
    // Drive consumer pipe so byte counter ticks; then abort.
    let bytesSeen = 0;
    const consumer = new Promise<unknown>((resolve) => {
      result.stream.on("data", (c: Buffer) => {
        bytesSeen += c.length;
        // Trigger abort once first chunk has been observed.
        if (bytesSeen >= 2048) controller.abort();
      });
      result.stream.on("error", (err) => resolve(err));
      result.stream.on("end", () => resolve(null));
    });
    await consumer;

    const cancelled = h.events.filter((e) => e.event === "download-cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.payload).toMatchObject({
      path: "CANCEL-ID",
      bytesDownloaded: 2048,
    });
    expect(h.events.some((e) => e.event === "download-failed")).toBe(false);
    expect(h.events.some((e) => e.event === "file-downloaded")).toBe(false);
  });
});

describe("GoogleDriveClient — doDownloadFileImpl mid-stream 401 → auth-expired → download-failed", () => {
  it("normalizes a mid-stream 401 to tag:auth-expired; bus emits exactly one download-failed whose payload IS the SerializedDatasourceError; no download-cancelled", async () => {
    const { client } = makeFakeDrive({
      gets: [
        {
          fileId: "401-ID",
          handler: () => ({
            id: "401-ID",
            name: "401-fixture.bin",
            mimeType: "application/octet-stream",
          }),
        },
      ],
      getStreams: [
        {
          fileId: "401-ID",
          handler: () => {
            const stream = new Readable({ read() {} });
            // Push a chunk so byte-counting fires once, then synthesize a
            // mid-stream 401 by destroying the stream with a Gaxios-shaped
            // 401 error. The strategy's normalizeErrorImpl maps this to
            // tag:auth-expired; the base emits download-failed carrying the
            // serialized error.
            setImmediate(() => {
              stream.push(Buffer.alloc(512));
              const err401 = makeGaxiosError(
                401,
                "auth-expired-mid-stream",
                "authError",
              );
              stream.destroy(err401);
            });
            return {
              stream,
              headers: { "content-length": "8192" },
            };
          },
        },
      ],
    });
    const h = makeHarness({ drive: client });
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
    expect(caught).toBeInstanceOf(Error);

    const failed = h.events.filter((e) => e.event === "download-failed");
    expect(failed).toHaveLength(1);
    // Payload IS the SerializedDatasourceError — not a wrapper. Mirrors
    // base-client.test.ts §5.9 + the authentication-failed precedent.
    expect(failed[0]!.payload).toMatchObject({
      tag: "auth-expired",
      datasourceType: "google-drive",
      datasourceId: "ds-gd-1",
    });
    expect(h.events.some((e) => e.event === "download-cancelled")).toBe(false);
    expect(h.events.some((e) => e.event === "file-downloaded")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// doDownloadFileImpl — Google Apps native files refuse with friendly error
// (post-archive smoke 2026-04-28; parked follow-up `add-drive-docs-editors-export`)
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — doDownloadFileImpl Google Apps native refusal", () => {
  it("Google Doc (mimeType application/vnd.google-apps.document) throws DatasourceError tag:'unsupported' with the concise toast message; no alt=media call is issued", async () => {
    // The strategy's metadata pre-fetch must catch the Google Apps mime
    // BEFORE the alt=media stream call. Post-smoke-2 (2026-04-28): the
    // user-facing message is a single concise line — the per-subtype
    // humanized noun + "Open it in Drive..." prose was rejected as
    // toast noise. The parked follow-up `add-drive-docs-editors-export`
    // still owns the proper export-path implementation.
    const { client, calls } = makeFakeDrive({
      gets: [
        {
          fileId: "DOC-ID",
          handler: () => ({
            id: "DOC-ID",
            name: "DT-206 Code Review",
            mimeType: "application/vnd.google-apps.document",
          }),
        },
      ],
      // No `getStreams` — the strategy must refuse before it would
      // dispatch the alt=media call. If the refusal misses, the fake
      // throws `no-get-stream-responder` and the test still surfaces
      // a failure (via a different error message).
    });
    const h = makeHarness({ drive: client });
    let caught: unknown;
    try {
      await h.client.downloadFile({ kind: "handle", handle: "DOC-ID" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    const e = caught as DatasourceError<"google-drive">;
    expect(e.tag).toBe("unsupported");
    expect(e.retryable).toBe(false);
    expect(e.message).toBe("Google Drive documents download not supported");

    // Only ONE files.get call — the metadata pre-fetch. No alt=media.
    expect(calls.get).toHaveLength(1);
    expect(calls.get[0]!.params.alt).toBeUndefined();
    expect(calls.get[0]!.params.fields).toBe("mimeType");

    // The base's downloadFile wrapper MUST emit `download-failed` even
    // for `tag: "unsupported"` throws from `doDownloadFileImpl` —
    // otherwise the renderer's toaster never sees the failure and the
    // user gets silent nothing (worse than the raw 403 they had before
    // this fix). Verify the event reaches the bus carrying the
    // concise message the renderer renders.
    const failed = h.events.filter((e) => e.event === "download-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({
      tag: "unsupported",
      datasourceType: "google-drive",
      datasourceId: "ds-gd-1",
    });
    const failedPayload = failed[0]!.payload as { message?: string };
    expect(failedPayload.message).toBe(
      "Google Drive documents download not supported",
    );
  });

  it("each Google Apps subtype (sheet/presentation/drawing/form/script) is refused with the same concise message", async () => {
    // Post-smoke-2 (2026-04-28): the per-subtype noun was dropped from
    // the user copy; every Apps subtype now produces the same line.
    const subtypes = [
      "spreadsheet",
      "presentation",
      "drawing",
      "form",
      "script",
    ];
    for (const subtype of subtypes) {
      const fileId = `APPS-${subtype.toUpperCase()}`;
      const { client } = makeFakeDrive({
        gets: [
          {
            fileId,
            handler: () => ({
              id: fileId,
              name: `fixture-${subtype}`,
              mimeType: `application/vnd.google-apps.${subtype}`,
            }),
          },
        ],
      });
      const h = makeHarness({ drive: client });
      let caught: unknown;
      try {
        await h.client.downloadFile({ kind: "handle", handle: fileId });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DatasourceError);
      const e = caught as DatasourceError<"google-drive">;
      expect(e.tag).toBe("unsupported");
      expect(e.message).toBe("Google Drive documents download not supported");
    }
  });

  it("an unknown application/vnd.google-apps.<future> subtype still refuses with the concise message (defence-in-depth against new Google types)", async () => {
    const { client } = makeFakeDrive({
      gets: [
        {
          fileId: "FUTURE-ID",
          handler: () => ({
            id: "FUTURE-ID",
            name: "future-thing",
            mimeType: "application/vnd.google-apps.somethingnew",
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    let caught: unknown;
    try {
      await h.client.downloadFile({ kind: "handle", handle: "FUTURE-ID" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    const e = caught as DatasourceError<"google-drive">;
    expect(e.tag).toBe("unsupported");
    expect(e.message).toBe("Google Drive documents download not supported");
  });

  it("DRIVE_FOLDER_MIME (application/vnd.google-apps.folder) is NOT caught by the Google Apps refusal — folder downloads have their own existing failure path (kind='folder' upstream)", async () => {
    // Sanity: if we ever lower the folder check we must not break the
    // existing folder-handling path. The Google Apps detection
    // explicitly excludes the folder mime so the refusal does not
    // alias as a "folder download" case. Here we verify by giving the
    // pre-fetch a folder mime and checking that the strategy proceeds
    // to the (missing) alt=media call — which should then fail in the
    // fake with `no-get-stream-responder`, not the friendly Apps msg.
    const { client } = makeFakeDrive({
      gets: [
        {
          fileId: "FOLDER-ID",
          handler: () => ({
            id: "FOLDER-ID",
            name: "Untitled folder",
            mimeType: "application/vnd.google-apps.folder",
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    let caught: unknown;
    try {
      await h.client.downloadFile({ kind: "handle", handle: "FOLDER-ID" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // The error must NOT be the friendly Apps message (different code
    // path); the fake's missing-stream responder bubbles up via
    // normalizeErrorImpl.
    const errMsg = (caught as Error).message ?? "";
    expect(errMsg).not.toContain("add-drive-docs-editors-export");
  });
});

// ---------------------------------------------------------------------------
// appendExtensionIfMissing — Drive's `name` titles often lack extensions for
// `text/plain` and a handful of other mimes, but the renderer derives the
// local-save filename from `entry.name`. Strategy-side append closes the
// gap by consulting a small mime → canonical-extension lookup.
// (post-archive smoke-2 2026-04-28)
// ---------------------------------------------------------------------------

describe("appendExtensionIfMissing — Drive title → local filename repair", () => {
  it("appends '.txt' to an extensionless text/plain title", () => {
    expect(appendExtensionIfMissing("Getting Started", "text/plain")).toBe(
      "Getting Started.txt",
    );
  });

  it("leaves an already-correctly-extensioned name unchanged (no double-append)", () => {
    expect(appendExtensionIfMissing("Report.txt", "text/plain")).toBe(
      "Report.txt",
    );
  });

  it("appends '.png' to an extensionless image/png title", () => {
    expect(appendExtensionIfMissing("scan", "image/png")).toBe("scan.png");
  });

  it("leaves an already-extensioned text/csv name unchanged", () => {
    expect(appendExtensionIfMissing("data.csv", "text/csv")).toBe("data.csv");
  });

  it("returns the name unchanged for an unknown mime (no append, no guess)", () => {
    expect(
      appendExtensionIfMissing("mystery", "application/octet-stream"),
    ).toBe("mystery");
  });

  it("returns the name unchanged for undefined mime (defensive)", () => {
    expect(appendExtensionIfMissing("loose", undefined)).toBe("loose");
  });

  it("returns empty unchanged (avoids producing a path that is just the extension)", () => {
    expect(appendExtensionIfMissing("", "text/plain")).toBe("");
  });

  it("treats names with a different extension as already-extensioned (preserves provider intent)", () => {
    // Caller said the mime is text/plain but the name is `.dat` — we
    // don't second-guess; `extname()` is non-empty so we leave it.
    expect(appendExtensionIfMissing("Fixture.dat", "text/plain")).toBe(
      "Fixture.dat",
    );
  });
});

// Integration: a `text/plain` row in the Drive listing whose `name` lacks
// `.txt` produces an entry whose `name` carries the canonical extension,
// so the renderer's `joinFolderAndName(folder, entry.name)` lands on
// `<folder>/<title>.txt` rather than `<folder>/<title>`.
describe("GoogleDriveClient — listDirectory entry.name extension repair", () => {
  it("appends '.txt' to a text/plain Drive title that lacks an extension (smoke-2 fix)", async () => {
    const { client } = makeFakeDrive({
      lists: [
        {
          qMatch: "'root' in parents",
          handler: () => ({
            files: [
              {
                id: "DOC-PLAIN-1",
                // Title with NO extension — Drive's web "New > Text file"
                // flow produces titles in this shape.
                name: "Getting Started",
                mimeType: "text/plain",
                parents: ["root"],
                size: "100",
                modifiedTime: "2024-06-02T00:00:00Z",
                createdTime: "2024-01-02T00:00:00Z",
              },
            ],
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const entries = await h.client.listDirectory({
      kind: "path",
      path: "/",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("Getting Started.txt");
    // The engine `path` is unchanged (still synthesized from the raw
    // title) — only the user-facing `name` is repaired. Renderer reads
    // `entry.name` for the local-save target.
    expect(entries[0]!.providerMetadata.mimeType).toBe("text/plain");
  });

  it("leaves a text/plain title that already carries '.txt' unchanged (no double-append)", async () => {
    const { client } = makeFakeDrive({
      lists: [
        {
          qMatch: "'root' in parents",
          handler: () => ({
            files: [
              {
                id: "DOC-PLAIN-2",
                name: "Report.txt",
                mimeType: "text/plain",
                parents: ["root"],
                size: "200",
                modifiedTime: "2024-06-02T00:00:00Z",
                createdTime: "2024-01-02T00:00:00Z",
              },
            ],
          }),
        },
      ],
    });
    const h = makeHarness({ drive: client });
    const entries = await h.client.listDirectory({
      kind: "path",
      path: "/",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("Report.txt");
  });
});
