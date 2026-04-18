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

export interface DatasourcesUploadRequest {
  datasourceId: string;
}
export interface DatasourcesUploadResponse {
  transactionId: string;
}
export interface DatasourcesUploadProgressEvent {
  transactionId: string;
  bytesUploaded: number;
  bytesTotal: number;
  status: "uploading" | "completed" | "failed";
  error?: string;
}

export const DATASOURCES_CHANNELS = {
  list: "datasources:list",
  add: "datasources:add",
  remove: "datasources:remove",
  action: "datasources:action",
  upload: "datasources:upload",
  uploadProgress: "datasources:upload:progress",
} as const;
