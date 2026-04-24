// Renderer-scoped ambient for `window.api`. The preload has its own copy of
// this declaration (apps/desktop/src/preload/window-api.d.ts) that lives in
// the preload tsconfig; this file is the renderer's canonical source and is
// intentionally not shared, so renderer code never picks up Node/Electron
// types through the preload's `.d.ts`.
import type {
  AnyDatasourceEvent,
  DatasourcesActionRequest,
  DatasourcesActionResponse,
  DatasourcesAddRequest,
  DatasourcesAddResponse,
  DatasourcesListResponse,
  DatasourcesPickFilesResponse,
  DatasourcesRemoveRequest,
  DatasourcesRemoveResponse,
  DatasourcesUploadProgressEvent,
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
  FilesUploadRequest,
  FilesUploadResponse,
  PingResponse,
} from "@ft5/ipc-contracts";
import type {
  SyncEvent,
  SyncListJobsRequest,
  SyncListJobsResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

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
        pickFilesToUpload(): Promise<DatasourcesPickFilesResponse>;
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
        upload(req: FilesUploadRequest): Promise<FilesUploadResponse>;
      };
      clipboard: {
        writeText(text: string): Promise<void>;
      };
      // Task 10.2 narrowed this to just `onEvent`; the smoke of 10.9 then
      // needed `listJobs` to pull the initial state on mount (the pushed
      // sync-state-seed event races the renderer's subscription and gets
      // dropped on a fast handshake — see design.md appendix defect #7).
      // Widening further requires the corresponding RED-first coverage.
      sync: {
        onEvent(callback: (event: SyncEvent) => void): () => void;
        listJobs(req: SyncListJobsRequest): Promise<SyncListJobsResponse>;
      };
    };
  }
}

export {};
