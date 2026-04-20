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
//     (`/me/drive/items/<id>`). `FileEntry<T>.handle` carries the driveItemId,
//     so subsequent calls via `{ kind: "handle", handle }` skip the path
//     lookup entirely. Path→id resolution is cached in an LRU keyed by the
//     engine path; invalidation happens via a bus subscription in the
//     constructor: every `deleted` or `file-created` event for this
//     datasource evicts the affected path.
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
//     hook `deleted` / `file-created` for invalidation. Because the factory
//     creates a fresh client per call with no explicit dispose, the
//     subscription currently leaks until the bus itself is discarded; a
//     future phase will add a `dispose()` method on `BaseDatasourceClient`
//     (flagged in the phase-7 report).
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

import type {
  AuthIntent,
  AuthResult,
  DatasourceStatus,
  FileEntry,
  FileMetadata,
  MimeFamily,
  OAuthIntent,
  ProviderMetadata,
  Quota,
  StoredCredentials,
  Target,
} from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

import { BaseDatasourceClient, type BaseClientContext } from "../base-client.js";
import type { ProviderFactoryFn } from "../factory.js";

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

// MSAL / Graph scopes for file read/write + refresh
const OAUTH_SCOPE = "offline_access Files.ReadWrite.All User.Read";

// ---------------------------------------------------------------------------
// Utility: path <-> Graph URL addressing
// ---------------------------------------------------------------------------

/** Normalize an engine path (e.g. `"/"`, `"/photos"`, `"/photos/2024/img.jpg"`)
 * into the Graph path segment used after `/root:` and `:/...`. Root is a
 * special case — Graph uses `/me/drive/root` (no `:` suffix) for root
 * addressing.
 */
function pathToGraphSegment(path: string): string {
  if (path === "" || path === "/") return "";
  return path.startsWith("/") ? path : `/${path}`;
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

/** Resolve a Target to a Graph URL with the given method-specific suffix. */
function targetUrl(target: Target, suffix: string): string {
  if (target.kind === "handle") return handleUrl(target.handle, suffix);
  return pathUrl(target.path, suffix);
}

// ---------------------------------------------------------------------------
// DriveItem → FileEntry mapping
// ---------------------------------------------------------------------------

interface DriveItem {
  id?: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { path?: string; driveId?: string };
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

function mimeFamilyFromMime(mime?: string): MimeFamily {
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

function buildFileEntry(item: DriveItem): FileEntry<"onedrive"> {
  const id = item.id ?? "";
  const name = item.name ?? "";
  const isFolder = item.folder !== undefined;
  const kind: "file" | "folder" = isFolder ? "folder" : "file";
  const mimeFamily: MimeFamily = isFolder
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
  const entry: FileEntry<"onedrive"> = {
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

  private creds: OneDriveCredsMeta;
  private readonly graphFactory: GraphFactory;
  private readonly fetchImpl: typeof fetch;
  private readonly lruCap: number;

  /** Path → driveItemId cache. `Map` preserves insertion order; we use that
   * as a crude LRU (delete on re-set to bump recency; drop-oldest on cap). */
  private readonly pathHandleCache = new Map<string, string>();

  /** Unsubscribe handle for the bus subscription driving cache invalidation.
   * Currently leaked — a future phase will add `dispose()` to the base class. */
  private readonly unsubscribe: () => void;

  constructor(
    init: { datasourceId: string; ctx: BaseClientContext },
    creds: OneDriveCredsMeta,
    options: OneDriveClientOptions = {},
  ) {
    super(init);
    this.creds = creds;
    this.graphFactory = options.graphFactory ?? createDefaultGraphFactory();
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch: typeof fetch }).fetch).bind(globalThis);
    this.lruCap = options.lruCap ?? 512;

    // Subscribe to bus events for cache invalidation. Narrow to this
    // datasource, and react to terminal `deleted` / `file-created` events.
    this.unsubscribe = this.ctx.bus.subscribe((e) => {
      if (e.datasourceId !== this.datasourceId) return;
      if (e.event === "deleted") {
        const payload = e.payload as { target?: Target };
        if (payload.target?.kind === "path") {
          this.evictPath(payload.target.path);
        } else if (payload.target?.kind === "handle") {
          this.evictHandle(payload.target.handle);
        }
      } else if (e.event === "file-created") {
        const payload = e.payload as { path?: string; handle?: string };
        // Refresh the cache with the new mapping so a subsequent path
        // lookup sees the new item without a round-trip.
        if (
          typeof payload.path === "string" &&
          typeof payload.handle === "string"
        ) {
          this.cachePathHandle(payload.path, payload.handle);
        }
      }
    });
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

  // -------------------------------------------------------------------------
  // Graph client access (re-built after token refresh)
  // -------------------------------------------------------------------------

  private graph(): GraphClientLike {
    return this.graphFactory(this.creds.accessToken);
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
    const { clientId, tenantId, redirectUri } = this.creds;
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
    const { clientId, tenantId, redirectUri } = this.creds;
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
    const result: AuthResult = {
      accessToken,
      meta: {
        clientId: this.creds.clientId,
        tenantId: this.creds.tenantId,
        redirectUri: this.creds.redirectUri,
      },
    };
    if (typeof refreshToken === "string") {
      result.refreshToken = refreshToken;
    }
    if (typeof expiresIn === "number") {
      result.expiresAt = Date.now() + expiresIn * 1000;
    }
    // Update in-memory creds so subsequent Graph calls use the new token.
    // The base's withRefresh cycle persists via CredentialStore.put — we
    // keep the in-memory copy synced here so a caller that never invokes
    // withRefresh still sees post-auth state.
    this.creds = {
      ...this.creds,
      accessToken,
      ...(typeof refreshToken === "string" ? { refreshToken } : {}),
    };
    return result;
  }

  // -------------------------------------------------------------------------
  // listDirectory
  // -------------------------------------------------------------------------

  protected override async doListDirectoryImpl(
    target: Target,
  ): Promise<FileEntry<"onedrive">[]> {
    const url = targetUrl(target, "/children");
    const resp = (await this.graph().api(url).get()) as { value?: DriveItem[] };
    const entries: FileEntry<"onedrive">[] = [];
    for (const item of resp.value ?? []) {
      const entry = buildFileEntry(item);
      entries.push(entry);
      // Seed the cache so subsequent path-based addressing is free.
      if (entry.handle) this.cachePathHandle(entry.path, entry.handle);
    }
    return entries;
  }

  // -------------------------------------------------------------------------
  // search — Graph's search(q='...') endpoint
  // -------------------------------------------------------------------------

  protected override async doSearchImpl(
    query: string,
    scope?: Target,
  ): Promise<FileEntry<"onedrive">[]> {
    const suffix = `/search(q='${encodeQueryValue(query)}')`;
    const url = scope ? targetUrl(scope, suffix) : `${GRAPH_ROOT}${suffix}`;
    const resp = (await this.graph().api(url).get()) as { value?: DriveItem[] };
    const out: FileEntry<"onedrive">[] = [];
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
    const url = targetUrl(target, "");
    const item = (await this.graph().api(url).get()) as DriveItem;
    const entry = buildFileEntry(item);
    if (entry.handle) this.cachePathHandle(entry.path, entry.handle);
    return entry;
  }

  // -------------------------------------------------------------------------
  // createFile — small PUT via Graph client
  // -------------------------------------------------------------------------

  protected override async doCreateFileImpl(
    parent: Target,
    name: string,
    content: { path: string },
  ): Promise<FileEntry<"onedrive">> {
    const body = await readFile(content.path);
    const url = childPathUrl(parent, name, "/content");
    // Use `@name.conflictBehavior=fail` so the upload fails with 409 if the
    // file already exists; normalizeError maps that to `conflict`.
    const item = (await this.graph()
      .api(`${url}?@microsoft.graph.conflictBehavior=fail`)
      .put(body)) as DriveItem;
    return buildFileEntry(item);
  }

  // -------------------------------------------------------------------------
  // uploadFile — small (≤4MB) simple PUT, large (>4MB) resumable session
  // -------------------------------------------------------------------------

  protected override async doUploadFileImpl(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<FileEntry<"onedrive">> {
    const name = file.name ?? basename(file.path);
    let total = 0;
    try {
      total = statSync(file.path).size;
    } catch {
      total = 0;
    }
    if (total <= RESUMABLE_THRESHOLD_BYTES) {
      return this.uploadSmall(parent, name, file, total, onProgress);
    }
    return this.uploadResumable(parent, name, file, total, onProgress);
  }

  private async uploadSmall(
    parent: Target,
    name: string,
    file: { path: string; mimeType?: string },
    total: number,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<FileEntry<"onedrive">> {
    onProgress?.(0, total);
    const body = await readFile(file.path);
    const url = childPathUrl(parent, name, "/content");
    const item = (await this.graph().api(url).put(body)) as DriveItem;
    onProgress?.(total, total);
    return buildFileEntry(item);
  }

  private async uploadResumable(
    parent: Target,
    name: string,
    file: { path: string; mimeType?: string },
    total: number,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<FileEntry<"onedrive">> {
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

    // Step 2: stream the file from disk in chunks and PUT each chunk to the
    // session URL via raw fetch. The final chunk response carries the new
    // DriveItem.
    onProgress?.(0, total);
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
      const resp = await this.fetchImpl(uploadUrl, {
        method: "PUT",
        headers,
        body: chunk,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw this.normalizeErrorImpl({
          statusCode: resp.status,
          message: text || `upload-chunk-failed (${resp.status})`,
        });
      }
      uploaded += chunk.length;
      onProgress?.(uploaded, total);
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
      // FileEntry.
      const meta = (await this.graph()
        .api(childPathUrl(parent, name, ""))
        .get()) as DriveItem;
      lastItem = meta;
    }
    return buildFileEntry(lastItem);
  }

  // -------------------------------------------------------------------------
  // deleteFile — DELETE on the target URL
  // -------------------------------------------------------------------------

  protected override async doDeleteFileImpl(target: Target): Promise<void> {
    const url = targetUrl(target, "");
    await this.graph().api(url).delete();
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
    const { clientId, tenantId, refreshToken, redirectUri } = this.creds;
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
    // network-error — Node fetch / undici surface these as FetchError or the
    // underlying socket code bubbles up directly.
    if (
      name === "FetchError" ||
      name === "NetworkError" ||
      name === "TypeError" && typeof message === "string" && message.toLowerCase().includes("fetch") ||
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
 * createFile and uploadFile.
 */
function childPathUrl(parent: Target, name: string, suffix: string): string {
  if (parent.kind === "handle") {
    // Item-id form: /me/drive/items/<id>:/<name>:<suffix>
    return suffix === ""
      ? `${GRAPH_ITEMS}/${parent.handle}:/${name}:`
      : `${GRAPH_ITEMS}/${parent.handle}:/${name}:${suffix}`;
  }
  // Path form.
  const parentSeg = pathToGraphSegment(parent.path);
  const joined = parentSeg === "" ? `/${name}` : pathPosix.join(parentSeg, name);
  return suffix === ""
    ? `${GRAPH_ROOT}:${joined}:`
    : `${GRAPH_ROOT}:${joined}:${suffix}`;
}

/** Encode a value for the Graph `search(q='...')` expression. The value is
 * wrapped in single quotes; literal single quotes are doubled per OData.
 */
function encodeQueryValue(v: string): string {
  return v.replace(/'/g, "''");
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
