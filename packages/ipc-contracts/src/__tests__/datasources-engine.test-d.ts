import { describe, expect, expectTypeOf, it } from "vitest";

import type { ProviderId } from "../datasources.js";
import type {
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  DatasourceType,
  DatasourceFileEntry,
  FileMetadata,
  DatasourceMimeFamily,
  OAuthIntent,
  ProviderMetadata,
  ProviderMetadataMap,
  Quota,
  SerializedDatasourceError,
  StoredCredentials,
  Target,
} from "../fs-datasource-engine.js";
import { serializeDatasourceError } from "../fs-datasource-engine.js";
import { DatasourceError, DatasourceErrorTag } from "../fs-datasource-engine.js";

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

  it("DatasourceMimeFamily is a finite union of high-level families", () => {
    // The concrete union may expand over time; what Phase 1 guarantees is
    // that the string-literal type exists, is assignable to `string`, and
    // covers at least the families used by later provider strategies.
    expectTypeOf<DatasourceMimeFamily>().toMatchTypeOf<string>();

    // Canonical members that any `DatasourceMimeFamily` widening MUST continue to
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
    expectTypeOf<CanonicalMimeFamilies>().toMatchTypeOf<DatasourceMimeFamily>();

    const family: DatasourceMimeFamily = "other";
    expect(family).toBe("other");
  });
});

describe("ipc-contracts fs-datasource-engine types — file entries", () => {
  it("DatasourceFileEntry<T> carries both path and handle plus provider metadata", () => {
    const s3Entry: DatasourceFileEntry<"amazon-s3"> = {
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

    const driveFolder: DatasourceFileEntry<"google-drive"> = {
      path: "/My Drive/Photos",
      handle: "1a2b3c4d5e",
      name: "Photos",
      kind: "folder",
      modifiedAt: Date.now(),
      mimeFamily: "folder",
      // Phase 8: the Drive metadata shape now requires `fileId` — `handle`
      // and `fileId` carry the same value (Drive's canonical item id).
      providerMetadata: { fileId: "1a2b3c4d5e" },
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
    // Drive's tightened shape is not a `Record<string, unknown>` subtype
    // because the required `fileId: string` field forbids arbitrary keys —
    // asserting shape equality below covers it.
    expectTypeOf<OneDrive>().toMatchTypeOf<Record<string, unknown>>();
    void ({} as Drive); // keep the alias referenced

    // Phase 6: `amazon-s3` is tightened to its SDK-native field set.
    // Phase 8: `google-drive` is tightened to a `fileId`-carrying shape plus
    // optional ambiguity-surfacing fields (see ProviderMetadataMap docs).
    // OneDrive stays `Record<string, unknown>` until a later phase refines it.
    expectTypeOf<ProviderMetadataMap["amazon-s3"]>().toEqualTypeOf<{
      bucket: string;
      key: string;
      etag?: string;
      storageClass?: string;
      versionId?: string;
    }>();
    expectTypeOf<ProviderMetadataMap["google-drive"]>().toEqualTypeOf<{
      fileId: string;
      mimeType?: string;
      parents?: string[];
      ambiguous?: true;
      ambiguousSiblings?: string[];
    }>();
    expectTypeOf<
      ProviderMetadataMap["onedrive"]
    >().toEqualTypeOf<Record<string, unknown>>();
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
  it("DatasourceErrorTag is exactly the documented 10-tag union", () => {
    // `"cancelled"` joined the taxonomy with `add-fs-engine-cancellation`.
    // It is reserved for base-originated cancellation of in-flight uploads —
    // strategies' own `normalizeError` MUST NOT emit this tag for raw
    // provider exceptions.
    //
    // `"invalid-datasource"` joined the taxonomy with
    // `add-invalid-datasource-state`. It surfaces misconfigured datasources
    // (registry drift, missing credential file, wrong credential shape)
    // detected at the `factory.create` / `resolveClient` layer before any
    // provider call goes out.
    expectTypeOf<DatasourceErrorTag>().toEqualTypeOf<
      | "auth-expired"
      | "auth-revoked"
      | "not-found"
      | "conflict"
      | "unsupported"
      | "rate-limited"
      | "network-error"
      | "provider-error"
      | "cancelled"
      | "invalid-datasource"
    >();
  });

  it("SerializedDatasourceError<T> mirrors DatasourceError's runtime-carried fields (structured-clone-safe projection)", () => {
    // Decision 12.4 (see design.md Open Questions — RESOLVED Phase 12):
    // the `authentication-failed` event payload carries the full serialized
    // DatasourceError, not a bare reason string. Subscribers on the other
    // side of IPC receive the serialized shape (structured-clone drops the
    // class identity) and reconstruct recovery affordances via field
    // access — `retryable`, `retryAfterMs`, `tag` — without relying on
    // `instanceof DatasourceError`.
    expectTypeOf<SerializedDatasourceError>().toEqualTypeOf<{
      tag: DatasourceErrorTag;
      datasourceType: DatasourceType;
      datasourceId: string;
      retryable: boolean;
      retryAfterMs?: number;
      raw?: unknown;
      message: string;
    }>();

    // The generic parameter narrows `datasourceType` per-provider so the
    // typed events preserve provenance through the bus.
    expectTypeOf<SerializedDatasourceError<"amazon-s3">["datasourceType"]>()
      .toEqualTypeOf<"amazon-s3">();
    expectTypeOf<SerializedDatasourceError<"google-drive">["datasourceType"]>()
      .toEqualTypeOf<"google-drive">();
    expectTypeOf<SerializedDatasourceError<"onedrive">["datasourceType"]>()
      .toEqualTypeOf<"onedrive">();
  });

  it("serializeDatasourceError projects a DatasourceError into its serialized shape", () => {
    // Minimal — only required fields populated; optional fields must be
    // ABSENT on the projection (not `undefined`) to honour
    // `exactOptionalPropertyTypes`.
    const minimal = new DatasourceError<"amazon-s3">({
      tag: DatasourceErrorTag.AuthExpired,
      datasourceType: "amazon-s3",
      datasourceId: "ds-minimal",
      retryable: false,
      message: "token expired",
    });
    const minSer = serializeDatasourceError(minimal);
    expect(minSer).toEqual({
      tag: DatasourceErrorTag.AuthExpired,
      datasourceType: "amazon-s3",
      datasourceId: "ds-minimal",
      retryable: false,
      message: "token expired",
    });
    expect("retryAfterMs" in minSer).toBe(false);
    expect("raw" in minSer).toBe(false);

    // Full — every optional field populated survives the projection.
    const full = new DatasourceError<"google-drive">({
      tag: DatasourceErrorTag.RateLimited,
      datasourceType: "google-drive",
      datasourceId: "ds-full",
      retryable: true,
      retryAfterMs: 1500,
      raw: { providerCode: 429 },
      message: "slow down",
    });
    const fullSer = serializeDatasourceError(full);
    expect(fullSer).toEqual({
      tag: DatasourceErrorTag.RateLimited,
      datasourceType: "google-drive",
      datasourceId: "ds-full",
      retryable: true,
      retryAfterMs: 1500,
      raw: { providerCode: 429 },
      message: "slow down",
    });

    // Return type carries the provider generic.
    expectTypeOf(serializeDatasourceError(full)).toEqualTypeOf<
      SerializedDatasourceError<"google-drive">
    >();
  });
});
