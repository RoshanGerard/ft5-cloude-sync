// Minimal internal event bus for the service. Producers (state-machine
// transitions, scheduler, executors, credential store, probe) emit events
// here; consumers (the IPC subscription layer, the logger) subscribe. No
// cross-process concerns live in this module.

import type {
  EventName,
  EventPayloadMap,
} from "@ft5/ipc-contracts/sync-service";

export type Listener = <N extends EventName>(
  name: N,
  payload: EventPayloadMap[N],
) => void;

export interface EventBus {
  emit<N extends EventName>(name: N, payload: EventPayloadMap[N]): void;
  subscribe(listener: Listener): () => void;
}

export function createEventBus(): EventBus {
  const listeners = new Set<Listener>();
  return {
    emit(name, payload) {
      for (const l of listeners) {
        try {
          l(name, payload);
        } catch {
          /* never let one listener break others */
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
