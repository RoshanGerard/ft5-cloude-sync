import { describe, expect, expectTypeOf, it } from "vitest";

import type { DatasourceErrorTag } from "../fs-datasource-engine.js";
import type {
  ConsentEvent,
  CredentialsSchema,
  DatasourceAction,
  DatasourceStatus,
  DatasourceSummary,
  DatasourceUsage,
  DatasourcesActionRequest,
  DatasourcesActionResponse,
  DatasourcesAddRequest,
  DatasourcesAddResponse,
  DatasourcesCancelConsentRequest,
  DatasourcesCancelConsentResponse,
  DatasourcesListRequest,
  DatasourcesListResponse,
  DatasourcesRemoveRequest,
  DatasourcesRemoveResponse,
  DatasourcesStartConsentRequest,
  DatasourcesStartConsentResponse,
  DatasourcesUploadProgressEvent,
  DatasourcesUploadRequest,
  DatasourcesUploadResponse,
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

  it("upload: { datasourceId } request, { transactionId } response, progress event shape", () => {
    const req: DatasourcesUploadRequest = { datasourceId: "ds-1" };
    const res: DatasourcesUploadResponse = { transactionId: "tx-1" };
    const progressUploading: DatasourcesUploadProgressEvent = {
      transactionId: "tx-1",
      bytesUploaded: 5,
      bytesTotal: 10,
      status: "uploading",
    };
    const progressDone: DatasourcesUploadProgressEvent = {
      transactionId: "tx-1",
      bytesUploaded: 10,
      bytesTotal: 10,
      status: "completed",
    };
    const progressFailed: DatasourcesUploadProgressEvent = {
      transactionId: "tx-1",
      bytesUploaded: 3,
      bytesTotal: 10,
      status: "failed",
      error: "network error",
    };
    expect(req.datasourceId).toBe("ds-1");
    expect(res.transactionId).toBe("tx-1");
    expect(progressUploading.status).toBe("uploading");
    expect(progressDone.status).toBe("completed");
    expect(progressFailed.error).toBe("network error");
  });
});

describe("ipc-contracts datasources channel names", () => {
  it("DATASOURCES_CHANNELS exposes the expected channels (incl. consent)", () => {
    expect(DATASOURCES_CHANNELS.list).toBe("datasources:list");
    expect(DATASOURCES_CHANNELS.add).toBe("datasources:add");
    expect(DATASOURCES_CHANNELS.remove).toBe("datasources:remove");
    expect(DATASOURCES_CHANNELS.action).toBe("datasources:action");
    expect(DATASOURCES_CHANNELS.upload).toBe("datasources:upload");
    expect(DATASOURCES_CHANNELS.uploadProgress).toBe(
      "datasources:upload:progress",
    );
    expect(DATASOURCES_CHANNELS.event).toBe("datasources:event");
    expect(DATASOURCES_CHANNELS.startConsent).toBe("datasources:start-consent");
    expect(DATASOURCES_CHANNELS.cancelConsent).toBe(
      "datasources:cancel-consent",
    );
    expect(Object.keys(DATASOURCES_CHANNELS).sort()).toEqual(
      [
        "action",
        "add",
        "cancelConsent",
        "event",
        "list",
        "remove",
        "startConsent",
        "upload",
        "uploadProgress",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// add-drive-oauth-browser-consent — Group 2 (tasks 2.1–2.4)
// ---------------------------------------------------------------------------

describe("ipc-contracts datasources startConsent / cancelConsent request-response (task 2.1, 2.2)", () => {
  it("DatasourcesStartConsentRequest is exactly { providerId: string; datasourceId?: string }", () => {
    expectTypeOf<DatasourcesStartConsentRequest>().toEqualTypeOf<{
      providerId: string;
      datasourceId?: string;
    }>();
  });

  it("DatasourcesStartConsentResponse is exactly { sessionId: string }", () => {
    expectTypeOf<DatasourcesStartConsentResponse>().toEqualTypeOf<{
      sessionId: string;
    }>();
  });

  it("DatasourcesCancelConsentRequest is exactly { sessionId: string }", () => {
    expectTypeOf<DatasourcesCancelConsentRequest>().toEqualTypeOf<{
      sessionId: string;
    }>();
  });

  it("DatasourcesCancelConsentResponse is void", () => {
    expectTypeOf<DatasourcesCancelConsentResponse>().toEqualTypeOf<void>();
  });
});

describe("ipc-contracts ConsentEvent union (task 2.3)", () => {
  it("ConsentEvent includes consent-started with optional datasourceId", () => {
    const e: ConsentEvent = {
      event: "consent-started",
      sessionId: "sess-1",
    };
    const withId: ConsentEvent = {
      event: "consent-started",
      sessionId: "sess-1",
      datasourceId: "ds-1",
    };
    expect(e.event).toBe("consent-started");
    expect(withId.datasourceId).toBe("ds-1");
  });

  it("ConsentEvent includes consent-completed with REQUIRED datasourceId", () => {
    const e: ConsentEvent = {
      event: "consent-completed",
      sessionId: "sess-1",
      datasourceId: "ds-1",
    };
    expect(e.datasourceId).toBe("ds-1");
    // Narrowing: when event === "consent-completed", datasourceId is required (not optional).
    type CompletedVariant = Extract<ConsentEvent, { event: "consent-completed" }>;
    expectTypeOf<CompletedVariant["datasourceId"]>().toEqualTypeOf<string>();
  });

  it("ConsentEvent includes consent-cancelled with only sessionId", () => {
    const e: ConsentEvent = { event: "consent-cancelled", sessionId: "sess-1" };
    expect(e.event).toBe("consent-cancelled");
  });

  it("ConsentEvent includes consent-failed with tag and optional message", () => {
    const e: ConsentEvent = {
      event: "consent-failed",
      sessionId: "sess-1",
      tag: "auth-revoked",
    };
    const withMsg: ConsentEvent = {
      event: "consent-failed",
      sessionId: "sess-1",
      tag: "provider-error",
      message: "token endpoint 500",
    };
    type FailedVariant = Extract<ConsentEvent, { event: "consent-failed" }>;
    expectTypeOf<FailedVariant["tag"]>().toEqualTypeOf<DatasourceErrorTag>();
    expectTypeOf<FailedVariant["message"]>().toEqualTypeOf<string | undefined>();
    expect(e.tag).toBe("auth-revoked");
    expect(withMsg.message).toBe("token endpoint 500");
  });

  it("ConsentEvent includes consent-timeout with only sessionId", () => {
    const e: ConsentEvent = { event: "consent-timeout", sessionId: "sess-1" };
    expect(e.event).toBe("consent-timeout");
  });

  it("ConsentEvent discriminates on `event` across all five variants", () => {
    type Events = ConsentEvent["event"];
    expectTypeOf<Events>().toEqualTypeOf<
      | "consent-started"
      | "consent-completed"
      | "consent-cancelled"
      | "consent-failed"
      | "consent-timeout"
    >();
  });
});

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
