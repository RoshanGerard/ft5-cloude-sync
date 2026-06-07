// GoogleDriveClient shared-contract-suite invocation.
//
// This file supplies a Drive-shaped `StrategyContractFixture` and delegates
// to `runStrategyContractSuite`. The fixture primes a fake Drive SDK + a
// fake `fetch` to cover every scenario the contract suite exercises.
//
// Like OneDrive, Drive is OAuth — `primeAuthFailureOnList` must account
// for the base's auto-refresh on `auth-expired`. Both the SDK list call
// AND the token endpoint are primed to fail, so the refresh fails with
// `auth-revoked` and the base re-throws the ORIGINAL `auth-expired` tag
// per `expectedAuthErrorTag: "auth-expired"`.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { vi } from "vitest";

import { providers, type StoredCredentials } from "@ft5/ipc-contracts";

import type { BaseClientContext } from "../base-client.js";
import {
  runStrategyContractSuite,
  type StrategyContractFixture,
} from "../__tests__/strategy-contract.js";
import {
  createGoogleDriveClient,
  type GoogleDriveClientLike,
} from "./googledrive-client.js";

// ---------------------------------------------------------------------------
// Per-test mutable state — the fixture's `resetMock()` rebuilds these.
// ---------------------------------------------------------------------------

type ListHandler = (
  params: Record<string, unknown>,
) => { files?: Array<Record<string, unknown>>; nextPageToken?: string };
type FileHandler = (params: Record<string, unknown>) => Record<string, unknown>;
type DeleteHandler = (params: Record<string, unknown>) => unknown;
type AboutHandler = (
  params: Record<string, unknown>,
) => Record<string, unknown>;

interface ListResponder {
  qMatch: string;
  handler: ListHandler;
}
interface FileResponder {
  fileId: string;
  handler: FileHandler;
}
interface GetStreamResponder {
  fileId: string;
  handler: (
    params: Record<string, unknown>,
    options: Record<string, unknown> | undefined,
  ) => { stream: Readable; headers: Record<string, string> };
}

let lists: ListResponder[] = [];
let gets: FileResponder[] = [];
let getStreams: GetStreamResponder[] = [];
let deletes: Array<{ fileId: string; handler: DeleteHandler }> = [];
let creates: Array<{ nameMatch: string; handler: FileHandler }> = [];
let updates: Array<{ fileId: string; handler: FileHandler }> = [];
let aboutHandler: AboutHandler | null = null;
let fetchResponses: Array<() => Response> = [];
// Cancel-upload state: when `cancelMode = true`, the chunk PUTs hang on a
// promise that rejects only when `cancelDoneSignal` aborts. The abort
// listener wired to the session URL's DELETE captures `init.signal` so
// the contract's `observedFreshCancelCleanup` hook can verify the signal
// passed to the cleanup is NOT the user's controller.signal.
let cancelMode = false;
let cancelDeleteSignal: AbortSignal | null = null;

function buildDrive(): GoogleDriveClientLike {
  return {
    files: {
      async list(params) {
        const q = String(params.q ?? "");
        const match = lists.find((r) => q.includes(r.qMatch));
        if (!match) {
          const err = Object.assign(new Error(`no-list-responder q=${q}`), {
            name: "GaxiosError",
            code: "500",
            status: 500,
            response: {
              status: 500,
              headers: {},
              data: {
                error: {
                  code: 500,
                  message: `no-list-responder q=${q}`,
                  errors: [
                    { reason: "internalError", message: "no responder" },
                  ],
                },
              },
            },
          });
          throw err;
        }
        return { data: match.handler(params) as never };
      },
      async get(params, options) {
        const fileId = String(params.fileId ?? "");
        // Stream-mode dispatch: `alt: "media"` distinguishes a download
        // from a metadata fetch. Stream responders are checked first so
        // a fileId can host both flavours.
        if (params.alt === "media") {
          const streamMatch = getStreams.find((r) => r.fileId === fileId);
          if (!streamMatch) {
            const err = Object.assign(
              new Error(`no-get-stream-responder ${fileId}`),
              {
                name: "GaxiosError",
                code: "404",
                status: 404,
                response: {
                  status: 404,
                  headers: {},
                  data: {
                    error: {
                      code: 404,
                      message: `no-get-stream-responder ${fileId}`,
                      errors: [{ reason: "notFound", message: "not found" }],
                    },
                  },
                },
              },
            );
            throw err;
          }
          const { stream, headers } = streamMatch.handler(
            params,
            options as Record<string, unknown> | undefined,
          );
          return { data: stream as unknown, headers };
        }
        const match = gets.find((r) => r.fileId === fileId);
        if (!match) {
          const err = Object.assign(new Error(`no-get-responder ${fileId}`), {
            name: "GaxiosError",
            code: "404",
            status: 404,
            response: {
              status: 404,
              headers: {},
              data: {
                error: {
                  code: 404,
                  message: `no-get-responder ${fileId}`,
                  errors: [{ reason: "notFound", message: "not found" }],
                },
              },
            },
          });
          throw err;
        }
        return { data: match.handler(params) as never };
      },
      async delete(params) {
        const fileId = String(params.fileId ?? "");
        const match = deletes.find((r) => r.fileId === fileId);
        if (!match) {
          const err = Object.assign(
            new Error(`no-delete-responder ${fileId}`),
            {
              name: "GaxiosError",
              code: "500",
              status: 500,
              response: {
                status: 500,
                headers: {},
                data: {
                  error: {
                    code: 500,
                    message: `no-delete-responder ${fileId}`,
                    errors: [
                      { reason: "internalError", message: "no responder" },
                    ],
                  },
                },
              },
            },
          );
          throw err;
        }
        match.handler(params);
        return { data: undefined };
      },
      async create(params) {
        const rb = (params.requestBody ?? {}) as { name?: string };
        const wanted = rb.name ?? "";
        const match = creates.find(
          (r) => r.nameMatch === "*" || wanted.includes(r.nameMatch),
        );
        if (!match) {
          const err = Object.assign(
            new Error(`no-create-responder ${wanted}`),
            {
              name: "GaxiosError",
              code: "500",
              status: 500,
              response: {
                status: 500,
                headers: {},
                data: {
                  error: {
                    code: 500,
                    message: `no-create-responder ${wanted}`,
                    errors: [
                      { reason: "internalError", message: "no responder" },
                    ],
                  },
                },
              },
            },
          );
          throw err;
        }
        return { data: match.handler(params) as never };
      },
      async update(params) {
        const fileId = String(params.fileId ?? "");
        const match = updates.find((r) => r.fileId === fileId);
        if (!match) {
          const err = Object.assign(
            new Error(`no-update-responder ${fileId}`),
            {
              name: "GaxiosError",
              code: "500",
              status: 500,
              response: {
                status: 500,
                headers: {},
                data: {
                  error: {
                    code: 500,
                    message: `no-update-responder ${fileId}`,
                    errors: [
                      { reason: "internalError", message: "no responder" },
                    ],
                  },
                },
              },
            },
          );
          throw err;
        }
        return { data: match.handler(params) as never };
      },
    },
    about: {
      async get(params) {
        if (!aboutHandler) {
          return {
            data: {
              storageQuota: { limit: "100", usage: "1" },
            } as never,
          };
        }
        return { data: aboutHandler(params) as never };
      },
    },
  };
}

const fakeFetch = vi.fn(
  async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    const method = (init?.method ?? "").toUpperCase();
    // The Drive resumable-session POST is the first fetch in the upload
    // flow; return a Location-header response so the strategy can proceed
    // to the chunk PUT. Subsequent PUTs to the session URL return the
    // file JSON.
    if (method === "POST" && urlStr.includes("upload/drive/v3/files")) {
      return new Response("", {
        status: 200,
        headers: { Location: "https://googleapis.com/upload/session/CONTRACT" },
      });
    }
    // Cancel-upload contract scenario: chunk PUT hangs until the
    // user's signal aborts (then rejects with AbortError so the strategy
    // normalizes to `cancelled`). A separate DELETE on the session URL
    // is the strategy's cleanup — capture its `init.signal` so the
    // fixture's `observedFreshCancelCleanup` can verify the cleanup
    // signal is NOT the user's signal (Decision 3).
    if (cancelMode && method === "DELETE" && urlStr.includes("/upload/session/CONTRACT")) {
      cancelDeleteSignal = init?.signal ?? null;
      // The Response constructor rejects null-body status codes with a
      // body argument (204 falls into that bucket per the Fetch spec).
      // Use 200 with an empty body — the strategy's cleanup catch path
      // does not branch on status, so the choice is purely cosmetic for
      // the test assertion.
      return new Response("", { status: 200 });
    }
    if (cancelMode && method === "PUT" && urlStr.includes("/upload/session/CONTRACT")) {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        sig?.addEventListener(
          "abort",
          () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true },
        );
      });
    }
    if (urlStr.includes("/upload/session/CONTRACT")) {
      return new Response(
        JSON.stringify({
          id: "contract-uploaded-id",
          name: "uploaded.txt",
          mimeType: "text/plain",
          parents: ["root"],
          size: "13",
          modifiedTime: "2024-06-01T00:00:00Z",
          createdTime: "2024-01-01T00:00:00Z",
        }),
        { status: 200 },
      );
    }
    // Token endpoint — per-scenario primed response.
    const next = fetchResponses.shift();
    if (next) return next();
    return new Response("{}", { status: 500 });
  },
) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const credentials: StoredCredentials = {
  providerId: "google-drive",
  authResult: {
    accessToken: "access-tok",
    refreshToken: "refresh-tok",
    meta: {
      clientId: "contract-client",
      clientSecret: "contract-secret",
      redirectUri: "http://localhost/callback",
    },
  },
  createdAt: 0,
  updatedAt: 0,
};

const tmp = mkdtempSync(join(tmpdir(), "gd-contract-"));

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const fixture: StrategyContractFixture = {
  credentials,
  expectedAuthErrorTag: "auth-expired",
  supportsQuota: true,
  hasPathHandleCache: true,

  resetMock() {
    lists = [];
    gets = [];
    getStreams = [];
    deletes = [];
    creates = [];
    updates = [];
    aboutHandler = null;
    fetchResponses = [];
    cancelMode = false;
    cancelDeleteSignal = null;
    (fakeFetch as unknown as ReturnType<typeof vi.fn>).mockClear();
  },

  primeListOk(opts) {
    const rootPath = opts.rootPath;
    // If root: just respond to 'root' in parents.
    // If a nested path: also prime the path-resolution walk for each
    // segment.
    if (rootPath === "/" || rootPath === "") {
      lists.push({
        qMatch: "'root' in parents",
        handler: () => ({
          files: [
            {
              id: "contract-folder-id",
              name: "folder-a",
              mimeType: "application/vnd.google-apps.folder",
              parents: ["root"],
              modifiedTime: "2024-06-01T00:00:00Z",
              createdTime: "2024-01-01T00:00:00Z",
            },
            {
              id: "contract-file-id",
              name: "file-a.txt",
              mimeType: "text/plain",
              parents: ["root"],
              size: "10",
              modifiedTime: "2024-06-01T00:00:00Z",
              createdTime: "2024-01-01T00:00:00Z",
            },
          ],
        }),
      });
    } else {
      // Walk each segment with a name-filter responder + a terminal
      // `<terminalId> in parents` responder. For the typical contract
      // scenario, `rootPath` is `/folder-a` carried forward from the
      // earlier root list — reuse `contract-folder-id` for stability.
      const segments = rootPath.replace(/^\//, "").split("/");
      let parentId = "root";
      for (const seg of segments) {
        const childId =
          seg === "folder-a" ? "contract-folder-id" : `resolved-${seg}`;
        const thisParent = parentId;
        lists.push({
          qMatch: `name='${seg}'`,
          handler: () => ({
            files: [
              {
                id: childId,
                name: seg,
                mimeType: "application/vnd.google-apps.folder",
                parents: [thisParent],
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        });
        parentId = childId;
      }
      lists.push({
        qMatch: `'${parentId}' in parents`,
        handler: () => ({
          files: [],
        }),
      });
    }
    // The handle-form children listing (called in the contract's second
    // scenario after obtaining a folder handle from the root list) —
    // `'contract-folder-id' in parents`.
    lists.push({
      qMatch: "'contract-folder-id' in parents",
      handler: () => ({ files: [] }),
    });
  },

  primeGetMetadata404(targetPath) {
    // Segment resolver for the terminal name will return empty → strategy
    // throws `not-found` before we even get to `files.get`. That matches
    // the contract-suite's "404 / not-found" expectation.
    const segments = targetPath.replace(/^\//, "").split("/");
    const terminal = segments[segments.length - 1] ?? "";
    lists.push({
      qMatch: `name='${terminal}'`,
      handler: () => ({ files: [] }),
    });
  },

  primeRateLimitOnList() {
    lists.push({
      qMatch: "'root' in parents",
      handler: () => {
        throw Object.assign(new Error("rateLimitExceeded"), {
          name: "GaxiosError",
          code: "403",
          status: 403,
          response: {
            status: 403,
            headers: { "retry-after": "2" },
            data: {
              error: {
                code: 403,
                message: "Rate Limit Exceeded",
                errors: [
                  {
                    reason: "rateLimitExceeded",
                    message: "Rate Limit Exceeded",
                  },
                ],
              },
            },
          },
        });
      },
    });
  },

  primeAuthFailureOnList() {
    // 401 on list → base triggers refresh.
    lists.push({
      qMatch: "'root' in parents",
      handler: () => {
        throw Object.assign(new Error("authError"), {
          name: "GaxiosError",
          code: "401",
          status: 401,
          response: {
            status: 401,
            headers: {},
            data: {
              error: {
                code: 401,
                message: "Invalid Credentials",
                errors: [{ reason: "authError", message: "Invalid Creds" }],
              },
            },
          },
        });
      },
    });
    // Refresh fails with invalid_grant → refresh path throws auth-revoked
    // → base re-throws the ORIGINAL auth-expired tag (per OneDrive's
    // pattern).
    fetchResponses.push(
      () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Token has been revoked",
          }),
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
    // The upload flow is driven by raw fetch (session POST + chunk PUTs);
    // the SDK `create` is not invoked. `fakeFetch` already primes the
    // session → chunk flow for any upload. But we MUST prime the parent
    // resolution (if the parent is a path).
    if (opts.parentPath !== "/" && opts.parentPath !== "") {
      const segments = opts.parentPath.replace(/^\//, "").split("/");
      let parentId = "root";
      for (const seg of segments) {
        const childId = `parent-${seg}`;
        const thisParent = parentId;
        lists.push({
          qMatch: `name='${seg}'`,
          handler: () => ({
            files: [
              {
                id: childId,
                name: seg,
                mimeType: "application/vnd.google-apps.folder",
                parents: [thisParent],
                createdTime: "2024-01-01T00:00:00Z",
              },
            ],
          }),
        });
        parentId = childId;
      }
    }
    // The contract suite calls primeUploadOk → uploadFile({path: "/"}),
    // so no path resolution is needed for the root case.
  },

  primeUploadCancellable(_opts) {
    // Drive's upload does not need extra path resolution for parent="/".
    // `fakeFetch` switches into cancel mode via the module-level flag —
    // the session POST returns a Location, the chunk PUT hangs until
    // the user's signal aborts (then rejects AbortError → normalize
    // to `cancelled`), and a separate DELETE on the session URL is
    // captured for the `observedFreshCancelCleanup` introspection.
    cancelMode = true;
    cancelDeleteSignal = null;
  },

  observedFreshCancelCleanup(opts) {
    // Drive's cleanup runs against `AbortSignal.timeout(5000)` per
    // Decision 3. The captured signal MUST exist (a DELETE was
    // observed) AND MUST NOT be the user's signal.
    return (
      cancelDeleteSignal !== null && cancelDeleteSignal !== opts.userSignal
    );
  },

  primeDeleteOk(targetPath) {
    const segments = targetPath.replace(/^\//, "").split("/");
    const terminal = segments[segments.length - 1] ?? "";
    lists.push({
      qMatch: `name='${terminal}'`,
      handler: () => ({
        files: [
          {
            id: "contract-del-id",
            name: terminal,
            mimeType: "text/plain",
            parents: ["root"],
            createdTime: "2024-01-01T00:00:00Z",
          },
        ],
      }),
    });
    deletes.push({
      fileId: "contract-del-id",
      handler: () => ({}),
    });
  },

  // -------------------------------------------------------------------------
  // §10.1 — rename + download contract hooks
  // -------------------------------------------------------------------------

  primeRenameFileOk(opts) {
    const fromTerminal = opts.fromPath.replace(/^\//, "");
    const fileId = "GD-CONTRACT-FILE";
    // resolveTarget for the from-path: list with name filter on the
    // terminal segment under root.
    lists.push({
      qMatch: `name='${fromTerminal}'`,
      handler: () => ({
        files: [
          {
            id: fileId,
            name: fromTerminal,
            mimeType: "text/plain",
            parents: ["root"],
            size: "12",
            modifiedTime: "2024-06-01T00:00:00Z",
            createdTime: "2024-01-01T00:00:00Z",
          },
        ],
      }),
    });
    // sibling pre-check on `fail`: list for the new name → empty.
    lists.push({
      qMatch: `name='${opts.newName}'`,
      handler: () => ({ files: [] }),
    });
    // files.update with fileId returns the renamed metadata.
    updates.push({
      fileId,
      handler: () => ({
        id: fileId,
        name: opts.newName,
        mimeType: "text/plain",
        parents: ["root"],
        size: "12",
        modifiedTime: "2024-06-02T00:00:00Z",
        createdTime: "2024-01-01T00:00:00Z",
      }),
    });
  },

  primeRenameDirectory(opts) {
    const fromTerminal = opts.fromPath.replace(/^\//, "");
    const fileId = "GD-CONTRACT-FOLDER";
    lists.push({
      qMatch: `name='${fromTerminal}'`,
      handler: () => ({
        files: [
          {
            id: fileId,
            name: fromTerminal,
            mimeType: "application/vnd.google-apps.folder",
            parents: ["root"],
            modifiedTime: "2024-06-01T00:00:00Z",
            createdTime: "2024-01-01T00:00:00Z",
          },
        ],
      }),
    });
    lists.push({
      qMatch: `name='${opts.newName}'`,
      handler: () => ({ files: [] }),
    });
    updates.push({
      fileId,
      handler: () => ({
        id: fileId,
        name: opts.newName,
        mimeType: "application/vnd.google-apps.folder",
        parents: ["root"],
        modifiedTime: "2024-06-02T00:00:00Z",
        createdTime: "2024-01-01T00:00:00Z",
      }),
    });
  },

  supportsFolderRename: true,

  primeDownloadOk(opts) {
    const terminal = opts.path.replace(/^\//, "");
    const fileId = "GD-CONTRACT-DL";
    lists.push({
      qMatch: `name='${terminal}'`,
      handler: () => ({
        files: [
          {
            id: fileId,
            name: terminal,
            mimeType: "text/plain",
            parents: ["root"],
            size: String(opts.bytes.length),
            modifiedTime: "2024-06-01T00:00:00Z",
            createdTime: "2024-01-01T00:00:00Z",
          },
        ],
      }),
    });
    // Metadata pre-fetch for the post-archive Google Apps detection
    // path (`fields: "mimeType"` post-smoke-2). The strategy issues
    // this BEFORE the alt=media stream call so it can refuse Google
    // Apps files with a concise error. Plain binary mime → no refusal,
    // continues to the stream.
    gets.push({
      fileId,
      handler: () => ({
        id: fileId,
        name: terminal,
        mimeType: "text/plain",
      }),
    });
    getStreams.push({
      fileId,
      handler: () => {
        const stream = new Readable({
          read() {
            this.push(opts.bytes);
            this.push(null);
          },
        });
        return {
          stream,
          headers: { "content-length": String(opts.bytes.length) },
        };
      },
    });
  },

  primeDownloadCancellable(opts) {
    const terminal = opts.path.replace(/^\//, "");
    const fileId = "GD-CONTRACT-CANCEL";
    lists.push({
      qMatch: `name='${terminal}'`,
      handler: () => ({
        files: [
          {
            id: fileId,
            name: terminal,
            mimeType: "text/plain",
            parents: ["root"],
            size: String(opts.totalBytes),
            modifiedTime: "2024-06-01T00:00:00Z",
            createdTime: "2024-01-01T00:00:00Z",
          },
        ],
      }),
    });
    // Metadata pre-fetch for Google Apps detection path (see
    // primeDownloadOk note).
    gets.push({
      fileId,
      handler: () => ({
        id: fileId,
        name: terminal,
        mimeType: "text/plain",
      }),
    });
    getStreams.push({
      fileId,
      handler: (_params, options) => {
        const sig = options?.signal as AbortSignal | undefined;
        const stream = new Readable({ read() {} });
        if (sig) {
          sig.addEventListener("abort", () => {
            stream.destroy(
              Object.assign(new Error("aborted"), { name: "AbortError" }),
            );
          });
        }
        // Push first chunk on next tick so the consumer's data handler
        // (which fires controller.abort()) runs after the abort
        // listener is wired.
        setImmediate(() => {
          stream.push(Buffer.alloc(opts.firstChunkBytes));
        });
        return {
          stream,
          headers: { "content-length": String(opts.totalBytes) },
        };
      },
    });
  },

  // -------------------------------------------------------------------------
  // migrate-engine-cache-invalidation §3 — cache-eviction contract hooks
  // -------------------------------------------------------------------------

  primeDeleteOfListedFile() {
    // The file `primeListOk` surfaces has id `contract-file-id`. After a
    // `listDirectory("/")` the cache holds `/file-a.txt → contract-file-id`,
    // so `deleteFile("/file-a.txt")` resolves via a cache HIT (no list call)
    // and issues `files.delete({ fileId: "contract-file-id" })`.
    deletes.push({
      fileId: "contract-file-id",
      handler: () => ({}),
    });
  },

  primeRenameOfListedFile(opts) {
    // Cache-hit rename of the listed file (`contract-file-id`, parent root).
    // resolveTarget cache-hits (no list); resolveRenameParent short-circuits
    // on root (no SDK call); the "fail" sibling pre-check lists
    // `name='<newName>'` under root → empty; the rename then PATCHes via
    // `files.update({ fileId: "contract-file-id" })` (plain mime → file, so
    // the strategy evicts the single old path).
    lists.push({
      qMatch: `name='${opts.newName}'`,
      handler: () => ({ files: [] }),
    });
    updates.push({
      fileId: "contract-file-id",
      handler: () => ({
        id: "contract-file-id",
        name: opts.newName,
        mimeType: "text/plain",
        parents: ["root"],
        size: "10",
        modifiedTime: "2024-06-02T00:00:00Z",
        createdTime: "2024-01-01T00:00:00Z",
      }),
    });
  },
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

runStrategyContractSuite({
  providerName: "GoogleDriveClient",
  buildClient: (bus, credentialStore, creds) => {
    const ctx: BaseClientContext = {
      bus,
      credentialStore,
      providerDescriptor: providers["google-drive"],
    };
    return createGoogleDriveClient("ds-gd-contract", creds, ctx, {
      driveFactory: () => buildDrive(),
      fetchImpl: fakeFetch,
    });
  },
  fixture,
});
