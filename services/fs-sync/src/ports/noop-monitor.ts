// NoopMonitorEventSource — v1 default. start/stop resolve successfully;
// onChange / onSnapshot register listeners that are never invoked.

import type {
  MonitorChangeEvent,
  MonitorEventSource,
  MonitorSnapshotEvent,
} from "./monitor.js";

export class NoopMonitorEventSource implements MonitorEventSource {
  onChange(listener: (e: MonitorChangeEvent) => void): () => void {
    void listener;
    return () => void 0;
  }
  onSnapshot(listener: (e: MonitorSnapshotEvent) => void): () => void {
    void listener;
    return () => void 0;
  }
  async start(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
}
