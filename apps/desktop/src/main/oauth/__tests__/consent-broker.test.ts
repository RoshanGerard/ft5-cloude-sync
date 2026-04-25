// Task 4.1 -- failing test: Loopback binding returns an ephemeral port.
// Task 4.2 -- failing test: State mismatch rejects the callback.
// Task 4.3 -- failing test: Valid callback invokes completeWith and emits consent-completed.
//
// RED phase of TDD. broker.start() throws Not implemented until task 4.7.
//
// Spec ref: openspec/changes/add-drive-oauth-browser-consent/specs/datasources-ui/spec.md
// Scenario: Loopback binding returns an ephemeral port
// Scenario: State mismatch rejects the callback
// Scenario: Valid callback invokes completeWith and emits consent-completed

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createOAuthConsentBroker,
  type OAuthConsentBroker,
} from "../consent-broker.js";
import type { ConsentEvent, AuthResult, DatasourceSummary } from "@ft5/ipc-contracts";

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


/**
 * Build a createClient factory whose completeWith resolves with the given
 * fakeAuthResult. Used by task 4.3 to control the AuthResult returned so
 * assertions on the built DatasourceSummary are deterministic.
 */
function makeFakeCreateClientWithResult(fakeAuthResult: AuthResult) {
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
      const spy = vi.fn(async (_code: string): Promise<AuthResult> => fakeAuthResult);
      lastCompleteWith = spy;
      return {
        kind: "oauth" as const,
        authorizeUrl: fakeAuthorizeUrl,
        completeWith: spy,
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

  // ---------------------------------------------------------------------------
  // Task 4.3 — Valid callback invokes completeWith and emits consent-completed
  // ---------------------------------------------------------------------------

  it("Valid callback invokes completeWith and emits consent-completed", async () => {
    // ARRANGE: deterministic AuthResult the fake engine will return.
    const fakeAuthResult: AuthResult = {
      accessToken: "real-access-token",
      refreshToken: "real-refresh-token",
      expiresAt: Date.now() + 3600_000,
    };

    const { createClient, getLastCompleteWith } =
      makeFakeCreateClientWithResult(fakeAuthResult);

    // addToRegistry spy: echoes the summary back (simulates a successful insert).
    const addToRegistry = vi.fn((summary: DatasourceSummary) => ({ ...summary }));
    // mintDatasourceId spy: always returns a deterministic id.
    const mintDatasourceId = vi.fn(() => "ds-test-42");

    // Consent-event subscriber registered BEFORE start() so it catches the
    // consent-completed event emitted inside the callback handler.
    const consentListener = vi.fn((_event: ConsentEvent) => {});

    const broker43 = createOAuthConsentBroker({
      openExternal,
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      createClient,
      addToRegistry,
      mintDatasourceId,
    });

    broker43.subscribe(consentListener);

    try {
      // ACT (a): start a consent session.
      // RED: throws "Not implemented" here until task 4.7.
      const { sessionId } = await broker43.start({ providerId: "google-drive" });

      // ASSERT D7: addToRegistry has NOT been called yet — no registry row
      // before completeWith succeeds (design decision D7).
      expect(addToRegistry).not.toHaveBeenCalled();

      // ACT (b): read the bound port and the stored CSRF state.
      const session = broker43._getPendingSessionForTests(sessionId);
      expect(session).toBeDefined();
      const { port, state: correctState } = session!;
      expect(port).toBeGreaterThanOrEqual(1024);
      expect(typeof correctState).toBe("string");
      expect(correctState.length).toBeGreaterThan(0);

      // ACT (c): make a real HTTP GET to /callback with the CORRECT state.
      const callbackUrl =
        "http://127.0.0.1:" + String(port) +
        "/callback?code=valid-code&state=" + encodeURIComponent(correctState);
      let response: Response;
      try {
        response = await fetch(callbackUrl, { signal: AbortSignal.timeout(3000) });
      } catch (err) {
        throw new Error(
          "Expected the loopback server to accept the connection at " +
          callbackUrl + " but got: " + String(err),
        );
      }

      // ASSERT 1: HTTP 200 — spec says respond 200 OK with a minimal HTML page.
      expect(response.status).toBe(200);

      // ASSERT 2: completeWith called exactly once with valid-code.
      const completeWithSpy = getLastCompleteWith();
      await vi.waitFor(() => {
        expect(completeWithSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
      expect(completeWithSpy).toHaveBeenCalledWith("valid-code");

      // ASSERT 3: addToRegistry called exactly once with a correct DatasourceSummary.
      await vi.waitFor(() => {
        expect(addToRegistry).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
      const persistedSummary = addToRegistry.mock.calls[0]?.[0] as DatasourceSummary;
      expect(persistedSummary.id).toBe("ds-test-42");
      expect(persistedSummary.providerId).toBe("google-drive");
      expect(persistedSummary.status).toBe("connected");
      // displayName must match the provider descriptor registered name.
      expect(persistedSummary.displayName).toBe("Google Drive");

      // ASSERT 4: consent-completed event received by the subscriber.
      await vi.waitFor(() => {
        expect(consentListener).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
      const emittedEvent = consentListener.mock.calls[0]?.[0] as ConsentEvent;
      expect(emittedEvent).toMatchObject({
        event: "consent-completed",
        sessionId,
        datasourceId: "ds-test-42",
      });

      // ASSERT 5: pending session cleared after success.
      expect(broker43._getPendingSessionForTests(sessionId)).toBeUndefined();

      // ASSERT 6: loopback server is closed — a second request fails with
      // ECONNREFUSED (or equivalent connection-closed error).
      let secondRequestFailed = false;
      try {
        await fetch(callbackUrl, { signal: AbortSignal.timeout(1000) });
      } catch {
        secondRequestFailed = true;
      }
      expect(secondRequestFailed).toBe(true);
    } finally {
      broker43.dispose();
    }
  });

  // ---------------------------------------------------------------------------
  // Task 4.8 — Construction-time validation: missing credentials throw at start()
  // ---------------------------------------------------------------------------

  it("start() throws a clear error when clientId is empty", async () => {
    const brokerNoId = createOAuthConsentBroker({
      openExternal: vi.fn(async (_url: string) => {}),
      clientId: "",
      clientSecret: "some-secret",
      createClient: makeFakeCreateClient(),
    });
    await expect(brokerNoId.start({ providerId: "google-drive" })).rejects.toThrow(
      /client.*id.*configured|FT5_GOOGLE_OAUTH_CLIENT_ID/i,
    );
    brokerNoId.dispose();
  });

  it("start() throws a clear error when clientSecret is empty", async () => {
    const brokerNoSecret = createOAuthConsentBroker({
      openExternal: vi.fn(async (_url: string) => {}),
      clientId: "some-id",
      clientSecret: "",
      createClient: makeFakeCreateClient(),
    });
    await expect(brokerNoSecret.start({ providerId: "google-drive" })).rejects.toThrow(
      /client.*secret.*configured|FT5_GOOGLE_OAUTH_CLIENT_SECRET/i,
    );
    brokerNoSecret.dispose();
  });

  // ---------------------------------------------------------------------------
  // Task 4.4 — Cancel closes listener and emits consent-cancelled
  // ---------------------------------------------------------------------------

  it("Cancel closes listener and emits consent-cancelled", async () => {
    const consentListener = vi.fn((_event: ConsentEvent) => {});
    const broker44 = createOAuthConsentBroker({
      openExternal,
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      createClient: makeFakeCreateClient(),
    });
    broker44.subscribe(consentListener);

    try {
      // RED: broker.start() throws "Not implemented" until task 4.7.
      const { sessionId } = await broker44.start({ providerId: "google-drive" });

      const session = broker44._getPendingSessionForTests(sessionId);
      expect(session).toBeDefined();
      const { port } = session!;

      // Verify server is listening before cancel.
      const preCancel = await fetch(
        "http://127.0.0.1:" + String(port) + "/health-probe",
        { signal: AbortSignal.timeout(2000) },
      );
      expect(preCancel.status).toBeGreaterThanOrEqual(100);

      // ACT: cancel the session.
      await broker44.cancel({ sessionId });

      // ASSERT 1: subsequent HTTP requests fail (ECONNREFUSED or similar).
      let connectionFailed = false;
      try {
        await fetch(
          "http://127.0.0.1:" + String(port) + "/callback",
          { signal: AbortSignal.timeout(1000) },
        );
      } catch {
        connectionFailed = true;
      }
      expect(connectionFailed).toBe(true);

      // ASSERT 2: consent-cancelled event emitted with matching sessionId.
      await vi.waitFor(() => {
        expect(consentListener).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
      const emittedEvent = consentListener.mock.calls[0]?.[0] as ConsentEvent;
      expect(emittedEvent).toMatchObject({ event: "consent-cancelled", sessionId });

      // ASSERT 3: pending session cleared.
      expect(broker44._getPendingSessionForTests(sessionId)).toBeUndefined();

      // ASSERT 4: second cancel is a no-op — no duplicate event, no thrown error.
      await expect(broker44.cancel({ sessionId })).resolves.toBeUndefined();
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(consentListener).toHaveBeenCalledTimes(1); // still exactly 1
    } finally {
      broker44.dispose();
    }
  });

  // ---------------------------------------------------------------------------
  // Task 4.5 — Timer fires at 5 minutes
  // ---------------------------------------------------------------------------

  it("Timer fires at 5 minutes", async () => {
    vi.useFakeTimers();
    const consentListener = vi.fn((_event: ConsentEvent) => {});
    const broker45 = createOAuthConsentBroker({
      openExternal,
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      createClient: makeFakeCreateClient(),
    });
    broker45.subscribe(consentListener);

    try {
      // RED: broker.start() throws "Not implemented" until task 4.7.
      const { sessionId } = await broker45.start({ providerId: "google-drive" });

      const session = broker45._getPendingSessionForTests(sessionId);
      expect(session).toBeDefined();
      const { port } = session!;

      // ACT: advance the clock by 300001 ms without any callback hit.
      await vi.advanceTimersByTimeAsync(300_001);

      // ASSERT 1: consent-timeout event emitted.
      await vi.waitFor(() => {
        expect(consentListener).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
      const emittedEvent = consentListener.mock.calls[0]?.[0] as ConsentEvent;
      expect(emittedEvent).toMatchObject({ event: "consent-timeout", sessionId });

      // ASSERT 2: loopback server is closed — new connection refused.
      let connectionFailed = false;
      try {
        await fetch("http://127.0.0.1:" + String(port) + "/callback");
      } catch {
        connectionFailed = true;
      }
      expect(connectionFailed).toBe(true);

      // ASSERT 3: pending session cleared.
      expect(broker45._getPendingSessionForTests(sessionId)).toBeUndefined();

      // ASSERT 4: no further events after the timeout.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(consentListener).toHaveBeenCalledTimes(1);
    } finally {
      broker45.dispose();
      vi.useRealTimers();
    }
  });

  // ---------------------------------------------------------------------------
  // Task 4.6 — Timer is cancelled on successful completion
  // ---------------------------------------------------------------------------

  it("Timer is cancelled on successful completion", async () => {
    vi.useFakeTimers();
    const consentListener = vi.fn((_event: ConsentEvent) => {});

    const fakeAuthResult: AuthResult = {
      accessToken: "real-access-token",
      refreshToken: "real-refresh-token",
      expiresAt: Date.now() + 3_600_000,
    };
    const { createClient } = makeFakeCreateClientWithResult(fakeAuthResult);
    const addToRegistry = vi.fn((summary: DatasourceSummary) => ({ ...summary }));
    const mintDatasourceId = vi.fn(() => "ds-test-timer");

    const broker46 = createOAuthConsentBroker({
      openExternal,
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      createClient,
      addToRegistry,
      mintDatasourceId,
    });
    broker46.subscribe(consentListener);

    try {
      // RED: broker.start() throws "Not implemented" until task 4.7.
      const { sessionId } = await broker46.start({ providerId: "google-drive" });

      const session = broker46._getPendingSessionForTests(sessionId);
      expect(session).toBeDefined();
      const { port, state: correctState } = session!;

      // Advance to t=60000 ms — timer has NOT fired yet (fires at 300000).
      await vi.advanceTimersByTimeAsync(60_000);

      // ACT: complete the callback at t=60000.
      const callbackUrl =
        "http://127.0.0.1:" + String(port) +
        "/callback?code=valid-code&state=" + encodeURIComponent(correctState);
      let response: Response;
      try {
        response = await fetch(callbackUrl);
      } catch (err) {
        throw new Error(
          "Expected HTTP server still listening at " + callbackUrl +
          " but got: " + String(err),
        );
      }
      expect(response.status).toBe(200);

      // ASSERT 1: exactly one consent-completed event.
      await vi.waitFor(() => {
        expect(consentListener).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
      const emittedEvent = consentListener.mock.calls[0]?.[0] as ConsentEvent;
      expect(emittedEvent).toMatchObject({ event: "consent-completed", sessionId });

      // ACT: advance well past the 5-minute mark.
      await vi.advanceTimersByTimeAsync(300_001);

      // ASSERT 2: no consent-timeout event — still exactly 1 event total.
      expect(consentListener).toHaveBeenCalledTimes(1);
    } finally {
      broker46.dispose();
      vi.useRealTimers();
    }
  });

});
