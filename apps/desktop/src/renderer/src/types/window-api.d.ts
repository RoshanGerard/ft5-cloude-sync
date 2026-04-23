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
import type { SyncEvent } from "@ft5/ipc-contracts/sync-service-desktop";

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
      clipboard: {
        writeText(text: string): Promise<void>;
      };
      // Task 10.2 — only the surface the renderer's jobs slice consumes.
      // The rest of `SYNC_CHANNELS` (listJobs/enqueueUpload/etc.) is the
      // preload's section-6 deliverable and is intentionally NOT surfaced
      // here so later task pairs follow the appropriate RED-first protocol
      // when they start consuming it.
      sync: {
        onEvent(callback: (event: SyncEvent) => void): () => void;
      };
    };
  }
}

export {};
