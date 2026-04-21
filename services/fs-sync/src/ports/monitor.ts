// MonitorEventSource input port. A future `services/fs-monitor` change
// supplies a concrete implementation driving auto-sync; in v1 the service
// binds NoopMonitorEventSource so the architecture stays pluggable.
//
// Spec: "MonitorEventSource input port with no-op default implementation".

export type MonitorChangeEvent =
  | { readonly kind: "file-created"; readonly datasourceId: string; readonly relPath: string }
  | { readonly kind: "file-modified"; readonly datasourceId: string; readonly relPath: string }
  | { readonly kind: "file-deleted"; readonly datasourceId: string; readonly relPath: string }
  | { readonly kind: "source-appeared"; readonly datasourceId: string }
  | { readonly kind: "source-disappeared"; readonly datasourceId: string };

export interface MonitorSnapshotEvent {
  readonly datasourceId: string;
  readonly files: ReadonlyArray<{
    readonly relPath: string;
    readonly size: number;
    readonly mtimeMs: number;
  }>;
}

export interface MonitorEventSource {
  onChange(listener: (e: MonitorChangeEvent) => void): () => void;
  onSnapshot(listener: (e: MonitorSnapshotEvent) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
