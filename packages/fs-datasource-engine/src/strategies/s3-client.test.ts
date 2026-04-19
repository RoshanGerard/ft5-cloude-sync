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

import {
  DeleteObjectCommand,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CredentialsFormIntent,
  StoredCredentials,
} from "@ft5/ipc-contracts";
import { DatasourceError, providers } from "@ft5/ipc-contracts";

import { createEventBus, type EventBus } from "../event-bus.js";
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
  bus: EventBus;
  events: unknown[];
  client: S3Client;
} {
  const bus = createEventBus();
  const events: unknown[] = [];
  bus.subscribe((e) => {
    events.push(e);
  });
  const ctx: BaseClientContext = {
    bus,
    credentialStore: makeStore(),
    providerDescriptor: providers["amazon-s3"],
  };
  const client = createS3Client("ds-s3-1", makeCreds(credsOverrides), ctx);
  return { bus, events, client };
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
  it("issues ListObjectsV2 with Prefix + Delimiter and maps Contents + CommonPrefixes to FileEntry", async () => {
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
    const entries = await client.listDirectory({ kind: "path", path: "/photos" });

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

describe("S3Client — deleteFile", () => {
  it("issues DeleteObject and emits `deleted`", async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    const { client, events } = makeHarness();
    await client.deleteFile({ kind: "path", path: "/todelete.txt" });
    const names = (events as Array<{ event: string }>).map((e) => e.event);
    expect(names).toContain("deleted");
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
// createFile — PutObject from local path
// ---------------------------------------------------------------------------

describe("S3Client — createFile", () => {
  const tmp = mkdtempSync(join(tmpdir(), "s3-test-"));
  const localFile = join(tmp, "hi.txt");
  writeFileSync(localFile, "hello from test\n");

  // Note: we deliberately do NOT rmSync the tmp dir in afterAll. The AWS SDK
  // mock swallows command inputs without consuming the request-body stream,
  // so `createReadStream` handles may linger one tick after the test body
  // resolves and trigger an ENOENT when they try to read from a deleted
  // directory. The OS cleans tmpdir entries on its own schedule; these tests
  // are short-lived, the leak is negligible.

  it("puts the file under parent/name and emits file-created", async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag-new"' });
    const { client, events } = makeHarness();
    const entry = await client.createFile(
      { kind: "path", path: "/inbox" },
      "hi.txt",
      { path: localFile },
    );
    expect(entry.path).toBe("/inbox/hi.txt");
    expect(entry.handle).toBe("inbox/hi.txt");
    expect(entry.providerMetadata.bucket).toBe("test-bucket");
    expect(entry.providerMetadata.key).toBe("inbox/hi.txt");
    expect(entry.providerMetadata.etag).toBe('"etag-new"');

    const input = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(input.Bucket).toBe("test-bucket");
    expect(input.Key).toBe("inbox/hi.txt");

    const names = (events as Array<{ event: string }>).map((e) => e.event);
    expect(names).toContain("file-created");
  });

  it("createFile succeeds with IfNoneMatch on a fresh key", async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag-fresh"' });
    const { client } = makeHarness();
    const entry = await client.createFile(
      { kind: "path", path: "/inbox" },
      "fresh.txt",
      { path: localFile },
    );
    expect(entry.handle).toBe("inbox/fresh.txt");
    expect(entry.providerMetadata.etag).toBe('"etag-fresh"');

    // Verify IfNoneMatch was set on the PutObject request so S3 rejects
    // existing keys with 412 instead of silently overwriting.
    const input = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(input.IfNoneMatch).toBe("*");
  });

  it("createFile rejects with conflict tag when key already exists (IfNoneMatch collision)", async () => {
    const err = new Error("PreconditionFailed");
    (err as { name: string }).name = "PreconditionFailed";
    (err as { $metadata?: { httpStatusCode: number } }).$metadata = {
      httpStatusCode: 412,
    };
    s3Mock.on(PutObjectCommand).rejects(err);

    const { client } = makeHarness();
    await expect(
      client.createFile(
        { kind: "path", path: "/inbox" },
        "existing.txt",
        { path: localFile },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof DatasourceError && e.tag === "conflict",
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

  // Cleanup intentionally omitted — see note in the createFile describe.

  it("uploads via lib-storage Upload; emits uploading (streaming) progress ticks then file-created", async () => {
    // For small bodies, lib-storage uses PutObject (not multipart). That's
    // fine — we assert the Upload path emits progress + file-created.
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag-up"' });
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "uid" });
    s3Mock.on(UploadPartCommand).resolves({ ETag: '"p1"' });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"etag-up"' });

    const { client, events } = makeHarness();
    const entry = await client.uploadFile(
      { kind: "path", path: "/uploads" },
      { path: bigFile, name: "big.bin" },
    );

    expect(entry.path).toBe("/uploads/big.bin");
    expect(entry.providerMetadata.bucket).toBe("test-bucket");
    expect(entry.providerMetadata.key).toBe("uploads/big.bin");
    expect(entry.providerMetadata.etag).toBeDefined();

    const names = (events as Array<{ event: string }>).map((e) => e.event);
    expect(names).toContain("uploading");
    expect(names).toContain("file-created");
    // file-created emits AFTER uploading
    expect(names.indexOf("uploading")).toBeLessThan(names.indexOf("file-created"));
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
