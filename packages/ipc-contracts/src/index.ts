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

export type {
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  DatasourceErrorInit,
  DatasourceErrorTag,
  DatasourceEvent,
  DatasourceType,
  FileEntry,
  FileMetadata,
  MimeFamily,
  OAuthIntent,
  PayloadMap,
  ProviderMetadata,
  ProviderMetadataMap,
  Quota,
  SerializedDatasourceError,
  StoredCredentials,
  Target,
} from "./fs-datasource-engine.js";
export {
  DatasourceError,
  serializeDatasourceError,
} from "./fs-datasource-engine.js";
