export type PingRequest = void;

export interface PingResponse {
  ok: true;
  ts: number;
}

export type {
  ConsentEvent,
  CredentialsSchema,
  DatasourceAction,
  DatasourceStatus,
  DatasourceSummary,
  DatasourceUsage,
  DatasourcesActionRequest,
  DatasourcesActionResponse,
  DatasourcesAddRequest,
  DatasourcesAddResponse,
  DatasourcesCancelConsentRequest,
  DatasourcesCancelConsentResponse,
  DatasourcesListRequest,
  DatasourcesListResponse,
  DatasourcesPickFilesRequest,
  DatasourcesPickFilesResponse,
  DatasourcesRemoveRequest,
  DatasourcesRemoveResponse,
  DatasourcesStartConsentRequest,
  DatasourcesStartConsentResponse,
  DatasourcesUploadProgressEvent,
  ErroredDatasourceSummary,
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
  FilesRemoveTarget,
  FilesRemoveValue,
  FilesRenameRequest,
  FilesRenameResponse,
  FilesSearchRequest,
  FilesSearchResponse,
  FilesSearchValue,
  FilesStatRequest,
  FilesStatResponse,
  FilesStatValue,
  FilesUploadRequest,
  FilesUploadResponse,
  FilesUploadValue,
  MimeFamily,
} from "./files.js";
export {
  FILES_CHANNELS,
  FILES_PROVIDER_SEARCH_DEFERRED_MESSAGE,
} from "./files.js";

// `ConflictPolicy` is the canonical union used by both the sync-service
// command surface and the new renderer-facing `FilesUploadRequest`. The
// canonical declaration lives in `./sync-service/commands.ts`; re-exported
// here so the renderer can import the upload contract and the policy union
// from a single top-level entry point without descending into the
// sync-service subpath.
export type { ConflictPolicy } from "./sync-service/commands.js";

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
// `DatasourceErrorTag` is now an `as const` object (per
// add-invalid-datasource-state Decision 1) — re-exported as a value so
// net-new code can reference `DatasourceErrorTag.InvalidDatasource`. The
// merged-name type-alias travels with the value export.
export {
  DatasourceError,
  DatasourceErrorTag,
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
