// GoogleDriveClient — concrete datasource strategy for Google Drive.
//
// Extends `BaseDatasourceClient<"google-drive">` and wires every `doX`
// primitive against `googleapis`. The base class owns event emission,
// retry-on-auth-expired, error normalization, and the capability gate for
// `getQuota`.
//
// Key design notes (see design.md Decisions 1, 2, 3, 6, 7, 9 and spec
// Requirements "Hybrid `Target`" + "Authentication returns an `AuthIntent`"):
//
//   - Credentials storage shape. Drive is OAuth 2.0; the authentication
//     flow needs `clientId`, `clientSecret`, and `redirectUri` at the
//     moment `authenticate()` is called, before any tokens exist. Mirroring
//     OneDrive's "meta-is-the-truth" pattern, the OAuth config lives in
//     `credentials.authResult.meta` and tokens in the top-level `authResult`.
//
//   - Path ↔ fileId mapping. Drive addresses files by stable `fileId`, not
//     by path. The strategy walks `files.list` segment by segment with a
//     name filter (and `parents in`) at each step to resolve a path to a
//     fileId. Handles (`{kind: "handle"}`) skip the walk entirely. Results
//     are cached in an LRU keyed by the full path; invalidation happens via
//     a bus subscription that reacts to `deleted` and `file-created`.
//
//   - Path ambiguity. Drive allows multiple files with the same name in
//     the same parent. When `files.list` returns more than one row for a
//     `(parent, name)` filter, the strategy picks the OLDEST hit (via
//     `orderBy: "createdTime asc"`) and surfaces the ambiguity on the
//     returned entry's `providerMetadata`:
//       - `ambiguous: true` (only present when true)
//       - `ambiguousSiblings: string[]` — the OTHER fileIds at the same
//         (parent, name), so the caller can re-address them via the
//         `handle`-form `Target`.
//     This is NOT a `status-changed` event: events describe operation
//     lifecycle, not result data, and late subscribers miss them. Ambiguity
//     belongs on the entry that is ambiguous.
//
//   - Upload. Drive supports a resumable upload session: POST
//     `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`
//     with metadata → response `Location` header carries the session URL →
//     PUT chunks to that URL with `Content-Range` headers. The strategy
//     streams from disk in 10 MiB chunks; no full-file buffer in memory.
//     The SDK's `drive.files.create` abstraction does not expose
//     per-chunk progress events cleanly, so the strategy drives the
//     resumable session via raw `fetch` — mirroring the OneDrive approach.
//
//   - `refreshToken`. POSTs `grant_type=refresh_token` to
//     `https://oauth2.googleapis.com/token`. Single-flight enforced by the
//     base; our `refreshTokenImpl` is just the critical section.
//
//   - `normalizeError`. `googleapis` surfaces API errors as `GaxiosError`
//     with `response.status`, `response.data.error.{code, message, errors}`,
//     and `errors[0].reason`. The strategy branches on status + reason and
//     maps to the 8-tag taxonomy per design.md. Network / Node system
//     errors (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`) map to `network-error`.
//
//   - Synthesized paths on search / handle-form listings. Drive responses
//     do NOT carry the engine-facing path — only `name`, `parents`, `id`.
//     For `search` and for `listDirectory` targeted by handle, the strategy
//     has no known parent-path context, so it synthesizes `path: "/<name>"`
//     on each returned `DatasourceFileEntry`. This synthesized path is NOT guaranteed
//     to round-trip: `getMetadata({kind: "path", path: "/<name>"})` will
//     resolve from the root and may return a DIFFERENT file (or
//     `not-found`). Callers re-addressing such entries MUST use the
//     `handle` form of `Target` — `{kind: "handle", handle: entry.handle}`
//     — which targets the specific `fileId`. The `path` on synthesized
//     entries is informational (good for display; unreliable for
//     re-resolution). Recovering the real path requires walking parents
//     backwards, a provider round-trip cost we defer until a caller needs it.
//
//   - Mutation on ambiguous path. Because path-to-fileId can be multi-valued
//     on Drive, `deleteFile` (and any future mutating op that targets a
//     specific file by path) REJECTS with `tag: "conflict"` when the path
//     resolution carries `ambiguousSiblings`. The raw payload lists all
//     candidate fileIds; the caller must re-address via handle to pick
//     one. Handle-form targets bypass this check — they explicitly name
//     one fileId.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";

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

import { BaseDatasourceClient, type BaseClientContext } from "../base-client.js";
import {
  type CredentialShapeValidator,
  type ProviderFactoryFn,
} from "../factory.js";

// ESM shim. This package is "type": "module", so bare `require` is not in
// scope. `createDefaultDriveFactory` below uses `require("googleapis")` to
// lazy-load the SDK (keeps unit tests from pulling it in); that call needs
// a `require` in module scope — hence this line.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Drive SDK duck-typing — `GoogleDriveClientLike`
// ---------------------------------------------------------------------------
//
// The `googleapis` SDK has no test-time mock package. We duck-type the
// subset of the SDK we use so tests can supply a plain-object fake. Every
// method signature mirrors the real SDK: params object in → `{ data: ... }`
// out.

export interface DriveFilesLike {
  list(params: Record<string, unknown>): Promise<{ data: DriveListResponse }>;
  get(params: Record<string, unknown>): Promise<{ data: DriveFile }>;
  create(params: Record<string, unknown>): Promise<{ data: DriveFile }>;
  delete(params: Record<string, unknown>): Promise<{ data: unknown }>;
}

export interface DriveAboutLike {
  get(params: Record<string, unknown>): Promise<{ data: DriveAboutResponse }>;
}

export interface GoogleDriveClientLike {
  files: DriveFilesLike;
  about: DriveAboutLike;
}

export type DriveFactory = (accessToken: string) => GoogleDriveClientLike;

// ---------------------------------------------------------------------------
// Drive response shapes
// ---------------------------------------------------------------------------

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  // Drive returns `size` as a numeric-string to avoid JS precision loss on
  // files > 2^53 bytes. We parse with `Number()`; for multi-PB files a
  // future migration to `bigint` would be required.
  size?: string | number;
  modifiedTime?: string;
  createdTime?: string;
}

interface DriveListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

interface DriveAboutResponse {
  storageQuota?: {
    limit?: string | number;
    usage?: string | number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DRIVE_ROOT_FILE_ID = "root";
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

// Resumable-session upload endpoint. POST here with metadata + uploadType=resumable
// to receive a session URL in the `Location` response header.
const DRIVE_UPLOAD_SESSION_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";

// Google OAuth endpoints.
const OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Drive's OAuth scope for full-access to all files the user owns or has been
// granted access to. `drive.file` is narrower (only app-created files) but
// would prevent listing the user's existing content.
const OAUTH_SCOPE = "https://www.googleapis.com/auth/drive";

// The scope the engine requires of the ISSUED grant. Intentionally a separate
// constant from OAUTH_SCOPE: OAUTH_SCOPE is what the authorize URL requests;
// REQUIRED_DRIVE_SCOPE is what we validate on the issued credential at runtime.
const REQUIRED_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

// Resumable-upload chunk size. Google recommends multiples of 256 KiB; we
// pick 10 MiB to match the OneDrive strategy's chunk cadence and keep the
// streaming-progress UX consistent across providers.
const UPLOAD_CHUNK_BYTES = 10 * 1024 * 1024;

// Default field set for `files.list` and `files.get`. Keep in sync across
// call sites so every response carries the fields `buildFileEntry` needs.
const DEFAULT_FILE_FIELDS =
  "id, name, mimeType, parents, size, modifiedTime, createdTime";
const DEFAULT_LIST_FIELDS = `nextPageToken, files(${DEFAULT_FILE_FIELDS})`;

// ---------------------------------------------------------------------------
// Helpers — path parsing, query encoding, response mapping
// ---------------------------------------------------------------------------

/** Split an engine path into its segments; root is the empty array. */
function pathSegments(path: string): string[] {
  if (path === "" || path === "/") return [];
  const stripped = path.startsWith("/") ? path.slice(1) : path;
  return stripped.split("/").filter((s) => s.length > 0);
}

/** Escape a value for embedding in a Drive `q=` string literal. Drive uses
 * OData-like syntax: values wrap in single quotes, literal quotes double.
 * The SDK submits the string as a query param — no URL-encoding is needed
 * at this layer (the SDK does that). */
export function encodeDriveQuery(value: string): string {
  return value.replace(/'/g, "''");
}

function mimeFamilyFromMime(mime?: string): DatasourceMimeFamily {
  if (!mime) return "other";
  if (mime === DRIVE_FOLDER_MIME) return "folder";
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
  // Google-native types (docs, sheets, slides) map to document.
  if (mime.startsWith("application/vnd.google-apps.")) return "document";
  return "other";
}

function parseSize(size: string | number | undefined): number | undefined {
  if (size === undefined) return undefined;
  const n = typeof size === "number" ? size : Number(size);
  if (Number.isNaN(n)) return undefined;
  return n;
}

function isFolder(file: DriveFile): boolean {
  return file.mimeType === DRIVE_FOLDER_MIME;
}

/** Returns true iff the space-separated `scope` string includes the full
 * Drive scope as a discrete token. Narrower variants (`drive.file`,
 * `drive.readonly`, etc.) are insufficient on their own because the engine
 * performs `createFile`, `uploadFile`, `deleteFile`. */
export function isScopeSufficient(scope: string): boolean {
  return scope.split(/\s+/).filter(Boolean).includes(REQUIRED_DRIVE_SCOPE);
}

// ---------------------------------------------------------------------------
// Credential extraction
// ---------------------------------------------------------------------------

interface GoogleDriveCredsMeta {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string;
  /** The space-separated OAuth scope string from the issued grant, when known.
   * Populated at construction from `authResult.meta.scope` if present.
   * `undefined` means legacy credentials pre-dating scope backfill. */
  scope?: string;
}

function readCredsFromStored(
  credentials: StoredCredentials,
): GoogleDriveCredsMeta {
  const authResult = credentials.authResult;
  const meta = (authResult.meta ?? {}) as Record<string, unknown>;
  if (
    typeof meta.clientId !== "string" ||
    typeof meta.clientSecret !== "string" ||
    typeof meta.redirectUri !== "string"
  ) {
    throw new DatasourceError<"google-drive">({
      tag: "auth-revoked",
      datasourceType: "google-drive",
      datasourceId: "<init>",
      retryable: false,
      raw: "google-drive-missing-oauth-config",
      message:
        "Google Drive credentials must include meta.clientId, meta.clientSecret, meta.redirectUri",
    });
  }
  return {
    clientId: meta.clientId,
    clientSecret: meta.clientSecret,
    redirectUri: meta.redirectUri,
    accessToken: authResult.accessToken,
    refreshToken: authResult.refreshToken ?? "",
    ...(typeof meta.scope === "string" ? { scope: meta.scope } : {}),
  };
}

// ---------------------------------------------------------------------------
// Default Drive factory — real SDK
// ---------------------------------------------------------------------------

/**
 * Build a production `GoogleDriveClientLike` via the official `googleapis`
 * SDK. Tests supply their own factory and never hit this path.
 *
 * The SDK's `google.drive({ version: 'v3', auth })` returns a client whose
 * `.files` and `.about` sub-resources match our duck-typed shape.
 */
export function createDefaultDriveFactory(): DriveFactory {
  return (accessToken: string): GoogleDriveClientLike => {
    // Lazy import so the SDK is not required at module-load time for tests.
    const mod = require("googleapis") as {
      google: {
        auth: {
          OAuth2: new () => {
            setCredentials(creds: { access_token: string }): void;
          };
        };
        drive(opts: {
          version: string;
          auth: unknown;
        }): GoogleDriveClientLike;
      };
    };
    const oauth = new mod.google.auth.OAuth2();
    oauth.setCredentials({ access_token: accessToken });
    return mod.google.drive({ version: "v3", auth: oauth });
  };
}

// ---------------------------------------------------------------------------
// GoogleDriveClient
// ---------------------------------------------------------------------------

export interface GoogleDriveClientOptions {
  /** Inject a Drive factory for tests; defaults to the real SDK. */
  driveFactory?: DriveFactory;
  /** Inject a fetch for the resumable-upload session + token endpoint;
   * defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** LRU cap for the path↔fileId cache. Default 512. */
  lruCap?: number;
  /** Test-only hook — override PKCE `code_verifier` generation. Each call
   * MUST return a fresh 64-char base64url string. Production callers
   * omit this; the default derives from `crypto.randomBytes(48)`. Tests
   * inject a capturing factory to inspect the verifier that threaded
   * into the authorize URL + token exchange. */
  codeVerifierFactory?: () => string;
}

export class GoogleDriveClient extends BaseDatasourceClient<"google-drive"> {
  readonly type = "google-drive" as const;

  private creds: GoogleDriveCredsMeta;
  private readonly driveFactory: DriveFactory;
  private readonly fetchImpl: typeof fetch;
  private readonly lruCap: number;
  /** Default verifier generator: 48 random bytes base64url-encoded. */
  private readonly codeVerifierFactory: () => string;

  /** Path → {fileId, ambiguousSiblings?} cache (LRU via insertion-order
   * Map). The value carries `ambiguousSiblings` when the cached path was
   * known ambiguous at the TERMINAL segment, so cache hits re-surface the
   * same ambiguity metadata the initial walk produced — consumers rendering
   * an entry on a cache hit still see the ambiguity badge. */
  private readonly pathHandleCache = new Map<
    string,
    { fileId: string; ambiguousSiblings?: string[] }
  >();

  /** Unsubscribe handle for the bus subscription driving cache invalidation. */
  private readonly unsubscribe: () => void;

  /** Idempotency guard for `dispose()`. */
  private disposed = false;

  constructor(
    init: { datasourceId: string; ctx: BaseClientContext },
    creds: GoogleDriveCredsMeta,
    options: GoogleDriveClientOptions = {},
  ) {
    super(init);
    this.creds = creds;
    this.driveFactory = options.driveFactory ?? createDefaultDriveFactory();
    this.fetchImpl =
      options.fetchImpl ??
      ((globalThis as { fetch: typeof fetch }).fetch).bind(globalThis);
    this.lruCap = options.lruCap ?? 512;
    this.codeVerifierFactory =
      options.codeVerifierFactory ??
      (() => randomBytes(48).toString("base64url"));

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
        if (
          typeof payload.path === "string" &&
          typeof payload.handle === "string"
        ) {
          this.cachePathHandle(payload.path, payload.handle);
        }
      }
    });
  }

  /** Tear down the bus subscription. Idempotent. */
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  // -------------------------------------------------------------------------
  // Cache helpers
  // -------------------------------------------------------------------------

  private cachePathHandle(
    path: string,
    handle: string,
    ambiguousSiblings?: string[],
  ): void {
    this.pathHandleCache.delete(path);
    this.pathHandleCache.set(path, {
      fileId: handle,
      ...(ambiguousSiblings && ambiguousSiblings.length > 0
        ? { ambiguousSiblings }
        : {}),
    });
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
    // Compare on the cached value's fileId — cache values now carry an
    // optional ambiguousSiblings alongside the fileId.
    for (const [k, v] of this.pathHandleCache) {
      if (v.fileId === handle) {
        this.pathHandleCache.delete(k);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Drive client access (rebuilt after token refresh)
  // -------------------------------------------------------------------------

  private drive(): GoogleDriveClientLike {
    return this.driveFactory(this.creds.accessToken);
  }

  // -------------------------------------------------------------------------
  // Path → fileId resolution
  // -------------------------------------------------------------------------
  //
  // `Resolved` = { fileId, ambiguousSiblings? }. The `ambiguousSiblings`
  // field is populated only when the TERMINAL segment's (parent, name)
  // query returned more than one match — that is the entry bound to the
  // returned DatasourceFileEntry. Intermediate-segment ambiguity is silently
  // resolved to "oldest wins" because descending further unambiguously
  // requires picking ONE parent.

  /**
   * Walk a path segment-by-segment, consulting the cache at each step.
   * Returns the fileId of the terminal segment, plus any sibling fileIds
   * at the terminal (parent, name) if the path was ambiguous. A cache hit
   * on the full path short-circuits the walk and re-surfaces the
   * `ambiguousSiblings` stored with the cache entry so consumers rendering
   * from cache still see the ambiguity badge. A mid-walk cache hit on the
   * TERMINAL segment likewise re-surfaces the stored ambiguity.
   */
  private async resolvePath(
    path: string,
  ): Promise<{ fileId: string; ambiguousSiblings?: string[] }> {
    // Root: fileId === "root".
    if (path === "/" || path === "") return { fileId: DRIVE_ROOT_FILE_ID };
    // Full-path cache hit — skip walking, preserve ambiguity.
    const cached = this.pathHandleCache.get(path);
    if (cached !== undefined) {
      // LRU bump on read.
      this.pathHandleCache.delete(path);
      this.pathHandleCache.set(path, cached);
      return {
        fileId: cached.fileId,
        ...(cached.ambiguousSiblings && cached.ambiguousSiblings.length > 0
          ? { ambiguousSiblings: cached.ambiguousSiblings }
          : {}),
      };
    }
    const segments = pathSegments(path);
    let parentId = DRIVE_ROOT_FILE_ID;
    let runningPath = "";
    let terminalSiblings: string[] | undefined;
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i]!;
      runningPath = `${runningPath}/${name}`;
      const cachedStep = this.pathHandleCache.get(runningPath);
      if (cachedStep !== undefined) {
        parentId = cachedStep.fileId;
        const isTerminal = i === segments.length - 1;
        // Only the terminal segment's ambiguity is surfaced. Intermediate
        // segments' ambiguity is silently resolved by the "oldest wins"
        // rule of the initial walk; we clear here so ambiguity carried
        // from a prior step is not inadvertently returned for the leaf.
        terminalSiblings =
          isTerminal && cachedStep.ambiguousSiblings
            ? cachedStep.ambiguousSiblings
            : undefined;
        continue;
      }
      const q = `name='${encodeDriveQuery(name)}' and '${parentId}' in parents and trashed=false`;
      let resp: DriveListResponse;
      try {
        const result = await this.drive().files.list({
          q,
          fields: DEFAULT_LIST_FIELDS,
          // `orderBy: "createdTime asc"` is MANDATORY for deterministic
          // ambiguity resolution — "oldest wins" and siblings list is
          // stable across calls.
          orderBy: "createdTime asc",
          pageSize: 10,
        });
        resp = result.data;
      } catch (err) {
        throw this.normalizeErrorImpl(err);
      }
      const matches = resp.files ?? [];
      if (matches.length === 0) {
        throw new DatasourceError<"google-drive">({
          tag: "not-found",
          datasourceType: "google-drive",
          datasourceId: this.datasourceId,
          retryable: false,
          raw: `path-not-found:${runningPath}`,
          message: `Path segment not found: ${runningPath}`,
        });
      }
      const chosen = matches[0]!;
      const chosenId = chosen.id;
      if (!chosenId) {
        throw new DatasourceError<"google-drive">({
          tag: "provider-error",
          datasourceType: "google-drive",
          datasourceId: this.datasourceId,
          retryable: false,
          raw: `list-missing-id:${runningPath}`,
          message: `Drive files.list response missing id for ${runningPath}`,
        });
      }
      parentId = chosenId;
      // Only carry ambiguity from the TERMINAL segment's resolution.
      const isTerminal = i === segments.length - 1;
      if (isTerminal && matches.length > 1) {
        terminalSiblings = matches
          .slice(1)
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0);
      } else {
        terminalSiblings = undefined;
      }
      // Cache the step, carrying the terminal-segment siblings alongside
      // the fileId so a subsequent cache hit re-surfaces the ambiguity.
      this.cachePathHandle(
        runningPath,
        chosenId,
        isTerminal ? terminalSiblings : undefined,
      );
    }
    return {
      fileId: parentId,
      ...(terminalSiblings ? { ambiguousSiblings: terminalSiblings } : {}),
    };
  }

  /**
   * Resolve a `Target` to `{fileId, ambiguousSiblings?}`. Handle-form
   * targets pass through unchanged (no ambiguity to surface).
   */
  private async resolveTarget(
    target: Target,
  ): Promise<{ fileId: string; ambiguousSiblings?: string[] }> {
    if (target.kind === "handle") return { fileId: target.handle };
    return this.resolvePath(target.path);
  }

  // -------------------------------------------------------------------------
  // Build DatasourceFileEntry / FileMetadata
  // -------------------------------------------------------------------------

  /**
   * Map a Drive `files.list` / `files.get` response to a `DatasourceFileEntry`. The
   * caller supplies the engine path (since Drive responses don't carry it
   * verbatim) plus optional ambiguity siblings. `parentPath` is joined
   * with `file.name` when `path` is not supplied.
   */
  private buildFileEntry(
    file: DriveFile,
    opts: { path: string; ambiguousSiblings?: string[] },
  ): DatasourceFileEntry<"google-drive"> {
    const id = file.id ?? "";
    const name = file.name ?? "";
    const folder = isFolder(file);
    const kind: "file" | "folder" = folder ? "folder" : "file";
    const mimeFamily: DatasourceMimeFamily = folder
      ? "folder"
      : mimeFamilyFromMime(file.mimeType);
    const modifiedAt = file.modifiedTime
      ? new Date(file.modifiedTime).getTime()
      : 0;
    const size = folder ? undefined : parseSize(file.size);
    const providerMetadata: ProviderMetadata<"google-drive"> = {
      fileId: id,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      ...(file.parents ? { parents: file.parents } : {}),
      ...(opts.ambiguousSiblings && opts.ambiguousSiblings.length > 0
        ? {
            ambiguous: true as const,
            ambiguousSiblings: opts.ambiguousSiblings,
          }
        : {}),
    };
    const entry: DatasourceFileEntry<"google-drive"> = {
      path: opts.path,
      handle: id,
      name,
      kind,
      ...(typeof size === "number" ? { size } : {}),
      modifiedAt,
      mimeFamily,
      providerMetadata,
    };
    return entry;
  }

  // -------------------------------------------------------------------------
  // Status / connection
  // -------------------------------------------------------------------------

  /** Verifies the issued grant contains REQUIRED_DRIVE_SCOPE.
   *
   * When `meta.scope` is undefined (legacy credential that pre-dates Work Unit
   * D's scope-capture), issues a single `tokeninfo` request to backfill the
   * scope, updates the in-memory credential, and persists it best-effort via
   * the credential store. After the scope is known, evaluates sufficiency. */
  private async checkScopeSufficiency(): Promise<void> {
    let scope = this.creds.scope;
    if (scope === undefined) {
      scope = await this.fetchTokenScope();
      this.creds = { ...this.creds, scope };
      await this.persistScope(scope);
    }
    if (!isScopeSufficient(scope)) {
      throw new DatasourceError<"google-drive">({
        tag: "auth-revoked",
        retryable: false,
        datasourceType: "google-drive",
        datasourceId: this.datasourceId,
        raw: { kind: "scope-insufficient", requiredScope: REQUIRED_DRIVE_SCOPE, actualScope: scope },
        message: "Drive permissions are too narrow — reconnect with full access to see your existing files.",
      });
    }
  }

  /** Calls Google's tokeninfo endpoint to discover the scope of the current
   * access token. Used only for legacy credentials that pre-date scope
   * capture (Work Unit E backfill). */
  private async fetchTokenScope(): Promise<string> {
    const url = `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(this.creds.accessToken)}`;
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, { method: "GET" });
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    const text = await resp.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw this.normalizeErrorImpl({
        message: "non-json tokeninfo response",
        status: resp.status,
      });
    }
    if (!resp.ok) {
      throw this.normalizeErrorImpl({
        code: typeof parsed.error === "string" ? parsed.error : "tokeninfo-error",
        status: resp.status,
        message: typeof parsed.error_description === "string" ? parsed.error_description : undefined,
      });
    }
    const scope = parsed.scope;
    if (typeof scope !== "string") {
      throw this.normalizeErrorImpl({
        message: "tokeninfo-response-missing-scope",
        status: resp.status,
      });
    }
    return scope;
  }

  /** Persists a backfilled scope onto the stored credential via read-modify-write.
   * Errors are swallowed — the in-memory value is already set and is good for
   * the lifetime of this process; the worst case is another tokeninfo round-trip
   * on next process start. */
  private async persistScope(scope: string): Promise<void> {
    try {
      const current = await this.ctx.credentialStore.get(this.datasourceId);
      if (current === null) return; // nothing to write back; in-memory creds are still good
      const updated: StoredCredentials = {
        ...current,
        authResult: {
          ...current.authResult,
          meta: {
            ...(current.authResult.meta ?? {}),
            scope,
          },
        },
      };
      await this.ctx.credentialStore.put(this.datasourceId, updated);
    } catch {
      // Swallow — the in-memory value is still good; the worst case is another
      // tokeninfo round-trip on next process start.
    }
  }

  protected override async doStatusImpl(): Promise<DatasourceStatus> {
    await this.checkScopeSufficiency();
    await this.drive().about.get({ fields: "storageQuota" });
    return "connected";
  }

  protected override async doTestConnectionImpl(): Promise<void> {
    await this.checkScopeSufficiency();
    await this.drive().about.get({ fields: "storageQuota" });
  }

  // -------------------------------------------------------------------------
  // authenticate — OAuth intent
  // -------------------------------------------------------------------------

  protected override async doAuthenticateImpl(): Promise<AuthIntent> {
    const { clientId, redirectUri } = this.creds;
    // PKCE (RFC 7636, S256). Generate a fresh `code_verifier` per consent
    // attempt — 48 random bytes base64url-encoded → 64 URL-safe characters
    // — and a matching `code_challenge = base64url(SHA256(verifier))`. The
    // challenge goes on the authorize URL; the verifier is captured in the
    // `completeWith` closure below and threaded into the token exchange.
    // The verifier is NEVER stored on `this` (no instance field), never
    // persisted via `CredentialStore`, and never logged.
    const codeVerifier = this.codeVerifierFactory();
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: OAUTH_SCOPE,
      // `access_type=offline` is required to receive a refresh token.
      access_type: "offline",
      // Force re-consent so a re-auth always returns a refresh token.
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    const authorizeUrl = `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
    const intent: OAuthIntent = {
      kind: "oauth",
      authorizeUrl,
      completeWith: async (code: string): Promise<AuthResult> => {
        // Closure captures `codeVerifier` — lives only for the duration
        // of this authenticate() attempt. No instance-field write.
        return this.exchangeCodeForTokens(code, codeVerifier);
      },
    };
    return intent;
  }

  private async exchangeCodeForTokens(
    code: string,
    codeVerifier: string,
  ): Promise<AuthResult> {
    const { clientId, clientSecret, redirectUri } = this.creds;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    let resp: Response;
    try {
      resp = await this.fetchImpl(OAUTH_TOKEN_URL, {
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
        status: resp.status,
      });
    }
    if (!resp.ok) {
      throw this.normalizeErrorImpl({
        // Google returns `error: "invalid_grant"` for revoked tokens.
        code: typeof parsed.error === "string" ? parsed.error : "provider-error",
        status: resp.status,
        message:
          typeof parsed.error_description === "string"
            ? parsed.error_description
            : undefined,
      });
    }
    const accessToken = parsed.access_token;
    const refreshToken = parsed.refresh_token;
    const expiresIn = parsed.expires_in;
    const issuedScope = parsed.scope;
    if (typeof accessToken !== "string") {
      throw this.normalizeErrorImpl({
        message: "token-response-missing-access_token",
        status: resp.status,
      });
    }
    const meta: Record<string, unknown> = {
      clientId: this.creds.clientId,
      clientSecret: this.creds.clientSecret,
      redirectUri: this.creds.redirectUri,
    };
    if (typeof issuedScope === "string") {
      meta.scope = issuedScope;
    }
    const result: AuthResult = {
      accessToken,
      meta,
    };
    if (typeof refreshToken === "string") {
      result.refreshToken = refreshToken;
    }
    if (typeof expiresIn === "number") {
      result.expiresAt = Date.now() + expiresIn * 1000;
    }
    this.creds = {
      ...this.creds,
      accessToken,
      ...(typeof refreshToken === "string" ? { refreshToken } : {}),
      ...(typeof issuedScope === "string" ? { scope: issuedScope } : {}),
    };
    return result;
  }

  // -------------------------------------------------------------------------
  // listDirectory
  // -------------------------------------------------------------------------

  protected override async doListDirectoryImpl(
    target: Target,
  ): Promise<DatasourceFileEntry<"google-drive">[]> {
    const { fileId } = await this.resolveTarget(target);
    // Compute the engine path we'll prefix children with. For path-targets
    // the prefix is the path itself; for handle-targets we don't have a
    // path, so children get a synthesized path of `/<name>`. Callers that
    // need absolute paths should have resolved via path in the first
    // place — handle-form listing is for tools that operate on fileIds.
    //
    // The synthesized `/<name>` path on children returned from a
    // handle-form listing is NOT guaranteed to be re-addressable via
    // `{kind: "path"}`; callers MUST re-address via the child entry's
    // `handle`. See the class header's "Synthesized paths" note.
    const pathPrefix =
      target.kind === "path" ? (target.path === "/" ? "" : target.path) : "";
    const q = `'${fileId}' in parents and trashed=false`;
    let resp: DriveListResponse;
    try {
      const result = await this.drive().files.list({
        q,
        fields: DEFAULT_LIST_FIELDS,
        orderBy: "folder,name",
        pageSize: 1000,
      });
      resp = result.data;
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    const entries: DatasourceFileEntry<"google-drive">[] = [];
    for (const file of resp.files ?? []) {
      const name = file.name ?? "";
      const childPath = `${pathPrefix}/${name}`;
      const entry = this.buildFileEntry(file, { path: childPath });
      entries.push(entry);
      if (entry.handle) this.cachePathHandle(entry.path, entry.handle);
    }
    return entries;
  }

  // -------------------------------------------------------------------------
  // search — Drive query: `name contains '<q>'`
  // -------------------------------------------------------------------------

  protected override async doSearchImpl(
    query: string,
    scope?: Target,
  ): Promise<DatasourceFileEntry<"google-drive">[]> {
    const parts: string[] = [];
    parts.push(`name contains '${encodeDriveQuery(query)}'`);
    parts.push("trashed=false");
    if (scope) {
      const { fileId } = await this.resolveTarget(scope);
      parts.push(`'${fileId}' in parents`);
    }
    const q = parts.join(" and ");
    let resp: DriveListResponse;
    try {
      const result = await this.drive().files.list({
        q,
        fields: DEFAULT_LIST_FIELDS,
        pageSize: 100,
      });
      resp = result.data;
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    const out: DatasourceFileEntry<"google-drive">[] = [];
    for (const file of resp.files ?? []) {
      const name = file.name ?? "";
      // Search results don't carry a known path prefix; synthesize one
      // from `/<name>` so callers still get an engine path. Recovering a
      // full path from a fileId requires walking parents — not done here
      // to avoid the extra round-trip on search.
      //
      // The synthesized `/<name>` path is NOT guaranteed to be
      // re-addressable via `{kind: "path"}` — a file with that name may
      // not exist at root, OR a DIFFERENT root-level file with that name
      // may exist. Callers MUST re-address via the returned entry's
      // `handle`. See the class header's "Synthesized paths" note.
      out.push(this.buildFileEntry(file, { path: `/${name}` }));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // getMetadata
  // -------------------------------------------------------------------------

  protected override async doGetMetadataImpl(
    target: Target,
  ): Promise<FileMetadata<"google-drive">> {
    const { fileId, ambiguousSiblings } = await this.resolveTarget(target);
    let file: DriveFile;
    try {
      const result = await this.drive().files.get({
        fileId,
        fields: DEFAULT_FILE_FIELDS,
      });
      file = result.data;
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    const resolvedPath =
      target.kind === "path" ? target.path : `/${file.name ?? fileId}`;
    const entry = this.buildFileEntry(file, {
      path: resolvedPath,
      ...(ambiguousSiblings ? { ambiguousSiblings } : {}),
    });
    if (entry.handle) {
      // Persist the terminal-segment ambiguity alongside the fileId so the
      // next cache hit re-surfaces it.
      this.cachePathHandle(entry.path, entry.handle, ambiguousSiblings);
    }
    return entry;
  }

  // -------------------------------------------------------------------------
  // createFile — resumable-session path (covers any size via one path)
  // -------------------------------------------------------------------------

  protected override async doCreateFileImpl(
    parent: Target,
    name: string,
    content: { path: string },
  ): Promise<DatasourceFileEntry<"google-drive">> {
    // `createFile` is not exposed as cancellable — it's a metadata-adjacent
    // op, not a user-visible upload. Supply a no-op register + a
    // never-aborted signal so `uploadResumable` can share the same
    // codepath as `doUploadFileImpl` without also flowing cancel plumbing
    // into the createFile surface.
    const noopRegister = (cancel: () => Promise<void>): void => {
      void cancel;
    };
    const neverAborted = new AbortController().signal;
    return this.uploadResumable(
      parent,
      name,
      content,
      undefined,
      undefined,
      noopRegister,
      neverAborted,
    );
  }

  // -------------------------------------------------------------------------
  // uploadFile — resumable session via raw fetch (streaming)
  // -------------------------------------------------------------------------

  protected override async doUploadFileImpl(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    onProgress: ((loaded: number, total: number) => void) | undefined,
    register: (cancel: () => Promise<void>) => void,
    signal: AbortSignal,
  ): Promise<DatasourceFileEntry<"google-drive">> {
    const name = file.name ?? basename(file.path);
    return this.uploadResumable(
      parent,
      name,
      file,
      onProgress,
      file.mimeType,
      register,
      signal,
    );
  }

  /**
   * Drive resumable upload via raw fetch. One path covers any file size
   * (session-init POST → chunked PUTs to the session URL). Streams from
   * disk — never buffers the full file.
   */
  private async uploadResumable(
    parent: Target,
    name: string,
    file: { path: string; mimeType?: string },
    onProgress: ((loaded: number, total: number) => void) | undefined,
    mimeType: string | undefined,
    register: (cancel: () => Promise<void>) => void,
    signal: AbortSignal,
  ): Promise<DatasourceFileEntry<"google-drive">> {
    const { fileId: parentFileId } = await this.resolveTarget(parent);
    let total = 0;
    try {
      total = statSync(file.path).size;
    } catch {
      total = 0;
    }

    // Step 1: initiate a resumable session. POST to the upload endpoint
    // with the file metadata in the body; Drive returns a session URL in
    // the `Location` response header.
    const sessionBody = JSON.stringify({
      name,
      parents: [parentFileId],
      ...(mimeType ? { mimeType } : {}),
    });
    let sessionResp: Response;
    try {
      sessionResp = await this.fetchImpl(DRIVE_UPLOAD_SESSION_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.creds.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mimeType ?? "application/octet-stream",
          ...(total > 0 ? { "X-Upload-Content-Length": String(total) } : {}),
        },
        body: sessionBody,
      });
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    if (!sessionResp.ok) {
      const text = await sessionResp.text().catch(() => "");
      throw this.normalizeErrorImpl({
        status: sessionResp.status,
        message: text || `create-upload-session-failed (${sessionResp.status})`,
      });
    }
    const sessionUrl = sessionResp.headers.get("Location");
    if (!sessionUrl) {
      throw this.normalizeErrorImpl({
        status: 500,
        message: "create-upload-session-missing-Location",
      });
    }

    // Register the provider-native cancel closure. Drive documents that a
    // DELETE to the session URL cancels the resumable session; the DELETE
    // MUST carry a `Content-Range: bytes */<total>` header (or `*/0` when
    // total is unknown) to match Drive's documented cancellation semantics.
    // Errors are swallowed by the base — best-effort cleanup.
    const cancelContentRange =
      total > 0 ? `bytes */${total}` : `bytes */0`;
    register(async () => {
      await this.fetchImpl(sessionUrl, {
        method: "DELETE",
        headers: { "Content-Range": cancelContentRange },
      });
    });

    // Step 2: stream the file in chunks, PUT each to the session URL.
    onProgress?.(0, total);
    const stream = createReadStream(file.path, {
      highWaterMark: UPLOAD_CHUNK_BYTES,
    });
    let uploaded = 0;
    let lastFile: DriveFile | null = null;
    let pending: Buffer = Buffer.alloc(0);

    const emitChunk = async (chunk: Buffer, isLast: boolean): Promise<void> => {
      const start = uploaded;
      const end = uploaded + chunk.length - 1;
      const totalHeader = total > 0 ? String(total) : "*";
      const headers: Record<string, string> = {
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${start}-${end}/${totalHeader}`,
      };
      // Thread the abort signal into each chunk PUT so the base's
      // `cancelUpload` unblocks promptly. An already-aborted signal makes
      // fetch reject synchronously with AbortError.
      const resp = await this.fetchImpl(sessionUrl, {
        method: "PUT",
        headers,
        body: chunk,
        signal,
      });
      // Drive returns 308 Resume Incomplete for interim chunks (body
      // typically empty, `Range` header shows bytes received); 200/201
      // with the file JSON for the final chunk.
      if (!resp.ok && resp.status !== 308) {
        const text = await resp.text().catch(() => "");
        throw this.normalizeErrorImpl({
          status: resp.status,
          message: text || `upload-chunk-failed (${resp.status})`,
        });
      }
      uploaded += chunk.length;
      onProgress?.(uploaded, total);
      if (isLast && resp.status !== 308) {
        const text = await resp.text();
        if (text) {
          try {
            lastFile = JSON.parse(text) as DriveFile;
          } catch {
            // Ignore — ambiguous, will fall through to the safety net.
          }
        }
      }
    };

    if (total === 0) {
      // Zero-byte file: emit a single empty-body chunk with
      // `Content-Range: bytes */0`.
      const headers: Record<string, string> = {
        "Content-Length": "0",
        "Content-Range": `bytes */0`,
      };
      const resp = await this.fetchImpl(sessionUrl, {
        method: "PUT",
        headers,
        body: new Uint8Array(0),
        signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw this.normalizeErrorImpl({
          status: resp.status,
          message: text || `upload-empty-failed (${resp.status})`,
        });
      }
      const text = await resp.text();
      if (text) {
        try {
          lastFile = JSON.parse(text) as DriveFile;
        } catch {
          /* fall through */
        }
      }
    } else {
      for await (const piece of stream as AsyncIterable<Buffer>) {
        pending =
          pending.length === 0 ? piece : Buffer.concat([pending, piece]);
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
    }

    if (!lastFile) {
      // Safety net: re-fetch via the SDK if the resumable session's final
      // response didn't carry the metadata (some proxies strip the body).
      // We don't know the fileId without the response, so this path
      // realistically throws.
      throw this.normalizeErrorImpl({
        status: 500,
        message: "upload-succeeded-but-response-missing-file-metadata",
      });
    }
    // Path of the uploaded entry. For path-targets we can compute it;
    // for handle-targets we synthesize `/<name>` (same as search).
    const parentPath = parent.kind === "path" ? parent.path : "";
    const entryPath =
      parentPath === "" || parentPath === "/"
        ? `/${name}`
        : `${parentPath}/${name}`;
    return this.buildFileEntry(lastFile, { path: entryPath });
  }

  // -------------------------------------------------------------------------
  // deleteFile — DELETE by fileId
  // -------------------------------------------------------------------------

  protected override async doDeleteFileImpl(target: Target): Promise<void> {
    const { fileId, ambiguousSiblings } = await this.resolveTarget(target);
    // Mutation-on-ambiguous-path guard. If the caller addressed via path
    // AND the path resolved to multiple Drive files at the same
    // (parent, name), refuse to silently pick the oldest — that would be a
    // data-loss trap. Handle-form targets explicitly name one fileId so
    // they bypass the guard.
    if (
      target.kind === "path" &&
      ambiguousSiblings &&
      ambiguousSiblings.length > 0
    ) {
      throw new DatasourceError<"google-drive">({
        tag: "conflict",
        datasourceType: "google-drive",
        datasourceId: this.datasourceId,
        retryable: false,
        raw: { ambiguousSiblings: [fileId, ...ambiguousSiblings] },
        message:
          "Ambiguous path — multiple files at this path. Re-address via handle.",
      });
    }
    try {
      await this.drive().files.delete({ fileId });
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
  }

  // -------------------------------------------------------------------------
  // getQuota — about.get({fields: "storageQuota"})
  // -------------------------------------------------------------------------

  protected override async doGetQuotaImpl(): Promise<Quota> {
    let data: DriveAboutResponse;
    try {
      const result = await this.drive().about.get({ fields: "storageQuota" });
      data = result.data;
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    const limit = parseSize(data.storageQuota?.limit) ?? 0;
    const usage = parseSize(data.storageQuota?.usage) ?? 0;
    return { used: usage, quota: limit };
  }

  // -------------------------------------------------------------------------
  // refreshToken — POST grant_type=refresh_token
  // -------------------------------------------------------------------------

  protected override async refreshTokenImpl(): Promise<AuthResult> {
    const { clientId, clientSecret, refreshToken } = this.creds;
    if (!refreshToken) {
      throw new DatasourceError<"google-drive">({
        tag: "auth-revoked",
        datasourceType: "google-drive",
        datasourceId: this.datasourceId,
        retryable: false,
        raw: "google-drive-no-refresh-token",
        message:
          "No refresh token stored — interactive re-authentication required",
      });
    }
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    let resp: Response;
    try {
      resp = await this.fetchImpl(OAUTH_TOKEN_URL, {
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
  // normalizeError — map Drive errors to the 8-tag taxonomy
  // -------------------------------------------------------------------------

  protected override normalizeErrorImpl(
    raw: unknown,
  ): DatasourceError<"google-drive"> {
    if (raw instanceof DatasourceError) {
      return raw as DatasourceError<"google-drive">;
    }
    const r = (raw ?? {}) as {
      name?: string;
      code?: string | number;
      message?: string;
      status?: number;
      statusCode?: number;
      response?: {
        status?: number;
        headers?: Record<string, string>;
        data?: {
          error?: {
            code?: number;
            message?: string;
            errors?: Array<{ reason?: string; message?: string }>;
          };
        };
      };
    };
    const status =
      r.response?.status ?? r.status ?? r.statusCode ?? 0;
    const headers = r.response?.headers ?? {};
    const reason =
      r.response?.data?.error?.errors?.[0]?.reason ?? "";
    const innerMessage = r.response?.data?.error?.message;
    const topMessage = r.message ?? innerMessage;
    const name = r.name ?? "";
    const sysCode = typeof r.code === "string" ? r.code : "";

    const mk = (
      tag: DatasourceError<"google-drive">["tag"],
      retryable: boolean,
      extra: { retryAfterMs?: number; message?: string } = {},
    ): DatasourceError<"google-drive"> =>
      new DatasourceError<"google-drive">({
        tag,
        datasourceType: "google-drive",
        datasourceId: this.datasourceId,
        retryable,
        raw,
        ...(extra.retryAfterMs !== undefined
          ? { retryAfterMs: extra.retryAfterMs }
          : {}),
        ...(extra.message
          ? { message: extra.message }
          : topMessage
            ? { message: topMessage }
            : {}),
      });

    const retryAfterMs = ((): number | undefined => {
      const h = headers["retry-after"] ?? headers["Retry-After"];
      if (!h) return undefined;
      const n = Number.parseInt(h, 10);
      if (Number.isNaN(n)) return undefined;
      return n * 1000;
    })();

    // OAuth hard-fail from the token endpoint (invalid_grant /
    // unauthorized_client surface via `code` on the synthesized object the
    // token-parser builds). invalid_token surfaces from the tokeninfo endpoint
    // when the access token has been revoked or expired beyond refresh.
    if (
      sysCode === "invalid_grant" ||
      sysCode === "unauthorized_client" ||
      sysCode === "invalid_token"
    ) {
      return mk("auth-revoked", false);
    }

    // Network / Node system errors. Check BEFORE status-based branches —
    // a network error has no `response` so `status` is 0.
    if (
      sysCode === "ECONNRESET" ||
      sysCode === "ETIMEDOUT" ||
      sysCode === "ENOTFOUND" ||
      sysCode === "EPIPE" ||
      name === "FetchError"
    ) {
      return mk("network-error", true);
    }

    // 401 → auth-expired (refreshable).
    if (status === 401) {
      return mk("auth-expired", false);
    }

    // 403 — branch on Drive's inner `reason`.
    if (status === 403) {
      if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
        return mk("rate-limited", true, {
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
      }
      if (reason === "authError" || reason === "invalidCredentials") {
        return mk("auth-revoked", false);
      }
      // domainPolicy / dailyLimitExceeded / quotaExceeded /
      // insufficientFilePermissions / (anything else) → provider-error
      // non-retryable. `quotaExceeded` is consistent with the OneDrive
      // Phase 7 decision: the 8-tag taxonomy has no quota slot.
      return mk("provider-error", false);
    }

    if (status === 404) {
      return mk("not-found", false);
    }
    if (status === 409) {
      return mk("conflict", false);
    }
    if (status === 429) {
      return mk("rate-limited", true, {
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    if (status >= 500 && status < 600) {
      if (reason === "serviceUnavailable" || status === 503) {
        return mk("rate-limited", true, {
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
      }
      return mk("provider-error", false);
    }

    return mk("provider-error", false);
  }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Construct a `GoogleDriveClient` with optional test injection. Production
 * callers omit `options` and get the real SDK.
 */
export function createGoogleDriveClient(
  datasourceId: string,
  credentials: StoredCredentials,
  ctx: BaseClientContext,
  options?: GoogleDriveClientOptions,
): GoogleDriveClient {
  const creds = readCredsFromStored(credentials);
  return new GoogleDriveClient({ datasourceId, ctx }, creds, options);
}

/** Canonical `ProviderFactoryFn` entry for the registry. */
export const createGoogleDriveClientForRegistry: ProviderFactoryFn<"google-drive"> =
  (datasourceId, credentials, ctx) => {
    return createGoogleDriveClient(datasourceId, credentials, ctx);
  };

/**
 * Per-provider credential-shape validator (per
 * add-invalid-datasource-state Decision 2 + spec scenario "Wrong-shape
 * credential throws InvalidDatasource"). Wired into the registry entry by
 * `createDefaultProviderRegistry` and invoked by `factory.create` BEFORE
 * the strategy factory runs. Throws `DatasourceError({ tag:
 * "invalid-datasource", retryable: false, message: "google-drive
 * credential is missing <field>" })` on the first missing/invalid field;
 * returns `void` on success.
 */
export const validateGoogleDriveCredentialShape: CredentialShapeValidator = (
  credentials,
  datasourceId,
) => {
  const authResult = (credentials as { authResult?: unknown }).authResult;
  if (
    authResult === null ||
    typeof authResult !== "object"
  ) {
    throw new DatasourceError<"google-drive">({
      tag: DatasourceErrorTag.InvalidDatasource,
      datasourceType: "google-drive",
      datasourceId,
      retryable: false,
      raw: "google-drive-missing-authResult",
      message: "google-drive credential is missing authResult",
    });
  }
  const ar = authResult as Record<string, unknown>;
  if (typeof ar.accessToken !== "string" || ar.accessToken.length === 0) {
    throw new DatasourceError<"google-drive">({
      tag: DatasourceErrorTag.InvalidDatasource,
      datasourceType: "google-drive",
      datasourceId,
      retryable: false,
      raw: "google-drive-missing-accessToken",
      message: "google-drive credential is missing accessToken",
    });
  }
  const meta = (ar.meta ?? {}) as Record<string, unknown>;
  for (const field of ["clientId", "clientSecret", "redirectUri"] as const) {
    if (typeof meta[field] !== "string" || (meta[field] as string).length === 0) {
      throw new DatasourceError<"google-drive">({
        tag: DatasourceErrorTag.InvalidDatasource,
        datasourceType: "google-drive",
        datasourceId,
        retryable: false,
        raw: `google-drive-missing-${field}`,
        message: `google-drive credential is missing ${field}`,
      });
    }
  }
};
