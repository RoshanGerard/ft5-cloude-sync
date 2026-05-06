import { describe, expect, expectTypeOf, it } from "vitest";

import type { ProviderId } from "../datasources.js";
import type {
  AnyDatasourceEvent,
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  DatasourceErrorTag,
  DatasourceEvent,
  DatasourceType,
  DatasourceFileEntry,
  FileMetadata,
  DatasourceMimeFamily,
  OAuthIntent,
  PayloadMap,
  ProviderMetadata,
  ProviderMetadataMap,
  Quota,
  SerializedDatasourceError,
  StoredCredentials,
  Target,
} from "../fs-datasource-engine.js";
import { serializeDatasourceError } from "../fs-datasource-engine.js";
import { DatasourceError } from "../fs-datasource-engine.js";

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

describe("ipc-contracts fs-datasource-engine types — events", () => {
  it("PayloadMap is keyed by DatasourceType → event name → payload shape", () => {
    // Each provider key must be present. The aliases below resolve only when
    // PayloadMap exposes the indexed keys; that's the existence check this
    // case asserts. (A prior `toMatchTypeOf<Record<string, unknown>>` shape
    // assertion no longer holds once provider-specific payloads tighten
    // beyond `unknown` — e.g. `"upload-cancelled": UploadCancelledPayload` —
    // so we drop it.)
    type S3Payloads = PayloadMap["amazon-s3"];
    type DrivePayloads = PayloadMap["google-drive"];
    type OneDrivePayloads = PayloadMap["onedrive"];
    void ({} as S3Payloads);
    void ({} as DrivePayloads);
    void ({} as OneDrivePayloads);
  });

  it("PayloadMap declares the sixteen canonical event names for every provider (post migrate-upload-orchestration-out-of-engine §7.6 / §7.7)", () => {
    // The assertion is compile-time: every provider's key set must be
    // EXACTLY the canonical set — bidirectional equality, not one-way
    // subtype. This catches both accidental drop (a provider missing
    // "rate-limited") and accidental drift (a provider adding a new
    // event name without updating the others).
    //
    // History:
    //   - `"upload-cancelled"` was added by `add-fs-engine-cancellation`
    //     and REMOVED from the engine bus by
    //     `migrate-upload-orchestration-out-of-engine` §7.6 (chunk E).
    //     The engine no longer participates in upload-lifecycle events;
    //     the post-migration shape lives on the fs-sync
    //     `sync:event-stream` keyed by `uploadJobId` (see
    //     `packages/ipc-contracts/src/sync-service/events.ts`
    //     `UploadCancelledPayload`). The `uploading`, `upload-failed`,
    //     and `file-created` slots remain on the engine bus as `unknown`
    //     for legacy subscriber compatibility — no engine code path
    //     emits them post-chunk-B.
    //   - The download-lifecycle four (`downloading`, `file-downloaded`,
    //     `download-failed`, `download-cancelled`) and `entry-renamed`
    //     joined the bus with `add-engine-rename-download`.
    //
    // Any future proposal that adds another event name MUST update this
    // enumeration in the same change.
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
      | "rate-limited"
      | "downloading"
      | "file-downloaded"
      | "download-failed"
      | "download-cancelled"
      | "entry-renamed";
    expectTypeOf<S3Keys>().toEqualTypeOf<Canonical>();
    expectTypeOf<DriveKeys>().toEqualTypeOf<Canonical>();
    expectTypeOf<OneDriveKeys>().toEqualTypeOf<Canonical>();
  });

  it("`upload-cancelled` is REMOVED from PayloadMap on every provider (engine no longer emits upload-lifecycle events)", () => {
    // §7.6 — the engine's `upload-cancelled` slot is gone. The shape
    // moved to `services/fs-sync/src/commands/files-upload.ts`'s
    // emitter on `sync:event-stream`, keyed by `uploadJobId` instead
    // of `transactionId`. The `cancelled` tag in `DatasourceErrorTag`
    // is RETAINED — strategies still reject with `tag: "cancelled"`
    // when their AbortSignal fires (chunk B refactor).
    type HasS3 = "upload-cancelled" extends keyof PayloadMap["amazon-s3"]
      ? true
      : never;
    expectTypeOf<HasS3>().toEqualTypeOf<never>();

    type HasDrive = "upload-cancelled" extends keyof PayloadMap["google-drive"]
      ? true
      : never;
    expectTypeOf<HasDrive>().toEqualTypeOf<never>();

    type HasOneDrive = "upload-cancelled" extends keyof PayloadMap["onedrive"]
      ? true
      : never;
    expectTypeOf<HasOneDrive>().toEqualTypeOf<never>();
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

  it("AnyDatasourceEvent is the distributed union of every provider's DatasourceEvent<T, K>", () => {
    // Every provider-narrowed event is assignable to the widened union;
    // subscribers that don't care about a specific provider accept this
    // shape and narrow client-side via `switch (e.datasourceType)`.
    expectTypeOf<DatasourceEvent<"amazon-s3", "file-created">>()
      .toMatchTypeOf<AnyDatasourceEvent>();
    expectTypeOf<DatasourceEvent<"google-drive", "uploading">>()
      .toMatchTypeOf<AnyDatasourceEvent>();
    expectTypeOf<DatasourceEvent<"onedrive", "authentication-failed">>()
      .toMatchTypeOf<AnyDatasourceEvent>();

    // The discriminant field narrows on the widened union. If
    // `AnyDatasourceEvent` ever collapses into a single provider's shape
    // (regression: accidental narrowing of `DatasourceType` at the
    // mapped-type head), the narrowed branches below would each reduce
    // to `never` and the assertion would fail.
    type ProviderBranch<T extends DatasourceType> = Extract<
      AnyDatasourceEvent,
      { datasourceType: T }
    >;
    expectTypeOf<ProviderBranch<"amazon-s3">["datasourceType"]>()
      .toEqualTypeOf<"amazon-s3">();
    expectTypeOf<ProviderBranch<"google-drive">["datasourceType"]>()
      .toEqualTypeOf<"google-drive">();
    expectTypeOf<ProviderBranch<"onedrive">["datasourceType"]>()
      .toEqualTypeOf<"onedrive">();
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

  // migrate-upload-orchestration-out-of-engine §7.7 — the
  // `upload-cancelled` engine-bus payload-shape test is REMOVED
  // alongside the slot itself. The post-migration `UploadCancelledPayload`
  // lives on `sync:event-stream` (keyed by `uploadJobId`) — coverage
  // moved to `packages/ipc-contracts/src/sync-service/events.test-d.ts`.

  it("entry-renamed payload is { from: Target; to: DatasourceFileEntry<T> } pinned per provider (add-engine-rename-download §3.5/§3.6)", () => {
    // The base class emits exactly one `entry-renamed` per successful
    // `rename` call regardless of how many provider API calls the
    // strategy made internally (per design.md Decision 2). The `from`
    // carries the original target so subscribers can identify the
    // pre-rename entry; the `to` is the full new entry shape and is
    // generic over `T` so Drive's `fileId`, S3's `bucket`/`key`, etc.
    // narrow correctly when consumers branch on `datasourceType`.
    type S3Renamed = PayloadMap["amazon-s3"]["entry-renamed"];
    type DriveRenamed = PayloadMap["google-drive"]["entry-renamed"];
    type OneDriveRenamed = PayloadMap["onedrive"]["entry-renamed"];

    expectTypeOf<S3Renamed>().toEqualTypeOf<{
      from: Target;
      to: DatasourceFileEntry<"amazon-s3">;
    }>();
    expectTypeOf<DriveRenamed>().toEqualTypeOf<{
      from: Target;
      to: DatasourceFileEntry<"google-drive">;
    }>();
    expectTypeOf<OneDriveRenamed>().toEqualTypeOf<{
      from: Target;
      to: DatasourceFileEntry<"onedrive">;
    }>();
  });

  it("the four download-lifecycle event payloads are pinned with the documented shapes (add-engine-rename-download §3.3/§3.4)", () => {
    // `downloading`, `file-downloaded`, `download-cancelled` carry
    // base-level byte-counter / placement state identical across
    // providers — pinned in `CanonicalEventPayloads` so the renderer's
    // toaster receives a uniform payload regardless of which strategy
    // emitted the event. `download-failed` mirrors the existing
    // `authentication-failed` pattern: the payload is the full
    // `SerializedDatasourceError<T>` so subscribers reconstruct retry
    // affordances (`retryable` / `retryAfterMs` / `tag`) without
    // round-tripping the class identity through structured-clone.
    //
    // None of these payloads carry `datasourceId` or `datasourceType`
    // — the standard `DatasourceEvent<T, K>` envelope already carries
    // those (plus `ts` and `streaming?`). Each payload DOES carry
    // `path` because the envelope does NOT (per the established
    // engine convention — see `UploadCancelledPayload` for the
    // analogous case).
    type DownloadingShape = {
      loaded: number;
      total: number | null;
      path: string;
    };
    expectTypeOf<PayloadMap["amazon-s3"]["downloading"]>().toEqualTypeOf<
      DownloadingShape
    >();
    expectTypeOf<PayloadMap["google-drive"]["downloading"]>().toEqualTypeOf<
      DownloadingShape
    >();
    expectTypeOf<PayloadMap["onedrive"]["downloading"]>().toEqualTypeOf<
      DownloadingShape
    >();

    // `file-downloaded` carries only `path` and `bytes` on the engine bus.
    // The engine never writes to disk — it emits when the strategy's response
    // stream fires `end` cleanly, with `bytes` reflecting the total bytes that
    // flowed from the provider. fs-sync (which DOES pipe the stream to disk)
    // emits its own desktop-facing `file-downloaded { downloadJobId, savedPath, bytes }`
    // event with `savedPath` populated from its pipe target.
    type FileDownloadedShape = {
      path: string;
      bytes: number;
    };
    expectTypeOf<PayloadMap["amazon-s3"]["file-downloaded"]>().toEqualTypeOf<
      FileDownloadedShape
    >();
    expectTypeOf<PayloadMap["google-drive"]["file-downloaded"]>().toEqualTypeOf<
      FileDownloadedShape
    >();
    expectTypeOf<PayloadMap["onedrive"]["file-downloaded"]>().toEqualTypeOf<
      FileDownloadedShape
    >();

    type DownloadCancelledShape = {
      bytesDownloaded: number;
      bytesTotal: number | null;
      path: string;
    };
    expectTypeOf<PayloadMap["amazon-s3"]["download-cancelled"]>().toEqualTypeOf<
      DownloadCancelledShape
    >();
    expectTypeOf<
      PayloadMap["google-drive"]["download-cancelled"]
    >().toEqualTypeOf<DownloadCancelledShape>();
    expectTypeOf<PayloadMap["onedrive"]["download-cancelled"]>().toEqualTypeOf<
      DownloadCancelledShape
    >();

    // `download-failed` is provider-pinned — narrowing on
    // `datasourceType` carries through to the serialized error.
    expectTypeOf<PayloadMap["amazon-s3"]["download-failed"]>().toEqualTypeOf<
      SerializedDatasourceError<"amazon-s3">
    >();
    expectTypeOf<PayloadMap["google-drive"]["download-failed"]>().toEqualTypeOf<
      SerializedDatasourceError<"google-drive">
    >();
    expectTypeOf<PayloadMap["onedrive"]["download-failed"]>().toEqualTypeOf<
      SerializedDatasourceError<"onedrive">
    >();
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
      tag: "auth-expired",
      datasourceType: "amazon-s3",
      datasourceId: "ds-minimal",
      retryable: false,
      message: "token expired",
    });
    const minSer = serializeDatasourceError(minimal);
    expect(minSer).toEqual({
      tag: "auth-expired",
      datasourceType: "amazon-s3",
      datasourceId: "ds-minimal",
      retryable: false,
      message: "token expired",
    });
    expect("retryAfterMs" in minSer).toBe(false);
    expect("raw" in minSer).toBe(false);

    // Full — every optional field populated survives the projection.
    const full = new DatasourceError<"google-drive">({
      tag: "rate-limited",
      datasourceType: "google-drive",
      datasourceId: "ds-full",
      retryable: true,
      retryAfterMs: 1500,
      raw: { providerCode: 429 },
      message: "slow down",
    });
    const fullSer = serializeDatasourceError(full);
    expect(fullSer).toEqual({
      tag: "rate-limited",
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

  it("PayloadMap[T]['authentication-failed'] is SerializedDatasourceError<T> for every provider", () => {
    // The payload is NOT a bare reason string: consumers need the full
    // serialized error so they can reconstruct retry affordances without
    // round-tripping the class identity through structured-clone.
    expectTypeOf<PayloadMap["amazon-s3"]["authentication-failed"]>()
      .toEqualTypeOf<SerializedDatasourceError<"amazon-s3">>();
    expectTypeOf<PayloadMap["google-drive"]["authentication-failed"]>()
      .toEqualTypeOf<SerializedDatasourceError<"google-drive">>();
    expectTypeOf<PayloadMap["onedrive"]["authentication-failed"]>()
      .toEqualTypeOf<SerializedDatasourceError<"onedrive">>();
  });
});
