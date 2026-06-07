// OneDriveClient — concrete datasource strategy for Microsoft OneDrive (Graph).
//
// Extends `BaseDatasourceClient<"onedrive">` and wires every `doX` primitive
// against `@microsoft/microsoft-graph-client`. The base class handles event
// emission, retry-on-auth-expired, error normalization, and the capability
// gate for `getQuota`.
//
// Key design notes for this strategy (see design.md Decisions 1, 2, 3, 6, 7, 9
// and spec Requirement: Hybrid `Target` + Requirement: Authentication returns
// an `AuthIntent`):
//
//   - Credentials storage shape. OneDrive is OAuth 2.0 / MSAL; the
//     authentication flow needs `clientId`, `tenantId`, and `redirectUri` at
//     the moment `authenticate()` is called — typically BEFORE any tokens
//     exist. We mirror S3's "meta-is-the-truth" pattern: the OAuth config
//     lives in `credentials.authResult.meta`, and `accessToken` / `refreshToken`
//     get populated by `completeWith(code)` (and later by `refreshTokenImpl`).
//     Callers (the Electron host) seed the meta fields from their OIDC /
//     MSAL registration before constructing the client.
//
//   - Path ↔ DriveItem id mapping. OneDrive's Graph API supports BOTH "path
//     addressing" (`/me/drive/root:/<path>:`) and "item id addressing"
//     (`/me/drive/items/<id>`). `DatasourceFileEntry<T>.handle` carries the driveItemId,
//     so subsequent calls via `{ kind: "handle", handle }` skip the path
//     lookup entirely. Path→id resolution is cached in an LRU keyed by the
//     engine path. Invalidation:
//       - Deletion: bus subscription in the constructor reacts to
//         `deleted` events for this datasource and evicts the affected path.
//       - Upload completion: populated directly by `doUploadFileImpl`'s
//         success branch (per migrate-upload-orchestration-out-of-engine —
//         the engine no longer emits `file-created`).
//
//   - Upload. Files ≤ 4 MB go over a simple PUT to
//     `/me/drive/root:/<parent>/<name>:/content`. Files > 4 MB use the
//     resumable-upload-session API: POST `/createUploadSession` through the
//     Graph client to obtain an `uploadUrl`, then PUT chunks directly to
//     that URL with raw `fetch` (the Graph client's fluent API does not cover
//     the chunk-upload path). Chunk size is fixed at 320 KiB × 32 ≈ 10 MiB
//     (Graph requires chunk sizes that are multiples of 320 KiB, max 60 MiB).
//
//   - Event-driven LRU invalidation. The base class owns the bus; strategies
//     MUST NOT emit directly. But a strategy MAY subscribe — and we do, to
//     hook `deleted` events for path-cache invalidation. Upload-completion
//     LRU population happens inside `doUploadFileImpl`'s success branch
//     directly (per migrate-upload-orchestration-out-of-engine).
//
//   - `refreshToken`. OAuth refresh posts `grant_type=refresh_token` to
//     `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`. This is
//     a raw `fetch` call, not the Graph client. Single-flight is enforced by
//     the base — our `refreshTokenImpl` is just the critical section.
//
//   - `normalizeError`. Graph errors carry either a structured `code` string
//     (e.g., `"itemNotFound"`, `"activityLimitReached"`) or an HTTP
//     `statusCode`. We branch on both and map to the 8-tag taxonomy per the
//     design.md constraint.

import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, posix as pathPosix } from "node:path";
import { Readable, Transform } from "node:stream";

import type {
  AuthIntent,
  AuthResult,
  DatasourceStatus,
  DatasourceFileEntry,
  FileMetadata,
  DatasourceMimeFamily,
  OAuthIntent,
  ProviderMetadata,
  Quota,
  StoredCredentials,
  Target,
} from "@ft5/ipc-contracts";
import { DatasourceError, DatasourceErrorTag } from "@ft5/ipc-contracts";

import type { PreAuthConfig } from "../auth-types.js";
import {
  BaseDatasourceClient,
  type BaseClientContext,
  type ConflictPolicy,
  type DownloadOptions,
  type DownloadResult,
} from "../base-client.js";
import {
  type CredentialShapeValidator,
  type ProviderFactoryFn,
  type PreAuthFactoryFn,
} from "../factory.js";

// ---------------------------------------------------------------------------
// Graph client duck-typing — `GraphClientLike` shape
// ---------------------------------------------------------------------------
//
// The official `@microsoft/microsoft-graph-client` has no test-time mock
// package (unlike `aws-sdk-client-mock`). We duck-type the subset of the
// SDK we use so tests can supply a plain-object fake without importing the
// SDK; production code still uses the real SDK via `createDefaultGraphFactory`.

export interface GraphRequestBuilderLike {
  header(name: string, value: string): GraphRequestBuilderLike;
  headers(values: Record<string, string>): GraphRequestBuilderLike;
  query(values: Record<string, unknown>): GraphRequestBuilderLike;
  select(fields: string | string[]): GraphRequestBuilderLike;
  expand(fields: string | string[]): GraphRequestBuilderLike;
  get(): Promise<unknown>;
  post(body?: unknown): Promise<unknown>;
  put(body?: unknown): Promise<unknown>;
  patch(body?: unknown): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface GraphClientLike {
  api(path: string): GraphRequestBuilderLike;
}

export type GraphFactory = (accessToken: string) => GraphClientLike;

// Resumable-upload threshold per Graph docs. Simple PUT `.../content` supports
// bodies up to 4 MB; above that, the resumable-upload-session flow is required.
const RESUMABLE_THRESHOLD_BYTES = 4 * 1024 * 1024;
// Chunk size for resumable uploads. Graph requires multiples of 320 KiB (max
// 60 MiB). We pick ~10 MiB (320 KiB * 32) as a safe middle ground.
const UPLOAD_CHUNK_BYTES = 320 * 1024 * 32;

const GRAPH_ROOT = "/me/drive/root";
const GRAPH_ITEMS = "/me/drive/items";
const GRAPH_DRIVE = "/me/drive";

// Pagination bounds + cursor validation for `doListDirectoryImpl`
// (add-engine-listdirectory-pagination Decisions 2 + 3).
//
// `@odata.nextLink` is a fully-qualified Graph URL, not an opaque token, so a
// next-page cursor MUST start with this prefix. Validating it before re-issue
// defends against an upstream cursor injection (Decision 2's OneDrive guard).
const GRAPH_NEXTLINK_PREFIX = "https://graph.microsoft.com/v1.0/";
// Graph's `$top` ceiling is 999; the floor is 1 so a degenerate `0` /
// negative request still returns at least one entry. There is no first-party
// default — when `pageSize` is omitted the strategy lets Graph apply its own
// default paging (no `$top`).
const ONEDRIVE_TOP_MAX = 999;

/** Clamp a requested page size to Graph's `$top` `[1, 999]` range. Only called
 * when the caller supplied a `pageSize`; omission uses the Graph default. */
function clampOneDrivePageSize(requested: number): number {
  return Math.min(Math.max(Math.trunc(requested), 1), ONEDRIVE_TOP_MAX);
}

// MSAL / Graph scopes for file read/write + refresh
const OAUTH_SCOPE = "offline_access Files.ReadWrite.All User.Read";

// ---------------------------------------------------------------------------
// Utility: path <-> Graph URL addressing
// ---------------------------------------------------------------------------

/** Normalize an engine path (e.g. `"/"`, `"/photos"`, `"/photos/2024/img.jpg"`)
 * into the Graph path segment used after `/root:` and `:/...`. Root is a
 * special case — Graph uses `/me/drive/root` (no `:` suffix) for root
 * addressing.
 *
 * Each path segment is percent-encoded via `encodeURIComponent` so characters
 * that are meaningful in URLs (`#`, `?`, `&`, `%`, `+`, space, etc.) do not
 * fight the Graph endpoint's path parser. `@microsoft/microsoft-graph-client`
 * v3 joins and normalizes but does NOT encode caller-supplied path segments,
 * so encoding is the strategy's responsibility. The forward-slash separator
 * is preserved (segments are encoded individually then rejoined).
 */
function pathToGraphSegment(path: string): string {
  if (path === "" || path === "/") return "";
  const raw = path.startsWith("/") ? path.slice(1) : path;
  const encoded = raw.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `/${encoded}`;
}

/**
 * Build the Graph URL for a path target. Root (`"/"`) uses `/me/drive/root`;
 * non-root paths use the `:/<path>:` path-addressing syntax so `suffix` can
 * be appended (e.g., `/children`, `/content`, `/createUploadSession`).
 *
 * `suffix` is either empty (getMetadata) or starts with `/`.
 */
function pathUrl(path: string, suffix: string): string {
  const seg = pathToGraphSegment(path);
  if (seg === "") {
    // Root: /me/drive/root + suffix (if any). getMetadata on root uses no suffix.
    return suffix === "" ? GRAPH_ROOT : `${GRAPH_ROOT}${suffix}`;
  }
  // Non-root: /me/drive/root:<path>:<suffix>
  return suffix === ""
    ? `${GRAPH_ROOT}:${seg}:`
    : `${GRAPH_ROOT}:${seg}:${suffix}`;
}

/** Build the Graph URL for a handle (driveItemId) target. */
function handleUrl(handle: string, suffix: string): string {
  return suffix === ""
    ? `${GRAPH_ITEMS}/${handle}`
    : `${GRAPH_ITEMS}/${handle}${suffix}`;
}

// ---------------------------------------------------------------------------
// DriveItem → DatasourceFileEntry mapping
// ---------------------------------------------------------------------------

interface DriveItem {
  id?: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { path?: string; driveId?: string; id?: string };
}

/** Derive the engine path for a DriveItem by joining the parent path and
 * the item's own name. Graph's `parentReference.path` is of the form
 * `/drive/root:` (root) or `/drive/root:/<path>` (nested); we strip the
 * `/drive/root:` prefix and append `/<name>`.
 */
function driveItemToPath(item: DriveItem): string {
  const parent = item.parentReference?.path ?? "/drive/root:";
  const stripped = parent.replace(/^\/drive\/root:/, "");
  const name = item.name ?? "";
  if (stripped === "" || stripped === "/") return `/${name}`;
  return `${stripped}/${name}`;
}

/**
 * Split a filename into `{ base, ext }` for the `keep-both` suffix loop.
 * Mirrors `path.basename` / `path.extname` semantics so candidate names
 * preserve the extension across attempts: `foo.pdf` → `{base:"foo",
 * ext:".pdf"}` → candidate `foo-2.pdf`. Extensionless names like
 * `Makefile` → `{base:"Makefile", ext:""}` → candidate `Makefile-2`.
 * Hidden files with a leading dot and no other separator (`.gitignore`)
 * are treated as extensionless to avoid pathological
 * `{base:"", ext:".gitignore"}` results.
 *
 * Local copy of the same helper Drive defines in
 * `googledrive-client.ts` — duplicated rather than cross-imported so each
 * strategy stays self-contained (cross-strategy imports are
 * architecturally forbidden by the engine's module boundary).
 */
function splitNameForSuffix(name: string): { base: string; ext: string } {
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dotIdx), ext: name.slice(dotIdx) };
}

/**
 * Parse a `Content-Range: bytes <start>-<end>/<total>` response header into
 * the `{ start, end, total }` shape used by `DownloadResult.contentRange`.
 * Returns `undefined` for headers we can't parse, including the
 * `unknown-range` form (`bytes [asterisk]/[total]`) which has no usable
 * range bounds.
 */
function parseContentRangeHeader(
  header: string | undefined,
): { start: number; end: number; total: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(header.trim());
  if (!match) return undefined;
  const start = Number.parseInt(match[1]!, 10);
  const end = Number.parseInt(match[2]!, 10);
  const total = Number.parseInt(match[3]!, 10);
  if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(total)) {
    return undefined;
  }
  return { start, end, total };
}

function mimeFamilyFromMime(mime?: string): DatasourceMimeFamily {
  if (!mime) return "other";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/zip" || mime === "application/x-tar" || mime === "application/gzip")
    return "archive";
  if (mime === "application/pdf" || mime.startsWith("text/")) {
    if (mime === "text/x-typescript" || mime === "text/x-python") return "code";
    return "document";
  }
  if (mime.includes("word") || mime.includes("document")) return "document";
  return "other";
}

function buildFileEntry(item: DriveItem): DatasourceFileEntry<"onedrive"> {
  const id = item.id ?? "";
  const name = item.name ?? "";
  const isFolder = item.folder !== undefined;
  const kind: "file" | "folder" = isFolder ? "folder" : "file";
  const mimeFamily: DatasourceMimeFamily = isFolder
    ? "folder"
    : mimeFamilyFromMime(item.file?.mimeType);
  const modifiedAt = item.lastModifiedDateTime
    ? new Date(item.lastModifiedDateTime).getTime()
    : 0;
  const providerMetadata: ProviderMetadata<"onedrive"> = {
    driveItemId: id,
    ...(item.file?.mimeType ? { mimeType: item.file.mimeType } : {}),
    ...(item.parentReference?.driveId
      ? { driveId: item.parentReference.driveId }
      : {}),
  };
  const entry: DatasourceFileEntry<"onedrive"> = {
    path: driveItemToPath(item),
    handle: id,
    name,
    kind,
    ...(typeof item.size === "number" ? { size: item.size } : {}),
    modifiedAt,
    mimeFamily,
    providerMetadata,
  };
  return entry;
}

// ---------------------------------------------------------------------------
// Credential extraction
// ---------------------------------------------------------------------------

interface OneDriveCredsMeta {
  clientId: string;
  tenantId: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string;
}

function readCredsFromStored(credentials: StoredCredentials): OneDriveCredsMeta {
  const authResult = credentials.authResult;
  const meta = (authResult.meta ?? {}) as Record<string, unknown>;
  if (
    typeof meta.clientId !== "string" ||
    typeof meta.tenantId !== "string" ||
    typeof meta.redirectUri !== "string"
  ) {
    throw new DatasourceError<"onedrive">({
      tag: "auth-revoked",
      datasourceType: "onedrive",
      datasourceId: "<init>",
      retryable: false,
      raw: "onedrive-missing-oauth-config",
      message:
        "OneDrive credentials must include meta.clientId, meta.tenantId, meta.redirectUri",
    });
  }
  return {
    clientId: meta.clientId,
    tenantId: meta.tenantId,
    redirectUri: meta.redirectUri,
    accessToken: authResult.accessToken,
    refreshToken: authResult.refreshToken ?? "",
  };
}

// ---------------------------------------------------------------------------
// Default Graph factory — real SDK
// ---------------------------------------------------------------------------

/** Build a production `GraphClientLike` via the official SDK. Tests supply
 * their own factory and never hit this path.
 */
export function createDefaultGraphFactory(): GraphFactory {
  return (accessToken: string): GraphClientLike => {
    // Lazy import so the SDK is not required at module-load time for tests.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@microsoft/microsoft-graph-client") as {
      Client: {
        init(options: {
          authProvider: (done: (err: unknown, token: string) => void) => void;
        }): GraphClientLike;
      };
    };
    return mod.Client.init({
      authProvider: (done) => done(null, accessToken),
    });
  };
}

// ---------------------------------------------------------------------------
// OneDriveClient
// ---------------------------------------------------------------------------

export interface OneDriveClientOptions {
  /** Inject a Graph factory for tests; defaults to the real SDK. */
  graphFactory?: GraphFactory;
  /** Inject a fetch for the resumable-upload and token-refresh paths; defaults
   * to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** LRU cap for the path↔handle cache. Default 512. */
  lruCap?: number;
}

export class OneDriveClient extends BaseDatasourceClient<"onedrive"> {
  readonly type = "onedrive" as const;

  /**
   * Per-user credentials. `null` only on the createForAuth path
   * (implement-datasource-onboarding §2 / §3) where the strategy is
   * constructed BEFORE any user has authenticated and `preAuth` carries
   * the OAuth app config instead. Every code path that consumes
   * `this.creds` for OAuth-app-config fields must go through
   * `getOAuthAppConfig()` so the precedence (preAuth → creds → throw)
   * is applied uniformly.
   */
  private creds: OneDriveCredsMeta | null;
  /**
   * Optional OAuth app config seeded at construction. Populated on the
   * createForAuth path; `undefined` on the legacy createOneDriveClient
   * path that carries the config via `creds.authResult.meta` (preserved
   * during the transition; tracked for deletion in §22.x). The
   * constructor parameter accepts `null` as an alias for `undefined`
   * so the factory.createForAuth contract (`OAuthAppConfig | null`)
   * lands here without a boundary translation step.
   */
  private preAuth: PreAuthConfig | undefined;
  private readonly graphFactory: GraphFactory;
  private readonly fetchImpl: typeof fetch;
  private readonly lruCap: number;

  /** Path → driveItemId cache. `Map` preserves insertion order; we use that
   * as a crude LRU (delete on re-set to bump recency; drop-oldest on cap). */
  private readonly pathHandleCache = new Map<string, string>();

  /** Idempotency guard for `dispose()`. */
  private disposed = false;

  constructor(
    init: { datasourceId: string; ctx: BaseClientContext },
    creds: OneDriveCredsMeta | null,
    options: OneDriveClientOptions = {},
    preAuth?: PreAuthConfig | null,
  ) {
    super(init);
    this.creds = creds;
    // Normalise null → undefined so internal precedence checks compare
    // against a single sentinel.
    this.preAuth = preAuth ?? undefined;
    this.graphFactory = options.graphFactory ?? createDefaultGraphFactory();
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch: typeof fetch }).fetch).bind(globalThis);
    this.lruCap = options.lruCap ?? 512;
    // No engine-bus subscription: cache eviction is performed inline by the
    // mutating ops (doDeleteFileImpl / doRenameImpl) — see
    // migrate-engine-cache-invalidation. Upload-success population stays inline
    // in doUploadFileImpl (per migrate-upload-orchestration-out-of-engine).
  }

  /**
   * No-op retained for `DatasourceClient` contract stability. The bus
   * self-subscription was removed — cache eviction is now inline in the
   * mutating ops (migrate-engine-cache-invalidation). Idempotent.
   */
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }

  // -------------------------------------------------------------------------
  // Cache helpers
  // -------------------------------------------------------------------------

  private cachePathHandle(path: string, handle: string): void {
    // Refresh recency.
    this.pathHandleCache.delete(path);
    this.pathHandleCache.set(path, handle);
    // Evict oldest when over cap.
    while (this.pathHandleCache.size > this.lruCap) {
      const oldest = this.pathHandleCache.keys().next().value;
      if (oldest === undefined) break;
      this.pathHandleCache.delete(oldest);
    }
  }

  private evictPath(path: string): void {
    this.pathHandleCache.delete(path);
  }

  private evictHandle(handle: string): void {
    for (const [k, v] of this.pathHandleCache) {
      if (v === handle) {
        this.pathHandleCache.delete(k);
        break;
      }
    }
  }

  /** Evict a path AND every cached descendant under `<path>/` (directory
   * rename — migrate-engine-cache-invalidation Decision 3). */
  private evictPathAndDescendants(path: string): void {
    this.pathHandleCache.delete(path);
    const prefix = `${path}/`;
    for (const k of this.pathHandleCache.keys()) {
      if (k.startsWith(prefix)) this.pathHandleCache.delete(k);
    }
  }

  /**
   * Resolve a `Target` to a Graph URL, consulting the LRU cache when the
   * target is a path. A cached hit yields a `/me/drive/items/<handle>`-form
   * URL, which (a) saves a path-resolution round-trip on the Graph API and
   * (b) is robust to renames (the driveItemId is stable, the path is not).
   *
   * Called by every path-addressed read / mutate primitive (`doGetMetadataImpl`,
   * `doListDirectoryImpl`, `doDeleteFileImpl`). Handle-form targets pass
   * through unchanged.
   */
  private resolveTargetUrl(target: Target, suffix: string): string {
    if (target.kind === "handle") return handleUrl(target.handle, suffix);
    const cached = this.pathHandleCache.get(target.path);
    if (cached !== undefined) {
      // LRU bump on read.
      this.pathHandleCache.delete(target.path);
      this.pathHandleCache.set(target.path, cached);
      return handleUrl(cached, suffix);
    }
    return pathUrl(target.path, suffix);
  }

  // -------------------------------------------------------------------------
  // OAuth app config + creds helpers (preAuth → creds → throw)
  // -------------------------------------------------------------------------

  /**
   * Resolve the OAuth app config + tenant authority at call time with
   * precedence: (a) `preAuth` if seeded at construction (the createForAuth
   * path; defaults `tenantId` to `"common"` per design.md Decision 13's
   * OneDrive clarification — `OAuthAppConfig` deliberately omits
   * `tenantId`); (b) the legacy `creds.authResult.meta` shape (transitional
   * path; reads `tenantId` from meta as before); (c) throw
   * `DatasourceError(invalid-datasource)` when neither source is available.
   *
   * Centralised here so the four call sites (authorize-URL build,
   * token-exchange POST, parseTokenResponse meta write, refresh-token POST)
   * apply the same precedence.
   */
  private getOAuthAppConfig(): {
    clientId: string;
    clientSecret: string | undefined;
    tenantId: string;
    redirectUri: string;
  } {
    if (this.preAuth !== undefined) {
      return {
        clientId: this.preAuth.clientId,
        clientSecret: this.preAuth.clientSecret,
        // OAuthAppConfig deliberately omits tenantId; default to the
        // multi-tenant authority on the preAuth path.
        tenantId: "common",
        redirectUri: this.preAuth.redirectUri,
      };
    }
    if (this.creds !== null) {
      return {
        clientId: this.creds.clientId,
        // Legacy creds shape does not surface clientSecret on OneDrive's
        // OneDriveCredsMeta — its OAuth flow does not require one for the
        // public-client (PKCE-style) authorize/exchange path. Returned as
        // `undefined` so callers can omit it from request bodies.
        clientSecret: undefined,
        tenantId: this.creds.tenantId,
        redirectUri: this.creds.redirectUri,
      };
    }
    throw new DatasourceError<"onedrive">({
      tag: DatasourceErrorTag.InvalidDatasource,
      datasourceType: "onedrive",
      datasourceId: this.datasourceId,
      retryable: false,
      raw: "onedrive-missing-oauth-app-config",
      message:
        "onedrive client constructed with neither creds nor preAuth — cannot resolve OAuth app config",
    });
  }

  /**
   * Assert that user-side credentials are present. Used by every operation
   * other than `authenticate()` (which is reachable on the createForAuth
   * path with `creds: null`). Throws a typed `invalid-datasource` error
   * when missing — clearer than a raw TypeError downstream.
   */
  private requireCreds(): OneDriveCredsMeta {
    if (this.creds === null) {
      throw new DatasourceError<"onedrive">({
        tag: DatasourceErrorTag.InvalidDatasource,
        datasourceType: "onedrive",
        datasourceId: this.datasourceId,
        retryable: false,
        raw: "onedrive-missing-creds",
        message:
          "onedrive operation requires user credentials, but client was constructed without them",
      });
    }
    return this.creds;
  }

  // -------------------------------------------------------------------------
  // Graph client access (re-built after token refresh)
  // -------------------------------------------------------------------------

  private graph(): GraphClientLike {
    return this.graphFactory(this.requireCreds().accessToken);
  }

  // -------------------------------------------------------------------------
  // Status / connection
  // -------------------------------------------------------------------------

  protected override async doStatusImpl(): Promise<DatasourceStatus> {
    await this.graph().api(GRAPH_DRIVE).get();
    return "connected";
  }

  protected override async doTestConnectionImpl(): Promise<void> {
    await this.graph().api(GRAPH_DRIVE).get();
  }

  // -------------------------------------------------------------------------
  // authenticate — OAuth intent
  // -------------------------------------------------------------------------

  protected override async doAuthenticateImpl(): Promise<AuthIntent> {
    const { clientId, tenantId, redirectUri } = this.getOAuthAppConfig();
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: OAUTH_SCOPE,
    });
    const authorizeUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
    const intent: OAuthIntent = {
      kind: "oauth",
      authorizeUrl,
      completeWith: async (code: string): Promise<AuthResult> => {
        return this.exchangeCodeForTokens(code);
      },
    };
    return intent;
  }

  private async exchangeCodeForTokens(code: string): Promise<AuthResult> {
    const { clientId, tenantId, redirectUri } = this.getOAuthAppConfig();
    const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      scope: OAUTH_SCOPE,
    });
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    return this.parseTokenResponse(resp);
  }

  private async parseTokenResponse(resp: Response): Promise<AuthResult> {
    const text = await resp.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw this.normalizeErrorImpl({
        message: "non-json token response",
        statusCode: resp.status,
      });
    }
    if (!resp.ok) {
      // Typical OAuth errors: invalid_grant / unauthorized_client.
      throw this.normalizeErrorImpl({
        code: typeof parsed.error === "string" ? parsed.error : "provider-error",
        statusCode: resp.status,
        message: typeof parsed.error_description === "string"
          ? parsed.error_description
          : undefined,
      });
    }
    const accessToken = parsed.access_token;
    const refreshToken = parsed.refresh_token;
    const expiresIn = parsed.expires_in;
    if (typeof accessToken !== "string") {
      throw this.normalizeErrorImpl({
        message: "token-response-missing-access_token",
        statusCode: resp.status,
      });
    }
    // Sourced via the same precedence used by doAuthenticateImpl /
    // exchangeCodeForTokens — the AuthResult.meta carries the app config
    // forward so subsequent operations (and the legacy meta-reading
    // factory.create path) keep functioning.
    const oauthApp = this.getOAuthAppConfig();
    const result: AuthResult = {
      accessToken,
      meta: {
        clientId: oauthApp.clientId,
        tenantId: oauthApp.tenantId,
        redirectUri: oauthApp.redirectUri,
      },
    };
    if (typeof refreshToken === "string") {
      result.refreshToken = refreshToken;
    }
    if (typeof expiresIn === "number") {
      result.expiresAt = Date.now() + expiresIn * 1000;
    }
    // Update in-memory creds so subsequent Graph calls use the new token.
    // On the createForAuth path (creds: null at construction), seed a
    // fresh OneDriveCredsMeta from the AuthResult + preAuth-sourced OAuth
    // app config; on the legacy path, merge into the existing creds.
    if (this.creds === null) {
      this.creds = {
        clientId: oauthApp.clientId,
        tenantId: oauthApp.tenantId,
        redirectUri: oauthApp.redirectUri,
        accessToken,
        refreshToken: typeof refreshToken === "string" ? refreshToken : "",
      };
    } else {
      this.creds = {
        ...this.creds,
        accessToken,
        ...(typeof refreshToken === "string" ? { refreshToken } : {}),
      };
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // listDirectory
  // -------------------------------------------------------------------------

  protected override async doListDirectoryImpl(
    target: Target,
    options: { cursor?: string; pageSize?: number },
  ): Promise<{
    entries: DatasourceFileEntry<"onedrive">[];
    nextCursor: string | null;
  }> {
    let resp: { value?: DriveItem[]; "@odata.nextLink"?: string };
    if (options.cursor !== undefined) {
      // Next-page call. The cursor IS the provider's `@odata.nextLink` — a
      // fully-qualified URL, not a token (Decision 2). Validate the prefix
      // BEFORE any network call to defend against an upstream cursor
      // injection (Decision 2's OneDrive guard); on mismatch throw without
      // touching the network (§3.3).
      //
      // DEVIATION from design Decision 8 / task §3.3, which say `tag: "other"`:
      // `"other"` is WIRE-level vocabulary (`FilesError`), not an engine
      // `DatasourceErrorTag` member (the engine enum has 10 tags; `"other"` is
      // not one). We use `provider-error`, which the wire layer collapses to
      // `"other"` (see the `normalizeError` "wire-layer collapses
      // provider-error → tag: other" comment below), so the renderer-observable
      // outcome the design specifies is preserved while the engine code still
      // type-checks. Honors Decision 8's intent of NOT adding a new engine tag.
      if (!options.cursor.startsWith(GRAPH_NEXTLINK_PREFIX)) {
        throw new DatasourceError<"onedrive">({
          tag: "provider-error",
          datasourceType: "onedrive",
          datasourceId: this.datasourceId,
          retryable: false,
          raw: options.cursor,
          message: "invalid pagination cursor: not a Graph @odata.nextLink",
        });
      }
      // Pass the validated nextLink URL directly to the Graph SDK. `$top` is
      // already baked into the nextLink — do NOT re-attach it (§3.4).
      resp = (await this.graph().api(options.cursor).get()) as {
        value?: DriveItem[];
        "@odata.nextLink"?: string;
      };
    } else {
      // First-page call. Address `<target>/children`; forward `$top` only when
      // the caller supplied a pageSize (clamped to Graph's `[1, 999]`
      // ceiling). When omitted, use the Graph default paging (no `$top`).
      const url = this.resolveTargetUrl(target, "/children");
      const builder = this.graph().api(url);
      const scopedBuilder =
        options.pageSize !== undefined
          ? builder.query({ $top: clampOneDrivePageSize(options.pageSize) })
          : builder;
      resp = (await scopedBuilder.get()) as {
        value?: DriveItem[];
        "@odata.nextLink"?: string;
      };
    }
    const entries: DatasourceFileEntry<"onedrive">[] = [];
    for (const item of resp.value ?? []) {
      const entry = buildFileEntry(item);
      entries.push(entry);
      // Seed the cache so subsequent path-based addressing is free.
      if (entry.handle) this.cachePathHandle(entry.path, entry.handle);
    }
    return { entries, nextCursor: resp["@odata.nextLink"] ?? null };
  }

  // -------------------------------------------------------------------------
  // search — Graph's search(q='...') endpoint
  // -------------------------------------------------------------------------

  protected override async doSearchImpl(
    query: string,
    scope?: Target,
  ): Promise<DatasourceFileEntry<"onedrive">[]> {
    const suffix = `/search(q='${encodeQueryValue(query)}')`;
    const url = scope
      ? this.resolveTargetUrl(scope, suffix)
      : `${GRAPH_ROOT}${suffix}`;
    const resp = (await this.graph().api(url).get()) as { value?: DriveItem[] };
    const out: DatasourceFileEntry<"onedrive">[] = [];
    for (const item of resp.value ?? []) {
      out.push(buildFileEntry(item));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // getMetadata
  // -------------------------------------------------------------------------

  protected override async doGetMetadataImpl(
    target: Target,
  ): Promise<FileMetadata<"onedrive">> {
    const url = this.resolveTargetUrl(target, "");
    const item = (await this.graph().api(url).get()) as DriveItem;
    const entry = buildFileEntry(item);
    if (entry.handle) this.cachePathHandle(entry.path, entry.handle);
    return entry;
  }

  // -------------------------------------------------------------------------
  // uploadFile — small (≤4MB) simple PUT, large (>4MB) resumable session
  // -------------------------------------------------------------------------

  protected override async doUploadFileImpl(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    options: {
      signal?: AbortSignal;
      onProgress?: (loaded: number, total: number) => void;
    },
  ): Promise<DatasourceFileEntry<"onedrive">> {
    const name = file.name ?? basename(file.path);
    let total = 0;
    try {
      total = statSync(file.path).size;
    } catch {
      total = 0;
    }
    if (total <= RESUMABLE_THRESHOLD_BYTES) {
      // Small-upload path: single `PUT /content` via Graph SDK. The Graph
      // SDK does not expose an `AbortSignal` parameter on `api().put()`,
      // so mid-PUT interruption is not available on this path. Per
      // migrate-upload-orchestration-out-of-engine Decision 2, the
      // strategy branches on `options.signal?.aborted` post-resolve and
      // rejects with `tag: "cancelled"` to preserve cancellation
      // semantics on this code path.
      return this.uploadSmall(parent, name, file, total, options);
    }
    return this.uploadResumable(parent, name, file, total, options);
  }

  private async uploadSmall(
    parent: Target,
    name: string,
    file: { path: string; mimeType?: string },
    total: number,
    options: {
      signal?: AbortSignal;
      onProgress?: (loaded: number, total: number) => void;
    },
  ): Promise<DatasourceFileEntry<"onedrive">> {
    options.onProgress?.(0, total);
    const body = await readFile(file.path);
    const url = childPathUrl(parent, name, "/content");
    const item = (await this.graph().api(url).put(body)) as DriveItem;
    // Post-resolve cancellation guard (per migrate-upload-orchestration-
    // out-of-engine Decision 2): the Graph SDK's `.put()` does not honor
    // AbortSignal cleanly, so we check the signal after the call settles
    // and reject with `cancelled` if the consumer aborted.
    if (options.signal?.aborted) {
      throw new DatasourceError<"onedrive">({
        tag: "cancelled",
        datasourceType: "onedrive",
        datasourceId: this.datasourceId,
        retryable: false,
        message: "upload cancelled",
      });
    }
    options.onProgress?.(total, total);
    const entry = buildFileEntry(item);
    if (entry.handle) {
      this.cachePathHandle(entry.path, entry.handle);
    }
    return entry;
  }

  private async uploadResumable(
    parent: Target,
    name: string,
    file: { path: string; mimeType?: string },
    total: number,
    options: {
      signal?: AbortSignal;
      onProgress?: (loaded: number, total: number) => void;
    },
  ): Promise<DatasourceFileEntry<"onedrive">> {
    // Step 1: ask Graph for an upload session; get back `uploadUrl`.
    const sessionUrl = childPathUrl(parent, name, "/createUploadSession");
    const session = (await this.graph().api(sessionUrl).post({
      item: {
        "@microsoft.graph.conflictBehavior": "replace",
        name,
      },
    })) as { uploadUrl?: string };
    if (!session.uploadUrl || typeof session.uploadUrl !== "string") {
      throw this.normalizeErrorImpl({
        message: "create-upload-session-missing-uploadUrl",
        statusCode: 500,
      });
    }
    const uploadUrl = session.uploadUrl;

    // Wire the consumer-driven cancel cleanup (per migrate-upload-
    // orchestration-out-of-engine Decision 3). When `options.signal`
    // aborts, issue `DELETE <uploadUrl>` against a FRESH AbortController
    // with a 5-second timeout. The user's signal is NOT forwarded into
    // the cleanup — that would abort the cleanup itself, leaving the
    // resumable session orphaned on Graph's side. Errors in the cleanup
    // are logged and swallowed (best-effort cleanup).
    options.signal?.addEventListener(
      "abort",
      () => {
         
        this.fetchImpl(uploadUrl, {
          method: "DELETE",
          signal: AbortSignal.timeout(5000),
        }).catch((err) => {
           
          console.warn("[onedrive] upload-session cleanup failed:", err);
        });
      },
      { once: true },
    );

    // Step 2: stream the file from disk in chunks and PUT each chunk to the
    // session URL via raw fetch. The final chunk response carries the new
    // DriveItem.
    options.onProgress?.(0, total);
    const stream = createReadStream(file.path, {
      highWaterMark: UPLOAD_CHUNK_BYTES,
    });
    let uploaded = 0;
    let lastItem: DriveItem | null = null;
    // Buffer chunks exactly at UPLOAD_CHUNK_BYTES (except the last, which
    // may be smaller). `createReadStream` with the matching highWaterMark
    // already yields correctly-sized chunks for all but the final slice.
    let pending: Buffer = Buffer.alloc(0);
    const emitChunk = async (chunk: Buffer, isLast: boolean): Promise<void> => {
      const start = uploaded;
      const end = uploaded + chunk.length - 1;
      const headers: Record<string, string> = {
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${start}-${end}/${total}`,
      };
      // Thread the consumer's abort signal into each chunk PUT so an
      // abort unblocks promptly. An already-aborted signal makes fetch
      // reject synchronously with an AbortError; the rejection is
      // normalized to `tag: "cancelled"` via `normalizeErrorImpl`.
      const resp = await this.fetchImpl(uploadUrl, {
        method: "PUT",
        headers,
        body: chunk,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw this.normalizeErrorImpl({
          statusCode: resp.status,
          message: text || `upload-chunk-failed (${resp.status})`,
        });
      }
      uploaded += chunk.length;
      options.onProgress?.(uploaded, total);
      if (isLast) {
        // Final chunk: Graph returns 200/201 with the DriveItem JSON.
        const text = await resp.text();
        if (text) {
          try {
            lastItem = JSON.parse(text) as DriveItem;
          } catch {
            // Ignore — caller will surface the error via statusCode if any.
          }
        }
      }
    };

    for await (const piece of stream as AsyncIterable<Buffer>) {
      pending = pending.length === 0 ? piece : Buffer.concat([pending, piece]);
      while (pending.length >= UPLOAD_CHUNK_BYTES) {
        const chunk = pending.subarray(0, UPLOAD_CHUNK_BYTES);
        pending = pending.subarray(UPLOAD_CHUNK_BYTES);
        const isLast = pending.length === 0 && uploaded + chunk.length === total;
        await emitChunk(Buffer.from(chunk), isLast);
      }
    }
    if (pending.length > 0) {
      await emitChunk(pending, true);
    }

    if (!lastItem) {
      // Some implementations return a minimal final response; recover by
      // re-fetching metadata at the new path so the base still gets a
      // DatasourceFileEntry.
      const meta = (await this.graph()
        .api(childPathUrl(parent, name, ""))
        .get()) as DriveItem;
      lastItem = meta;
    }
    const entry = buildFileEntry(lastItem);
    // LRU population on upload success is internal (per migrate-upload-
    // orchestration-out-of-engine Decision 4). The constructor's bus
    // subscription dropped its `file-created` arm; populate the cache
    // here so subsequent path-keyed addressing skips the round-trip.
    if (entry.handle) {
      this.cachePathHandle(entry.path, entry.handle);
    }
    return entry;
  }

  // -------------------------------------------------------------------------
  // deleteFile — DELETE on the target URL
  // -------------------------------------------------------------------------

  protected override async doDeleteFileImpl(target: Target): Promise<void> {
    const url = this.resolveTargetUrl(target, "");
    await this.graph().api(url).delete();
    // Inline path-cache eviction (migrate-engine-cache-invalidation
    // Decisions 1/3) — replaces the former `deleted`-event bus subscription.
    if (target.kind === "path") {
      this.evictPath(target.path);
    } else {
      this.evictHandle(target.handle);
    }
  }

  // -------------------------------------------------------------------------
  // rename — PATCH /me/drive/items/{id} body { name }
  // (add-engine-rename-download §8.1-§8.4, §8.8)
  // -------------------------------------------------------------------------
  //
  // Graph treats files and folders uniformly via the `driveItem` resource.
  // PATCH `body: { name }` renames either kind; the response carries either
  // a `folder` or `file` facet which drives the returned entry's `kind`.
  //
  // Sibling-collision pre-check: `GET /me/drive/items/{parentId}/children
  // ?$filter=name eq '<encoded>'`. The pre-check is the strategy's
  // primary guard against duplicate-name siblings BUT cannot rule out a
  // race — a concurrent client could insert a sibling between pre-check
  // and PATCH. The PATCH error path therefore re-routes through
  // `normalizeErrorImpl` which already maps Graph 409 / `nameAlreadyExists`
  // to `tag: "conflict"`; the base then routes to
  // `delete-failed { via: "rename" }`.
  //
  // Directory-overwrite refusal mirrors Drive §7.5/§7.6: probe the
  // target's `folder` facet on the `overwrite` path and throw
  // `unsupported` BEFORE any mutation.
  //
  // File-overwrite explicit deletion: when `conflictPolicy: "overwrite"`
  // on a file, the strategy issues `DELETE /me/drive/items/{siblingId}`
  // for any colliding sibling — using the SDK's direct `delete` rather
  // than `this.deleteFile` so no public `deleted` event fires (single-step
  // UX per design.md Decision 7; same convention as Drive §7.4-§7.6).
  protected override async doRenameImpl(
    target: Target,
    newName: string,
    conflictPolicy: ConflictPolicy,
  ): Promise<DatasourceFileEntry<"onedrive">> {
    // Resolve target → driveItemId + parent metadata. The pre-check needs
    // the parent's id; the path-form parent path lets us populate
    // `existingPath` with a real engine path (otherwise `/<newName>`).
    const resolved = await this.resolveRenameTarget(target);
    const itemId = resolved.itemId;
    const parentId = resolved.parentId;
    const parentPath = resolved.parentPath;

    if (conflictPolicy === "overwrite") {
      // Pre-rename folder-facet probe — directory-overwrite is unsupported
      // because recursive replacement is out of scope (parallel to Drive
      // §7.5/§7.6). The post-rename response would tell us, but we need
      // to refuse BEFORE issuing the PATCH.
      let probe: DriveItem;
      try {
        probe = (await this.graph()
          .api(`${GRAPH_ITEMS}/${itemId}`)
          .get()) as DriveItem;
      } catch (err) {
        throw this.normalizeErrorImpl(err);
      }
      if (probe.folder !== undefined) {
        throw new DatasourceError<"onedrive">({
          tag: "unsupported",
          datasourceType: "onedrive",
          datasourceId: this.datasourceId,
          retryable: false,
          message:
            "directory rename with conflictPolicy 'overwrite' is not supported (would require recursive replacement)",
        });
      }
      // File-overwrite: enumerate colliding siblings and DELETE each
      // directly (NOT via `this.deleteFile` — bypassing the public
      // wrapper avoids emitting `deleted` events). Graph normally
      // disallows duplicate siblings, but we tolerate the multi-result
      // case for symmetry with Drive's handling.
      let listResp: { value?: DriveItem[] };
      try {
        listResp = (await this.graph()
          .api(this.childrenFilterUrl(parentId, newName))
          .get()) as { value?: DriveItem[] };
      } catch (err) {
        throw this.normalizeErrorImpl(err);
      }
      for (const sibling of listResp.value ?? []) {
        if (!sibling.id || sibling.id === itemId) continue;
        try {
          await this.graph().api(`${GRAPH_ITEMS}/${sibling.id}`).delete();
        } catch (err) {
          throw this.normalizeErrorImpl(err);
        }
        // Evict the displaced sibling's cached path — no `deleted` event fires
        // for this internal deletion (migrate-engine-cache-invalidation Dec. 3).
        this.evictHandle(sibling.id);
      }
    }

    if (conflictPolicy === "fail") {
      // Sibling pre-check: a single match short-circuits with `conflict`.
      let listResp: { value?: DriveItem[] };
      try {
        listResp = (await this.graph()
          .api(this.childrenFilterUrl(parentId, newName))
          .get()) as { value?: DriveItem[] };
      } catch (err) {
        throw this.normalizeErrorImpl(err);
      }
      const matches = listResp.value ?? [];
      if (matches.length > 0) {
        const existingPath = parentPath
          ? `${parentPath}/${newName}`
          : `/${newName}`;
        throw new DatasourceError<"onedrive">({
          tag: "conflict",
          datasourceType: "onedrive",
          datasourceId: this.datasourceId,
          retryable: false,
          raw: { existingPath },
          message: `Sibling already exists at ${existingPath}`,
        });
      }
    }

    // `keep-both` suffix-retry loop. Issue a children $filter query for
    // each candidate (starting with the original `newName`); on collision,
    // bump the suffix and retry. The original counts as attempt #1, so
    // suffixes 2..99 cover up to 99 total attempts. On exhaustion, throw
    // `tag: "provider-error"` per spec (engine taxonomy lacks `"other"`;
    // wire-layer collapses provider-error → `tag: "other"`).
    let effectiveName = newName;
    if (conflictPolicy === "keep-both") {
      const { base, ext } = splitNameForSuffix(newName);
      let chosen: string | null = null;
      for (let attempt = 1; attempt <= 99; attempt++) {
        const candidate =
          attempt === 1 ? newName : `${base}-${attempt}${ext}`;
        let listResp: { value?: DriveItem[] };
        try {
          listResp = (await this.graph()
            .api(this.childrenFilterUrl(parentId, candidate))
            .get()) as { value?: DriveItem[] };
        } catch (err) {
          throw this.normalizeErrorImpl(err);
        }
        const matches = listResp.value ?? [];
        if (matches.length === 0) {
          chosen = candidate;
          break;
        }
      }
      if (chosen === null) {
        throw new DatasourceError<"onedrive">({
          tag: "provider-error",
          datasourceType: "onedrive",
          datasourceId: this.datasourceId,
          retryable: false,
          message: "exhausted keep-both attempts",
        });
      }
      effectiveName = chosen;
    }

    let updated: DriveItem;
    try {
      updated = (await this.graph()
        .api(`${GRAPH_ITEMS}/${itemId}`)
        .patch({ name: effectiveName })) as DriveItem;
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }

    // Engine-facing path on the renamed entry. For path-form targets we
    // can compute it from the original path's parent + the new name; for
    // handle-form we synthesize `/<newName>` (same convention as
    // search / handle-form listDirectory).
    const isFolder = updated.folder !== undefined;
    const kind: "file" | "folder" = isFolder ? "folder" : "file";
    const mimeFamily: DatasourceMimeFamily = isFolder
      ? "folder"
      : mimeFamilyFromMime(updated.file?.mimeType);
    let entryPath: string;
    if (target.kind === "path") {
      const segs = target.path
        .replace(/^\/+/, "")
        .split("/")
        .filter((s) => s.length > 0);
      segs.pop();
      const parent = segs.length === 0 ? "" : `/${segs.join("/")}`;
      entryPath =
        parent === "" ? `/${effectiveName}` : `${parent}/${effectiveName}`;
    } else {
      entryPath = `/${effectiveName}`;
    }
    const providerMetadata: ProviderMetadata<"onedrive"> = {
      driveItemId: updated.id ?? itemId,
      ...(updated.file?.mimeType ? { mimeType: updated.file.mimeType } : {}),
      ...(updated.parentReference?.driveId
        ? { driveId: updated.parentReference.driveId }
        : {}),
    };
    const modifiedAt = updated.lastModifiedDateTime
      ? new Date(updated.lastModifiedDateTime).getTime()
      : 0;
    const entry: DatasourceFileEntry<"onedrive"> = {
      path: entryPath,
      handle: updated.id ?? itemId,
      name: effectiveName,
      kind,
      ...(typeof updated.size === "number" ? { size: updated.size } : {}),
      modifiedAt,
      mimeFamily,
      providerMetadata,
    };
    // Inline path-cache eviction on rename (migrate-engine-cache-invalidation
    // Decisions 1/3) — evict the OLD path; for a directory rename evict its
    // cached descendants too. Evict-only (the new path resolves fresh).
    // Handle-form has no old path → evict by the stable driveItemId.
    if (target.kind === "path") {
      if (isFolder) this.evictPathAndDescendants(target.path);
      else this.evictPath(target.path);
    } else {
      this.evictHandle(itemId);
    }
    return entry;
  }

  /**
   * Resolve a rename target into `{ itemId, parentId, parentPath }`. For
   * path-form targets we derive `parentPath` from the input path (so
   * conflict's `existingPath` can be a real engine path); for handle-form
   * `parentPath` is "" (the conflict raw payload uses `/<newName>` in
   * that case).
   *
   * Both forms read `parentReference.id` from the resolved DriveItem.
   * Graph populates this field on every item-resolution response (root's
   * children, item-by-id, item-by-path), so it is the canonical parent
   * identifier without an additional round-trip.
   */
  private async resolveRenameTarget(
    target: Target,
  ): Promise<{ itemId: string; parentId: string; parentPath: string }> {
    const url = this.resolveTargetUrl(target, "");
    let item: DriveItem;
    try {
      item = (await this.graph().api(url).get()) as DriveItem;
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    const itemId = item.id ?? "";
    const parentId = item.parentReference?.id ?? "";
    const parentPath =
      target.kind === "path"
        ? (() => {
            const segs = target.path
              .replace(/^\/+/, "")
              .split("/")
              .filter((s) => s.length > 0);
            segs.pop();
            return segs.length === 0 ? "" : `/${segs.join("/")}`;
          })()
        : "";
    return { itemId, parentId, parentPath };
  }

  /**
   * Build the `/me/drive/items/{parentId}/children?$filter=name eq '<v>'`
   * URL used by the rename sibling pre-check. The `$filter` value is
   * percent-encoded so embedded spaces / special characters do not
   * terminate the query string (Graph does its own decoding before
   * OData parsing, so single-quote doubling for OData literals AND
   * percent-encoding for URL-safety stack cleanly).
   *
   * Single quotes inside the name are doubled per OData's string-literal
   * rules BEFORE percent-encoding; the encoded result decodes back to
   * `''` (one OData-escaped quote pair) on the server.
   */
  private childrenFilterUrl(parentId: string, name: string): string {
    const odataEscaped = name.replace(/'/g, "''");
    const filter = `name eq '${odataEscaped}'`;
    return `${GRAPH_ITEMS}/${parentId}/children?$filter=${encodeURIComponent(
      filter,
    )}`;
  }

  // -------------------------------------------------------------------------
  // downloadFile — fetch GET /me/drive/items/{id}/content
  // (add-engine-rename-download §8.5-§8.7)
  // -------------------------------------------------------------------------
  //
  // The Graph SDK's `.api(...).get()` returns parsed JSON, not a Node
  // `Readable` / Web `ReadableStream`. We therefore use raw `fetch` against
  // Graph's REST equivalent (`https://graph.microsoft.com/v1.0/me/drive/
  // items/{id}/content`), forwarding the consumer's AbortSignal directly
  // to fetch's `signal` so an aborted in-flight request rejects with
  // `AbortError`. The Web ReadableStream returned by `fetch` is converted
  // to a Node `Readable` via `Readable.fromWeb(...)`.
  //
  // The byte-counting wrapper is a `Transform` (NOT a PassThrough +
  // `data` listener) — the same timing-race avoidance Drive's §7.7
  // describes. The Transform's `_transform` invokes
  // `options.onProgress?.(...)` AND `this.emitDownloading(path, loaded,
  // total)` per chunk so consumer callback + bus stay in lockstep.
  //
  // Auth-expired surfacing: a 401 surfaced before the body opens is
  // mapped by `normalizeErrorImpl` (Graph 401 → `tag: "auth-expired"`)
  // and routed by the base to `download-failed`. A mid-stream 401 (the
  // body opens 200 then errors) is also mapped to `auth-expired` —
  // raised by the underlying ReadableStream's error and caught by the
  // wrapper's source-error listener.
  protected override async doDownloadFileImpl(
    target: Target,
    options: DownloadOptions,
  ): Promise<DownloadResult> {
    // Resolve target to a driveItemId. Path-form targets walk the cache
    // first (cache hit avoids the round-trip); handle-form passes
    // through directly. The download URL itself uses item-id form so
    // path renames mid-flight do not invalidate the URL.
    const itemId = await this.resolveTargetItemId(target);
    const path = target.kind === "path" ? target.path : target.handle;

    const downloadUrl = `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}/content`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.requireCreds().accessToken}`,
    };
    if (options.rangeStart !== undefined && options.rangeStart > 0) {
      headers.Range = `bytes=${options.rangeStart}-`;
    }
    let resp: Response;
    try {
      resp = await this.fetchImpl(downloadUrl, {
        method: "GET",
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    if (!resp.ok) {
      // Graph error envelope as JSON. Parse and surface via
      // normalizeErrorImpl so the standard taxonomy applies.
      let bodyJson: { error?: { code?: string; message?: string } } | undefined;
      try {
        bodyJson = (await resp.json()) as {
          error?: { code?: string; message?: string };
        };
      } catch {
        bodyJson = undefined;
      }
      throw this.normalizeErrorImpl({
        statusCode: resp.status,
        ...(bodyJson?.error?.code ? { code: bodyJson.error.code } : {}),
        ...(bodyJson?.error?.message
          ? { message: bodyJson.error.message }
          : {}),
        body: bodyJson,
      });
    }
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v;
    });
    const contentLengthHeader = respHeaders["content-length"];
    const contentLength =
      contentLengthHeader !== undefined && contentLengthHeader !== ""
        ? Number.parseInt(contentLengthHeader, 10)
        : null;
    const contentRange = parseContentRangeHeader(respHeaders["content-range"]);

    // Convert fetch's Web ReadableStream → Node Readable. `Readable.fromWeb`
    // is supported on Node 18+ (this codebase's target).
    if (resp.body === null) {
      throw this.normalizeErrorImpl({
        message: "graph-download-missing-body",
        statusCode: resp.status,
      });
    }
    const sourceStream = Readable.fromWeb(
      resp.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    );

    // Wrap source in a `Transform` so the byte-counting hook is INLINE
    // with the data flow. Mirrors Drive §7.7's pattern: forking a
    // separate `data` listener races with the consumer's
    // attach-listeners step; a `Transform` pushes each chunk forward
    // exactly once.
    let loaded = 0;
    const total: number | null = contentLength;
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        loaded += chunk.length;
        try {
          options.onProgress?.(loaded, total);
        } catch {
          // Consumer-callback errors must not break the stream pipeline.
        }
        this.emitDownloading(path, loaded, total);
        cb(null, chunk);
      },
    });
    // Forward errors from the source stream so the wrapper transitions
    // to errored state and the base's `error` listener fires on a
    // mid-stream provider error (e.g., synthesized 401, network drop).
    sourceStream.on("error", (err) => {
      const normalized = this.normalizeErrorImpl(err);
      counter.destroy(normalized);
    });
    sourceStream.pipe(counter);

    return {
      stream: counter,
      contentLength,
      ...(contentRange ? { contentRange } : {}),
    };
  }

  /**
   * Resolve a `Target` to a driveItemId for the download URL. Path-form
   * targets consult the LRU cache (the `resolveTargetUrl` cache lookup
   * is duplicated here so we get the id directly rather than a URL
   * string). On cache miss, a `files.get` round-trip resolves the path
   * and seeds the cache for subsequent calls.
   */
  private async resolveTargetItemId(target: Target): Promise<string> {
    if (target.kind === "handle") return target.handle;
    const cached = this.pathHandleCache.get(target.path);
    if (cached !== undefined) {
      this.pathHandleCache.delete(target.path);
      this.pathHandleCache.set(target.path, cached);
      return cached;
    }
    let item: DriveItem;
    try {
      item = (await this.graph()
        .api(pathUrl(target.path, ""))
        .get()) as DriveItem;
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    const id = item.id ?? "";
    if (id) this.cachePathHandle(target.path, id);
    return id;
  }

  // -------------------------------------------------------------------------
  // getQuota — read /me/drive and return {used, quota}
  // -------------------------------------------------------------------------

  protected override async doGetQuotaImpl(): Promise<Quota> {
    const resp = (await this.graph().api(GRAPH_DRIVE).get()) as {
      quota?: { total?: number; used?: number };
    };
    const total = resp.quota?.total ?? 0;
    const used = resp.quota?.used ?? 0;
    return { used, quota: total };
  }

  // -------------------------------------------------------------------------
  // refreshToken — OAuth refresh over fetch
  // -------------------------------------------------------------------------

  protected override async refreshTokenImpl(): Promise<AuthResult> {
    // OAuth app config (clientId / tenantId / redirectUri) flows through
    // the preAuth-aware helper; the refresh token itself is per-user
    // state sourced from `creds`.
    const { clientId, tenantId, redirectUri } = this.getOAuthAppConfig();
    const { refreshToken } = this.requireCreds();
    if (!refreshToken) {
      throw new DatasourceError<"onedrive">({
        tag: "auth-revoked",
        datasourceType: "onedrive",
        datasourceId: this.datasourceId,
        retryable: false,
        raw: "onedrive-no-refresh-token",
        message: "No refresh token stored — interactive re-authentication required",
      });
    }
    const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      redirect_uri: redirectUri,
      scope: OAUTH_SCOPE,
    });
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    return this.parseTokenResponse(resp);
  }

  // -------------------------------------------------------------------------
  // normalizeError — map Graph errors to the 8-tag taxonomy
  // -------------------------------------------------------------------------

  protected override normalizeErrorImpl(raw: unknown): DatasourceError<"onedrive"> {
    if (raw instanceof DatasourceError) {
      return raw as DatasourceError<"onedrive">;
    }
    const r = (raw ?? {}) as {
      name?: string;
      code?: string;
      message?: string;
      statusCode?: number;
      status?: number;
      headers?: Record<string, string>;
      body?: { error?: { code?: string; message?: string } };
    };
    const code = r.code ?? r.body?.error?.code ?? "";
    // Preserve the inner-error code independently of the outer code. Graph
    // 403 responses carry the semantically meaningful code inside
    // `body.error.code` (e.g., `unauthenticated`, `invalidAuthenticationToken`,
    // `revoked`) while the outer code is the generic `accessDenied`.
    const innerCode = r.body?.error?.code ?? "";
    const status = r.statusCode ?? r.status ?? 0;
    const name = r.name ?? "";
    const message = r.message ?? r.body?.error?.message ?? undefined;
    const headers = r.headers ?? {};

    const mk = (
      tag: DatasourceError<"onedrive">["tag"],
      retryable: boolean,
      extra: { retryAfterMs?: number; message?: string } = {},
    ): DatasourceError<"onedrive"> =>
      new DatasourceError<"onedrive">({
        tag,
        datasourceType: "onedrive",
        datasourceId: this.datasourceId,
        retryable,
        raw,
        ...(extra.retryAfterMs !== undefined
          ? { retryAfterMs: extra.retryAfterMs }
          : {}),
        ...(extra.message ? { message: extra.message } : message ? { message } : {}),
      });

    // auth-revoked — OAuth hard-fail. Check BEFORE auth-expired since some
    // servers include a 401 alongside invalid_grant.
    if (code === "unauthorized_client" || code === "invalid_grant") {
      return mk("auth-revoked", false);
    }
    // 403 with a revoked-consent inner code — Graph reuses outer
    // `accessDenied` for both revoked consent and ordinary access denials.
    // Inner codes `unauthenticated` / `invalidAuthenticationToken` / `revoked`
    // indicate the token is no longer trusted; everything else (sharing-policy
    // denial, unified-audit policies, etc.) stays a generic provider-error.
    // Check BEFORE the 401 branch so a 403 carrying `invalidAuthenticationToken`
    // in its inner code doesn't get misrouted to `auth-expired`.
    if (status === 403) {
      if (
        innerCode === "unauthenticated" ||
        innerCode === "invalidAuthenticationToken" ||
        innerCode === "revoked"
      ) {
        return mk("auth-revoked", false);
      }
      return mk("provider-error", false);
    }
    // auth-expired — transient token expiry (Graph returns 401 with
    // `InvalidAuthenticationToken`).
    if (code === "InvalidAuthenticationToken" || status === 401) {
      return mk("auth-expired", false);
    }
    // not-found
    if (code === "itemNotFound" || status === 404) {
      return mk("not-found", false);
    }
    // conflict — Graph uses `nameAlreadyExists` for duplicate children.
    if (code === "nameAlreadyExists" || status === 409) {
      return mk("conflict", false);
    }
    // rate-limited — Graph throttling uses `activityLimitReached` + 429.
    if (code === "activityLimitReached" || status === 429 || status === 503) {
      const retryAfterHeader = headers["retry-after"] ?? headers["Retry-After"];
      const retryAfterMs = retryAfterHeader
        ? Number.parseInt(retryAfterHeader, 10) * 1000
        : undefined;
      return mk("rate-limited", true, {
        ...(retryAfterMs !== undefined && !Number.isNaN(retryAfterMs)
          ? { retryAfterMs }
          : {}),
      });
    }
    // quotaLimitReached — storage quota exhausted. The 8-tag taxonomy does
    // NOT have a dedicated `quota-exceeded` tag (see `DatasourceErrorTag` in
    // `@ft5/ipc-contracts`). Mapping to `provider-error` with
    // `retryable: false` is the safe fit: the write will not succeed on
    // retry until the user frees space. Taxonomy expansion is tracked as a
    // phase-7 code-review follow-up; until it lands, the outer `raw` payload
    // preserves `code: "quotaLimitReached"` for any caller that wants
    // quota-aware UX.
    if (code === "quotaLimitReached") {
      return mk("provider-error", false);
    }
    // AbortError — `fetch` propagates an aborted signal as an error with
    // `name: "AbortError"` (DOMException-like) regardless of any other
    // shape on the error. Map it to `tag: "cancelled"` BEFORE the
    // network-error branch so an aborted in-flight request that ALSO
    // exposes a network-y `code` does not get mis-classified as
    // transient. The base routes `cancelled` to the `download-cancelled`
    // bus event per design.md Decision 3 (mirrors Drive §7.10).
    if (name === "AbortError") {
      return mk("cancelled", false, { message: "download cancelled" });
    }
    // network-error — Node fetch / undici surface these as FetchError or the
    // underlying socket code bubbles up directly.
    if (
      name === "FetchError" ||
      name === "NetworkError" ||
      (name === "TypeError" &&
        typeof message === "string" &&
        message.toLowerCase().includes("fetch")) ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "EPIPE"
    ) {
      return mk("network-error", true);
    }
    // fallthrough
    return mk("provider-error", false);
  }
}

/**
 * Build the Graph URL for a `<parent>/<name>` path inside a parent `Target`,
 * with the given suffix (`""`, `/content`, `/createUploadSession`). Used by
 * uploadFile.
 */
function childPathUrl(parent: Target, name: string, suffix: string): string {
  // `name` is user-controlled and must be percent-encoded so characters like
  // `#`, `&`, `+`, and space do not terminate the Graph path, attach a query
  // string, or decode to a different name server-side. See pathToGraphSegment
  // for the SDK-encoding rationale.
  const encodedName = encodeURIComponent(name);
  if (parent.kind === "handle") {
    // Item-id form: /me/drive/items/<id>:/<name>:<suffix>
    return suffix === ""
      ? `${GRAPH_ITEMS}/${parent.handle}:/${encodedName}:`
      : `${GRAPH_ITEMS}/${parent.handle}:/${encodedName}:${suffix}`;
  }
  // Path form. `parentSeg` is already segment-encoded by pathToGraphSegment;
  // `pathPosix.join` preserves the encoded segments and inserts the
  // separator.
  const parentSeg = pathToGraphSegment(parent.path);
  const joined =
    parentSeg === "" ? `/${encodedName}` : pathPosix.join(parentSeg, encodedName);
  return suffix === ""
    ? `${GRAPH_ROOT}:${joined}:`
    : `${GRAPH_ROOT}:${joined}:${suffix}`;
}

/** Encode a value for the Graph `search(q='...')` expression. The value is
 * wrapped in single quotes; literal single quotes are doubled per OData's
 * string-literal rules. AFTER quote-doubling, the result is
 * percent-encoded so characters that are meaningful in URLs (`#`, `&`, `+`,
 * space, and the now-doubled `'`) do not terminate or mutate the query
 * string. The Graph service percent-decodes before OData parsing, so this
 * is safe: `''` → `%27%27` → decoded back to `''` by the server, which OData
 * treats as a literal single quote inside the string literal.
 */
function encodeQueryValue(v: string): string {
  return encodeURIComponent(v.replace(/'/g, "''"));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory function for the OneDrive strategy. Extracts OAuth config from
 * `StoredCredentials.authResult.meta` and access / refresh tokens from the
 * top-level `authResult`, then constructs a fresh `OneDriveClient`.
 *
 * Tests pass an `options` object to inject the Graph factory + fetchImpl.
 * Production callers (the main-process IPC wiring) omit it and get the real
 * SDK backed by the built-in factory.
 */
export function createOneDriveClient(
  datasourceId: string,
  credentials: StoredCredentials,
  ctx: BaseClientContext,
  options?: OneDriveClientOptions,
): OneDriveClient {
  const creds = readCredsFromStored(credentials);
  return new OneDriveClient({ datasourceId, ctx }, creds, options);
}

/** Canonical `ProviderFactoryFn` entry for the registry. No `options`
 * parameter — production wiring uses the default SDK. Tests that need
 * injection call `createOneDriveClient` directly.
 */
export const createOneDriveClientForRegistry: ProviderFactoryFn<"onedrive"> = (
  datasourceId,
  credentials,
  ctx,
) => {
  return createOneDriveClient(datasourceId, credentials, ctx);
};

/**
 * Canonical `PreAuthFactoryFn` entry for `factory.createForAuth(...)` —
 * implement-datasource-onboarding §3.4. Constructs the strategy without
 * `StoredCredentials` (creds=null) and threads the `OAuthAppConfig` into
 * the `preAuth` constructor slot. The strategy defaults `tenantId` to
 * `"common"` on the preAuth path (per design.md Decision 13's OneDrive
 * clarification — `OAuthAppConfig` deliberately omits `tenantId`).
 */
export const createOneDriveClientForAuth: PreAuthFactoryFn<"onedrive"> = (
  datasourceId,
  preAuth,
  ctx,
) => {
  return new OneDriveClient({ datasourceId, ctx }, null, {}, preAuth);
};

/**
 * Per-provider credential-shape validator (per
 * add-invalid-datasource-state Decision 2). Wired into the registry entry
 * by `createDefaultProviderRegistry` and invoked by `factory.create`
 * BEFORE the strategy factory runs.
 */
export const validateOneDriveCredentialShape: CredentialShapeValidator = (
  credentials,
  datasourceId,
) => {
  const authResult = (credentials as { authResult?: unknown }).authResult;
  if (authResult === null || typeof authResult !== "object") {
    throw new DatasourceError<"onedrive">({
      tag: DatasourceErrorTag.InvalidDatasource,
      datasourceType: "onedrive",
      datasourceId,
      retryable: false,
      raw: "onedrive-missing-authResult",
      message: "onedrive credential is missing authResult",
    });
  }
  const ar = authResult as Record<string, unknown>;
  if (typeof ar.accessToken !== "string" || ar.accessToken.length === 0) {
    throw new DatasourceError<"onedrive">({
      tag: DatasourceErrorTag.InvalidDatasource,
      datasourceType: "onedrive",
      datasourceId,
      retryable: false,
      raw: "onedrive-missing-accessToken",
      message: "onedrive credential is missing accessToken",
    });
  }
  const meta = (ar.meta ?? {}) as Record<string, unknown>;
  for (const field of ["clientId", "tenantId", "redirectUri"] as const) {
    if (typeof meta[field] !== "string" || (meta[field] as string).length === 0) {
      throw new DatasourceError<"onedrive">({
        tag: DatasourceErrorTag.InvalidDatasource,
        datasourceType: "onedrive",
        datasourceId,
        retryable: false,
        raw: `onedrive-missing-${field}`,
        message: `onedrive credential is missing ${field}`,
      });
    }
  }
};
