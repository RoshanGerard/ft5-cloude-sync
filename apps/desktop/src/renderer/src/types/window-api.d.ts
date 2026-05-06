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
import type { DownloadJob, UploadJob } from "@ft5/ipc-contracts/sync-service";
import type {
  SyncAuthenticateCancelRequest,
  SyncAuthenticateCancelResponse,
  SyncAuthenticateCompleteRequest,
  SyncAuthenticateCompleteResponse,
  SyncAuthenticateStartRequest,
  SyncAuthenticateStartResponse,
  SyncCancelUploadRequest,
  SyncCancelUploadResponse,
  SyncEvent,
  SyncListJobsRequest,
  SyncListJobsResponse,
  SyncUploadsListActiveResponse,
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
        onEvent(callback: (event: AnyDatasourceEvent) => void): () => void;
      };
      files: {
        list(req: FilesListRequest): Promise<FilesListResponse>;
        stat(req: FilesStatRequest): Promise<FilesStatResponse>;
        search(req: FilesSearchRequest): Promise<FilesSearchResponse>;
        rename(req: FilesRenameRequest): Promise<FilesRenameResponse>;
        remove(req: FilesRemoveRequest): Promise<FilesRemoveResponse>;
        download(req: FilesDownloadRequest): Promise<FilesDownloadResponse>;
        upload(req: FilesUploadRequest): Promise<FilesUploadResponse>;
        // add-engine-rename-download §18.3-§18.6: download-success toast
        // CTAs route through main → shell. The renderer never reaches
        // Electron's `shell` directly.
        openSavedPath(savedPath: string): Promise<void>;
        showSavedInFolder(savedPath: string): Promise<void>;
        // §18.9-§18.10: one-way main → renderer event channel; fires
        // EXACTLY ONCE per app session on the supervisor's first connect
        // with the active-downloads snapshot from `downloads:list-active`.
        // Reconnects mid-session do NOT re-fire.
        onActiveDownloadsHydrate(
          callback: (jobs: readonly DownloadJob[]) => void,
        ): () => void;
        // migrate-upload-orchestration-out-of-engine §13.3 / §15 — symmetric
        // upload-side hydrate channel. Fires once per app session on the
        // supervisor's first connect with the active-uploads snapshot
        // from `uploads:list-active`. Reconnects mid-session do NOT
        // re-fire — the live event feed (sync:event-stream filtered to
        // the four upload kinds) drives in-flight progress instead.
        onActiveUploadsHydrate(
          callback: (jobs: readonly UploadJob[]) => void,
        ): () => void;
      };
      clipboard: {
        writeText(text: string): Promise<void>;
      };
      // add-engine-rename-download §18.1-§18.2: download-default-folder
      // preferences API. Renderer-side `downloads-store` (built in §20)
      // is the durable owner via localStorage; this surface routes
      // through main IPC so callers outside the store have a uniform
      // window.api.* binding.
      preferences: {
        setDefaultDownloadsFolder(folder: string): Promise<void>;
        getDefaultDownloadsFolder(): Promise<string | null>;
        // Post-archive bug-fix follow-up — `app.getPath("downloads")`
        // exposure used by the first-run downloads modal to pre-fill a
        // REAL absolute path. The renderer composes `<resolved>/ft5`
        // with the host's separator.
        getOSDefaultDownloadsFolder(): Promise<string>;
      };
      // §18.7-§18.8: thin pass-through to Electron's `dialog.showSaveDialog`
      // for the download orchestrator's Shift+Click / Always-ask paths.
      dialog: {
        showSaveDialog(opts: {
          title?: string;
          defaultPath?: string;
          buttonLabel?: string;
          filters?: ReadonlyArray<{
            name: string;
            extensions: readonly string[];
          }>;
        }): Promise<{ canceled: boolean; filePath?: string }>;
      };
      // Task 10.2 narrowed this to just `onEvent`; the smoke of 10.9 then
      // needed `listJobs` to pull the initial state on mount (the pushed
      // sync-state-seed event races the renderer's subscription and gets
      // dropped on a fast handshake — see design.md appendix defect #7).
      // Widening further requires the corresponding RED-first coverage.
      sync: {
        onEvent(callback: (event: SyncEvent) => void): () => void;
        listJobs(req: SyncListJobsRequest): Promise<SyncListJobsResponse>;
        authenticateStart(
          req: SyncAuthenticateStartRequest,
        ): Promise<SyncAuthenticateStartResponse>;
        authenticateComplete(
          req: SyncAuthenticateCompleteRequest,
        ): Promise<SyncAuthenticateCompleteResponse>;
        authenticateCancel(
          req: SyncAuthenticateCancelRequest,
        ): Promise<SyncAuthenticateCancelResponse>;
        // migrate-upload-orchestration-out-of-engine §7.3 / §13.2 — the
        // upload-toaster's Cancel button routes through here, NOT
        // through `cancelJob` (which targets the legacy queue-based
        // upload job id). The bridge is a thin pass-through to the
        // service's `sync:cancel-upload` command; idempotent on
        // unknown `uploadJobId`.
        cancelUpload(
          req: SyncCancelUploadRequest,
        ): Promise<SyncCancelUploadResponse>;
      };
      // migrate-upload-orchestration-out-of-engine §7.2 — renderer-facing
      // namespace for the new `uploads:*` commands.
      uploads: {
        listActive(): Promise<SyncUploadsListActiveResponse>;
      };
      // Electron 32+ removed `File.path`. Drag-drop reads each dropped
      // File's absolute filesystem path via this contextBridge wrapper
      // around `electron.webUtils.getPathForFile` so the main-process
      // upload handler can stream the source.
      webUtils: {
        getPathForFile(file: File): string;
      };
    };
  }
}

export {};
