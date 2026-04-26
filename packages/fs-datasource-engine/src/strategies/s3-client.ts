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
//   - `normalizeError`. Auth errors (403, AccessDenied, InvalidAccessKeyId,
//     SignatureDoesNotMatch) are tagged `auth-revoked`, NOT `auth-expired`.
//     Static keys cannot refresh, so the base's `withRefresh` path MUST never
//     fire for this strategy. Routing all auth-flavored errors to
//     `auth-revoked` short-circuits the retry/refresh loop entirely — the
//     defensive `refreshTokenImpl` throw is a safety net that will (by this
//     design) never actually fire.
//
//   - `deleteDirectory` and `getQuota` are both unsupported (base's
//     `deleteDirectory` always throws; `getQuota` throws via the descriptor
//     `capabilities.quota === false` gate before our impl would run).

import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";

import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
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

import { BaseDatasourceClient, type BaseClientContext } from "../base-client.js";
import {
  type CredentialShapeValidator,
  type ProviderFactoryFn,
} from "../factory.js";

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
      tag: "auth-revoked",
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

  constructor(
    init: { datasourceId: string; ctx: BaseClientContext },
    creds: S3CredsMeta,
  ) {
    super(init);
    this.creds = creds;
    this.aws = buildAwsClient(creds);
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
            tag: "provider-error",
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
  ): Promise<DatasourceFileEntry<"amazon-s3">[]> {
    let prefix = targetToKey(target);
    // Ensure trailing slash for folder-listing semantics (unless root).
    if (prefix !== "" && !prefix.endsWith("/")) prefix = `${prefix}/`;
    const out: DatasourceFileEntry<"amazon-s3">[] = [];
    let continuationToken: string | undefined;
    do {
      const resp = await this.aws.send(
        new ListObjectsV2Command({
          Bucket: this.creds.bucket,
          Prefix: prefix,
          Delimiter: "/",
          ...(continuationToken
            ? { ContinuationToken: continuationToken }
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
      continuationToken = resp.IsTruncated
        ? resp.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return out;
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
          tag: "not-found",
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
  // createFile — PutObject from a local path (streamed via fs.createReadStream)
  // -------------------------------------------------------------------------

  /**
   * Create a new object under `parent/name` from a local file path.
   *
   * No-overwrite guarantee: uses S3's `IfNoneMatch: "*"` precondition so the
   * PutObject fails with HTTP 412 PreconditionFailed if the key already
   * exists. `normalizeError` maps that to `DatasourceError` tag `"conflict"`.
   * Callers that want overwrite semantics should use `uploadFile` instead.
   */
  protected override async doCreateFileImpl(
    parent: Target,
    name: string,
    content: { path: string },
  ): Promise<DatasourceFileEntry<"amazon-s3">> {
    const parentKey = targetToKey(parent);
    const normalisedParent =
      parentKey === "" || parentKey.endsWith("/")
        ? parentKey
        : `${parentKey}/`;
    const key = `${normalisedParent}${name}`;
    const body = createReadStream(content.path);
    const resp = await this.aws.send(
      new PutObjectCommand({
        Bucket: this.creds.bucket,
        Key: key,
        Body: body,
        IfNoneMatch: "*", // S3 precondition: fail with 412 if key already exists.
      }),
    );
    let size: number | undefined;
    try {
      size = statSync(content.path).size;
    } catch {
      // Ignore — local file disappeared between upload + stat. The entry
      // still carries bucket + key + etag.
    }
    return buildFileEntry(this.creds.bucket, key, {
      ...(size !== undefined ? { size } : {}),
      lastModified: new Date(),
      ...(resp.ETag ? { etag: resp.ETag } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // uploadFile — streaming via lib-storage Upload, wires onProgress
  // -------------------------------------------------------------------------

  protected override async doUploadFileImpl(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    onProgress: ((loaded: number, total: number) => void) | undefined,
    register: (cancel: () => Promise<void>) => void,
    _signal: AbortSignal,
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
    // Register the provider-native cancel closure. `Upload.abort()` sets the
    // SDK's internal AbortController signal; `__doMultipartUpload()` then
    // observes the aborted signal after `Promise.all(concurrentUploaders)`
    // and calls `markUploadAsAborted()`, which issues
    // `AbortMultipartUploadCommand` if `UploadId` was allocated. No
    // supplementary `AbortMultipartUploadCommand` send is required — the
    // SDK does the cleanup itself. Verified against
    // `@aws-sdk/lib-storage@3.1032.0/dist-cjs/index.js:229-231, 420-424,
    // 466-470` during the design review for `add-fs-engine-cancellation`.
    //
    // The base's `_signal` is unused on S3: the SDK owns its own
    // AbortController internally, and the pre-upload work (statSync,
    // createReadStream) completes synchronously. Keep the parameter in
    // the signature so future S3 changes that do need signal plumbing
    // don't have to re-thread it.
    register(async () => {
      upload.abort();
    });
    // `_signal` intentionally unused — see the long-form comment on the
    // register() call above. Lint the variable to shut the unused-vars
    // rule up without silently dropping the parameter from the signature.
    void _signal;
    upload.on("httpUploadProgress", (p) => {
      const loaded = p.loaded ?? 0;
      const denom = p.total ?? total;
      onProgress?.(loaded, denom);
    });
    const resp = await upload.done();
    // `resp` is CompleteMultipartUploadCommandOutput | PutObjectCommandOutput.
    // Both carry `ETag` (lib-storage normalises).
    const etag = (resp as { ETag?: string }).ETag;
    return buildFileEntry(this.creds.bucket, key, {
      // Omit size when statSync raced (file moved/removed) — total === 0 is
      // the race sentinel, not a legit zero-byte upload here. Consistent with
      // how doCreateFileImpl handles the same case.
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
  // getQuota — defensive Unsupported (capability gate short-circuits above)
  // -------------------------------------------------------------------------

  protected override async doGetQuotaImpl(): Promise<Quota> {
    throw new DatasourceError<"amazon-s3">({
      tag: "unsupported",
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
    // so the base's withRefresh path never fires. If a future change ever
    // routes an `auth-expired` tag to this strategy, this throw stops the
    // retry loop immediately with the correct taxonomy tag.
    throw new DatasourceError<"amazon-s3">({
      tag: "auth-revoked",
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

    // not-found
    if (name === "NoSuchKey" || name === "NotFound" || status === 404) {
      return mk("not-found", false);
    }
    // auth-revoked (not auth-expired — see class docstring)
    if (
      name === "AccessDenied" ||
      name === "InvalidAccessKeyId" ||
      name === "SignatureDoesNotMatch" ||
      name === "ExpiredToken" ||
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
