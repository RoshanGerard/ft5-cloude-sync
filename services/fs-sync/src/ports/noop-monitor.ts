// NoopMonitorEventSource — v1 default. start/stop resolve successfully;
// onChange / onSnapshot register listeners that are never invoked.

import type {
  MonitorChangeEvent,
  MonitorEventSource,
  MonitorSnapshotEvent,
} from "./monitor.js";

export class NoopMonitorEventSource implements MonitorEventSource {
  onChange(_listener: (e: MonitorChangeEvent) => void): () => void {
    return () => void 0;
  }
  onSnapshot(_listener: (e: MonitorSnapshotEvent) => void): () => void {
    return () => void 0;
  }
  async start(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
}
