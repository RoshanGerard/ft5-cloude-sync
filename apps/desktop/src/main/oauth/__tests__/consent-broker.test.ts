// Task 4.1 -- failing test: Loopback binding returns an ephemeral port.
// Task 4.2 -- failing test: State mismatch rejects the callback.
//
// RED phase of TDD. broker.start() throws Not implemented until task 4.7.
//
// Spec ref: openspec/changes/add-drive-oauth-browser-consent/specs/datasources-ui/spec.md
// Scenario: Loopback binding returns an ephemeral port
// Scenario: State mismatch rejects the callback

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createOAuthConsentBroker,
  type OAuthConsentBroker,
} from "../consent-broker.js";
import type { ConsentEvent } from "@ft5/ipc-contracts";

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

/**
 * Variant of makeFakeCreateClient that captures the OAuthIntent so tests can
 * spy on completeWith (task 4.2+). Returns:
 *   - createClient: the factory to pass to createOAuthConsentBroker
 *   - getLastCompleteWith(): the vi.fn() assigned to completeWith on the most
 *     recently constructed intent; throws if authenticate() has not yet run.
 *
 * completeWith is a vi.fn() so the test can call .not.toHaveBeenCalled().
 */
function makeFakeCreateClientWithSpy() {
  let lastCompleteWith: ReturnType<typeof vi.fn> | null = null;

  const createClient = (
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
      const completeWithSpy = vi.fn(async (_code: string) => ({
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
      }));
      lastCompleteWith = completeWithSpy;
      return {
        kind: "oauth" as const,
        authorizeUrl: fakeAuthorizeUrl,
        completeWith: completeWithSpy,
      };
    },
  });

  const getLastCompleteWith = () => {
    if (!lastCompleteWith) {
      throw new Error("authenticate() not yet called -- no completeWith spy available");
    }
    return lastCompleteWith;
  };

  return { createClient, getLastCompleteWith };
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

  it("State mismatch rejects the callback", async () => {
    // ARRANGE: build a broker whose createClient exposes a spy on completeWith.
    const { createClient, getLastCompleteWith } = makeFakeCreateClientWithSpy();
    const brokerWithSpy = createOAuthConsentBroker({
      openExternal,
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      createClient,
    });

    // Subscribe a spy listener to the broker consent-event stream BEFORE
    // starting so we can assert on what events arrive.
    const consentListener = vi.fn((_event: ConsentEvent) => {});
    brokerWithSpy.subscribe(consentListener);

    try {
      // STEP (a): start a consent session.
      // RED: broker.start() throws "Not implemented" here until task 4.7.
      const { sessionId } = await brokerWithSpy.start({ providerId: "google-drive" });

      // STEP (b): read the stored CSRF state from the pending session.
      const session = brokerWithSpy._getPendingSessionForTests(sessionId);
      expect(session).toBeDefined();
      const legitimateState = session!.state;
      expect(typeof legitimateState).toBe("string");
      expect(legitimateState.length).toBeGreaterThan(0);

      // STEP (c): compute a deliberately wrong state (attacker-controlled).
      const wrongState = "ATTACKER_" + legitimateState;

      // STEP (d): read the bound port.
      const { port } = session!;
      expect(port).toBeGreaterThanOrEqual(1024);

      // STEP (e): make a real HTTP GET to /callback with the wrong state.
      const callbackUrl =
        "http://127.0.0.1:" + String(port) +
        "/callback?code=fake-code&state=" + encodeURIComponent(wrongState);
      let response: Response;
      try {
        response = await fetch(callbackUrl, { signal: AbortSignal.timeout(3000) });
      } catch (err) {
        throw new Error(
          "Expected the loopback server to accept the connection at " +
          callbackUrl + " but got: " + String(err),
        );
      }

      // STEP (f): HTTP response MUST be a 400-class status code.
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThanOrEqual(499);

      // STEP (g): completeWith MUST NOT have been called -- state was invalid.
      const completeWithSpy = getLastCompleteWith();
      expect(completeWithSpy).not.toHaveBeenCalled();

      // STEP (h): the broker MUST have emitted exactly one consent-failed event
      // with tag "auth-revoked". The broker may emit synchronously or on the
      // next tick after responding -- waitFor handles both.
      await vi.waitFor(() => {
        expect(consentListener).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      const emittedEvent = consentListener.mock.calls[0]?.[0] as ConsentEvent;
      expect(emittedEvent).toMatchObject({
        event: "consent-failed",
        sessionId,
        tag: "auth-revoked",
      });

      // STEP (i): pending session MUST have been cleared.
      expect(brokerWithSpy._getPendingSessionForTests(sessionId)).toBeUndefined();
    } finally {
      brokerWithSpy.dispose();
    }
  });
});
