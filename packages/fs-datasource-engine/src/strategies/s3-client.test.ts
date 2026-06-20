// S3Client strategy tests — Phase 6 of add-fs-datasource-engine.
//
// These tests mock the AWS SDK via `aws-sdk-client-mock`. The real
// `@aws-sdk/client-s3` classes are intercepted at the command-dispatch level,
// so the strategy exercises the real SDK code paths (command serialization,
// middleware chain, region/endpoint resolution) without making network calls.
//
// Every S3-specific behaviour documented in design.md / tasks.md is covered
// here. The shared contract suite (strategy-contract.test.ts) runs its own
// provider-agnostic scenarios against this strategy in s3-client.contract.test.ts.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client as AwsS3Client,
  UploadPartCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CredentialsFormIntent,
  StoredCredentials,
} from "@ft5/ipc-contracts";
import { DatasourceError, providers } from "@ft5/ipc-contracts";

import type { BaseClientContext, CredentialStore } from "../base-client.js";
import { createS3Client, S3Client, pathToKey, keyToPath } from "./s3-client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const s3Mock = mockClient(AwsS3Client);

function makeCreds(
  overrides: Partial<{
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    bucket: string;
    sessionToken: string;
  }> = {},
): StoredCredentials {
  return {
    providerId: "amazon-s3",
    authResult: {
      accessToken: "",
      meta: {
        accessKeyId: overrides.accessKeyId ?? "AKIAFAKE",
        secretAccessKey: overrides.secretAccessKey ?? "SK/fake",
        region: overrides.region ?? "us-east-1",
        bucket: overrides.bucket ?? "test-bucket",
        ...(overrides.sessionToken
          ? { sessionToken: overrides.sessionToken }
          : {}),
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

function makeHarness(credsOverrides: Parameters<typeof makeCreds>[0] = {}): {
  client: S3Client;
} {
  const ctx: BaseClientContext = {
    credentialStore: makeStore(),
    providerDescriptor: providers["amazon-s3"],
  };
  const client = createS3Client("ds-s3-1", makeCreds(credsOverrides), ctx);
  return { client };
}

beforeEach(() => {
  s3Mock.reset();
});

afterEach(() => {
  s3Mock.reset();
});

// ---------------------------------------------------------------------------
// Path <-> key utilities
// ---------------------------------------------------------------------------

describe("S3Client — path↔key mapping", () => {
  it("pathToKey strips leading slash and handles root", () => {
    expect(pathToKey("/")).toBe("");
    expect(pathToKey("/photos/2024/img.jpg")).toBe("photos/2024/img.jpg");
    expect(pathToKey("")).toBe("");
    // Leading slash required on non-empty; ensure idempotent behaviour.
    expect(pathToKey("photos/img.jpg")).toBe("photos/img.jpg");
  });

  it("keyToPath prefixes with / and returns '/' for empty key", () => {
    expect(keyToPath("")).toBe("/");
    expect(keyToPath("photos/2024/img.jpg")).toBe("/photos/2024/img.jpg");
  });
});

// ---------------------------------------------------------------------------
// listDirectory
// ---------------------------------------------------------------------------

describe("S3Client — listDirectory", () => {
  it("issues ListObjectsV2 with Prefix + Delimiter and maps Contents + CommonPrefixes to DatasourceFileEntry", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      CommonPrefixes: [{ Prefix: "photos/2024/" }],
      Contents: [
        {
          Key: "photos/hero.jpg",
          Size: 123,
          LastModified: new Date("2024-01-02"),
          ETag: '"abc"',
          StorageClass: "STANDARD",
        },
      ],
    });

    const { client } = makeHarness();
    const { entries } = await client.listDirectory({ kind: "path", path: "/photos" });

    expect(entries).toHaveLength(2);
    const folder = entries.find((e) => e.kind === "folder")!;
    expect(folder.path).toBe("/photos/2024");
    expect(folder.handle).toBe("photos/2024/");
    expect(folder.name).toBe("2024");
    expect(folder.mimeFamily).toBe("folder");

    const file = entries.find((e) => e.kind === "file")!;
    expect(file.path).toBe("/photos/hero.jpg");
    expect(file.handle).toBe("photos/hero.jpg");
    expect(file.name).toBe("hero.jpg");
    expect(file.size).toBe(123);
    expect(file.providerMetadata.bucket).toBe("test-bucket");
    expect(file.providerMetadata.key).toBe("photos/hero.jpg");
    expect(file.providerMetadata.etag).toBe('"abc"');

    // Verify the emitted command.
    const calls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.Bucket).toBe("test-bucket");
    expect(input.Prefix).toBe("photos/");
    expect(input.Delimiter).toBe("/");
  });

  it("lists bucket root when path is /", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], CommonPrefixes: [] });
    const { client } = makeHarness();
    await client.listDirectory({ kind: "path", path: "/" });
    const input = s3Mock.commandCalls(ListObjectsV2Command)[0]!.args[0].input;
    expect(input.Prefix).toBe("");
  });

  it("accepts handle-form Target equivalently (handle is an S3 key)", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], CommonPrefixes: [] });
    const { client } = makeHarness();
    await client.listDirectory({ kind: "handle", handle: "photos/" });
    const input = s3Mock.commandCalls(ListObjectsV2Command)[0]!.args[0].input;
    expect(input.Prefix).toBe("photos/");
  });

  // -------------------------------------------------------------------------
  // add-engine-listdirectory-pagination §4 — cursor pagination
  // -------------------------------------------------------------------------

  it("first page (no cursor): issues a single ListObjectsV2 with no ContinuationToken, default MaxKeys 1000, nextCursor null when not truncated", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "photos/hero.jpg", Size: 1 }],
      CommonPrefixes: [],
      IsTruncated: false,
    });
    const { client } = makeHarness();
    const result = await client.listDirectory({ kind: "path", path: "/photos" });

    const calls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.ContinuationToken).toBeUndefined();
    // Default page size 1000 when options.pageSize is omitted (Decision 3).
    expect(input.MaxKeys).toBe(1000);
    expect(result.nextCursor).toBeNull();
  });

  it("does NOT auto-loop: a truncated first page returns ONE provider call and surfaces NextContinuationToken as nextCursor", async () => {
    // Pre-pagination behavior auto-looped over IsTruncated until exhausted.
    // §4.2 replaces that do/while with a single call — the continuation token
    // is now surfaced to the caller as `nextCursor`, not consumed internally.
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "photos/a.jpg", Size: 1 }],
      CommonPrefixes: [],
      IsTruncated: true,
      NextContinuationToken: "TOKEN-PAGE-2",
    });
    const { client } = makeHarness();
    const result = await client.listDirectory({ kind: "path", path: "/photos" });

    // Exactly one ListObjectsV2 call — the auto-loop is gone.
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(1);
    expect(result.entries).toHaveLength(1);
    expect(result.nextCursor).toBe("TOKEN-PAGE-2");
  });

  it("next page (with cursor): forwards options.cursor as ContinuationToken", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "photos/b.jpg", Size: 1 }],
      CommonPrefixes: [],
      IsTruncated: false,
    });
    const { client } = makeHarness();
    const result = await client.listDirectory(
      { kind: "path", path: "/photos" },
      { cursor: "TOKEN-PAGE-2" },
    );

    const input = s3Mock.commandCalls(ListObjectsV2Command)[0]!.args[0].input;
    expect(input.ContinuationToken).toBe("TOKEN-PAGE-2");
    expect(result.nextCursor).toBeNull();
  });

  it("clamps pageSize above the S3 MaxKeys ceiling (5000 → 1000) and forwards it as MaxKeys", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [],
      CommonPrefixes: [],
      IsTruncated: false,
    });
    const { client } = makeHarness();
    await client.listDirectory(
      { kind: "path", path: "/photos" },
      { pageSize: 5000 },
    );

    const input = s3Mock.commandCalls(ListObjectsV2Command)[0]!.args[0].input;
    expect(input.MaxKeys).toBe(1000);
  });

  it("forwards an in-range pageSize unchanged as MaxKeys", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [],
      CommonPrefixes: [],
      IsTruncated: false,
    });
    const { client } = makeHarness();
    await client.listDirectory(
      { kind: "path", path: "/photos" },
      { pageSize: 250 },
    );

    const input = s3Mock.commandCalls(ListObjectsV2Command)[0]!.args[0].input;
    expect(input.MaxKeys).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// getMetadata
// ---------------------------------------------------------------------------

describe("S3Client — getMetadata", () => {
  it("uses HeadObject and maps response to FileMetadata", async () => {
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 42,
      LastModified: new Date("2024-06-01"),
      ETag: '"xyz"',
      StorageClass: "STANDARD_IA",
      VersionId: "v1",
    });

    const { client } = makeHarness();
    const meta = await client.getMetadata({ kind: "path", path: "/docs/readme.md" });
    expect(meta.kind).toBe("file");
    expect(meta.size).toBe(42);
    expect(meta.providerMetadata.bucket).toBe("test-bucket");
    expect(meta.providerMetadata.key).toBe("docs/readme.md");
    expect(meta.providerMetadata.etag).toBe('"xyz"');
    expect(meta.providerMetadata.storageClass).toBe("STANDARD_IA");
    expect(meta.providerMetadata.versionId).toBe("v1");

    const input = s3Mock.commandCalls(HeadObjectCommand)[0]!.args[0].input;
    expect(input.Bucket).toBe("test-bucket");
    expect(input.Key).toBe("docs/readme.md");
  });

  it("404/NoSuchKey throws DatasourceError with tag 'not-found'", async () => {
    // Simulate the AWS "NotFound" metadata error.
    const err = new Error("NotFound");
    (err as { name: string }).name = "NotFound";
    (err as { $metadata?: { httpStatusCode: number } }).$metadata = {
      httpStatusCode: 404,
    };
    s3Mock.on(HeadObjectCommand).rejects(err);

    const { client } = makeHarness();
    await expect(
      client.getMetadata({ kind: "path", path: "/nope.txt" }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DatasourceError && e.tag === "not-found",
    );
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("S3Client — delete (file)", () => {
  it("issues DeleteObject and resolves", async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    const { client } = makeHarness();
    await expect(
      client.delete({ kind: "path", path: "/todelete.txt" }, "file"),
    ).resolves.toBeUndefined();
    const input = s3Mock.commandCalls(DeleteObjectCommand)[0]!.args[0].input;
    expect(input.Key).toBe("todelete.txt");
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe("S3Client — search", () => {
  it("lists by prefix and filters client-side (case-insensitive substring)", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: "photos/Alpha.jpg", Size: 1, LastModified: new Date() },
        { Key: "photos/beta.jpg", Size: 2, LastModified: new Date() },
        { Key: "photos/Gamma.PNG", Size: 3, LastModified: new Date() },
      ],
      CommonPrefixes: [],
      IsTruncated: false,
    });

    const { client } = makeHarness();
    const results = await client.search("alpha");
    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe("/photos/Alpha.jpg");

    // Case-insensitive
    const results2 = await client.search("PNG");
    expect(results2.map((r) => r.path)).toContain("/photos/Gamma.PNG");
  });

  it("paginates when IsTruncated=true", async () => {
    s3Mock
      .on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: "a/file.txt", Size: 1, LastModified: new Date() }],
        IsTruncated: true,
        NextContinuationToken: "tok-1",
      })
      .resolvesOnce({
        Contents: [{ Key: "b/file.txt", Size: 2, LastModified: new Date() }],
        IsTruncated: false,
      });

    const { client } = makeHarness();
    const res = await client.search("file.txt");
    expect(res).toHaveLength(2);
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// authenticate
// ---------------------------------------------------------------------------

describe("S3Client — authenticate", () => {
  it("returns a credentials-form intent; successful submit + HeadBucket yields AuthResult with creds in meta", async () => {
    s3Mock.on(HeadBucketCommand).resolves({});

    const { client } = makeHarness();
    const intent = (await client.authenticate()) as CredentialsFormIntent;
    expect(intent.kind).toBe("credentials-form");
    expect(intent.schema).toBe("aws-access-key");

    const result = await intent.submit({
      accessKeyId: "AKIA-NEW",
      secretAccessKey: "SK-NEW",
      region: "eu-west-1",
      bucket: "another-bucket",
    });
    expect(result.accessToken).toBe("");
    expect(result.meta).toEqual({
      accessKeyId: "AKIA-NEW",
      secretAccessKey: "SK-NEW",
      region: "eu-west-1",
      bucket: "another-bucket",
    });
  });

  it("HeadBucket 403 → submit rejects with DatasourceError tag 'auth-revoked'", async () => {
    const err = new Error("AccessDenied");
    (err as { name: string }).name = "AccessDenied";
    (err as { $metadata?: { httpStatusCode: number } }).$metadata = {
      httpStatusCode: 403,
    };
    s3Mock.on(HeadBucketCommand).rejects(err);

    const { client } = makeHarness();
    const intent = (await client.authenticate()) as CredentialsFormIntent;
    await expect(
      intent.submit({
        accessKeyId: "bad",
        secretAccessKey: "bad",
        region: "us-east-1",
        bucket: "x",
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DatasourceError && e.tag === "auth-revoked",
    );
  });

  it("submit with missing required field rejects with provider-error", async () => {
    const { client } = makeHarness();
    const intent = (await client.authenticate()) as CredentialsFormIntent;
    await expect(
      intent.submit({ accessKeyId: "AK" }),
    ).rejects.toBeInstanceOf(DatasourceError);
  });
});

// ---------------------------------------------------------------------------
// refreshToken
// ---------------------------------------------------------------------------

describe("S3Client — refreshToken", () => {
  it("static keys cannot refresh — throws DatasourceError tag 'auth-revoked'", async () => {
    // Exercise via direct normalize path: auth-expired is redirected to
    // auth-revoked by normalizeError so the base's refresh path never fires.
    // But if it did fire, refreshTokenImpl must fail with auth-revoked.
    const { client } = makeHarness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refreshImpl = (client as any).refreshTokenImpl.bind(client);
    await expect(refreshImpl()).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DatasourceError && e.tag === "auth-revoked",
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeError — taxonomy coverage
// ---------------------------------------------------------------------------

describe("S3Client — normalizeError taxonomy", () => {
  function normalize(client: S3Client, raw: unknown): DatasourceError<"amazon-s3"> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (client as any).normalizeErrorImpl(raw);
  }

  it("404 / NoSuchKey → not-found", () => {
    const { client } = makeHarness();
    expect(normalize(client, { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }).tag).toBe(
      "not-found",
    );
    expect(normalize(client, { $metadata: { httpStatusCode: 404 } }).tag).toBe(
      "not-found",
    );
  });

  it("403 / AccessDenied / InvalidAccessKeyId / SignatureDoesNotMatch → auth-revoked", () => {
    const { client } = makeHarness();
    expect(normalize(client, { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }).tag).toBe(
      "auth-revoked",
    );
    expect(normalize(client, { name: "InvalidAccessKeyId" }).tag).toBe("auth-revoked");
    expect(normalize(client, { name: "SignatureDoesNotMatch" }).tag).toBe(
      "auth-revoked",
    );
  });

  it("SlowDown / TooManyRequests / 503 → rate-limited, carries retryAfterMs when Retry-After header present", () => {
    const { client } = makeHarness();
    expect(normalize(client, { name: "SlowDown" }).tag).toBe("rate-limited");
    expect(
      normalize(client, { name: "TooManyRequests" }).tag,
    ).toBe("rate-limited");
    const with503 = normalize(client, {
      $metadata: {
        httpStatusCode: 503,
        // Retry-After header carried on `$response.headers` by the SDK.
      },
      $response: { headers: { "retry-after": "7" } },
    });
    expect(with503.tag).toBe("rate-limited");
    expect(with503.retryAfterMs).toBe(7000);
  });

  it("network errors (NetworkingError / ECONNRESET / ETIMEDOUT) → network-error retryable=true", () => {
    const { client } = makeHarness();
    const netErr = normalize(client, { name: "NetworkingError" });
    expect(netErr.tag).toBe("network-error");
    expect(netErr.retryable).toBe(true);
    expect(normalize(client, { code: "ECONNRESET" }).tag).toBe("network-error");
    expect(normalize(client, { code: "ETIMEDOUT" }).tag).toBe("network-error");
  });

  it("412 / PreconditionFailed → conflict", () => {
    const { client } = makeHarness();
    expect(normalize(client, { name: "PreconditionFailed" }).tag).toBe("conflict");
    expect(normalize(client, { $metadata: { httpStatusCode: 412 } }).tag).toBe("conflict");
  });

  it("unknown → provider-error", () => {
    const { client } = makeHarness();
    expect(normalize(client, new Error("no idea")).tag).toBe("provider-error");
    expect(normalize(client, "just a string").tag).toBe("provider-error");
  });
});

// ---------------------------------------------------------------------------
// getQuota — Unsupported
// ---------------------------------------------------------------------------

describe("S3Client — getQuota", () => {
  it("throws Unsupported (capability quota=false short-circuits in the base)", async () => {
    const { client } = makeHarness();
    await expect(client.getQuota()).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DatasourceError && e.tag === "unsupported",
    );
  });
});

// ---------------------------------------------------------------------------
// uploadFile — multipart via lib-storage Upload, wires httpUploadProgress
// ---------------------------------------------------------------------------

describe("S3Client — uploadFile (multipart via lib-storage)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "s3-test-up-"));
  const bigFile = join(tmp, "big.bin");
  // Small file — lib-storage falls back to single PutObject under partSize.
  writeFileSync(bigFile, "multipart-small-fake-body");

  // Note: we deliberately do NOT rmSync the tmp dir in afterAll. The AWS SDK
  // mock swallows command inputs without consuming the request-body stream,
  // so `createReadStream` handles may linger one tick after the test body
  // resolves and trigger an ENOENT when they try to read from a deleted
  // directory. The OS cleans tmpdir entries on its own schedule; these tests
  // are short-lived, the leak is negligible.

  it("uploads via lib-storage Upload and resolves with the new entry; threads options.onProgress (engine emits nothing — no event bus post-migrate-engine-events-to-consumer)", async () => {
    // For small bodies, lib-storage uses PutObject (not multipart). The
    // strategy threads `options.onProgress` to the SDK's
    // `httpUploadProgress` event; the engine has no event bus.
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag-up"' });
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "uid" });
    s3Mock.on(UploadPartCommand).resolves({ ETag: '"p1"' });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"etag-up"' });

    const onProgress = vi.fn<(loaded: number, total: number) => void>();
    const { client } = makeHarness();
    const entry = await client.uploadFile(
      { kind: "path", path: "/uploads" },
      { path: bigFile, name: "big.bin" },
      { onProgress },
    );

    expect(entry.path).toBe("/uploads/big.bin");
    expect(entry.providerMetadata.bucket).toBe("test-bucket");
    expect(entry.providerMetadata.key).toBe("uploads/big.bin");
    expect(entry.providerMetadata.etag).toBeDefined();
  });

  it("signal-driven cancel mid-upload triggers Upload.abort() and rejects with cancelled tag", async () => {
    // Hold PutObject open so the cancel has a window. When the consumer
    // aborts options.signal, the strategy's abort-listener fires
    // `upload.abort()`. lib-storage's `__doMultipartUpload` sees
    // `abortController.signal.aborted` on resumption and rejects the
    // done() promise. The strategy's normalizeError path tags the
    // rejection `cancelled`.
    let releasePut!: () => void;
    s3Mock.on(PutObjectCommand).callsFake(
      () =>
        new Promise<{ ETag: string }>((resolve) => {
          releasePut = () => resolve({ ETag: '"etag-never"' });
        }),
    );
    const { client } = makeHarness();
    const controller = new AbortController();

    const uploadPromise = client.uploadFile(
      { kind: "path", path: "/uploads" },
      { path: bigFile, name: "big.bin" },
      { signal: controller.signal },
    );
    // Yield to give the strategy time to register its abort listener
    // against the user signal and kick off the SDK Upload.
    await new Promise<void>((r) => setImmediate(r));

    controller.abort();
    // Release the pending PutObject so a non-aborted `done()` still
    // settles deterministically. Defensive — abort itself should
    // unwind via the SDK's internal AbortController.
    releasePut?.();

    await expect(uploadPromise).rejects.toSatisfy(
      (e: unknown) => e instanceof DatasourceError && e.tag === "cancelled",
    );
  });
});

// ---------------------------------------------------------------------------
// testConnection — HeadBucket
// ---------------------------------------------------------------------------

describe("S3Client — testConnection / status", () => {
  it("testConnection resolves on HeadBucket success", async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    const { client } = makeHarness();
    await expect(client.testConnection()).resolves.toBeUndefined();
  });

  it("status returns 'connected' on HeadBucket success", async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    const { client } = makeHarness();
    await expect(client.status()).resolves.toBe("connected");
  });
});

// ---------------------------------------------------------------------------
// rename — file/folder introspection (§9.1-§9.2)
// ---------------------------------------------------------------------------
//
// S3 has no native rename. For file targets we issue CopyObject + DeleteObject;
// for folder targets we refuse (unsupported). The strategy's introspection
// helper distinguishes the two via:
//   - HeadObject(key) → 200 → file
//   - HeadObject(key) → 404, then ListObjectsV2(Prefix=key+"/", MaxKeys=1) →
//     at least one key → folder (S3's "virtual folder" — a prefix with at
//     least one descendant key)
//   - both 404 → not-found
//
// Helpers below build the AWS-shaped errors so the rename branches see the
// same shape `normalizeErrorImpl` already understands.

function awsNotFoundError(): Error {
  const err = new Error("NotFound");
  (err as { name: string }).name = "NotFound";
  (err as { $metadata?: { httpStatusCode: number } }).$metadata = {
    httpStatusCode: 404,
  };
  return err;
}

describe("S3Client — doRenameImpl introspection (file vs virtual-folder vs not-found)", () => {
  it("HeadObject 200 → file branch: issues CopyObject + DeleteObject; resolves with the renamed entry", async () => {
    // HeadObject answers 200 for the source key.
    s3Mock.on(HeadObjectCommand, { Key: "old.txt" }).resolves({
      ContentLength: 12,
      LastModified: new Date("2024-06-01"),
      ETag: '"old-etag"',
    });
    // Sibling pre-check (HeadObject on the target) → 404 (no collision).
    s3Mock.on(HeadObjectCommand, { Key: "new.txt" }).rejects(awsNotFoundError());
    s3Mock.on(CopyObjectCommand).resolves({
      CopyObjectResult: { ETag: '"new-etag"', LastModified: new Date("2024-06-02") },
    });
    s3Mock.on(DeleteObjectCommand).resolves({});
    const { client } = makeHarness();
    const entry = await client.rename(
      { kind: "path", path: "/old.txt" },
      "new.txt",
      "fail",
    );
    expect(entry.kind).toBe("file");
    expect(entry.handle).toBe("new.txt");
    expect(entry.path).toBe("/new.txt");
    expect(entry.providerMetadata.key).toBe("new.txt");
  });

  it("HeadObject 404 + ListObjectsV2 returns ≥1 key → folder branch: throws unsupported with the S3-folder-rename message; no Copy/Delete issued", async () => {
    s3Mock.on(HeadObjectCommand).rejects(awsNotFoundError());
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "photos/inner.jpg" }],
    });
    const { client } = makeHarness();
    await expect(
      client.rename({ kind: "path", path: "/photos" }, "pictures", "fail"),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DatasourceError &&
        e.tag === "unsupported" &&
        e.message === "S3 folder rename is not supported in this version",
    );
    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it("HeadObject 404 AND ListObjectsV2 returns no keys → not-found", async () => {
    s3Mock.on(HeadObjectCommand).rejects(awsNotFoundError());
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
    const { client } = makeHarness();
    await expect(
      client.rename({ kind: "path", path: "/missing.txt" }, "new.txt", "fail"),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof DatasourceError && e.tag === "not-found",
    );
  });
});

// ---------------------------------------------------------------------------
// rename — file-rename branch (§9.3-§9.4)
// ---------------------------------------------------------------------------

describe("S3Client — doRenameImpl file-rename CopyObject + DeleteObject", () => {
  it("issues CopyObject with CopySource '<bucket>/<oldKey>' / Key '<newKey>' / Bucket '<bucket>', then DeleteObject for the original key; resolves with the new entry", async () => {
    s3Mock.on(HeadObjectCommand, { Key: "docs/old.pdf" }).resolves({
      ContentLength: 99,
      LastModified: new Date("2024-06-01"),
      ETag: '"old-etag"',
    });
    s3Mock.on(HeadObjectCommand, { Key: "docs/new.pdf" }).rejects(awsNotFoundError());
    s3Mock.on(CopyObjectCommand).resolves({
      CopyObjectResult: { ETag: '"new-etag"', LastModified: new Date("2024-06-02") },
    });
    s3Mock.on(DeleteObjectCommand).resolves({});
    const { client } = makeHarness();
    const entry = await client.rename(
      { kind: "path", path: "/docs/old.pdf" },
      "new.pdf",
      "fail",
    );
    expect(entry.handle).toBe("docs/new.pdf");
    expect(entry.path).toBe("/docs/new.pdf");
    expect(entry.name).toBe("new.pdf");
    expect(entry.kind).toBe("file");
    expect(entry.providerMetadata.bucket).toBe("test-bucket");
    expect(entry.providerMetadata.key).toBe("docs/new.pdf");
    expect(entry.providerMetadata.etag).toBe('"new-etag"');
    // CopyObject input verification.
    const copyCalls = s3Mock.commandCalls(CopyObjectCommand);
    expect(copyCalls).toHaveLength(1);
    const copyInput = copyCalls[0]!.args[0].input;
    expect(copyInput.Bucket).toBe("test-bucket");
    expect(copyInput.Key).toBe("docs/new.pdf");
    expect(copyInput.CopySource).toBe("test-bucket/docs/old.pdf");
    // DeleteObject input verification — issued on the OLD key.
    const delCalls = s3Mock.commandCalls(DeleteObjectCommand);
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0]!.args[0].input.Key).toBe("docs/old.pdf");
  });
});

// ---------------------------------------------------------------------------
// rename — orphan-tolerance on DeleteObject failure (§9.5-§9.6)
// ---------------------------------------------------------------------------

describe("S3Client — doRenameImpl orphan-tolerance on DeleteObject failure", () => {
  it("when CopyObject succeeds but DeleteObject fails, still resolves with the renamed entry (per Decision 2: rename succeeded from user's perspective)", async () => {
    s3Mock.on(HeadObjectCommand, { Key: "old.txt" }).resolves({
      ContentLength: 5,
      LastModified: new Date("2024-06-01"),
    });
    s3Mock.on(HeadObjectCommand, { Key: "new.txt" }).rejects(awsNotFoundError());
    s3Mock.on(CopyObjectCommand).resolves({
      CopyObjectResult: { ETag: '"new"', LastModified: new Date("2024-06-02") },
    });
    // DeleteObject fails after the copy lands (orphan scenario).
    s3Mock.on(DeleteObjectCommand).rejects(new Error("delete-blew-up"));
    const { client } = makeHarness();
    const entry = await client.rename(
      { kind: "path", path: "/old.txt" },
      "new.txt",
      "fail",
    );
    expect(entry.handle).toBe("new.txt");
    expect(entry.kind).toBe("file");
    // The failed DeleteObject does not surface to the caller; the rename
    // succeeded from the user's perspective per design.md Decision 2.
  });
});

// ---------------------------------------------------------------------------
// rename — folder refusal (§9.7-§9.8) covered above in §9.1-§9.2 introspection
// (kept here as a focused redundant assertion for cross-reference clarity).
// ---------------------------------------------------------------------------

describe("S3Client — doRenameImpl folder refusal (no CopyObject / DeleteObject)", () => {
  it("when introspection identifies a folder (HeadObject 404 + ListObjectsV2 has results), no CopyObject/DeleteObject are issued; throws DatasourceError tag='unsupported'", async () => {
    s3Mock.on(HeadObjectCommand).rejects(awsNotFoundError());
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "albums/2024/img.jpg" }],
    });
    const { client } = makeHarness();
    let caught: unknown;
    try {
      await client.rename(
        { kind: "path", path: "/albums" },
        "newAlbums",
        "fail",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    expect((caught as DatasourceError<"amazon-s3">).tag).toBe("unsupported");
    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// rename — sibling-collision pre-check on `fail` (§9.9-§9.10)
// ---------------------------------------------------------------------------

describe("S3Client — doRenameImpl sibling-collision pre-check on `fail`", () => {
  it("HeadObject for the target key returns 200 → throws conflict { existingPath: '/<newKey>' }; no CopyObject / DeleteObject issued", async () => {
    // Source HeadObject is a file.
    s3Mock.on(HeadObjectCommand, { Key: "foo.txt" }).resolves({
      ContentLength: 1,
      LastModified: new Date(),
    });
    // Target HeadObject says 200 (collision).
    s3Mock.on(HeadObjectCommand, { Key: "bar.txt" }).resolves({
      ContentLength: 1,
      LastModified: new Date(),
    });
    const { client } = makeHarness();
    let caught: unknown;
    try {
      await client.rename({ kind: "path", path: "/foo.txt" }, "bar.txt", "fail");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<"amazon-s3">;
    expect(err.tag).toBe("conflict");
    expect((err.raw as { existingPath?: string }).existingPath).toBe(
      "/bar.txt",
    );
    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it("HeadObject for the target key returns 404 → proceeds with CopyObject + DeleteObject", async () => {
    s3Mock.on(HeadObjectCommand, { Key: "foo.txt" }).resolves({
      ContentLength: 1,
      LastModified: new Date(),
    });
    s3Mock.on(HeadObjectCommand, { Key: "bar.txt" }).rejects(awsNotFoundError());
    s3Mock.on(CopyObjectCommand).resolves({
      CopyObjectResult: { ETag: '"e"', LastModified: new Date() },
    });
    s3Mock.on(DeleteObjectCommand).resolves({});
    const { client } = makeHarness();
    const entry = await client.rename(
      { kind: "path", path: "/foo.txt" },
      "bar.txt",
      "fail",
    );
    expect(entry.handle).toBe("bar.txt");
    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// rename — `overwrite` on file uses S3's natural CopyObject overwrite (§9.11-§9.12)
// ---------------------------------------------------------------------------

describe("S3Client — doRenameImpl overwrite on file (S3 natural overwrite via CopyObject)", () => {
  it("when conflictPolicy='overwrite' on a file, issues CopyObject (overwrites existing) + DeleteObject for the original; no explicit pre-delete (S3's CopyObject is naturally overwriting, unlike Drive/OneDrive)", async () => {
    s3Mock.on(HeadObjectCommand, { Key: "old.txt" }).resolves({
      ContentLength: 9,
      LastModified: new Date(),
    });
    // Target key already exists — overwrite path proceeds anyway.
    s3Mock.on(HeadObjectCommand, { Key: "new.txt" }).resolves({
      ContentLength: 4,
      LastModified: new Date(),
    });
    s3Mock.on(CopyObjectCommand).resolves({
      CopyObjectResult: { ETag: '"new"', LastModified: new Date() },
    });
    s3Mock.on(DeleteObjectCommand).resolves({});
    const { client } = makeHarness();
    const entry = await client.rename(
      { kind: "path", path: "/old.txt" },
      "new.txt",
      "overwrite",
    );
    expect(entry.handle).toBe("new.txt");
    // Exactly one CopyObject; exactly one DeleteObject (for the original).
    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(1);
    const delCalls = s3Mock.commandCalls(DeleteObjectCommand);
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0]!.args[0].input.Key).toBe("old.txt");
  });
});

// ---------------------------------------------------------------------------
// rename — directory-overwrite refusal (§9.13-§9.14)
// ---------------------------------------------------------------------------

describe("S3Client — doRenameImpl directory-overwrite refusal", () => {
  it("when introspection resolves folder + conflictPolicy='overwrite', throws unsupported with the directory-overwrite message; no CopyObject / DeleteObject issued", async () => {
    s3Mock.on(HeadObjectCommand).rejects(awsNotFoundError());
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "dir/inner.txt" }],
    });
    const { client } = makeHarness();
    let caught: unknown;
    try {
      await client.rename(
        { kind: "path", path: "/dir" },
        "newDir",
        "overwrite",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<"amazon-s3">;
    expect(err.tag).toBe("unsupported");
    expect(err.message).toBe(
      "directory rename with conflictPolicy 'overwrite' is not supported (would require recursive replacement)",
    );
    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// downloadFile — GetObject stream (§9.15-§9.16)
// ---------------------------------------------------------------------------
//
// S3 GetObjectCommand returns a `Body` typed as `StreamingBlobTypes`. In Node
// runtimes the SDK reaches a Node Readable; tests pass a plain `Readable`
// instance as the mocked Body (the strategy code casts to Readable and pipes
// through a Transform).

describe("S3Client — doDownloadFileImpl (GetObject stream + Range + abortSignal)", () => {
  it("calls GetObject with Bucket+Key (no Range when rangeStart is undefined); resolves with stream + ContentLength; drains intact and fires options.onProgress (engine emits nothing — no event bus)", async () => {
    const fixture = Buffer.from("hello-from-s3");
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from(fixture) as unknown as undefined,
      ContentLength: fixture.length,
    });
    const onProgress = vi.fn<(loaded: number, total: number | null) => void>();
    const { client } = makeHarness();
    const result = await client.downloadFile(
      { kind: "path", path: "/hello.txt" },
      { onProgress },
    );
    expect(result.contentLength).toBe(fixture.length);
    expect(result.contentRange).toBeUndefined();
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      result.stream.on("data", (c: Buffer) => chunks.push(c));
      result.stream.on("end", () => resolve());
      result.stream.on("error", reject);
    });
    expect(Buffer.concat(chunks).toString()).toBe(fixture.toString());
    const getInput = s3Mock.commandCalls(GetObjectCommand)[0]!.args[0].input;
    expect(getInput.Bucket).toBe("test-bucket");
    expect(getInput.Key).toBe("hello.txt");
    expect(getInput.Range).toBeUndefined();
    // Progress is consumer-observed via options.onProgress (the sole progress
    // channel — the engine no longer emits `downloading`/`file-downloaded`).
    // The final loaded count reaches the full byte length on a complete drain.
    expect(onProgress).toHaveBeenCalled();
    const lastCall = onProgress.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe(fixture.length);
  });

  it("forwards options.rangeStart > 0 as Range:bytes=<n>- on GetObject; parses ContentRange from the 206-equivalent response", async () => {
    const partial = Buffer.from("PARTIAL");
    const total = 1024;
    const start = 16;
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from(partial) as unknown as undefined,
      ContentLength: partial.length,
      ContentRange: `bytes ${start}-${start + partial.length - 1}/${total}`,
    });
    const { client } = makeHarness();
    const result = await client.downloadFile(
      { kind: "handle", handle: "RANGE-KEY" },
      { rangeStart: start },
    );
    expect(result.contentLength).toBe(partial.length);
    expect(result.contentRange).toEqual({
      start,
      end: start + partial.length - 1,
      total,
    });
    // Drain the stream to completion.
    await new Promise<void>((resolve, reject) => {
      result.stream.on("data", () => {});
      result.stream.on("end", () => resolve());
      result.stream.on("error", reject);
    });
    const getInput = s3Mock.commandCalls(GetObjectCommand)[0]!.args[0].input;
    expect(getInput.Range).toBe(`bytes=${start}-`);
    expect(getInput.Key).toBe("RANGE-KEY");
  });
});

// ---------------------------------------------------------------------------
// downloadFile — AbortSignal forwarding (§9.17)
// ---------------------------------------------------------------------------

describe("S3Client — doDownloadFileImpl AbortSignal forwarding", () => {
  it("aborting the consumer signal propagates AbortError: the returned stream errors with a normalized tag:cancelled DatasourceError, and options.onProgress's last loaded reflects the bytes seen at abort time", async () => {
    const controller = new AbortController();
    // GetObject mock returns a Readable that pushes one chunk then awaits abort.
    let pushedFirstChunk = false;
    const body = new Readable({
      read() {
        if (!pushedFirstChunk) {
          pushedFirstChunk = true;
          this.push(Buffer.alloc(2048));
          // Don't end the stream — wait for abort.
        }
      },
    });
    // Wire abort: when the consumer signal aborts, error the body with AbortError.
    controller.signal.addEventListener(
      "abort",
      () => {
        body.destroy(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      },
      { once: true },
    );
    s3Mock.on(GetObjectCommand).callsFake(() =>
      Promise.resolve({
        Body: body,
        ContentLength: 16384,
      }),
    );
    const onProgress = vi.fn<(loaded: number, total: number | null) => void>();
    const { client } = makeHarness();
    const result = await client.downloadFile(
      { kind: "handle", handle: "CANCEL-KEY" },
      { signal: controller.signal, onProgress },
    );
    let bytesSeen = 0;
    let caught: unknown;
    await new Promise<void>((resolve) => {
      result.stream.on("data", (c: Buffer) => {
        bytesSeen += c.length;
        if (bytesSeen >= 2048) controller.abort();
      });
      result.stream.on("error", (e: unknown) => {
        caught = e;
        resolve();
      });
      result.stream.on("end", () => resolve());
    });
    // The engine no longer emits download-cancelled; the cancellation surfaces
    // as the stream erroring with a normalized tag:cancelled DatasourceError.
    expect(caught).toBeInstanceOf(DatasourceError);
    expect((caught as DatasourceError<"amazon-s3">).tag).toBe("cancelled");
    // The old download-cancelled event's `bytesDownloaded` analog: the last
    // onProgress loaded reaches the first-chunk byte count seen before abort.
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress.mock.calls.at(-1)![0]).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// downloadFile — mid-stream ExpiredToken → auth-expired → download-failed (§9.18)
// ---------------------------------------------------------------------------

describe("S3Client — doDownloadFileImpl mid-stream ExpiredToken → auth-expired", () => {
  it("when the body errors mid-stream with name='ExpiredToken', normalizeErrorImpl maps to tag:auth-expired; the returned stream errors with that normalized DatasourceError (engine emits nothing — no event bus)", async () => {
    let pushedFirst = false;
    let scheduledError = false;
    const body = new Readable({
      read() {
        if (!pushedFirst) {
          pushedFirst = true;
          this.push(Buffer.alloc(512));
        }
        if (!scheduledError) {
          scheduledError = true;
          setTimeout(() => {
            const err = Object.assign(new Error("token expired"), {
              name: "ExpiredToken",
            });
            this.destroy(err);
          }, 5);
        }
      },
    });
    s3Mock.on(GetObjectCommand).resolves({
      Body: body as unknown as undefined,
      ContentLength: 8192,
    });
    const { client } = makeHarness();
    const result = await client.downloadFile({
      kind: "handle",
      handle: "EXP-KEY",
    });
    let caught: unknown;
    await new Promise<void>((resolve) => {
      result.stream.on("data", () => {});
      result.stream.on("end", () => resolve());
      result.stream.on("error", (e: unknown) => {
        caught = e;
        resolve();
      });
    });
    // The mid-stream provider error is normalized and surfaced as the
    // returned stream's `error` — there is no download-failed event.
    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<"amazon-s3">;
    expect(err.tag).toBe("auth-expired");
    expect(err.datasourceType).toBe("amazon-s3");
    expect(err.datasourceId).toBe("ds-s3-1");
  });
});

// ---------------------------------------------------------------------------
// AbortError + ExpiredToken normalization branches (§9.17 + §9.18 — unit-level)
// ---------------------------------------------------------------------------

describe("S3Client — normalizeError AbortError + ExpiredToken branches", () => {
  function normalize(client: S3Client, raw: unknown): DatasourceError<"amazon-s3"> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (client as any).normalizeErrorImpl(raw);
  }

  it("AbortError name → tag:cancelled (NOT network-error; placed before the network branch)", () => {
    const { client } = makeHarness();
    const err = Object.assign(new Error("abort"), { name: "AbortError" });
    expect(normalize(client, err).tag).toBe("cancelled");
  });

  it("ExpiredToken name → tag:auth-expired (NOT auth-revoked) — surfaces mid-stream STS-temporary-credential expiry to fs-sync's retry loop", () => {
    const { client } = makeHarness();
    expect(normalize(client, { name: "ExpiredToken" }).tag).toBe("auth-expired");
  });
});

// ---------------------------------------------------------------------------
// rename — `keep-both` policy retries with suffix until success (§9.19-§9.20)
// ---------------------------------------------------------------------------

describe("S3Client — doRenameImpl keep-both suffix retry", () => {
  it("first HeadObject for `bar.pdf` collides; second collides for `bar-2.pdf`; third returns 404 for `bar-3.pdf`; then CopyObject + DeleteObject; entry.name='bar-3.pdf'", async () => {
    // Source key.
    s3Mock.on(HeadObjectCommand, { Key: "foo.pdf" }).resolves({
      ContentLength: 100,
      LastModified: new Date(),
    });
    // Two collisions, then a 404.
    s3Mock.on(HeadObjectCommand, { Key: "bar.pdf" }).resolves({
      ContentLength: 1,
      LastModified: new Date(),
    });
    s3Mock.on(HeadObjectCommand, { Key: "bar-2.pdf" }).resolves({
      ContentLength: 1,
      LastModified: new Date(),
    });
    s3Mock.on(HeadObjectCommand, { Key: "bar-3.pdf" }).rejects(awsNotFoundError());
    s3Mock.on(CopyObjectCommand).resolves({
      CopyObjectResult: { ETag: '"new"', LastModified: new Date() },
    });
    s3Mock.on(DeleteObjectCommand).resolves({});
    const { client } = makeHarness();
    const entry = await client.rename(
      { kind: "path", path: "/foo.pdf" },
      "bar.pdf",
      "keep-both",
    );
    expect(entry.name).toBe("bar-3.pdf");
    expect(entry.handle).toBe("bar-3.pdf");
    // CopyObject issued exactly once with the chosen name.
    const copyCalls = s3Mock.commandCalls(CopyObjectCommand);
    expect(copyCalls).toHaveLength(1);
    expect(copyCalls[0]!.args[0].input.Key).toBe("bar-3.pdf");
    expect(copyCalls[0]!.args[0].input.CopySource).toBe("test-bucket/foo.pdf");
  });

  it("after 99 collisions (newName + suffixes 2..99), throws DatasourceError { tag:'provider-error', message:'exhausted keep-both attempts' }; no CopyObject issued", async () => {
    // Source HeadObject always 200.
    s3Mock.on(HeadObjectCommand, { Key: "foo.pdf" }).resolves({
      ContentLength: 1,
      LastModified: new Date(),
    });
    // All other HeadObject targets respond 200 (collision).
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 1,
      LastModified: new Date(),
    });
    const { client } = makeHarness();
    let caught: unknown;
    try {
      await client.rename(
        { kind: "path", path: "/foo.pdf" },
        "bar.pdf",
        "keep-both",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<"amazon-s3">;
    expect(err.tag).toBe("provider-error");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe("exhausted keep-both attempts");
    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(0);
  });
});
