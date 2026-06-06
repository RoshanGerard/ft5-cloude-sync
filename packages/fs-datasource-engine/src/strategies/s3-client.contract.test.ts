// S3Client shared-contract-suite invocation.
//
// This file supplies an S3-shaped `StrategyContractFixture` and delegates to
// `runStrategyContractSuite` (see `../__tests__/strategy-contract.ts`). Every
// cross-provider behaviour the base class / descriptor promises is exercised
// here without duplicating the scenarios — Phases 7 / 8 will ship their own
// similarly-shaped fixture file for OneDrive and Google Drive.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Readable } from "node:stream";

import {
  AbortMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client as AwsS3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { mockClient } from "aws-sdk-client-mock";
import { vi } from "vitest";

import { providers, type StoredCredentials } from "@ft5/ipc-contracts";

import type { BaseClientContext } from "../base-client.js";
import { runStrategyContractSuite, type StrategyContractFixture } from "../__tests__/strategy-contract.js";
import { createS3Client } from "./s3-client.js";

const s3Mock = mockClient(AwsS3Client);

// Spy on `Upload.prototype.abort` so the cancel-upload contract scenario
// can verify the strategy invoked it (per migrate-upload-orchestration-
// out-of-engine Decision 3 — S3 uses the SDK's own internal controller
// for cleanup, no fresh AbortController is needed). The spy is reset
// inside `resetMock()` per scenario.
const uploadAbortSpy = vi.spyOn(Upload.prototype, "abort");

const credentials: StoredCredentials = {
  providerId: "amazon-s3",
  authResult: {
    accessToken: "",
    meta: {
      accessKeyId: "AKIAFAKE",
      secretAccessKey: "SK/fake",
      region: "us-east-1",
      bucket: "contract-bucket",
    },
  },
  createdAt: 0,
  updatedAt: 0,
};

const tmp = mkdtempSync(join(tmpdir(), "s3-contract-"));

const fixture: StrategyContractFixture = {
  credentials,
  expectedAuthErrorTag: "auth-revoked",
  supportsQuota: false,
  hasPathHandleCache: false,

  resetMock() {
    s3Mock.reset();
    uploadAbortSpy.mockClear();
  },

  primeListOk() {
    s3Mock.on(ListObjectsV2Command).resolves({
      CommonPrefixes: [{ Prefix: "folder-a/" }],
      Contents: [
        {
          Key: "file-a.txt",
          Size: 10,
          LastModified: new Date(),
          ETag: '"etag-contract"',
        },
      ],
      IsTruncated: false,
    });
  },

  primeGetMetadata404() {
    const err = new Error("NotFound");
    (err as { name: string }).name = "NotFound";
    (err as { $metadata?: { httpStatusCode: number } }).$metadata = {
      httpStatusCode: 404,
    };
    s3Mock.on(HeadObjectCommand).rejects(err);
  },

  primeRateLimitOnList() {
    const err = new Error("SlowDown");
    (err as { name: string }).name = "SlowDown";
    (err as { $metadata?: { httpStatusCode: number } }).$metadata = {
      httpStatusCode: 503,
    };
    s3Mock.on(ListObjectsV2Command).rejects(err);
  },

  primeAuthFailureOnList() {
    const err = new Error("AccessDenied");
    (err as { name: string }).name = "AccessDenied";
    (err as { $metadata?: { httpStatusCode: number } }).$metadata = {
      httpStatusCode: 403,
    };
    s3Mock.on(ListObjectsV2Command).rejects(err);
  },

  buildLocalFile() {
    const p = join(tmp, `contract-${Date.now()}-${Math.random()}.txt`);
    writeFileSync(p, "contract-body");
    return p;
  },

  primeUploadOk() {
    // lib-storage may route through simple PutObject (small body) or through
    // multipart — prime both paths defensively.
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"up-etag"' });
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "uid" });
    s3Mock.on(UploadPartCommand).resolves({ ETag: '"p1"' });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"up-etag"' });
  },

  primeUploadCancellable(opts) {
    // Multipart path: PutObjectCommand never resolves — `Upload.done()`
    // hangs until `upload.abort()` is invoked by the strategy's
    // signal listener, at which point the SDK's internal controller
    // cancels the in-flight commands. The mock-client's `.callsFake()`
    // returns a promise that rejects only when the cancel is observed
    // by the lib-storage internals. We use the simplest shape that
    // surfaces an abort-driven rejection: PutObject hangs forever, and
    // the strategy's `upload.abort()` call (verified via the
    // `uploadAbortSpy`) terminates the upload by triggering
    // `markUploadAsAborted()`. Since the mock's command never reaches
    // a real SDK signal, lib-storage's `.done()` rejects synchronously
    // after `.abort()` runs. Prime an AbortMultipartUploadCommand
    // resolution defensively in case multipart was initiated.
    s3Mock.on(PutObjectCommand).callsFake(
      (_input: unknown, _ctx: unknown) =>
        new Promise<never>((_resolve, reject) => {
          opts.controller.signal.addEventListener(
            "abort",
            () => {
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              );
            },
            { once: true },
          );
        }),
    );
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "uid" });
    s3Mock.on(UploadPartCommand).callsFake(
      (_input: unknown, _ctx: unknown) =>
        new Promise<never>((_resolve, reject) => {
          opts.controller.signal.addEventListener(
            "abort",
            () => {
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              );
            },
            { once: true },
          );
        }),
    );
    s3Mock.on(AbortMultipartUploadCommand).resolves({});
  },

  observedFreshCancelCleanup(_opts) {
    // S3's cleanup is `upload.abort()` — the SDK's internal controller
    // takes care of issuing `AbortMultipartUploadCommand` if a multipart
    // was allocated. No user-signal coupling is required because the
    // `Upload` instance manages its own controller. The verdict: the
    // strategy invoked `upload.abort()` at least once.
    return uploadAbortSpy.mock.calls.length > 0;
  },

  primeDeleteOk() {
    s3Mock.on(DeleteObjectCommand).resolves({});
  },

  // -------------------------------------------------------------------------
  // §10.1 — rename + download contract hooks
  // -------------------------------------------------------------------------

  primeRenameFileOk(opts) {
    const oldKey = opts.fromPath.replace(/^\//, "");
    const newKey = oldKey.includes("/")
      ? `${oldKey.slice(0, oldKey.lastIndexOf("/") + 1)}${opts.newName}`
      : opts.newName;
    // introspectKey(oldKey) → HeadObject 200 → "file"
    s3Mock
      .on(HeadObjectCommand, { Key: oldKey })
      .resolves({
        ContentLength: 12,
        LastModified: new Date("2024-06-01"),
        ETag: '"contract-old-etag"',
      });
    // sibling pre-check on `fail` → HeadObject(newKey) → 404
    const notFoundErr = Object.assign(new Error("NotFound"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
    s3Mock.on(HeadObjectCommand, { Key: newKey }).rejects(notFoundErr);
    s3Mock.on(CopyObjectCommand).resolves({
      CopyObjectResult: {
        ETag: '"contract-new-etag"',
        LastModified: new Date("2024-06-02"),
      },
    });
    s3Mock.on(DeleteObjectCommand).resolves({});
  },

  primeRenameDirectory(opts) {
    const folderKey = opts.fromPath.replace(/^\//, "");
    // introspectKey(folderKey) → HeadObject 404, ListObjectsV2(Prefix+"/")
    // returns ≥1 → return "folder" → strategy throws unsupported.
    const notFoundErr = Object.assign(new Error("NotFound"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
    s3Mock.on(HeadObjectCommand).rejects(notFoundErr);
    s3Mock
      .on(ListObjectsV2Command, { Prefix: `${folderKey}/` })
      .resolves({
        Contents: [{ Key: `${folderKey}/inner.txt` }],
        IsTruncated: false,
      });
  },

  supportsFolderRename: false,

  primeDownloadOk(opts) {
    const key = opts.path.replace(/^\//, "");
    s3Mock.on(GetObjectCommand, { Key: key }).resolves({
      Body: Readable.from(opts.bytes) as unknown as undefined,
      ContentLength: opts.bytes.length,
    });
  },

  primeDownloadCancellable(opts) {
    let pushedFirstChunk = false;
    const body = new Readable({
      read() {
        if (!pushedFirstChunk) {
          pushedFirstChunk = true;
          this.push(Buffer.alloc(opts.firstChunkBytes));
          // Don't end — wait for abort.
        }
      },
    });
    opts.controller.signal.addEventListener(
      "abort",
      () => {
        body.destroy(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      },
      { once: true },
    );
    const key = opts.path.replace(/^\//, "");
    s3Mock.on(GetObjectCommand, { Key: key }).resolves({
      Body: body as unknown as undefined,
      ContentLength: opts.totalBytes,
    });
  },
};

runStrategyContractSuite({
  providerName: "S3Client",
  buildClient: (bus, credentialStore, creds) => {
    const ctx: BaseClientContext = {
      bus,
      credentialStore,
      providerDescriptor: providers["amazon-s3"],
    };
    return createS3Client("ds-s3-contract", creds, ctx);
  },
  fixture,
});
