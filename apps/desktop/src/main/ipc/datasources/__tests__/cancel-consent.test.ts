import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsentEvent } from "@ft5/ipc-contracts";

import type { OAuthConsentBroker } from "../../../oauth/consent-broker.js";
import { handleDatasourcesCancelConsent } from "../cancel-consent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeBroker(): OAuthConsentBroker {
  return {
    start: vi.fn().mockResolvedValue({ sessionId: "fake-session" }),
    cancel: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn().mockImplementation(() => () => undefined),
    _getPendingSessionForTests: vi.fn().mockReturnValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleDatasourcesCancelConsent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates to broker.cancel with the correct sessionId", async () => {
    const broker = makeFakeBroker();

    const result = await handleDatasourcesCancelConsent(
      { sessionId: "sess-to-cancel" },
      { broker },
    );

    expect(broker.cancel).toHaveBeenCalledWith({ sessionId: "sess-to-cancel" });
    expect(broker.cancel).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  it("tolerates an unknown sessionId without throwing (idempotent)", async () => {
    const broker = makeFakeBroker();
    // broker.cancel is already a no-op for unknown sessions (idempotency
    // is enforced inside the broker, not the handler)
    await expect(
      handleDatasourcesCancelConsent({ sessionId: "nonexistent-session" }, { broker }),
    ).resolves.toBeUndefined();
    expect(broker.cancel).toHaveBeenCalledWith({ sessionId: "nonexistent-session" });
  });

  it("returns void — not a DatasourceSummary or any other value", async () => {
    const broker = makeFakeBroker();

    const result = await handleDatasourcesCancelConsent(
      { sessionId: "s1" },
      { broker },
    );

    expect(result).toBeUndefined();
  });
});

// Satisfy the unused import check — `ConsentEvent` is imported for
// type-level documentation parity with the start-consent test helper.
type _ConsentEventUsed = ConsentEvent;
