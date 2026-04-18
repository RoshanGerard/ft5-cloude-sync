export type PingRequest = void;

export interface PingResponse {
  ok: true;
  ts: number;
}

export type {
  CredentialsSchema,
  DatasourceAction,
  DatasourceStatus,
  DatasourceSummary,
  DatasourceUsage,
  DatasourcesActionRequest,
  DatasourcesActionResponse,
  DatasourcesAddRequest,
  DatasourcesAddResponse,
  DatasourcesListRequest,
  DatasourcesListResponse,
  DatasourcesRemoveRequest,
  DatasourcesRemoveResponse,
  DatasourcesUploadProgressEvent,
  DatasourcesUploadRequest,
  DatasourcesUploadResponse,
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderId,
} from "./datasources.js";
export { DATASOURCES_CHANNELS, providers } from "./datasources.js";
