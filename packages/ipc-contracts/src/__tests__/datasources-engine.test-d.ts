import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  DatasourceErrorTag,
  DatasourceEvent,
  DatasourceType,
  FileEntry,
  FileMetadata,
  MimeFamily,
  OAuthIntent,
  PayloadMap,
  ProviderId,
  ProviderMetadata,
  ProviderMetadataMap,
  Quota,
  StoredCredentials,
  Target,
} from "../fs-datasource-engine.js";

describe("ipc-contracts fs-datasource-engine types — addressing", () => {
  it("DatasourceType aliases ProviderId (engine surface is provider-typed)", () => {
    expectTypeOf<DatasourceType>().toEqualTypeOf<ProviderId>();
  });

  it("Target is a discriminated union of path and handle", () => {
    expectTypeOf<Target>().toEqualTypeOf<
      | { kind: "path"; path: string }
      | { kind: "handle"; handle: string }
    >();

    const pathTarget: Target = { kind: "path", path: "/photos/2024" };
    const handleTarget: Target = { kind: "handle", handle: "drive-item-42" };
    expect(pathTarget.kind).toBe("path");
    expect(handleTarget.kind).toBe("handle");
  });

  it("MimeFamily is a finite union of high-level families", () => {
    // The concrete union may expand over time; what Phase 1 guarantees is
    // that the string-literal type exists, is assignable to `string`, and
    // covers at least the families used by later provider strategies.
    expectTypeOf<MimeFamily>().toMatchTypeOf<string>();

    // Canonical members that any `MimeFamily` widening MUST continue to
    // cover. The overall union may widen later (e.g., adding "spreadsheet")
    // but removing one of these members is a breaking change — this guard
    // makes that breakage a type error rather than a silent regression.
    type CanonicalMimeFamilies =
      | "folder"
      | "image"
      | "video"
      | "audio"
      | "document"
      | "archive"
      | "code"
      | "other";
    expectTypeOf<CanonicalMimeFamilies>().toMatchTypeOf<MimeFamily>();

    const family: MimeFamily = "other";
    expect(family).toBe("other");
  });
});

describe("ipc-contracts fs-datasource-engine types — file entries", () => {
  it("FileEntry<T> carries both path and handle plus provider metadata", () => {
    const s3Entry: FileEntry<"amazon-s3"> = {
      path: "/bucket/folder/file.txt",
      handle: "/bucket/folder/file.txt",
      name: "file.txt",
      kind: "file",
      size: 1024,
      modifiedAt: Date.now(),
      mimeFamily: "document",
      providerMetadata: {
        bucket: "bucket",
        key: "folder/file.txt",
        etag: '"abc"',
      },
    };
    expect(s3Entry.path).toContain("file.txt");
    expect(s3Entry.handle.length).toBeGreaterThan(0);

    const driveFolder: FileEntry<"google-drive"> = {
      path: "/My Drive/Photos",
      handle: "1a2b3c4d5e",
      name: "Photos",
      kind: "folder",
      modifiedAt: Date.now(),
      mimeFamily: "folder",
      providerMetadata: {},
    };
    expect(driveFolder.kind).toBe("folder");
  });

  it("FileMetadata<T> extends the entry shape with optional metadata fields", () => {
    const meta: FileMetadata<"onedrive"> = {
      path: "/Documents/plan.md",
      handle: "item!abc",
      name: "plan.md",
      kind: "file",
      size: 256,
      modifiedAt: Date.now(),
      mimeFamily: "document",
      providerMetadata: {},
    };
    expect(meta.name).toBe("plan.md");
  });

  it("ProviderMetadata<T> is keyed by DatasourceType", () => {
    // Phase 1 stubs each provider's metadata as an empty Record; later
    // phases refine these with SDK-specific fields. The test verifies the
    // indexing works — it is not asserting the contents.
    type S3 = ProviderMetadata<"amazon-s3">;
    type Drive = ProviderMetadata<"google-drive">;
    type OneDrive = ProviderMetadata<"onedrive">;
    expectTypeOf<S3>().toMatchTypeOf<Record<string, unknown>>();
    expectTypeOf<Drive>().toMatchTypeOf<Record<string, unknown>>();
    expectTypeOf<OneDrive>().toMatchTypeOf<Record<string, unknown>>();

    // Phase 6: the `amazon-s3` entry is tightened to the concrete SDK-native
    // field set. OneDrive and Google Drive stay `Record<string, unknown>`
    // until Phases 7 and 8.
    expectTypeOf<ProviderMetadataMap["amazon-s3"]>().toEqualTypeOf<{
      bucket: string;
      key: string;
      etag?: string;
      storageClass?: string;
      versionId?: string;
    }>();
    expectTypeOf<
      ProviderMetadataMap["google-drive"]
    >().toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf<
      ProviderMetadataMap["onedrive"]
    >().toEqualTypeOf<Record<string, unknown>>();
  });
});

describe("ipc-contracts fs-datasource-engine types — events", () => {
  it("PayloadMap is keyed by DatasourceType → event name → payload shape", () => {
    // Each provider key must be present.
    type S3Payloads = PayloadMap["amazon-s3"];
    type DrivePayloads = PayloadMap["google-drive"];
    type OneDrivePayloads = PayloadMap["onedrive"];
    expectTypeOf<S3Payloads>().toMatchTypeOf<Record<string, unknown>>();
    expectTypeOf<DrivePayloads>().toMatchTypeOf<Record<string, unknown>>();
    expectTypeOf<OneDrivePayloads>().toMatchTypeOf<Record<string, unknown>>();
  });

  it("PayloadMap declares the eleven canonical event names for every provider", () => {
    // The assertion is compile-time: every provider's key set must be
    // EXACTLY the canonical 11 — bidirectional equality, not one-way
    // subtype. This catches both accidental drop (a provider missing
    // "rate-limited") and accidental drift (a provider adding a new
    // event name without updating the others).
    type S3Keys = keyof PayloadMap["amazon-s3"];
    type DriveKeys = keyof PayloadMap["google-drive"];
    type OneDriveKeys = keyof PayloadMap["onedrive"];
    type Canonical =
      | "uploading"
      | "upload-failed"
      | "file-created"
      | "deleted"
      | "delete-failed"
      | "authenticated"
      | "authentication-failed"
      | "token-refreshed"
      | "token-expired"
      | "status-changed"
      | "rate-limited";
    expectTypeOf<S3Keys>().toEqualTypeOf<Canonical>();
    expectTypeOf<DriveKeys>().toEqualTypeOf<Canonical>();
    expectTypeOf<OneDriveKeys>().toEqualTypeOf<Canonical>();
  });

  it("DatasourceEvent<T, K> carries the required event envelope fields", () => {
    const fileCreated: DatasourceEvent<"amazon-s3", "file-created"> = {
      event: "file-created",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      ts: Date.now(),
      payload:
        {} as PayloadMap["amazon-s3"]["file-created"],
    };
    expect(fileCreated.event).toBe("file-created");
    expect(fileCreated.datasourceType).toBe("amazon-s3");

    const uploading: DatasourceEvent<"google-drive", "uploading"> = {
      event: "uploading",
      datasourceType: "google-drive",
      datasourceId: "ds-2",
      ts: Date.now(),
      streaming: true,
      payload:
        {} as PayloadMap["google-drive"]["uploading"],
    };
    expect(uploading.streaming).toBe(true);

    // `streaming` is the literal `true | undefined`, NOT `boolean`. The
    // engine's EventBus throttles by presence of `streaming: true`; a
    // future accidental widening to `boolean` would silently admit
    // `streaming: false` events and break the throttle contract.
    expectTypeOf<
      DatasourceEvent<"amazon-s3", "uploading">["streaming"]
    >().toEqualTypeOf<true | undefined>();
  });

  it("DatasourceEvent narrows payload by provider via switch", () => {
    function handle<
      T extends DatasourceType,
      K extends keyof PayloadMap[T] & string,
    >(e: DatasourceEvent<T, K>): T {
      return e.datasourceType;
    }
    const t = handle<"amazon-s3", "uploading">({
      event: "uploading",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      ts: 0,
      payload: {} as PayloadMap["amazon-s3"]["uploading"],
    });
    expect(t).toBe("amazon-s3");
  });
});

describe("ipc-contracts fs-datasource-engine types — auth", () => {
  it("AuthResult carries accessToken plus optional refresh/expiry/meta", () => {
    const minimal: AuthResult = { accessToken: "abc" };
    const full: AuthResult = {
      accessToken: "abc",
      refreshToken: "def",
      expiresAt: Date.now() + 3600_000,
      meta: { tenantId: "mock" },
    };
    expect(minimal.accessToken).toBe("abc");
    expect(full.refreshToken).toBe("def");
    expect(full.meta?.tenantId).toBe("mock");
  });

  it("OAuthIntent has authorizeUrl + completeWith(code) → AuthResult", () => {
    const intent: OAuthIntent = {
      kind: "oauth",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?...",
      completeWith: async (code: string) => ({ accessToken: `ok:${code}` }),
    };
    expect(intent.kind).toBe("oauth");
    expectTypeOf<OAuthIntent["completeWith"]>().toEqualTypeOf<
      (code: string) => Promise<AuthResult>
    >();
  });

  it("CredentialsFormIntent has schema + submit(values) → AuthResult", () => {
    const intent: CredentialsFormIntent = {
      kind: "credentials-form",
      schema: "aws-access-key",
      submit: async (values: Record<string, unknown>) => ({
        accessToken: `aws:${Object.keys(values).length}`,
      }),
    };
    expect(intent.kind).toBe("credentials-form");
    expect(intent.schema).toBe("aws-access-key");
    expectTypeOf<CredentialsFormIntent["submit"]>().toEqualTypeOf<
      (values: Record<string, unknown>) => Promise<AuthResult>
    >();
  });

  it("AuthIntent is the discriminated union of the two kinds", () => {
    expectTypeOf<AuthIntent>().toEqualTypeOf<
      OAuthIntent | CredentialsFormIntent
    >();
  });
});

describe("ipc-contracts fs-datasource-engine types — credentials & quota", () => {
  it("StoredCredentials ties an AuthResult to a provider + timestamps", () => {
    const now = Date.now();
    const stored: StoredCredentials = {
      providerId: "google-drive",
      authResult: { accessToken: "abc", refreshToken: "def" },
      createdAt: now,
      updatedAt: now,
    };
    expect(stored.providerId).toBe("google-drive");
    expect(stored.authResult.accessToken).toBe("abc");
    expectTypeOf<StoredCredentials["providerId"]>().toEqualTypeOf<ProviderId>();
  });

  it("Quota is { used: number; quota: number }", () => {
    expectTypeOf<Quota>().toEqualTypeOf<{ used: number; quota: number }>();
    const q: Quota = { used: 10, quota: 100 };
    expect(q.quota).toBe(100);
  });
});

describe("ipc-contracts fs-datasource-engine types — error taxonomy", () => {
  it("DatasourceErrorTag is exactly the documented 8-tag union", () => {
    expectTypeOf<DatasourceErrorTag>().toEqualTypeOf<
      | "auth-expired"
      | "auth-revoked"
      | "not-found"
      | "conflict"
      | "unsupported"
      | "rate-limited"
      | "network-error"
      | "provider-error"
    >();
  });
});
