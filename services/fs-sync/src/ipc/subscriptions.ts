// Per-connection subscription registry. A client only starts receiving
// events AFTER it sends `sync:subscribe-events`; closing the socket
// removes its subscription. Events are NOT buffered across disconnects.
//
// Spec: "Event subscription semantics" — per-client opt-in, cleanup on
// disconnect, no cross-client leakage.

import type {
  EventName,
  EventPayloadMap,
} from "@ft5/ipc-contracts/sync-service";

import type { EventBus } from "../events/event-bus.js";

import type { Connection } from "./server.js";

export interface SubscriptionRegistry {
  subscribe(conn: Connection): void;
  unsubscribe(conn: Connection): void;
  isSubscribed(conn: Connection): boolean;
  forget(conn: Connection): void;
  subscriberCount(): number;
  attachBus(bus: EventBus): () => void;
}

export function createSubscriptionRegistry(): SubscriptionRegistry {
  const subscribed = new Set<Connection>();

  return {
    subscribe(conn) {
      subscribed.add(conn);
    },
    unsubscribe(conn) {
      subscribed.delete(conn);
    },
    isSubscribed(conn) {
      return subscribed.has(conn);
    },
    forget(conn) {
      // Called when a socket closes. Idempotent.
      subscribed.delete(conn);
    },
    subscriberCount() {
      return subscribed.size;
    },
    attachBus(bus) {
      return bus.subscribe(
        <N extends EventName>(name: N, payload: EventPayloadMap[N]) => {
          for (const conn of subscribed) {
            if (conn.closed) {
              subscribed.delete(conn);
              continue;
            }
            try {
              conn.sendEvent({ name, payload });
            } catch {
              // Connection.sendEvent already swallows write errors;
              // defensive catch in case a listener further along throws.
              subscribed.delete(conn);
            }
          }
        },
      );
    },
  };
}
