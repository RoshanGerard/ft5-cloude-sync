// Task 4.1 -- failing test: Loopback binding returns an ephemeral port.
//
// RED phase of TDD. broker.start() throws Not implemented until task 4.7.
//
// Spec ref: openspec/changes/add-drive-oauth-browser-consent/specs/datasources-ui/spec.md
// Scenario: Loopback binding returns an ephemeral port

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createOAuthConsentBroker,
  type OAuthConsentBroker,
} from "../consent-broker.js";

// Fake createClient: returns an OAuthIntent whose authorizeUrl echos the
// redirectUri the broker injected into StoredCredentials meta.
function makeFakeCreateClient() {
  return (
    _datasourceId: string,
    credentials: import("@ft5/ipc-contracts").StoredCredentials,
  ) => ({
    authenticate: async () => {
      const meta = (credentials.authResult.meta ?? {}) as Record<string, unknown>;
      const redirectUri = typeof meta.redirectUri === "string"
        ? meta.redirectUri
        : "http://127.0.0.1:0/callback";
      const fakeAuthorizeUrl =
        "https://accounts.google.com/o/oauth2/v2/auth"
        + "?client_id=test-client-id"
        + "&response_type=code"
        + "&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive"
        + "&redirect_uri=" + encodeURIComponent(redirectUri)
        + "&code_challenge=FAKE_CHALLENGE"
        + "&code_challenge_method=S256";
      return {
        kind: "oauth" as const,
        authorizeUrl: fakeAuthorizeUrl,
        completeWith: async (_code: string) => ({
          accessToken: "fake-access-token",
          refreshToken: "fake-refresh-token",
        }),
      };
    },
  });
}

describe("OAuthConsentBroker", () => {
  let broker: OAuthConsentBroker;
  const openExternal = vi.fn(async (_url: string) => {});

  beforeEach(() => {
    openExternal.mockClear();
    broker = createOAuthConsentBroker({
      openExternal,
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      createClient: makeFakeCreateClient(),
    });
  });

  afterEach(() => {
    broker.dispose();
    vi.restoreAllMocks();
  });

  it("Loopback binding returns an ephemeral port", async () => {
    // ACT
    const { sessionId } = await broker.start({ providerId: "google-drive" });

    // ASSERT 1: sessionId is non-empty.
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);

    // ASSERT 2: pending-session record has an ephemeral port.
    const session = broker._getPendingSessionForTests(sessionId);
    expect(session).toBeDefined();
    expect(session!.port).toBeGreaterThanOrEqual(1024);
    expect(session!.port).toBeLessThanOrEqual(65535);

    // ASSERT 3: loopback HTTP server is actually listening.
    const probeUrl = "http://127.0.0.1:" + String(session!.port) + "/health-probe";
    let probeResponse: Response | undefined;
    try {
      probeResponse = await fetch(probeUrl, { signal: AbortSignal.timeout(2000) });
    } catch {
      throw new Error("Expected listening HTTP server at " + probeUrl + " but got ECONNREFUSED or timeout.");
    }
    expect(probeResponse.status).toBeGreaterThanOrEqual(100);

    // ASSERT 4: openExternal called exactly once.
    expect(openExternal).toHaveBeenCalledTimes(1);

    // ASSERT 5: authorize URL redirect_uri === http://127.0.0.1:<port>/callback
    const openExternalArg = openExternal.mock.calls[0]?.[0] as string;
    expect(typeof openExternalArg).toBe("string");
    const parsedUrl = new URL(openExternalArg);
    const rawRedirectUri = parsedUrl.searchParams.get("redirect_uri");
    expect(rawRedirectUri).not.toBeNull();
    const decodedRedirectUri = decodeURIComponent(rawRedirectUri!);
    const expectedRedirectUri = "http://127.0.0.1:" + String(session!.port) + "/callback";
    expect(decodedRedirectUri).toBe(expectedRedirectUri);

    // CLEANUP
    try {
      await broker.cancel({ sessionId });
    } catch {
      // Expected in RED phase: stub cancel() throws Not implemented.
    }
  });
});