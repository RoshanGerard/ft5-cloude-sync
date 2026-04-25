// Task 10.1 — Dev override short-circuits the browser flow.
// Task 10.2 — Startup warning fires once when dev override is active.
//
// TDD RED phase: these tests fail until OAuthConsentBrokerOptions gains
// `readDevCredentials?` and `warnOnce?`, and consent-broker.start() implements
// the dev-override branch (task 10.3).

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOAuthConsentBroker,
  type OAuthConsentBroker,
} from "../consent-broker.js";
import type {
  ConsentEvent,
  DatasourceSummary,
  StoredCredentials,
} from "@ft5/ipc-contracts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildDevCredentials(): StoredCredentials {
  return {
    providerId: "google-drive",
    authResult: {
      accessToken: "dev-access-token",
      refreshToken: "dev-refresh-token",
    },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function makeFakeCreateClient() {
  return (
    _datasourceId: string,
    credentials: StoredCredentials,
  ) => ({
    authenticate: async () => {
      const meta = (credentials.authResult.meta ?? {}) as Record<string, unknown>;
      const redirectUri =
        typeof meta.redirectUri === "string"
          ? meta.redirectUri
          : "http://127.0.0.1:0/callback";
      return {
        kind: "oauth" as const,
        authorizeUrl:
          "https://accounts.google.com/o/oauth2/v2/auth"
          + "?client_id=test-id"
          + "&redirect_uri=" + encodeURIComponent(redirectUri),
        completeWith: async (_code: string) => ({ accessToken: "tok" }),
      };
    },
  });
}

let broker: OAuthConsentBroker | null = null;

afterEach(() => {
  broker?.dispose();
  broker = null;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 10.1 — Dev override short-circuits the browser flow
// ---------------------------------------------------------------------------

describe("OAuthConsentBroker — dev override: 10.1", () => {
  it("does NOT open the browser when readDevCredentials returns non-null", async () => {
    const openExternal = vi.fn(async (_url: string) => {});
    const addToRegistry = vi.fn((s: DatasourceSummary) => ({ ...s }));
    const mintDatasourceId = vi.fn(() => "ds-dev-42");
    const consentListener = vi.fn((_e: ConsentEvent) => {});

    broker = createOAuthConsentBroker({
      openExternal,
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      createClient: makeFakeCreateClient(),
      addToRegistry,
      mintDatasourceId,
      readDevCredentials: () => buildDevCredentials(),
    });
    broker.subscribe(consentListener);

    const { sessionId } = await broker.start({ providerId: "google-drive" });

    // Browser must NOT have been opened.
    expect(openExternal).not.toHaveBeenCalled();

    // No HTTP server stored (dev path skips the loopback bind).
    expect(broker._getPendingSessionForTests(sessionId)).toBeUndefined();

    // consent-completed emitted immediately (synchronous).
    expect(consentListener).toHaveBeenCalledTimes(1);
    const event = consentListener.mock.calls[0]![0] as ConsentEvent;
    expect(event).toMatchObject({
      event: "consent-completed",
      sessionId,
      datasourceId: "ds-dev-42",
    });
  });

  it("calls addToRegistry with a connected DatasourceSummary for the provider", async () => {
    const addToRegistry = vi.fn((s: DatasourceSummary) => ({ ...s }));
    const mintDatasourceId = vi.fn(() => "ds-dev-99");

    broker = createOAuthConsentBroker({
      openExternal: vi.fn(async () => {}),
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      createClient: makeFakeCreateClient(),
      addToRegistry,
      mintDatasourceId,
      readDevCredentials: () => buildDevCredentials(),
    });

    await broker.start({ providerId: "google-drive" });

    expect(addToRegistry).toHaveBeenCalledTimes(1);
    const summary = addToRegistry.mock.calls[0]![0] as DatasourceSummary;
    expect(summary.id).toBe("ds-dev-99");
    expect(summary.providerId).toBe("google-drive");
    expect(summary.status).toBe("connected");
    expect(summary.errorKind).toBeNull();
  });

  it("uses the provided datasourceId (reconnect path) instead of minting a new one", async () => {
    const mintDatasourceId = vi.fn(() => "ds-minted");
    const consentListener = vi.fn((_e: ConsentEvent) => {});

    broker = createOAuthConsentBroker({
      openExternal: vi.fn(async () => {}),
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      createClient: makeFakeCreateClient(),
      mintDatasourceId,
      readDevCredentials: () => buildDevCredentials(),
    });
    broker.subscribe(consentListener);

    await broker.start({ providerId: "google-drive", datasourceId: "ds-existing-123" });

    // mintDatasourceId must NOT be called when datasourceId is supplied.
    expect(mintDatasourceId).not.toHaveBeenCalled();

    const event = consentListener.mock.calls[0]![0] as ConsentEvent;
    expect(event).toMatchObject({
      event: "consent-completed",
      datasourceId: "ds-existing-123",
    });
  });

  it("falls through to the normal browser flow when readDevCredentials returns null", async () => {
    const openExternal = vi.fn(async (_url: string) => {});

    broker = createOAuthConsentBroker({
      openExternal,
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      createClient: makeFakeCreateClient(),
      readDevCredentials: () => null,
    });

    await broker.start({ providerId: "google-drive" });

    // Normal browser flow: openExternal called once.
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 10.2 — Startup warning fires exactly once across multiple calls
// ---------------------------------------------------------------------------

describe("OAuthConsentBroker — dev override: 10.2", () => {
  it("calls warnOnce exactly once on the first start() with dev override active", async () => {
    const warnOnce = vi.fn();
    const mintDatasourceId = vi.fn()
      .mockReturnValueOnce("ds-dev-w1")
      .mockReturnValue("ds-dev-w2");

    broker = createOAuthConsentBroker({
      openExternal: vi.fn(async () => {}),
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      createClient: makeFakeCreateClient(),
      readDevCredentials: () => buildDevCredentials(),
      warnOnce,
      mintDatasourceId,
    });

    await broker.start({ providerId: "google-drive" });
    expect(warnOnce).toHaveBeenCalledTimes(1);

    // Second start() — warnOnce must NOT fire again.
    await broker.start({ providerId: "google-drive" });
    expect(warnOnce).toHaveBeenCalledTimes(1);
  });

  it("does NOT call warnOnce when readDevCredentials returns null (no dev override)", async () => {
    const warnOnce = vi.fn();

    broker = createOAuthConsentBroker({
      openExternal: vi.fn(async () => {}),
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      createClient: makeFakeCreateClient(),
      readDevCredentials: () => null,
      warnOnce,
    });

    await broker.start({ providerId: "google-drive" });
    expect(warnOnce).not.toHaveBeenCalled();
  });
});
