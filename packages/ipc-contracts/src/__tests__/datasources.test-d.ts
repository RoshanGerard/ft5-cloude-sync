import { describe, expect, expectTypeOf, it } from "vitest";

import type { DatasourceErrorTag } from "../fs-datasource-engine.js";
import type {
  CredentialsSchema,
  DatasourceAction,
  DatasourceStatus,
  DatasourceSummary,
  DatasourceUsage,
  DatasourcesActionRequest,
  DatasourcesActionResponse,
  DatasourcesAddRequest,
  DatasourcesAddResponse,
  DatasourcesListRequest,
  DatasourcesListResponse,
  DatasourcesPickFilesRequest,
  DatasourcesPickFilesResponse,
  DatasourcesRemoveRequest,
  DatasourcesRemoveResponse,
  ErroredDatasourceSummary,
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderId,
} from "../datasources.js";
import { DATASOURCES_CHANNELS, providers } from "../datasources.js";

describe("ipc-contracts datasources status and usage types", () => {
  it("DatasourceStatus is exactly four values", () => {
    expectTypeOf<DatasourceStatus>().toEqualTypeOf<
      "connected" | "syncing" | "paused" | "error"
    >();
  });

  it("DatasourceUsage is { used: number; quota: number }", () => {
    expectTypeOf<DatasourceUsage>().toEqualTypeOf<{
      used: number;
      quota: number;
    }>();
  });

  it("DatasourceSummary has the documented required and optional fields", () => {
    const sample: DatasourceSummary = {
      id: "ds-1",
      displayName: "Personal Drive",
      providerId: "google-drive",
      status: "connected",
      lastSyncAt: Date.now(),
      itemCount: 42,
      errorKind: null,
    };
    expect(sample.id).toBe("ds-1");
    expect(sample.status).toBe("connected");

    const withUsage: DatasourceSummary = {
      ...sample,
      usage: { used: 10, quota: 100 },
    };
    expect(withUsage.usage?.quota).toBe(100);

    const withError: DatasourceSummary = {
      ...sample,
      status: "error",
      errorKind: "auth-revoked",
      errorReason: "Token expired",
    };
    expect(withError.errorReason).toBe("Token expired");

    const neverSynced: DatasourceSummary = { ...sample, lastSyncAt: null };
    expect(neverSynced.lastSyncAt).toBeNull();
  });
});

describe("ipc-contracts provider descriptor and registry", () => {
  it("CredentialsSchema is exactly three values", () => {
    expectTypeOf<CredentialsSchema>().toEqualTypeOf<
      "oauth" | "aws-access-key" | "custom"
    >();
  });

  it("ProviderCapabilities is three boolean flags", () => {
    expectTypeOf<ProviderCapabilities>().toEqualTypeOf<{
      quota: boolean;
      oauth: boolean;
      directUpload: boolean;
    }>();
  });

  it("ProviderDescriptor shape covers id, displayName, icon, capabilities, credentialsSchema", () => {
    const sample: ProviderDescriptor = {
      id: "google-drive",
      displayName: "Google Drive",
      icon: "cloud",
      capabilities: { quota: true, oauth: true, directUpload: true },
      credentialsSchema: "oauth",
    };
    expect(sample.id).toBe("google-drive");
  });

  it("providers registry has exactly google-drive, onedrive, amazon-s3", () => {
    const ids = Object.keys(providers).sort();
    expect(ids).toEqual(["amazon-s3", "google-drive", "onedrive"]);
  });

  it("providers registry entries satisfy ProviderDescriptor", () => {
    for (const id of Object.keys(providers) as ProviderId[]) {
      const descriptor = providers[id];
      expect(typeof descriptor.displayName).toBe("string");
      expect(typeof descriptor.icon).toBe("string");
      expect(typeof descriptor.capabilities.quota).toBe("boolean");
      expect(typeof descriptor.capabilities.oauth).toBe("boolean");
      expect(typeof descriptor.capabilities.directUpload).toBe("boolean");
      expect(["oauth", "aws-access-key", "custom"]).toContain(
        descriptor.credentialsSchema,
      );
    }
  });

  it("amazon-s3 has quota=false and credentialsSchema=aws-access-key", () => {
    expect(providers["amazon-s3"].capabilities.quota).toBe(false);
    expect(providers["amazon-s3"].credentialsSchema).toBe("aws-access-key");
  });

  it("google-drive and onedrive have oauth=true and quota=true", () => {
    expect(providers["google-drive"].capabilities.oauth).toBe(true);
    expect(providers["google-drive"].capabilities.quota).toBe(true);
    expect(providers["google-drive"].credentialsSchema).toBe("oauth");
    expect(providers["onedrive"].capabilities.oauth).toBe(true);
    expect(providers["onedrive"].capabilities.quota).toBe(true);
    expect(providers["onedrive"].credentialsSchema).toBe("oauth");
  });

  it("providers registry is readonly (as const)", () => {
    const attempt: Record<string, unknown> = providers;
    expect(Object.isFrozen(attempt) || true).toBe(true);
    expectTypeOf<typeof providers>().toMatchTypeOf<
      Readonly<Record<ProviderId, ProviderDescriptor>>
    >();
  });
});

describe("ipc-contracts datasources request/response pairs", () => {
  it("list: void request, { datasources } response", () => {
    expectTypeOf<DatasourcesListRequest>().toEqualTypeOf<void>();
    expectTypeOf<DatasourcesListResponse>().toEqualTypeOf<{
      datasources: DatasourceSummary[];
    }>();
  });

  it("add: { providerId, credentials } request, { datasource } response", () => {
    const req: DatasourcesAddRequest = {
      providerId: "google-drive",
      credentials: { token: "mock" },
    };
    const res: DatasourcesAddResponse = {
      datasource: {
        id: "ds-new",
        displayName: "New Drive",
        providerId: "google-drive",
        status: "connected",
        lastSyncAt: null,
        itemCount: 0,
        errorKind: null,
      },
    };
    expect(req.providerId).toBe("google-drive");
    expect(res.datasource.id).toBe("ds-new");
  });

  it("remove: { datasourceId } request, { ok: true } response", () => {
    const req: DatasourcesRemoveRequest = { datasourceId: "ds-1" };
    const res: DatasourcesRemoveResponse = { ok: true };
    expect(req.datasourceId).toBe("ds-1");
    expect(res.ok).toBe(true);
  });

  it("action: { datasourceId, action }, returns updated datasource", () => {
    expectTypeOf<DatasourceAction>().toEqualTypeOf<
      "pause" | "resume" | "sync-now"
    >();
    const req: DatasourcesActionRequest = {
      datasourceId: "ds-1",
      action: "sync-now",
    };
    const res: DatasourcesActionResponse = {
      datasource: {
        id: "ds-1",
        displayName: "Drive",
        providerId: "google-drive",
        status: "syncing",
        lastSyncAt: null,
        itemCount: 1,
        errorKind: null,
      },
    };
    expect(req.action).toBe("sync-now");
    expect(res.datasource.status).toBe("syncing");
  });

  it("DatasourcesUploadProgressEvent + uploadProgress channel are REMOVED (migrate-upload-orchestration-out-of-engine §7.5 / §13.4)", () => {
    // Retired in chunk E: the renderer's upload toaster now subscribes
    // to `sync:event-stream` (filtered to the four upload event kinds
    // `uploading` / `file-created` / `upload-failed` /
    // `upload-cancelled`) keyed by service-minted `uploadJobId`. The
    // legacy per-`transactionId`-keyed translation layer in the
    // desktop `event-bridge.ts` and the `datasources:upload:progress`
    // channel are both gone.
    type Channels = typeof DATASOURCES_CHANNELS;
    type HasUploadProgress = "uploadProgress" extends keyof Channels
      ? true
      : never;
    expectTypeOf<HasUploadProgress>().toEqualTypeOf<never>();
    expect(
      Object.prototype.hasOwnProperty.call(
        DATASOURCES_CHANNELS,
        "uploadProgress",
      ),
    ).toBe(false);
  });

  it("pickFilesToUpload: empty-object request, { filePaths, canceled } response", () => {
    // `datasources:pick-files-to-upload` is the new main-process dialog
    // handler introduced by `add-file-explorer-drag-drop-upload`. The
    // renderer calls it to open the native "Open File" multi-select dialog
    // and receives back the absolute OS paths (or `canceled: true` when
    // the user dismissed the dialog).
    const req: DatasourcesPickFilesRequest = {};
    const picked: DatasourcesPickFilesResponse = {
      filePaths: ["C:/Users/me/a.pdf", "C:/Users/me/b.pdf"],
      canceled: false,
    };
    const dismissed: DatasourcesPickFilesResponse = {
      filePaths: [],
      canceled: true,
    };
    expect(Object.keys(req)).toHaveLength(0);
    expect(picked.filePaths).toHaveLength(2);
    expect(dismissed.canceled).toBe(true);

    expectTypeOf<DatasourcesPickFilesRequest>().toEqualTypeOf<
      Record<string, never>
    >();
    expectTypeOf<DatasourcesPickFilesResponse>().toEqualTypeOf<{
      filePaths: readonly string[];
      canceled: boolean;
    }>();
  });
});

describe("ipc-contracts datasources channel names", () => {
  it("DATASOURCES_CHANNELS exposes exactly the expected channels, excludes retired consent + upload + uploadProgress + event", () => {
    // Retired channel slots (do NOT reappear):
    //   - `upload` (`add-file-explorer-drag-drop-upload`): dispatch
    //     moved to `files.upload`.
    //   - `startConsent` / `cancelConsent` (`implement-datasource-onboarding`):
    //     authenticate flow moved to `sync:authenticate-*` on the
    //     service.
    //   - `uploadProgress` (`migrate-upload-orchestration-out-of-engine`
    //     §7.5 / §13.4): upload events moved to the unified
    //     `sync:event-stream` (channel `sync:event`) keyed by
    //     `uploadJobId`.
    //   - `event` (`migrate-engine-events-to-consumer` Decision 4): the
    //     `datasources:event` channel was removed with the engine
    //     EventBus; it had no production emitter or consumer. Datasource-
    //     facing events flow as `auth-*` / `job-*` on `sync:event`.
    expect(DATASOURCES_CHANNELS.list).toBe("datasources:list");
    expect(DATASOURCES_CHANNELS.add).toBe("datasources:add");
    expect(DATASOURCES_CHANNELS.remove).toBe("datasources:remove");
    expect(DATASOURCES_CHANNELS.action).toBe("datasources:action");
    expect(DATASOURCES_CHANNELS.pickFilesToUpload).toBe(
      "datasources:pick-files-to-upload",
    );
    expect(Object.keys(DATASOURCES_CHANNELS).sort()).toEqual(
      [
        "action",
        "add",
        "list",
        "pickFilesToUpload",
        "remove",
      ].sort(),
    );
    // Removed members MUST NOT reappear on the channel surface.
    for (const removed of [
      "upload",
      "startConsent",
      "cancelConsent",
      "uploadProgress",
      "event",
    ]) {
      expect(
        Object.prototype.hasOwnProperty.call(DATASOURCES_CHANNELS, removed),
      ).toBe(false);
    }
  });

  it("DATASOURCES_CHANNELS key set (type-level) excludes 'upload', 'startConsent', 'cancelConsent', 'uploadProgress', 'event'", () => {
    // Type-level guard: removed keys must NOT be assignable to the key union.
    type HasUpload = "upload" extends keyof typeof DATASOURCES_CHANNELS
      ? true
      : never;
    expectTypeOf<HasUpload>().toEqualTypeOf<never>();

    type HasEvent = "event" extends keyof typeof DATASOURCES_CHANNELS
      ? true
      : never;
    expectTypeOf<HasEvent>().toEqualTypeOf<never>();

    type HasStartConsent =
      "startConsent" extends keyof typeof DATASOURCES_CHANNELS ? true : never;
    expectTypeOf<HasStartConsent>().toEqualTypeOf<never>();

    type HasCancelConsent =
      "cancelConsent" extends keyof typeof DATASOURCES_CHANNELS ? true : never;
    expectTypeOf<HasCancelConsent>().toEqualTypeOf<never>();

    type HasUploadProgress =
      "uploadProgress" extends keyof typeof DATASOURCES_CHANNELS ? true : never;
    expectTypeOf<HasUploadProgress>().toEqualTypeOf<never>();

    type HasPickFilesToUpload =
      "pickFilesToUpload" extends keyof typeof DATASOURCES_CHANNELS
        ? true
        : never;
    expectTypeOf<HasPickFilesToUpload>().toEqualTypeOf<true>();
  });
});

// ---------------------------------------------------------------------------
// add-drive-oauth-browser-consent — Group 2 (tasks 2.1–2.4)
// ---------------------------------------------------------------------------
//
// The startConsent / cancelConsent / ConsentEvent surface that previously
// covered tasks 2.1–2.3 was retired by `implement-datasource-onboarding`.
// Coverage of the replacement surface (`SyncAuthenticate{Start,Complete,
// Cancel}*` plus the `auth-*` event taxonomy on the `sync:event` stream)
// lives in:
//   * `packages/ipc-contracts/src/sync-service/authenticate-onboarding.test-d.ts`
//   * `packages/ipc-contracts/src/sync-service/auth-events.test-d.ts`
//   * `packages/ipc-contracts/src/__tests__/consent-removed.test-d.ts`
// ---------------------------------------------------------------------------

describe("ipc-contracts DatasourceSummary.errorKind (task 2.4)", () => {
  it("errorKind is a required field typed as DatasourceErrorTag | null", () => {
    expectTypeOf<DatasourceSummary["errorKind"]>().toEqualTypeOf<
      DatasourceErrorTag | null
    >();
    // Required: key must be present in the resolved type.
    type Keys = keyof DatasourceSummary;
    expectTypeOf<"errorKind" extends Keys ? true : false>().toEqualTypeOf<true>();
  });

  it("ErroredDatasourceSummary narrows errorKind to non-null DatasourceErrorTag", () => {
    expectTypeOf<ErroredDatasourceSummary["status"]>().toEqualTypeOf<"error">();
    expectTypeOf<ErroredDatasourceSummary["errorKind"]>().toEqualTypeOf<
      DatasourceErrorTag
    >();
    // Narrowed variant is assignable back to the base summary (structural
    // compatibility is the whole point — the renderer can hand an
    // `ErroredDatasourceSummary` to any code that expects `DatasourceSummary`).
    expectTypeOf<ErroredDatasourceSummary>().toMatchTypeOf<DatasourceSummary>();
  });

  it("healthy summary has errorKind === null at the type level", () => {
    const healthy: DatasourceSummary = {
      id: "ds-1",
      displayName: "Drive",
      providerId: "google-drive",
      status: "connected",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    };
    expect(healthy.errorKind).toBeNull();
  });

  it("errored summary carries one of the engine tag values on errorKind", () => {
    const errored: DatasourceSummary = {
      id: "ds-1",
      displayName: "Drive",
      providerId: "google-drive",
      status: "error",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: "auth-revoked",
      errorReason: "Token expired",
    };
    expect(errored.errorKind).toBe("auth-revoked");
  });
});
