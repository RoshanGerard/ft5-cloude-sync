// S3Client — concrete datasource strategy for Amazon S3.
//
// Extends `BaseDatasourceClient<"amazon-s3">` and wires every `doX` primitive
// against `@aws-sdk/client-s3` (+ `@aws-sdk/lib-storage` for streaming upload).
// The base class handles event emission, retry-on-auth-expired, error
// normalization, and the capability gate for `getQuota`.
//
// Key design notes for this strategy (see design.md Decisions 1, 2, 3, 9; and
// the Phase 6 spec notes in tasks.md / change proposal):
//
//   - Credentials storage shape. Static AWS keys (accessKeyId / secret /
//     region / bucket, plus optional sessionToken) do not fit the OAuth-style
//     `AuthResult.accessToken`. We use `AuthResult.meta` as the authoritative
//     store: `accessToken` is an empty placeholder, the real data lives in
//     `meta`. `authenticate()` returns a credentials-form intent whose
//     `submit(values)` validates shape, calls `HeadBucket` to verify, and
//     returns the AuthResult; the base's `decorateIntent` then persists via
//     `CredentialStore.put`.
//
//   - Path ↔ S3 Key mapping. Engine paths carry a leading slash for UI
//     friendliness; S3 keys do not. `/` maps to the bucket root (`""`);
//     `/photos/2024/img.jpg` maps to `photos/2024/img.jpg`. Folders list with
//     a trailing-slash prefix and `Delimiter: "/"` so `CommonPrefixes` carries
//     the child folders and `Contents` carries the child files. `DatasourceFileEntry.handle`
//     for S3 is the S3 key itself (post-strip), so callers that pass a `handle`
//     Target in a later call skip the strip.
//
//   - `normalizeError`. Most auth errors (403, AccessDenied, InvalidAccessKeyId,
//     SignatureDoesNotMatch) are tagged `auth-revoked`, NOT `auth-expired`.
//     Static keys cannot refresh, so no credential-refresh ever needs to
//     fire for those. (Post migrate-engine-retry-policy-to-consumer the
//     engine no longer auto-refreshes; fs-sync's `withAuthRefresh` ->
//     `refreshCredentials()` owns refresh, and it triggers only on
//     `auth-expired`.) Routing to `auth-revoked` short-circuits the
//     consumer's refresh-and-retry entirely — the defensive
//     `refreshTokenImpl` throw is a safety net that will (by this design)
//     never actually fire for the static-key case.
//
//     ExpiredToken is the exception: it manifests for STS temporary
//     credentials (which carry a `sessionToken` and have a finite TTL). The
//     strategy itself still cannot refresh those tokens (no refresh-grant
//     mechanism is wired here), but mid-stream the error is surfaced as
//     `auth-expired` so fs-sync's download retry loop (add-engine-rename-
//     download Decision 3) can drive its refresh-and-retry cycle — fs-sync
//     calls `refreshCredentials()` then re-issues (per
//     migrate-engine-retry-policy-to-consumer). Per
//     `add-engine-rename-download` §9.18: `ExpiredToken` → `tag:
//     auth-expired`. `refreshTokenImpl` still throws `auth-revoked` to halt
//     the loop if it fires anyway.
//
//   - `deleteDirectory` and `getQuota` are both unsupported (base's
//     `deleteDirectory` always throws; `getQuota` throws via the descriptor
//     `capabilities.quota === false` gate before our impl would run).

import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { Readable, Transform } from "node:stream";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client as AwsS3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type {
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  DatasourceStatus,
  DatasourceFileEntry,
  FileMetadata,
  DatasourceMimeFamily,
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
// Pagination bounds
// ---------------------------------------------------------------------------

// `MaxKeys` bounds for `doListDirectoryImpl` (add-engine-listdirectory-
// pagination Decision 3). S3's `MaxKeys` ceiling is 1000; we also use 1000 as
// the default when the caller omits `pageSize` (the prior do/while loop
// effectively fetched 1000 per provider page). The floor is 1 so a degenerate
// `0` / negative request still returns at least one entry.
const S3_LIST_MAX_KEYS_MAX = 1000;
const S3_LIST_MAX_KEYS_DEFAULT = 1000;

/** Clamp a requested page size to S3's `MaxKeys` `[1, 1000]` range, defaulting
 * to 1000 when omitted. */
function clampS3PageSize(requested: number | undefined): number {
  if (requested === undefined) return S3_LIST_MAX_KEYS_DEFAULT;
  return Math.min(Math.max(Math.trunc(requested), 1), S3_LIST_MAX_KEYS_MAX);
}

// ---------------------------------------------------------------------------
// Path ↔ Key utilities
// ---------------------------------------------------------------------------

/**
 * Strip a leading slash and return the resulting S3 key. The engine uses
 * `/`-prefixed paths for UI friendliness; S3 keys have no leading slash.
 * `"/"` (root) maps to `""`.
 */
export function pathToKey(path: string): string {
  if (path === "" || path === "/") return "";
  return path.startsWith("/") ? path.slice(1) : path;
}

/** Inverse of `pathToKey`: prefix with `/` and return the engine path. An
 * empty key (bucket root) becomes `"/"`.
 */
export function keyToPath(key: string): string {
  if (key === "") return "/";
  return key.startsWith("/") ? key : `/${key}`;
}

/** Resolve a `Target` to an S3 key (strips leading slash if path-form). */
function targetToKey(target: Target): string {
  if (target.kind === "path") return pathToKey(target.path);
  return target.handle;
}

/**
 * Split a filename into `{ base, ext }` for the `keep-both` suffix loop.
 * Mirrors the same helper in `googledrive-client.ts` (kept local because the
 * §9 implementation must not touch other strategy files). `foo.pdf` →
 * `{base:"foo", ext:".pdf"}` → candidate `foo-2.pdf`. Extensionless names
 * like `Makefile` → `{base:"Makefile", ext:""}`. Hidden files like
 * `.gitignore` (leading dot, no other dots) are treated as extensionless to
 * avoid `{base:"", ext:".gitignore"}`.
 */
function splitNameForSuffix(name: string): { base: string; ext: string } {
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dotIdx), ext: name.slice(dotIdx) };
}

/**
 * Parse an S3 `Content-Range` response field (RFC 7233 `bytes <start>-<end>/<total>`)
 * into the engine's `{ start, end, total }` shape. Returns `undefined` for
 * unparseable input. Matches the convention used by the Drive / OneDrive
 * strategies' `parseContentRangeHeader`; kept local to avoid cross-strategy
 * imports.
 */
function parseContentRangeFromS3(
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

/** MIME family inference. S3 does not return a mime type on list/head in
 * general — we infer from the extension. Kept deliberately narrow; consumers
 * that need a precise mime can read from the `providerMetadata` on a
 * `HeadObject` (future enhancement) or from the full extension map.
 */
function mimeFamilyForKey(key: string): DatasourceMimeFamily {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  if (
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "gif" ||
    ext === "webp" ||
    ext === "svg" ||
    ext === "bmp"
  ) {
    return "image";
  }
  if (ext === "mp4" || ext === "mov" || ext === "mkv" || ext === "webm") {
    return "video";
  }
  if (ext === "mp3" || ext === "wav" || ext === "ogg" || ext === "flac") {
    return "audio";
  }
  if (
    ext === "zip" ||
    ext === "tar" ||
    ext === "gz" ||
    ext === "7z" ||
    ext === "rar"
  ) {
    return "archive";
  }
  if (
    ext === "ts" ||
    ext === "js" ||
    ext === "tsx" ||
    ext === "jsx" ||
    ext === "py" ||
    ext === "rs" ||
    ext === "go" ||
    ext === "c" ||
    ext === "h"
  ) {
    return "code";
  }
  if (
    ext === "pdf" ||
    ext === "doc" ||
    ext === "docx" ||
    ext === "txt" ||
    ext === "md" ||
    ext === "rtf"
  ) {
    return "document";
  }
  return "other";
}

/** Build a base DatasourceFileEntry from an S3 key + optional list/head fields. */
function buildFileEntry(
  bucket: string,
  key: string,
  opts: {
    size?: number;
    lastModified?: Date;
    etag?: string;
    storageClass?: string;
    versionId?: string;
  } = {},
): DatasourceFileEntry<"amazon-s3"> {
  const name = basename(key);
  const providerMetadata: ProviderMetadata<"amazon-s3"> = {
    bucket,
    key,
    ...(opts.etag !== undefined ? { etag: opts.etag } : {}),
    ...(opts.storageClass !== undefined ? { storageClass: opts.storageClass } : {}),
    ...(opts.versionId !== undefined ? { versionId: opts.versionId } : {}),
  };
  return {
    path: keyToPath(key),
    handle: key,
    name,
    kind: "file",
    ...(opts.size !== undefined ? { size: opts.size } : {}),
    modifiedAt: opts.lastModified ? opts.lastModified.getTime() : 0,
    mimeFamily: mimeFamilyForKey(key),
    providerMetadata,
  };
}

/** Build a folder DatasourceFileEntry from a `CommonPrefixes` entry. */
function buildFolderEntry(
  bucket: string,
  prefix: string,
): DatasourceFileEntry<"amazon-s3"> {
  // Normalise: CommonPrefixes carry a trailing slash; strip for display name.
  const normalised = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const name = basename(normalised);
  return {
    path: keyToPath(normalised),
    handle: prefix, // preserve the trailing slash — it's the list prefix
    name,
    kind: "folder",
    modifiedAt: 0,
    mimeFamily: "folder",
    providerMetadata: { bucket, key: prefix },
  };
}

// ---------------------------------------------------------------------------
// Credential extraction
// ---------------------------------------------------------------------------

interface S3CredsMeta {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  sessionToken?: string;
}

function readCredsFromStored(credentials: StoredCredentials): S3CredsMeta {
  const meta = credentials.authResult.meta ?? {};
  const m = meta as Record<string, unknown>;
  if (
    typeof m.accessKeyId !== "string" ||
    typeof m.secretAccessKey !== "string" ||
    typeof m.region !== "string" ||
    typeof m.bucket !== "string"
  ) {
    throw new DatasourceError<"amazon-s3">({
      tag: DatasourceErrorTag.AuthRevoked,
      datasourceType: "amazon-s3",
      datasourceId: "<init>",
      retryable: false,
      raw: "s3-missing-credentials-fields",
      message:
        "S3 credentials must include accessKeyId, secretAccessKey, region, bucket",
    });
  }
  const out: S3CredsMeta = {
    accessKeyId: m.accessKeyId,
    secretAccessKey: m.secretAccessKey,
    region: m.region,
    bucket: m.bucket,
  };
  if (typeof m.sessionToken === "string") out.sessionToken = m.sessionToken;
  return out;
}

function buildAwsClient(creds: S3CredsMeta): AwsS3Client {
  return new AwsS3Client({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// S3Client
// ---------------------------------------------------------------------------

export class S3Client extends BaseDatasourceClient<"amazon-s3"> {
  readonly type = "amazon-s3" as const;

  private readonly creds: S3CredsMeta;
  private readonly aws: AwsS3Client;

  /**
   * `preAuth` is accepted for type uniformity across the strategy hierarchy
   * (implement-datasource-onboarding §2.7). S3 is a credentials-form
   * provider — it does not consume an OAuth app config — so the value is
   * intentionally ignored. Accepts `null` as an alias for `undefined` so
   * the factory.createForAuth contract (`OAuthAppConfig | null`) lands
   * here without a boundary translation step. The parameter is
   * `void`-cast to silence the unused-parameter lint without dropping
   * the slot from the signature.
   */
  constructor(
    init: { datasourceId: string; ctx: BaseClientContext },
    creds: S3CredsMeta,
    preAuth?: PreAuthConfig | null,
  ) {
    super(init);
    this.creds = creds;
    this.aws = buildAwsClient(creds);
    void preAuth;
  }

  // -------------------------------------------------------------------------
  // Status / connection
  // -------------------------------------------------------------------------

  protected override async doStatusImpl(): Promise<DatasourceStatus> {
    await this.aws.send(new HeadBucketCommand({ Bucket: this.creds.bucket }));
    return "connected";
  }

  protected override async doTestConnectionImpl(): Promise<void> {
    await this.aws.send(new HeadBucketCommand({ Bucket: this.creds.bucket }));
  }

  // -------------------------------------------------------------------------
  // authenticate — credentials-form intent
  // -------------------------------------------------------------------------

  protected override async doAuthenticateImpl(): Promise<AuthIntent> {
    const intent: CredentialsFormIntent = {
      kind: "credentials-form",
      schema: "aws-access-key",
      submit: async (values): Promise<AuthResult> => {
        // Shape validation.
        const v = values as Record<string, unknown>;
        const accessKeyId = v.accessKeyId;
        const secretAccessKey = v.secretAccessKey;
        const region = v.region;
        const bucket = v.bucket;
        const sessionToken = v.sessionToken;
        if (
          typeof accessKeyId !== "string" ||
          typeof secretAccessKey !== "string" ||
          typeof region !== "string" ||
          typeof bucket !== "string"
        ) {
          throw new DatasourceError<"amazon-s3">({
            tag: DatasourceErrorTag.ProviderError,
            datasourceType: "amazon-s3",
            datasourceId: this.datasourceId,
            retryable: false,
            raw: "s3-credentials-form-validation-failed",
            message:
              "Missing required field: accessKeyId, secretAccessKey, region, bucket",
          });
        }
        const submitted: S3CredsMeta = {
          accessKeyId,
          secretAccessKey,
          region,
          bucket,
        };
        if (typeof sessionToken === "string") {
          submitted.sessionToken = sessionToken;
        }
        // Verify against real S3 via HeadBucket. Errors normalize through
        // our own normalizeErrorImpl so 403 becomes auth-revoked.
        const verifyClient = buildAwsClient(submitted);
        try {
          await verifyClient.send(new HeadBucketCommand({ Bucket: bucket }));
        } catch (err) {
          throw this.normalizeErrorImpl(err);
        } finally {
          verifyClient.destroy();
        }
        // Success — return an AuthResult with empty accessToken and the
        // creds in `meta`. The base's decorateIntent will persist via
        // `CredentialStore.put`.
        const meta: Record<string, unknown> = {
          accessKeyId,
          secretAccessKey,
          region,
          bucket,
        };
        if (typeof sessionToken === "string") meta.sessionToken = sessionToken;
        return {
          accessToken: "",
          meta,
        };
      },
    };
    return intent;
  }

  // -------------------------------------------------------------------------
  // listDirectory
  // -------------------------------------------------------------------------

  protected override async doListDirectoryImpl(
    target: Target,
    options: { cursor?: string; pageSize?: number },
  ): Promise<{
    entries: DatasourceFileEntry<"amazon-s3">[];
    nextCursor: string | null;
  }> {
    let prefix = targetToKey(target);
    // Ensure trailing slash for folder-listing semantics (unless root).
    if (prefix !== "" && !prefix.endsWith("/")) prefix = `${prefix}/`;
    // add-engine-listdirectory-pagination §4.2: a SINGLE ListObjectsV2 call
    // per engine call (the prior do/while auto-loop is gone — the
    // continuation token is now surfaced to the caller as `nextCursor`
    // instead of being consumed internally). `options.cursor` maps to
    // `ContinuationToken`; `options.pageSize` clamps to S3's `[1, 1000]`
    // `MaxKeys` ceiling (default 1000 when omitted).
    const out: DatasourceFileEntry<"amazon-s3">[] = [];
    const resp = await this.aws.send(
      new ListObjectsV2Command({
        Bucket: this.creds.bucket,
        Prefix: prefix,
        Delimiter: "/",
        MaxKeys: clampS3PageSize(options.pageSize),
        ...(options.cursor !== undefined
          ? { ContinuationToken: options.cursor }
          : {}),
      }),
    );
    for (const cp of resp.CommonPrefixes ?? []) {
      if (cp.Prefix) {
        out.push(buildFolderEntry(this.creds.bucket, cp.Prefix));
      }
    }
    for (const obj of resp.Contents ?? []) {
      if (!obj.Key) continue;
      // Filter out the folder marker (prefix itself) so a listing under
      // `/photos/` does not emit `/photos/` as a file.
      if (obj.Key === prefix) continue;
      out.push(
        buildFileEntry(this.creds.bucket, obj.Key, {
          ...(typeof obj.Size === "number" ? { size: obj.Size } : {}),
          ...(obj.LastModified ? { lastModified: obj.LastModified } : {}),
          ...(obj.ETag ? { etag: obj.ETag } : {}),
          ...(obj.StorageClass ? { storageClass: obj.StorageClass } : {}),
        }),
      );
    }
    const nextCursor =
      resp.IsTruncated && resp.NextContinuationToken
        ? resp.NextContinuationToken
        : null;
    return { entries: out, nextCursor };
  }

  // -------------------------------------------------------------------------
  // search — prefix list + client-side substring filter
  // -------------------------------------------------------------------------

  protected override async doSearchImpl(
    query: string,
    scope?: Target,
  ): Promise<DatasourceFileEntry<"amazon-s3">[]> {
    // Perf caveat: S3 offers no server-side search. We paginate under the
    // scope prefix and filter client-side. Large buckets should scope the
    // search (`scope`) to a bounded folder.
    const prefix = scope ? targetToKey(scope) : "";
    const normalisedPrefix =
      prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
    const q = query.toLowerCase();
    const out: DatasourceFileEntry<"amazon-s3">[] = [];
    let continuationToken: string | undefined;
    do {
      const resp = await this.aws.send(
        new ListObjectsV2Command({
          Bucket: this.creds.bucket,
          Prefix: normalisedPrefix,
          // NO Delimiter here — search walks the entire subtree.
          ...(continuationToken
            ? { ContinuationToken: continuationToken }
            : {}),
        }),
      );
      for (const obj of resp.Contents ?? []) {
        if (!obj.Key) continue;
        if (!obj.Key.toLowerCase().includes(q)) continue;
        out.push(
          buildFileEntry(this.creds.bucket, obj.Key, {
            ...(typeof obj.Size === "number" ? { size: obj.Size } : {}),
            ...(obj.LastModified ? { lastModified: obj.LastModified } : {}),
            ...(obj.ETag ? { etag: obj.ETag } : {}),
            ...(obj.StorageClass ? { storageClass: obj.StorageClass } : {}),
          }),
        );
      }
      continuationToken = resp.IsTruncated
        ? resp.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return out;
  }

  // -------------------------------------------------------------------------
  // getMetadata — file: HeadObject; folder: synthesize via ListObjectsV2
  // -------------------------------------------------------------------------

  protected override async doGetMetadataImpl(
    target: Target,
  ): Promise<FileMetadata<"amazon-s3">> {
    const rawKey = targetToKey(target);
    // Folder: caller passed a trailing-slash key; synthesize.
    if (rawKey.endsWith("/")) {
      const resp = await this.aws.send(
        new ListObjectsV2Command({
          Bucket: this.creds.bucket,
          Prefix: rawKey,
          MaxKeys: 1,
        }),
      );
      if (!resp.Contents?.length && !resp.CommonPrefixes?.length) {
        throw new DatasourceError<"amazon-s3">({
          tag: DatasourceErrorTag.NotFound,
          datasourceType: "amazon-s3",
          datasourceId: this.datasourceId,
          retryable: false,
          raw: "s3-folder-empty-or-missing",
          message: `No objects under folder ${rawKey}`,
        });
      }
      return buildFolderEntry(this.creds.bucket, rawKey);
    }
    // File: HeadObject.
    const resp = await this.aws.send(
      new HeadObjectCommand({ Bucket: this.creds.bucket, Key: rawKey }),
    );
    return buildFileEntry(this.creds.bucket, rawKey, {
      ...(typeof resp.ContentLength === "number"
        ? { size: resp.ContentLength }
        : {}),
      ...(resp.LastModified ? { lastModified: resp.LastModified } : {}),
      ...(resp.ETag ? { etag: resp.ETag } : {}),
      ...(resp.StorageClass ? { storageClass: resp.StorageClass } : {}),
      ...(resp.VersionId ? { versionId: resp.VersionId } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // uploadFile — streaming via lib-storage Upload, wires onProgress
  // -------------------------------------------------------------------------

  protected override async doUploadFileImpl(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    options: {
      signal?: AbortSignal;
      onProgress?: (loaded: number, total: number) => void;
    },
  ): Promise<DatasourceFileEntry<"amazon-s3">> {
    const parentKey = targetToKey(parent);
    const normalisedParent =
      parentKey === "" || parentKey.endsWith("/")
        ? parentKey
        : `${parentKey}/`;
    const name = file.name ?? basename(file.path);
    const key = `${normalisedParent}${name}`;
    // Pre-compute the total so onProgress gets a stable denominator even if
    // the SDK fires progress before its own `total` is populated.
    let total = 0;
    try {
      total = statSync(file.path).size;
    } catch {
      total = 0;
    }
    const body = createReadStream(file.path);
    const upload = new Upload({
      client: this.aws,
      params: {
        Bucket: this.creds.bucket,
        Key: key,
        Body: body,
        ...(file.mimeType ? { ContentType: file.mimeType } : {}),
      },
    });
    // Wire the consumer's abort signal to `Upload.abort()`. `Upload.abort()`
    // sets the SDK's internal AbortController signal;
    // `__doMultipartUpload()` then observes the aborted signal after
    // `Promise.all(concurrentUploaders)` and calls `markUploadAsAborted()`,
    // which issues `AbortMultipartUploadCommand` if `UploadId` was
    // allocated. No supplementary `AbortMultipartUploadCommand` send is
    // required — the SDK does the cleanup itself. Verified against
    // `@aws-sdk/lib-storage@3.1032.0/dist-cjs/index.js:229-231, 420-424,
    // 466-470` during the design review for `add-fs-engine-cancellation`.
    // No fresh AbortController is needed on the cleanup side because the
    // `Upload` instance manages its own controller internally — the SDK's
    // cleanup HTTP call is not coupled to `options.signal`.
    options.signal?.addEventListener(
      "abort",
      () => {
        upload.abort();
      },
      { once: true },
    );
    upload.on("httpUploadProgress", (p) => {
      const loaded = p.loaded ?? 0;
      const denom = p.total ?? total;
      options.onProgress?.(loaded, denom);
    });
    const resp = await upload.done();
    // `resp` is CompleteMultipartUploadCommandOutput | PutObjectCommandOutput.
    // Both carry `ETag` (lib-storage normalises).
    const etag = (resp as { ETag?: string }).ETag;
    return buildFileEntry(this.creds.bucket, key, {
      // Omit size when statSync raced (file moved/removed) — total === 0 is
      // the race sentinel, not a legit zero-byte upload here.
      ...(total > 0 ? { size: total } : {}),
      lastModified: new Date(),
      ...(etag ? { etag } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // deleteFile — DeleteObject
  // -------------------------------------------------------------------------

  protected override async doDeleteFileImpl(target: Target): Promise<void> {
    const key = targetToKey(target);
    await this.aws.send(
      new DeleteObjectCommand({ Bucket: this.creds.bucket, Key: key }),
    );
  }

  // -------------------------------------------------------------------------
  // rename — CopyObject + DeleteObject for files; folder targets unsupported
  // -------------------------------------------------------------------------
  //
  // S3 has no native rename. The strategy's introspection helper distinguishes
  // file vs virtual-folder vs not-found before branching:
  //
  //   - HeadObject(key) 200 → file → CopyObject + DeleteObject path
  //   - HeadObject(key) 404 then ListObjectsV2(Prefix=key+"/", MaxKeys=1) returns
  //     ≥1 key → virtual folder → throw `unsupported` (S3 folder rename is
  //     out of scope this version: a recursive copy + delete walk is required)
  //   - both 404 → throw `not-found`
  //
  // Decision 2 (design.md): when CopyObject succeeds but the subsequent
  // DeleteObject fails, the rename SUCCEEDED from the user's perspective —
  // the new key has the renamed content. The orphan old key is silently
  // tolerated; the bus emits exactly one `entry-renamed` regardless of
  // post-copy delete failure.
  //
  // S3's CopyObject is naturally OVERWRITING (unlike Drive/OneDrive's PATCH
  // path which needs explicit pre-delete). For `conflictPolicy: "overwrite"`
  // on a file we simply proceed. For `conflictPolicy: "fail"` we issue a
  // pre-flight `HeadObject` for the target and short-circuit with `conflict`
  // if it returns 200. For `keep-both` we loop HeadObject probes for `name`,
  // `name-2`, `name-3`, … up to 99 attempts, then throw `provider-error`
  // (engine taxonomy lacks `"other"`; the wire layer collapses it to
  // `tag: "other"` for the renderer per Drive §7.14 precedent).
  //
  // For directory targets + `conflictPolicy === "overwrite"`, the strategy
  // refuses with the same "directory rename with conflictPolicy 'overwrite'
  // is not supported" message Drive / OneDrive use (recursive replacement
  // is out of scope this change).
  protected override async doRenameImpl(
    target: Target,
    newName: string,
    conflictPolicy: ConflictPolicy,
  ): Promise<DatasourceFileEntry<"amazon-s3">> {
    const oldKey = targetToKey(target);
    const kind = await this.introspectKey(oldKey);
    if (kind === null) {
      throw new DatasourceError<"amazon-s3">({
        tag: DatasourceErrorTag.NotFound,
        datasourceType: "amazon-s3",
        datasourceId: this.datasourceId,
        retryable: false,
        raw: "s3-rename-target-not-found",
        message: `Rename target not found at /${oldKey}`,
      });
    }
    if (kind === "folder") {
      // §9.13/§9.14 — directory-overwrite refusal takes precedence over the
      // generic folder-rename refusal so the message is policy-specific.
      if (conflictPolicy === "overwrite") {
        throw new DatasourceError<"amazon-s3">({
          tag: DatasourceErrorTag.Unsupported,
          datasourceType: "amazon-s3",
          datasourceId: this.datasourceId,
          retryable: false,
          message:
            "directory rename with conflictPolicy 'overwrite' is not supported (would require recursive replacement)",
        });
      }
      // §9.7/§9.8 — generic folder-rename refusal.
      throw new DatasourceError<"amazon-s3">({
        tag: DatasourceErrorTag.Unsupported,
        datasourceType: "amazon-s3",
        datasourceId: this.datasourceId,
        retryable: false,
        message: "S3 folder rename is not supported in this version",
      });
    }

    // File branch. Compute the new key (preserve the parent prefix).
    const lastSlash = oldKey.lastIndexOf("/");
    const parentPrefix = lastSlash === -1 ? "" : oldKey.slice(0, lastSlash + 1);
    const candidateInitial = `${parentPrefix}${newName}`;

    // Pre-rename collision pre-check / keep-both loop. Each branch resolves
    // to `effectiveKey` — the destination key that the CopyObject below
    // will write.
    let effectiveKey: string;
    let effectiveName: string;
    if (conflictPolicy === "fail") {
      // §9.9/§9.10 — sibling collision pre-check. HeadObject 200 → conflict.
      const exists = await this.headObjectExists(candidateInitial);
      if (exists) {
        const existingPath = `/${candidateInitial}`;
        throw new DatasourceError<"amazon-s3">({
          tag: DatasourceErrorTag.Conflict,
          datasourceType: "amazon-s3",
          datasourceId: this.datasourceId,
          retryable: false,
          raw: { existingPath },
          message: `Sibling already exists at ${existingPath}`,
        });
      }
      effectiveKey = candidateInitial;
      effectiveName = newName;
    } else if (conflictPolicy === "keep-both") {
      // §9.19/§9.20 — suffix retry loop, capped at 99.
      const { base, ext } = splitNameForSuffix(newName);
      let chosenKey: string | null = null;
      let chosenName: string | null = null;
      for (let attempt = 1; attempt <= 99; attempt++) {
        const candidateName =
          attempt === 1 ? newName : `${base}-${attempt}${ext}`;
        const candidateKey = `${parentPrefix}${candidateName}`;
        const exists = await this.headObjectExists(candidateKey);
        if (!exists) {
          chosenKey = candidateKey;
          chosenName = candidateName;
          break;
        }
      }
      if (chosenKey === null || chosenName === null) {
        throw new DatasourceError<"amazon-s3">({
          tag: DatasourceErrorTag.ProviderError,
          datasourceType: "amazon-s3",
          datasourceId: this.datasourceId,
          retryable: false,
          message: "exhausted keep-both attempts",
        });
      }
      effectiveKey = chosenKey;
      effectiveName = chosenName;
    } else {
      // §9.11/§9.12 — `overwrite` on a file: S3's CopyObject is naturally
      // overwriting. No pre-delete is needed (unlike Drive/OneDrive).
      effectiveKey = candidateInitial;
      effectiveName = newName;
    }

    // CopyObject then DeleteObject. Decision 2: if DeleteObject fails after
    // a successful Copy, the rename SUCCEEDS from the user's perspective.
    // The old key becomes an orphan; the bus still emits exactly one
    // entry-renamed event.
    let copyResult: { ETag?: string; LastModified?: Date } = {};
    try {
      const resp = await this.aws.send(
        new CopyObjectCommand({
          Bucket: this.creds.bucket,
          Key: effectiveKey,
          CopySource: `${this.creds.bucket}/${oldKey}`,
        }),
      );
      copyResult = {
        ...(resp.CopyObjectResult?.ETag ? { ETag: resp.CopyObjectResult.ETag } : {}),
        ...(resp.CopyObjectResult?.LastModified
          ? { LastModified: resp.CopyObjectResult.LastModified }
          : {}),
      };
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    try {
      await this.aws.send(
        new DeleteObjectCommand({
          Bucket: this.creds.bucket,
          Key: oldKey,
        }),
      );
    } catch {
      // Orphan old key — Decision 2: the rename succeeded from the user's
      // perspective, so we swallow the delete failure and proceed. No
      // logger is wired for this strategy; a future change can introduce
      // structured logging here without altering the user-facing contract.
    }

    return buildFileEntry(this.creds.bucket, effectiveKey, {
      ...(copyResult.LastModified ? { lastModified: copyResult.LastModified } : {}),
      ...(copyResult.ETag ? { etag: copyResult.ETag } : {}),
    });
    // The entry's `name` is derived from the key's basename, matching
    // `effectiveName` by construction. We do not pass `name` separately;
    // `buildFileEntry`'s `basename(key)` produces the same value.
    void effectiveName;
  }

  /**
   * Resolve an S3 key to one of `"file"` / `"folder"` / `null` (not-found)
   * via the documented two-phase introspection:
   *
   *   1. `HeadObject(Key=key)` — if 200, the object exists at that exact key
   *      (a real file).
   *   2. If HeadObject returns 404, fall back to
   *      `ListObjectsV2(Prefix=key+"/", MaxKeys=1)`. If at least one key is
   *      under that prefix, this is an S3 "virtual folder" (no actual
   *      object exists at the bare key, but children do).
   *   3. Both empty → `null` (not-found).
   *
   * Non-404 errors from HeadObject (auth, transport) propagate via
   * `normalizeErrorImpl` so the caller surfaces the right taxonomy tag.
   */
  private async introspectKey(
    key: string,
  ): Promise<"file" | "folder" | null> {
    try {
      await this.aws.send(
        new HeadObjectCommand({ Bucket: this.creds.bucket, Key: key }),
      );
      return "file";
    } catch (err) {
      const normalized = this.normalizeErrorImpl(err);
      if (normalized.tag !== DatasourceErrorTag.NotFound) {
        throw normalized;
      }
      // Fall through to ListObjectsV2 to detect the virtual-folder case.
    }
    let listResp;
    try {
      listResp = await this.aws.send(
        new ListObjectsV2Command({
          Bucket: this.creds.bucket,
          Prefix: `${key}/`,
          MaxKeys: 1,
        }),
      );
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    const hasChildren =
      (listResp.Contents && listResp.Contents.length > 0) ||
      (listResp.CommonPrefixes && listResp.CommonPrefixes.length > 0);
    if (hasChildren) return "folder";
    return null;
  }

  /**
   * `HeadObject(Key=key)` → boolean: true if the object exists, false on a
   * 404. Other errors propagate via `normalizeErrorImpl` so the caller
   * surfaces the right taxonomy tag (e.g., auth-revoked).
   */
  private async headObjectExists(key: string): Promise<boolean> {
    try {
      await this.aws.send(
        new HeadObjectCommand({ Bucket: this.creds.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      const normalized = this.normalizeErrorImpl(err);
      if (normalized.tag === DatasourceErrorTag.NotFound) return false;
      throw normalized;
    }
  }

  // -------------------------------------------------------------------------
  // downloadFile — GetObject stream, with Range + abortSignal forwarding
  // -------------------------------------------------------------------------
  //
  // S3's media-download primitive is `GetObjectCommand({Bucket, Key,
  // Range})`. The strategy threads `options.signal` into the SDK's
  // per-call `abortSignal` (HttpHandlerOptions on `client.send`'s second
  // arg), wraps `response.Body` (a Node `Readable` in this runtime) in a
  // `Transform` so byte-counting is INLINE with the data flow (mirrors
  // Drive §7.7 / OneDrive §8.5 — a separate `data` listener races with
  // the consumer attach), and surfaces `ContentLength` / `ContentRange`
  // from the response so fs-sync's range-resume retry loop can validate.
  //
  // Auth-expired surfacing: a mid-stream `ExpiredToken` (STS temporary
  // credentials) is mapped by `normalizeErrorImpl` to `tag:auth-expired`
  // — see the class-header normalizeError note. The base routes
  // `auth-expired` to `download-failed` whose payload IS the
  // `SerializedDatasourceError<"amazon-s3">`.
  protected override async doDownloadFileImpl(
    target: Target,
    options: DownloadOptions,
  ): Promise<DownloadResult> {
    const key = targetToKey(target);
    const range =
      options.rangeStart !== undefined && options.rangeStart > 0
        ? `bytes=${options.rangeStart}-`
        : undefined;
    let resp;
    try {
      resp = await this.aws.send(
        new GetObjectCommand({
          Bucket: this.creds.bucket,
          Key: key,
          ...(range !== undefined ? { Range: range } : {}),
        }),
        // HttpHandlerOptions per @smithy/types — `abortSignal` is the
        // per-call signal that propagates to the underlying handler.
        ...(options.signal ? [{ abortSignal: options.signal }] : []),
      );
    } catch (err) {
      throw this.normalizeErrorImpl(err);
    }
    if (resp.Body === undefined || resp.Body === null) {
      throw this.normalizeErrorImpl({
        message: "s3-download-missing-body",
      });
    }
    // The SDK's `Body` is `StreamingBlobTypes` — in Node it's a Readable.
    // Cast at the boundary; tests pass a Readable directly via the mock.
    const sourceStream = resp.Body as Readable;
    const contentLength =
      typeof resp.ContentLength === "number" ? resp.ContentLength : null;
    const contentRange = parseContentRangeFromS3(resp.ContentRange);

    // Wrap source in a Transform so byte counting is inline with data flow.
    // The consumer attaches their listeners to the wrapper; chunks flow
    // through `_transform` (counting + emit) then onward untouched.
    let loaded = 0;
    const total: number | null = contentLength;
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        loaded += chunk.length;
        try {
          options.onProgress?.(loaded, total);
        } catch {
          // Consumer-callback errors must not break the pipeline.
        }
        cb(null, chunk);
      },
    });
    // Forward source errors so the wrapper transitions to errored state and
    // the base's `error` listener fires on a mid-stream provider error
    // (e.g., ExpiredToken or AbortError surfaced via the body's destroy).
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

  // -------------------------------------------------------------------------
  // getQuota — defensive Unsupported (capability gate short-circuits above)
  // -------------------------------------------------------------------------

  protected override async doGetQuotaImpl(): Promise<Quota> {
    throw new DatasourceError<"amazon-s3">({
      tag: DatasourceErrorTag.Unsupported,
      datasourceType: "amazon-s3",
      datasourceId: this.datasourceId,
      retryable: false,
      raw: "s3-quota-unsupported",
      message: "S3 does not expose a bucket quota API",
    });
  }

  // -------------------------------------------------------------------------
  // refreshToken — static keys cannot refresh; defensive throw.
  // -------------------------------------------------------------------------

  protected override async refreshTokenImpl(): Promise<AuthResult> {
    // Safety net: normalizeError redirects all auth failures to `auth-revoked`
    // so no consumer refresh path (fs-sync's `refreshCredentials()` via
    // `withAuthRefresh`) ever needs to fire. If a future change ever routes
    // an `auth-expired` tag to this strategy, this throw stops the
    // refresh-and-retry loop immediately with the correct taxonomy tag.
    throw new DatasourceError<"amazon-s3">({
      tag: DatasourceErrorTag.AuthRevoked,
      datasourceType: "amazon-s3",
      datasourceId: this.datasourceId,
      retryable: false,
      raw: "s3-static-keys-cannot-refresh",
      message: "AWS static access keys do not support token refresh",
    });
  }

  // -------------------------------------------------------------------------
  // normalizeError — map AWS SDK errors to the 8-tag taxonomy
  // -------------------------------------------------------------------------

  protected override normalizeErrorImpl(raw: unknown): DatasourceError<"amazon-s3"> {
    if (raw instanceof DatasourceError) {
      return raw as DatasourceError<"amazon-s3">;
    }
    const r = raw as {
      name?: string;
      code?: string;
      message?: string;
      $metadata?: { httpStatusCode?: number };
      $response?: { headers?: Record<string, string> };
    } | null;
    const name = r?.name ?? "";
    const code = r?.code ?? "";
    const status = r?.$metadata?.httpStatusCode ?? 0;
    const headers = r?.$response?.headers ?? {};

    const mk = (
      tag: DatasourceError<"amazon-s3">["tag"],
      retryable: boolean,
      extra: { retryAfterMs?: number; message?: string } = {},
    ): DatasourceError<"amazon-s3"> =>
      new DatasourceError<"amazon-s3">({
        tag,
        datasourceType: "amazon-s3",
        datasourceId: this.datasourceId,
        retryable,
        raw,
        ...(extra.retryAfterMs !== undefined
          ? { retryAfterMs: extra.retryAfterMs }
          : {}),
        ...(extra.message ? { message: extra.message } : {}),
      });

    // AbortError surfacing — per add-engine-rename-download §9.17. Placed
    // BEFORE the network-error branch so an aborted in-flight request whose
    // error also exposes a network-y `code` does not get mis-classified as
    // transient. The base routes `cancelled` to the `download-cancelled`
    // bus event per Decision 3.
    if (name === "AbortError") {
      return mk("cancelled", false, { message: "download cancelled" });
    }
    // not-found
    if (name === "NoSuchKey" || name === "NotFound" || status === 404) {
      return mk("not-found", false);
    }
    // auth-expired — STS temporary credential expiry. Surfaced separately
    // from the static-key auth-revoked branch per §9.18: `ExpiredToken`
    // signals a TTL'd session token, which the consumer (fs-sync's
    // download retry loop) can drive a refresh against. The strategy
    // itself cannot refresh (refreshTokenImpl throws auth-revoked), but
    // the engine's `download-failed` event MUST carry `auth-expired` so
    // fs-sync can splice resumption.
    if (name === "ExpiredToken") {
      return mk("auth-expired", false);
    }
    // auth-revoked (not auth-expired — see class docstring)
    if (
      name === "AccessDenied" ||
      name === "InvalidAccessKeyId" ||
      name === "SignatureDoesNotMatch" ||
      status === 403
    ) {
      return mk("auth-revoked", false);
    }
    // rate-limited
    if (
      name === "SlowDown" ||
      name === "TooManyRequests" ||
      status === 429 ||
      status === 503
    ) {
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
    // network-error
    if (
      name === "NetworkingError" ||
      name === "TimeoutError" ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "EPIPE"
    ) {
      return mk("network-error", true);
    }
    // conflict
    if (name === "PreconditionFailed" || status === 412) {
      return mk("conflict", false);
    }
    // fallthrough
    return mk("provider-error", false);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory function for the S3 strategy. Extracts AWS credentials from
 * `StoredCredentials.authResult.meta` and constructs a fresh `S3Client`.
 *
 * Per design: the factory is stateless — each call yields a new client, and
 * the client captures the credentials at construction time. Credentials
 * rotated via a subsequent `authenticate()` flow are persisted to the store
 * but do NOT automatically apply to already-constructed clients; callers
 * that cache clients per `(providerId, datasourceId)` MUST evict and rebuild
 * when creds change.
 */
export const createS3Client: ProviderFactoryFn<"amazon-s3"> = (
  datasourceId,
  credentials,
  ctx,
) => {
  const creds = readCredsFromStored(credentials);
  return new S3Client({ datasourceId, ctx }, creds);
};

/**
 * Canonical `PreAuthFactoryFn` entry for `factory.createForAuth(...)` —
 * implement-datasource-onboarding §3.4. S3 is a credentials-form provider:
 * the factory contract passes `preAuth: null`. The strategy is constructed
 * with placeholder `S3CredsMeta` — the AWS SDK client built from these
 * placeholder values is unused on the createForAuth path because
 * `doAuthenticateImpl()` returns a `CredentialsFormIntent` whose `submit()`
 * builds its own AWS client (`buildAwsClient(submitted)`) from the values
 * the user types in. No `aws.send(...)` call ever consumes the placeholder
 * client. The placeholder `region` is a non-empty value because the AWS
 * SDK's `S3Client` constructor validates `region` at construction-time
 * (rejects empty string with "Region is missing"); the value chosen is
 * neutral and explicitly marked as a placeholder.
 */
export const createS3ClientForAuth: PreAuthFactoryFn<"amazon-s3"> = (
  datasourceId,
  preAuth,
  ctx,
) => {
  const placeholderCreds: S3CredsMeta = {
    accessKeyId: "pre-auth-placeholder",
    secretAccessKey: "pre-auth-placeholder",
    // AWS SDK validates region at construction; "us-east-1" is the AWS
    // default and a safe non-empty placeholder.
    region: "us-east-1",
    bucket: "pre-auth-placeholder",
  };
  return new S3Client({ datasourceId, ctx }, placeholderCreds, preAuth);
};

/**
 * Per-provider credential-shape validator (per
 * add-invalid-datasource-state Decision 2). Wired into the registry entry
 * by `createDefaultProviderRegistry` and invoked by `factory.create`
 * BEFORE the strategy factory runs. Throws `DatasourceError({ tag:
 * "invalid-datasource", retryable: false, message: "amazon-s3 credential
 * is missing <field>" })` on the first missing/invalid field.
 */
export const validateS3CredentialShape: CredentialShapeValidator = (
  credentials,
  datasourceId,
) => {
  const authResult = (credentials as { authResult?: unknown }).authResult;
  if (authResult === null || typeof authResult !== "object") {
    throw new DatasourceError<"amazon-s3">({
      tag: DatasourceErrorTag.InvalidDatasource,
      datasourceType: "amazon-s3",
      datasourceId,
      retryable: false,
      raw: "amazon-s3-missing-authResult",
      message: "amazon-s3 credential is missing authResult",
    });
  }
  const meta = ((authResult as { meta?: unknown }).meta ?? {}) as Record<
    string,
    unknown
  >;
  for (const field of [
    "accessKeyId",
    "secretAccessKey",
    "region",
    "bucket",
  ] as const) {
    if (typeof meta[field] !== "string" || (meta[field] as string).length === 0) {
      throw new DatasourceError<"amazon-s3">({
        tag: DatasourceErrorTag.InvalidDatasource,
        datasourceType: "amazon-s3",
        datasourceId,
        retryable: false,
        raw: `amazon-s3-missing-${field}`,
        message: `amazon-s3 credential is missing ${field}`,
      });
    }
  }
};
