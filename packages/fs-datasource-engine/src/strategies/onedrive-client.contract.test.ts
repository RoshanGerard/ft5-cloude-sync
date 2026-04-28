// OneDriveClient shared-contract-suite invocation.
//
// This file supplies a OneDrive-shaped `StrategyContractFixture` and delegates
// to `runStrategyContractSuite`. The fixture primes a fake Graph client and a
// fake `fetch` to cover every scenario the contract suite exercises.
//
// Unlike S3, OneDrive is OAuth — the suite's `primeAuthFailureOnList` has
// to account for the fact that the base class will automatically invoke
// `refreshTokenImpl` once on `auth-expired`. We prime both the Graph list
// call AND the token-refresh endpoint to return `invalid_grant`, so the
// refresh itself fails with `auth-revoked`, causing the base to re-throw
// the original `auth-expired` tag — which is what the contract asserts.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

import { providers, type StoredCredentials } from "@ft5/ipc-contracts";

import type { BaseClientContext } from "../base-client.js";
import {
  runStrategyContractSuite,
  type StrategyContractFixture,
} from "../__tests__/strategy-contract.js";
import {
  createOneDriveClient,
  type GraphClientLike,
  type GraphRequestBuilderLike,
} from "./onedrive-client.js";

// ---------------------------------------------------------------------------
// Per-test mutable state — the fixture's `resetMock()` rebuilds these.
// ---------------------------------------------------------------------------

type VerbResponder = {
  get?: () => unknown;
  post?: (body?: unknown) => unknown;
  put?: (body?: unknown) => unknown;
  patch?: (body?: unknown) => unknown;
  delete?: () => unknown;
};
type PathResponder = { match: string; verbs: VerbResponder };

let responders: PathResponder[] = [];
let fetchResponses: Array<() => Response> = [];
let graphApiCalls: string[] = [];

function buildGraphClient(): GraphClientLike {
  return {
    api(path: string) {
      graphApiCalls.push(path);
      const found = responders.find((r) => path.startsWith(r.match));
      const builder: GraphRequestBuilderLike = {
        header: () => builder,
        headers: () => builder,
        query: () => builder,
        select: () => builder,
        expand: () => builder,
        async get() {
          if (!found?.verbs.get) {
            throw Object.assign(new Error(`no-get-responder ${path}`), {
              statusCode: 500,
            });
          }
          return found.verbs.get();
        },
        async post(body?: unknown) {
          if (!found?.verbs.post) {
            throw Object.assign(new Error(`no-post-responder ${path}`), {
              statusCode: 500,
            });
          }
          return found.verbs.post(body);
        },
        async put(body?: unknown) {
          if (!found?.verbs.put) {
            throw Object.assign(new Error(`no-put-responder ${path}`), {
              statusCode: 500,
            });
          }
          return found.verbs.put(body);
        },
        async patch(body?: unknown) {
          if (!found?.verbs.patch) {
            throw Object.assign(new Error(`no-patch-responder ${path}`), {
              statusCode: 500,
            });
          }
          return found.verbs.patch(body);
        },
        async delete() {
          if (!found?.verbs.delete) {
            throw Object.assign(new Error(`no-delete-responder ${path}`), {
              statusCode: 500,
            });
          }
          return found.verbs.delete();
        },
      };
      return builder;
    },
  };
}

const fakeFetch = vi.fn(async () => {
  const next = fetchResponses.shift();
  if (!next) {
    return new Response("{}", { status: 500 });
  }
  return next();
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const credentials: StoredCredentials = {
  providerId: "onedrive",
  authResult: {
    accessToken: "access-tok",
    refreshToken: "refresh-tok",
    meta: {
      clientId: "contract-client",
      tenantId: "common",
      redirectUri: "http://localhost/callback",
    },
  },
  createdAt: 0,
  updatedAt: 0,
};

const tmp = mkdtempSync(join(tmpdir(), "od-contract-"));

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const fixture: StrategyContractFixture = {
  credentials,
  expectedAuthErrorTag: "auth-expired",
  supportsQuota: true,

  resetMock() {
    responders = [];
    fetchResponses = [];
    graphApiCalls = [];
    (fakeFetch as unknown as ReturnType<typeof vi.fn>).mockClear();
  },

  primeListOk(opts) {
    // Map rootPath "/" to the root listing endpoint; non-root to the path endpoint.
    const rootSuffix =
      opts.rootPath === "/" || opts.rootPath === ""
        ? "/me/drive/root/children"
        : `/me/drive/root:${opts.rootPath}:/children`;
    responders.push({
      match: rootSuffix,
      verbs: {
        get: () => ({
          value: [
            {
              id: "contract-folder-id",
              name: "folder-a",
              folder: { childCount: 0 },
              lastModifiedDateTime: "2024-06-01T00:00:00Z",
              parentReference: { path: `/drive/root:${opts.rootPath === "/" ? "" : opts.rootPath}` },
            },
            {
              id: "contract-file-id",
              name: "file-a.txt",
              file: { mimeType: "text/plain" },
              size: 10,
              lastModifiedDateTime: "2024-06-01T00:00:00Z",
              parentReference: { path: `/drive/root:${opts.rootPath === "/" ? "" : opts.rootPath}` },
            },
          ],
        }),
      },
    });
    // When a folder entry's children are subsequently listed via handle, the
    // suite calls `/me/drive/items/<id>/children`. Also prime the handle
    // endpoint so the handle-form-list test does not 500.
    responders.push({
      match: "/me/drive/items/contract-folder-id/children",
      verbs: { get: () => ({ value: [] }) },
    });
  },

  primeGetMetadata404(targetPath) {
    responders.push({
      match: `/me/drive/root:${targetPath}:`,
      verbs: {
        get: () => {
          throw Object.assign(new Error("itemNotFound"), {
            code: "itemNotFound",
            statusCode: 404,
          });
        },
      },
    });
  },

  primeRateLimitOnList() {
    responders.push({
      match: "/me/drive/root/children",
      verbs: {
        get: () => {
          throw Object.assign(new Error("activityLimitReached"), {
            code: "activityLimitReached",
            statusCode: 429,
            headers: { "retry-after": "2" },
          });
        },
      },
    });
  },

  primeAuthFailureOnList() {
    // Graph list throws 401 → base will trigger refresh once.
    responders.push({
      match: "/me/drive/root/children",
      verbs: {
        get: () => {
          throw Object.assign(new Error("InvalidAuthenticationToken"), {
            code: "InvalidAuthenticationToken",
            statusCode: 401,
          });
        },
      },
    });
    // Refresh fails with invalid_grant → re-throw auth-expired (the base
    // preserves the ORIGINAL normalized error — auth-expired — and emits
    // token-expired + authentication-failed).
    fetchResponses.push(
      () =>
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "bad" }),
          { status: 400 },
        ),
    );
  },

  buildLocalFile() {
    const p = join(tmp, `contract-${Date.now()}-${Math.random()}.txt`);
    writeFileSync(p, "contract-body");
    return p;
  },

  primeUploadOk(opts) {
    // Simple PUT — bodies under 4 MB go via direct `/content`.
    const base =
      opts.parentPath === "/" || opts.parentPath === ""
        ? `/me/drive/root:/`
        : `/me/drive/root:${opts.parentPath}/`;
    responders.push({
      match: base,
      verbs: {
        put: () => ({
          id: "contract-uploaded-id",
          name: "uploaded.txt",
          file: { mimeType: "text/plain" },
          size: 13,
          lastModifiedDateTime: "2024-06-01T00:00:00Z",
          parentReference: { path: `/drive/root:${opts.parentPath === "/" ? "" : opts.parentPath}` },
        }),
      },
    });
  },

  primeDeleteOk(targetPath) {
    responders.push({
      match: `/me/drive/root:${targetPath}:`,
      verbs: { delete: () => undefined },
    });
  },

  // -------------------------------------------------------------------------
  // §10.1 — rename + download contract hooks
  // -------------------------------------------------------------------------

  primeRenameFileOk(opts) {
    const itemId = "OD-CONTRACT-FILE";
    const parentId = "OD-CONTRACT-PARENT-ROOT";
    // resolveRenameTarget: GET /me/drive/root:/<fromPath>:
    responders.push({
      match: `/me/drive/root:${opts.fromPath}:`,
      verbs: {
        get: () => ({
          id: itemId,
          name: opts.fromPath.replace(/^\//, ""),
          file: { mimeType: "text/plain" },
          size: 12,
          lastModifiedDateTime: "2024-06-01T00:00:00Z",
          parentReference: { path: "/drive/root:", id: parentId },
        }),
      },
    });
    // sibling pre-check on `fail`: GET /me/drive/items/<parentId>/children?$filter=...
    responders.push({
      match: `/me/drive/items/${parentId}/children?$filter=name%20eq%20'${opts.newName}'`,
      verbs: { get: () => ({ value: [] }) },
    });
    // PATCH /me/drive/items/<itemId>
    responders.push({
      match: `/me/drive/items/${itemId}`,
      verbs: {
        patch: () => ({
          id: itemId,
          name: opts.newName,
          file: { mimeType: "text/plain" },
          size: 12,
          lastModifiedDateTime: "2024-06-02T00:00:00Z",
          parentReference: { path: "/drive/root:", id: parentId },
        }),
      },
    });
  },

  primeRenameDirectory(opts) {
    const itemId = "OD-CONTRACT-FOLDER";
    const parentId = "OD-CONTRACT-PARENT-ROOT";
    responders.push({
      match: `/me/drive/root:${opts.fromPath}:`,
      verbs: {
        get: () => ({
          id: itemId,
          name: opts.fromPath.replace(/^\//, ""),
          folder: { childCount: 2 },
          lastModifiedDateTime: "2024-06-01T00:00:00Z",
          parentReference: { path: "/drive/root:", id: parentId },
        }),
      },
    });
    responders.push({
      match: `/me/drive/items/${parentId}/children?$filter=name%20eq%20'${opts.newName}'`,
      verbs: { get: () => ({ value: [] }) },
    });
    responders.push({
      match: `/me/drive/items/${itemId}`,
      verbs: {
        patch: () => ({
          id: itemId,
          name: opts.newName,
          folder: { childCount: 2 },
          lastModifiedDateTime: "2024-06-02T00:00:00Z",
          parentReference: { path: "/drive/root:", id: parentId },
        }),
      },
    });
  },

  supportsFolderRename: true,

  primeDownloadOk(opts) {
    const itemId = "OD-CONTRACT-DL";
    // resolveTargetItemId: GET /me/drive/root:<path>: returns item w/ id.
    responders.push({
      match: `/me/drive/root:${opts.path}:`,
      verbs: {
        get: () => ({
          id: itemId,
          name: opts.path.replace(/^\//, ""),
          file: { mimeType: "text/plain" },
          size: opts.bytes.length,
          parentReference: { path: "/drive/root:", id: "OD-CONTRACT-DL-PARENT" },
        }),
      },
    });
    // The download URL is built from the resolved itemId; the fakeFetch
    // shifts a response from `fetchResponses` for any non-upload URL.
    fetchResponses.push(
      () =>
        new Response(opts.bytes, {
          status: 200,
          headers: { "content-length": String(opts.bytes.length) },
        }),
    );
  },

  primeDownloadCancellable(opts) {
    const itemId = "OD-CONTRACT-CANCEL";
    responders.push({
      match: `/me/drive/root:${opts.path}:`,
      verbs: {
        get: () => ({
          id: itemId,
          name: opts.path.replace(/^\//, ""),
          file: { mimeType: "text/plain" },
          size: opts.totalBytes,
          parentReference: { path: "/drive/root:", id: "OD-CONTRACT-CANCEL-PARENT" },
        }),
      },
    });
    // The fakeFetch closure has no access to the per-call init.signal,
    // so we override fakeFetch's behaviour for this scenario via an
    // override push to fetchResponses that consults `opts.controller`.
    // We push a function that builds a Response with a Web ReadableStream
    // body which pushes one chunk and awaits abort.
    fetchResponses.push(() => {
      const sig = opts.controller.signal;
      const body = new ReadableStream<Uint8Array>({
        start(streamCtrl) {
          // Push first chunk synchronously.
          streamCtrl.enqueue(new Uint8Array(opts.firstChunkBytes));
        },
        pull() {
          return new Promise<void>((_resolve, reject) => {
            sig.addEventListener("abort", () => {
              const err = Object.assign(new Error("aborted"), {
                name: "AbortError",
              });
              reject(err);
            });
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(opts.totalBytes) },
      });
    });
  },
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

runStrategyContractSuite({
  providerName: "OneDriveClient",
  buildClient: (bus, credentialStore, creds) => {
    const ctx: BaseClientContext = {
      bus,
      credentialStore,
      providerDescriptor: providers.onedrive,
    };
    return createOneDriveClient("ds-od-contract", creds, ctx, {
      graphFactory: () => buildGraphClient(),
      fetchImpl: fakeFetch,
    });
  },
  fixture,
});
