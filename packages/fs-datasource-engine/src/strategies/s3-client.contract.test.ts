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

import {
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client as AwsS3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { providers, type StoredCredentials } from "@ft5/ipc-contracts";

import type { BaseClientContext } from "../base-client.js";
import { runStrategyContractSuite, type StrategyContractFixture } from "../__tests__/strategy-contract.js";
import { createS3Client } from "./s3-client.js";

const s3Mock = mockClient(AwsS3Client);

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

  resetMock() {
    s3Mock.reset();
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

  primeDeleteOk() {
    s3Mock.on(DeleteObjectCommand).resolves({});
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
