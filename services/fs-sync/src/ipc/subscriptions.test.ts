import { describe, expect, it, vi } from "vitest";

import { createEventBus, type EventBus } from "../events/event-bus.js";

import { createSubscriptionRegistry } from "./subscriptions.js";
import type { Connection } from "./server.js";

function makeFakeConnection(id: number): Connection & {
  seen: Array<{ name: string; payload: unknown }>;
} {
  const seen: Array<{ name: string; payload: unknown }> = [];
  const conn: Connection & { seen: typeof seen } = {
    id,
    closed: false,
    seen,
    sendEvent(event) {
      seen.push({ name: event.name, payload: event.payload });
    },
  };
  return conn;
}

function emitJobStarted(bus: EventBus, jobId: string): void {
  bus.emit("job-started", {
    jobId,
    attempt: 1,
    startedAt: Date.now(),
  });
}

describe("SubscriptionRegistry", () => {
  it("does NOT deliver events to unsubscribed connections", () => {
    const bus = createEventBus();
    const reg = createSubscriptionRegistry();
    const detach = reg.attachBus(bus);

    const conn = makeFakeConnection(1);
    emitJobStarted(bus, "j-1");
    expect(conn.seen).toHaveLength(0);
    detach();
  });

  it("delivers events to a subscribed connection; stops after unsubscribe", () => {
    const bus = createEventBus();
    const reg = createSubscriptionRegistry();
    reg.attachBus(bus);

    const conn = makeFakeConnection(1);
    reg.subscribe(conn);

    emitJobStarted(bus, "j-1");
    expect(conn.seen.map((e) => e.name)).toEqual(["job-started"]);

    reg.unsubscribe(conn);
    emitJobStarted(bus, "j-2");
    expect(conn.seen).toHaveLength(1); // unchanged
  });

  it("forget() cleans up a subscription (simulated socket close)", () => {
    const bus = createEventBus();
    const reg = createSubscriptionRegistry();
    reg.attachBus(bus);

    const conn = makeFakeConnection(1);
    reg.subscribe(conn);
    reg.forget(conn);
    emitJobStarted(bus, "j-1");
    expect(conn.seen).toHaveLength(0);
    expect(reg.subscriberCount()).toBe(0);
  });

  it("isolated per client — only subscribed clients receive events", () => {
    const bus = createEventBus();
    const reg = createSubscriptionRegistry();
    reg.attachBus(bus);

    const a = makeFakeConnection(1);
    const b = makeFakeConnection(2);
    reg.subscribe(a);
    // b never subscribes.
    emitJobStarted(bus, "j-1");
    expect(a.seen.map((e) => e.name)).toEqual(["job-started"]);
    expect(b.seen).toHaveLength(0);
  });

  it("closed connection is dropped lazily on next emission", () => {
    const bus = createEventBus();
    const reg = createSubscriptionRegistry();
    reg.attachBus(bus);

    const conn = makeFakeConnection(1);
    reg.subscribe(conn);
    (conn as { closed: boolean }).closed = true; // simulate socket-close race

    emitJobStarted(bus, "j-1");
    expect(conn.seen).toHaveLength(0);
    expect(reg.subscriberCount()).toBe(0);
  });

  it("sendEvent throw is swallowed and the connection is dropped", () => {
    const bus = createEventBus();
    const reg = createSubscriptionRegistry();
    reg.attachBus(bus);

    const exploder: Connection = {
      id: 1,
      closed: false,
      sendEvent: vi.fn(() => {
        throw new Error("EPIPE");
      }),
    };
    reg.subscribe(exploder);
    expect(() => emitJobStarted(bus, "j-1")).not.toThrow();
    expect(reg.subscriberCount()).toBe(0);
  });

  it("detach() stops future deliveries to every subscriber", () => {
    const bus = createEventBus();
    const reg = createSubscriptionRegistry();
    const detach = reg.attachBus(bus);
    const conn = makeFakeConnection(1);
    reg.subscribe(conn);
    emitJobStarted(bus, "j-1");
    expect(conn.seen).toHaveLength(1);
    detach();
    emitJobStarted(bus, "j-2");
    expect(conn.seen).toHaveLength(1); // unchanged
  });
});
