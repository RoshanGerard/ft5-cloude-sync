import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsentEvent } from "@ft5/ipc-contracts";

import type { OAuthConsentBroker } from "../../../oauth/consent-broker.js";
import { handleDatasourcesStartConsent } from "../start-consent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeBroker(sessionId = "fake-session-id"): {
  broker: OAuthConsentBroker;
  emitToSubscribers: (event: ConsentEvent) => void;
} {
  const subscribers = new Set<(event: ConsentEvent) => void>();
  const broker: OAuthConsentBroker = {
    start: vi.fn().mockResolvedValue({ sessionId }),
    cancel: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn().mockImplementation((handler) => {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    }),
    _getPendingSessionForTests: vi.fn().mockReturnValue(undefined),
  };
  return {
    broker,
    emitToSubscribers: (event) => {
      for (const h of subscribers) h(event);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleDatasourcesStartConsent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { sessionId } from broker.start()", async () => {
    const { broker } = makeFakeBroker("test-session-abc");
    const sendToWindows = vi.fn();

    const result = await handleDatasourcesStartConsent(
      { providerId: "google-drive" },
      { broker, sendToWindows },
    );

    expect(result.sessionId).toBe("test-session-abc");
    expect(broker.start).toHaveBeenCalledWith({ providerId: "google-drive" });
  });

  it("passes datasourceId to broker.start when provided", async () => {
    const { broker } = makeFakeBroker("sess-1");
    const sendToWindows = vi.fn();

    await handleDatasourcesStartConsent(
      { providerId: "google-drive", datasourceId: "ds-existing" },
      { broker, sendToWindows },
    );

    expect(broker.start).toHaveBeenCalledWith({
      providerId: "google-drive",
      datasourceId: "ds-existing",
    });
  });

  it("forwards consent events to sendToWindows", async () => {
    const { broker, emitToSubscribers } = makeFakeBroker("sess-2");
    const sendToWindows = vi.fn();

    await handleDatasourcesStartConsent(
      { providerId: "google-drive" },
      { broker, sendToWindows },
    );

    const event: ConsentEvent = {
      event: "consent-completed",
      sessionId: "sess-2",
      datasourceId: "ds-new",
    };
    emitToSubscribers(event);

    expect(sendToWindows).toHaveBeenCalledWith(event);
  });

  it("does not forward events for a different sessionId", async () => {
    const { broker, emitToSubscribers } = makeFakeBroker("sess-3");
    const sendToWindows = vi.fn();

    await handleDatasourcesStartConsent(
      { providerId: "google-drive" },
      { broker, sendToWindows },
    );

    emitToSubscribers({ event: "consent-cancelled", sessionId: "other-session" });

    expect(sendToWindows).not.toHaveBeenCalled();
  });

  it("unsubscribes after a terminal consent-cancelled event", async () => {
    const { broker, emitToSubscribers } = makeFakeBroker("sess-4");
    const sendToWindows = vi.fn();

    await handleDatasourcesStartConsent(
      { providerId: "google-drive" },
      { broker, sendToWindows },
    );

    emitToSubscribers({ event: "consent-cancelled", sessionId: "sess-4" });
    // Second event should be ignored — subscription was torn down
    emitToSubscribers({
      event: "consent-completed",
      sessionId: "sess-4",
      datasourceId: "ds-x",
    });

    expect(sendToWindows).toHaveBeenCalledTimes(1);
    expect(sendToWindows).toHaveBeenCalledWith({
      event: "consent-cancelled",
      sessionId: "sess-4",
    });
  });

  it("unsubscribes after consent-completed", async () => {
    const { broker, emitToSubscribers } = makeFakeBroker("sess-5");
    const sendToWindows = vi.fn();

    await handleDatasourcesStartConsent(
      { providerId: "google-drive" },
      { broker, sendToWindows },
    );

    emitToSubscribers({
      event: "consent-completed",
      sessionId: "sess-5",
      datasourceId: "ds-y",
    });
    emitToSubscribers({ event: "consent-timeout", sessionId: "sess-5" });

    expect(sendToWindows).toHaveBeenCalledTimes(1);
  });
});
