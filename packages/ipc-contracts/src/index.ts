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

// UI / file-explorer-facing file primitives (non-generic). These are the
// shapes the renderer's file-explorer feature consumes via
// `window.api.files.*`. Shipped by the `ui-file-explorer` change.
export type {
  EntryKind,
  FileEntry,
  FilesDownloadRequest,
  FilesDownloadResponse,
  FilesEnvelope,
  FilesErrorEnvelope,
  FilesErrorTag,
  FilesListRequest,
  FilesListResponse,
  FilesListValue,
  FilesRemoveEntryResult,
  FilesRemoveRequest,
  FilesRemoveResponse,
  FilesRemoveValue,
  FilesRenameRequest,
  FilesRenameResponse,
  FilesSearchRequest,
  FilesSearchResponse,
  FilesSearchValue,
  FilesStatRequest,
  FilesStatResponse,
  FilesStatValue,
  MimeFamily,
} from "./files.js";
export {
  FILES_CHANNELS,
  FILES_PROVIDER_SEARCH_DEFERRED_MESSAGE,
} from "./files.js";

// Engine-facing file primitives (generic over `DatasourceType`). These live
// alongside the UI's `FileEntry` / `MimeFamily` rather than replacing them;
// the two serve different domains (UI display vs. provider abstraction) and
// carry different fields. Shipped by `add-fs-datasource-engine`.
export type {
  AnyDatasourceEvent,
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  DatasourceErrorInit,
  DatasourceErrorTag,
  DatasourceEvent,
  DatasourceFileEntry,
  DatasourceMimeFamily,
  DatasourceType,
  FileMetadata,
  OAuthIntent,
  PayloadMap,
  ProviderMetadata,
  ProviderMetadataMap,
  Quota,
  SerializedDatasourceError,
  StoredCredentials,
  Target,
  UploadCancelReason,
  UploadCancelledPayload,
} from "./fs-datasource-engine.js";
export {
  DatasourceError,
  serializeDatasourceError,
} from "./fs-datasource-engine.js";

// Sync-service IPC contract surface. Shipped by `add-fs-sync-service`.
// Clients reach this via the `@ft5/ipc-contracts/sync-service` subpath
// (see package.json `exports`).
export * as SyncService from "./sync-service/index.js";

// Renderer-facing sync-service IPC surface. Shipped by
// `wire-fs-sync-service`. Re-exports the channel constants at the top
// level for convenience (the preload and main process are the primary
// consumers; the full subpath `@ft5/ipc-contracts/sync-service-desktop`
// is the canonical import for the type surface).
export { SYNC_CHANNELS } from "./sync-service-desktop/channels.js";
export type { SyncChannelName } from "./sync-service-desktop/channels.js";
