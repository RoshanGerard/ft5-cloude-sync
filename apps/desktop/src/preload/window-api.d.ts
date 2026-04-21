import type {
  AnyDatasourceEvent,
  DatasourcesActionRequest,
  DatasourcesActionResponse,
  DatasourcesAddRequest,
  DatasourcesAddResponse,
  DatasourcesListResponse,
  DatasourcesRemoveRequest,
  DatasourcesRemoveResponse,
  DatasourcesUploadProgressEvent,
  DatasourcesUploadRequest,
  DatasourcesUploadResponse,
  FilesDownloadRequest,
  FilesDownloadResponse,
  FilesListRequest,
  FilesListResponse,
  FilesRemoveRequest,
  FilesRemoveResponse,
  FilesRenameRequest,
  FilesRenameResponse,
  FilesSearchRequest,
  FilesSearchResponse,
  FilesStatRequest,
  FilesStatResponse,
  PingResponse,
} from "@ft5/ipc-contracts";

// Ambient augmentation of the DOM `Window` interface so renderer code can
// type-check calls to `window.api.*` without importing from this preload
// directory (which the architecture-lint rules forbid for the renderer).
// This file lives next to the preload sources per tasks.md 5.2.
//
// We also re-export `PingResponse` from here per the tasks.md directive
// ("preload-local .d.ts that re-exports PingResponse from @ft5/ipc-contracts").
// The re-export is declarative only -- renderer code may instead depend on
// `@ft5/ipc-contracts` directly in Section 6; this does not lock that choice.
export type { PingResponse } from "@ft5/ipc-contracts";

declare global {
  interface Window {
    api: {
      ping(): Promise<PingResponse>;
      datasources: {
        list(): Promise<DatasourcesListResponse>;
        add(req: DatasourcesAddRequest): Promise<DatasourcesAddResponse>;
        remove(
          req: DatasourcesRemoveRequest,
        ): Promise<DatasourcesRemoveResponse>;
        action(
          req: DatasourcesActionRequest,
        ): Promise<DatasourcesActionResponse>;
        upload(
          req: DatasourcesUploadRequest,
        ): Promise<DatasourcesUploadResponse>;
        onUploadProgress(
          transactionId: string,
          callback: (event: DatasourcesUploadProgressEvent) => void,
        ): () => void;
        onEvent(
          callback: (event: AnyDatasourceEvent) => void,
        ): () => void;
      };
      files: {
        list(req: FilesListRequest): Promise<FilesListResponse>;
        stat(req: FilesStatRequest): Promise<FilesStatResponse>;
        search(req: FilesSearchRequest): Promise<FilesSearchResponse>;
        rename(req: FilesRenameRequest): Promise<FilesRenameResponse>;
        remove(req: FilesRemoveRequest): Promise<FilesRemoveResponse>;
        download(req: FilesDownloadRequest): Promise<FilesDownloadResponse>;
      };
    };
  }
}

export {};
