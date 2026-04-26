// Tests for `sync:authenticate-cancel` handler — implement-datasource-
// onboarding §11.
//
// Cancel is symmetric across the OAuth (broker) and credentials-form
// (correlation store) branches. The handler tries both paths in the
// same call — they are mutually exclusive in practice but the handler
// does not need to know which branch is active.
//
// Idempotent: a second cancel for the same correlationId returns
// `{ok: true, result: {cancelled: false}}` and emits no further event.

import { describe, expect, it, vi } from "vitest";

import type { CredentialsFormIntent } from "@ft5/fs-datasource-engine";

import { createEventBus, type EventBus } from "../events/event-bus.js";
import type { EventName, EventPayloadMap } from "@ft5/ipc-contracts/sync-service";
import {
  createAuthCorrelationStore,
  type AuthCorrelationStore,
} from "../state/auth-correlation-store.js";
import type { OAuthLoopbackBroker } from "../oauth/loopback-broker.js";
import type { Connection } from "../ipc/server.js";

import { makeAuthenticateCancelHandler } from "./authenticate-cancel.js";

const ctx = (): { readonly connection: Connection } => ({
  connection: {
    id: 1,
    closed: false,
    sendEvent: () => void 0,
  },
});

function makeBusSpy(bus: EventBus): {
  events: Array<{ name: EventName; payload: EventPayloadMap[EventName] }>;
} {
  const events: Array<{ name: EventName; payload: EventPayloadMap[EventName] }> = [];
  bus.subscribe((name, payload) => {
    events.push({ name, payload: payload as EventPayloadMap[EventName] });
  });
  return { events };
}

interface DepsBundle {
  bus: EventBus;
  events: Array<{ name: EventName; payload: EventPayloadMap[EventName] }>;
  correlationStore: AuthCorrelationStore;
  brokerCancel: ReturnType<typeof vi.fn>;
  /** Set of correlationIds the broker considers "active" — broker.cancel
   *  is idempotent in production, but the test stub differentiates
   *  active vs unknown so we can assert the broker emitted auth-cancelled
   *  exactly once. The fake broker emits auth-cancelled itself when the
   *  id is in this set, mirroring real broker behaviour. */
  activeBrokerIds: Set<string>;
}

function buildDeps(): DepsBundle {
  const bus = createEventBus();
  const { events } = makeBusSpy(bus);
  const correlationStore = createAuthCorrelationStore();
  const activeBrokerIds = new Set<string>();
  const brokerCancel = vi.fn(async (opts: { correlationId: string }) => {
    if (activeBrokerIds.delete(opts.correlationId)) {
      bus.emit("auth-cancelled", { correlationId: opts.correlationId });
    }
  });
  return { bus, events, correlationStore, brokerCancel, activeBrokerIds };
}

function buildHandler(d: DepsBundle) {
  const broker = {
    start: vi.fn(),
    cancel: d.brokerCancel,
    dispose: vi.fn(),
    _getPendingSessionForTests: vi.fn(),
  } as unknown as OAuthLoopbackBroker;
  return makeAuthenticateCancelHandler({
    bus: d.bus,
    correlationStore: d.correlationStore,
    loopbackBroker: broker,
  });
}

function makeFormIntent(): CredentialsFormIntent {
  return {
    kind: "credentials-form",
    schema: "aws-access-key",
    submit: vi.fn(async () => ({ accessToken: "x" })),
  };
}

describe("sync:authenticate-cancel handler — implement-datasource-onboarding §11", () => {
  it("OAuth pending: broker.cancel called, broker emits auth-cancelled, handler returns cancelled=true", async () => {
    const d = buildDeps();
    d.activeBrokerIds.add("corr-oauth");
    const handler = buildHandler(d);

    const res = await handler({ correlationId: "corr-oauth" }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.cancelled).toBe(true);

    expect(d.brokerCancel).toHaveBeenCalledTimes(1);
    expect(d.brokerCancel).toHaveBeenCalledWith({ correlationId: "corr-oauth" });

    // auth-cancelled fired exactly once (from broker — handler does NOT
    // double-emit when the broker already did).
    expect(d.events.filter((e) => e.name === "auth-cancelled")).toHaveLength(1);
  });

  it("credentials-form pending: correlationStore.consume called, handler emits auth-cancelled, broker.cancel is a no-op", async () => {
    const d = buildDeps();
    d.correlationStore.createWith("corr-form", makeFormIntent(), {
      datasourceId: "ds-form",
      providerId: "amazon-s3",
    });
    const handler = buildHandler(d);

    const res = await handler({ correlationId: "corr-form" }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.cancelled).toBe(true);

    // Correlation store entry is gone.
    expect(d.correlationStore.peek("corr-form")).toBeUndefined();

    // broker.cancel called (handler is branch-agnostic) but is a no-op
    // because the id was never in the broker's active set.
    expect(d.brokerCancel).toHaveBeenCalledTimes(1);

    // auth-cancelled emitted exactly once (by the handler — broker did
    // nothing for an unknown id).
    const cancelled = d.events.filter((e) => e.name === "auth-cancelled");
    expect(cancelled).toHaveLength(1);
    expect(
      (cancelled[0]!.payload as EventPayloadMap["auth-cancelled"]).correlationId,
    ).toBe("corr-form");
  });

  it("idempotent: second cancel for the same correlationId returns cancelled=false, emits NO event", async () => {
    const d = buildDeps();
    d.correlationStore.createWith("corr-x", makeFormIntent(), {
      datasourceId: "ds-x",
      providerId: "amazon-s3",
    });
    const handler = buildHandler(d);

    // First cancel — succeeds.
    const r1 = await handler({ correlationId: "corr-x" }, ctx());
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.result.cancelled).toBe(true);
    expect(d.events.filter((e) => e.name === "auth-cancelled")).toHaveLength(1);

    // Second cancel — already gone everywhere.
    const r2 = await handler({ correlationId: "corr-x" }, ctx());
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.result.cancelled).toBe(false);

    // No new event.
    expect(d.events.filter((e) => e.name === "auth-cancelled")).toHaveLength(1);
  });

  it("unknown correlationId: returns cancelled=false, emits no event, no error", async () => {
    const d = buildDeps();
    const handler = buildHandler(d);

    const res = await handler({ correlationId: "never-existed" }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.cancelled).toBe(false);

    // broker.cancel was still tried (branch-agnostic), it just did nothing.
    expect(d.brokerCancel).toHaveBeenCalledTimes(1);

    // No event.
    expect(d.events).toHaveLength(0);
  });
});
