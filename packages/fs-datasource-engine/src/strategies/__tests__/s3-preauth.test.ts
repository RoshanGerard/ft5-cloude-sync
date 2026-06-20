// S3Client — `preAuth?: PreAuthConfig` constructor slot tests.
//
// implement-datasource-onboarding §2.6 + §2.7. S3 is a credentials-form
// provider; the preAuth slot is purely for type uniformity across the
// strategy hierarchy. The strategy ignores the value — its
// `doAuthenticateImpl()` returns a `CredentialsFormIntent` regardless.
//
// These tests exercise the no-op shape:
//   1. constructor accepts `preAuth: undefined` (omitted parameter) — the
//      pre-existing call shape;
//   2. constructor accepts `preAuth: undefined` explicitly;
//   3. authenticate() returns a credentials-form intent unchanged whether
//      preAuth is supplied or not.

import { describe, expect, it } from "vitest";

import type { CredentialsFormIntent } from "@ft5/ipc-contracts";
import { providers } from "@ft5/ipc-contracts";

import type { PreAuthConfig } from "../../auth-types.js";
import type { BaseClientContext, CredentialStore } from "../../base-client.js";
import { S3Client } from "../s3-client.js";

function makeContext(): BaseClientContext {
  const credentialStore: CredentialStore = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  };
  return {
    credentialStore,
    providerDescriptor: providers["amazon-s3"],
  };
}

// `S3CredsMeta` is not exported from s3-client.ts — tests construct the
// shape inline. The fields below match the internal shape.
const stubCreds = {
  accessKeyId: "AKIA-stub",
  secretAccessKey: "secret-stub",
  region: "us-east-1",
  bucket: "stub-bucket",
};

describe("S3Client — preAuth (type uniformity, no-op)", () => {
  it("accepts construction with preAuth omitted (legacy shape)", () => {
    const ctx = makeContext();
    const client = new S3Client(
      { datasourceId: "ds-s3-1", ctx },
      stubCreds,
    );
    expect(client.type).toBe("amazon-s3");
  });

  it("accepts construction with preAuth: undefined explicitly", () => {
    const ctx = makeContext();
    const client = new S3Client(
      { datasourceId: "ds-s3-2", ctx },
      stubCreds,
      undefined,
    );
    expect(client.type).toBe("amazon-s3");
  });

  it("accepts construction with preAuth: null (factory.createForAuth dispatch shape)", () => {
    const ctx = makeContext();
    // Mirror the upcoming `factory.createForAuth("amazon-s3", null, ctx)`
    // call shape — null carries the credentials-form intent semantics.
    const client = new S3Client(
      { datasourceId: "ds-s3-null", ctx },
      stubCreds,
      null,
    );
    expect(client.type).toBe("amazon-s3");
  });

  it("accepts a PreAuthConfig value at the slot (ignored — no-op for credentials-form)", () => {
    const ctx = makeContext();
    const preAuth: PreAuthConfig = {
      clientId: "ignored-by-s3",
      clientSecret: "ignored-by-s3",
      redirectUri: "ignored-by-s3",
    };
    const client = new S3Client(
      { datasourceId: "ds-s3-3", ctx },
      stubCreds,
      preAuth,
    );
    expect(client.type).toBe("amazon-s3");
  });

  it("authenticate() returns a credentials-form intent regardless of preAuth", async () => {
    const ctx = makeContext();
    const preAuth: PreAuthConfig = {
      clientId: "x",
      clientSecret: "y",
      redirectUri: "z",
    };
    const client = new S3Client(
      { datasourceId: "ds-s3-4", ctx },
      stubCreds,
      preAuth,
    );
    const intent = (await client.authenticate()) as CredentialsFormIntent;
    expect(intent.kind).toBe("credentials-form");
    expect(intent.schema).toBe("aws-access-key");
  });
});
