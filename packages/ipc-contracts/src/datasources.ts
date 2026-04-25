export type DatasourceStatus = "connected" | "syncing" | "paused" | "error";

export interface DatasourceUsage {
  used: number;
  quota: number;
}

export interface DatasourceSummary {
  id: string;
  displayName: string;
  providerId: string;
  status: DatasourceStatus;
  lastSyncAt: number | null;
  itemCount: number;
  usage?: DatasourceUsage;
  errorReason?: string;
}

export type CredentialsSchema = "oauth" | "aws-access-key" | "custom";

export interface ProviderCapabilities {
  quota: boolean;
  oauth: boolean;
  directUpload: boolean;
}

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  icon: string;
  capabilities: ProviderCapabilities;
  credentialsSchema: CredentialsSchema;
}

export const providers = {
  "google-drive": {
    id: "google-drive",
    displayName: "Google Drive",
    icon: "cloud",
    capabilities: { quota: true, oauth: true, directUpload: true },
    credentialsSchema: "oauth",
  },
  onedrive: {
    id: "onedrive",
    displayName: "OneDrive",
    icon: "cloud",
    capabilities: { quota: true, oauth: true, directUpload: true },
    credentialsSchema: "oauth",
  },
  "amazon-s3": {
    id: "amazon-s3",
    displayName: "Amazon S3",
    icon: "database",
    capabilities: { quota: false, oauth: false, directUpload: true },
    credentialsSchema: "aws-access-key",
  },
} as const satisfies Record<string, ProviderDescriptor>;

export type ProviderId = keyof typeof providers;

export type DatasourcesListRequest = void;
export interface DatasourcesListResponse {
  datasources: DatasourceSummary[];
}

export interface DatasourcesAddRequest {
  providerId: string;
  credentials: Record<string, unknown>;
}
export interface DatasourcesAddResponse {
  datasource: DatasourceSummary;
}

export interface DatasourcesRemoveRequest {
  datasourceId: string;
}
export interface DatasourcesRemoveResponse {
  ok: true;
}

export type DatasourceAction = "pause" | "resume" | "sync-now";

export interface DatasourcesActionRequest {
  datasourceId: string;
  action: DatasourceAction;
}
export interface DatasourcesActionResponse {
  datasource: DatasourceSummary;
}

// The legacy upload request/response types on this surface were retired by
// `add-file-explorer-drag-drop-upload`. Uploads now flow through
// `files.upload` (→ sync-service `sync:enqueue-upload`). The progress event
// shape below survives because the `uploadProgress` channel is still the
// transport for per-job progress notifications keyed on `transactionId`
// (the sync-service's job id).
export interface DatasourcesUploadProgressEvent {
  transactionId: string;
  bytesUploaded: number;
  bytesTotal: number;
  status: "uploading" | "completed" | "failed";
  error?: string;
}

// `datasources:pick-files-to-upload` is the main-process dialog handler
// the renderer calls to open the native "Open File" multi-select dialog.
// The request carries no fields (the dialog's configuration lives in the
// handler); the response returns the absolute OS paths the user picked,
// or `canceled: true` when the user dismissed the dialog. `filePaths` is
// `readonly` so callers can't mutate the OS-provided list in place.
export type DatasourcesPickFilesRequest = Record<string, never>;
export interface DatasourcesPickFilesResponse {
  filePaths: readonly string[];
  canceled: boolean;
}

export const DATASOURCES_CHANNELS = {
  list: "datasources:list",
  add: "datasources:add",
  remove: "datasources:remove",
  action: "datasources:action",
  // Replaces the retired upload-channel slot (now removed). Opens the
  // native multi-select "Open File" dialog; the renderer then dispatches
  // each picked path through `files.upload`.
  pickFilesToUpload: "datasources:pick-files-to-upload",
  uploadProgress: "datasources:upload:progress",
  // One-way main → renderer stream carrying `DatasourceEvent<T, K>` envelopes
  // emitted by the FS Datasource Engine's bus. Wired up by the event bridge
  // in Phase 10 of `openspec/changes/add-fs-datasource-engine`; declared here
  // in Phase 1 so contract consumers can name the channel without reaching
  // into a later-phase file.
  event: "datasources:event",
} as const;
