import type {
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
// migrate-upload-orchestration-out-of-engine §13.3 — `UploadJob` joins
// the import set alongside `DownloadJob`. The callback parameter on
// `files.onActiveUploadsHydrate` is `readonly UploadJob[]`, parallel to
// the download equivalent. Chunk C kept this import out because the
// hydrate channel hadn't been wired yet; chunk E adds the desktop
// bridge + preload binding so the type now lives on the cross-bridge
// callback.
import type { DownloadJob, UploadJob } from "@ft5/ipc-contracts/sync-service";
import type {
  SyncAuthenticateCancelRequest,
  SyncAuthenticateCancelResponse,
  SyncAuthenticateCompleteRequest,
  SyncAuthenticateCompleteResponse,
  SyncAuthenticateStartRequest,
  SyncAuthenticateStartResponse,
  SyncCancelDownloadRequest,
  SyncCancelDownloadResponse,
  SyncCancelJobRequest,
  SyncCancelJobResponse,
  SyncCancelUploadRequest,
  SyncCancelUploadResponse,
  SyncUploadsListActiveResponse,
  SyncEnqueueMirrorRequest,
  SyncEnqueueMirrorResponse,
  SyncEvent,
  SyncGetJobRequest,
  SyncGetJobResponse,
  SyncGetRetryPolicyRequest,
  SyncGetRetryPolicyResponse,
  SyncGetStatusResponse,
  SyncListJobsRequest,
  SyncListJobsResponse,
  SyncSetRetryPolicyRequest,
  SyncSetRetryPolicyResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

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
        pickFilesToUpload(): Promise<DatasourcesPickFilesResponse>;
      };
      files: {
        list(req: FilesListRequest): Promise<FilesListResponse>;
        stat(req: FilesStatRequest): Promise<FilesStatResponse>;
        search(req: FilesSearchRequest): Promise<FilesSearchResponse>;
        rename(req: FilesRenameRequest): Promise<FilesRenameResponse>;
        remove(req: FilesRemoveRequest): Promise<FilesRemoveResponse>;
        download(req: FilesDownloadRequest): Promise<FilesDownloadResponse>;
        upload(req: FilesUploadRequest): Promise<FilesUploadResponse>;
        openSavedPath(savedPath: string): Promise<void>;
        showSavedInFolder(savedPath: string): Promise<void>;
        onActiveDownloadsHydrate(
          callback: (jobs: readonly DownloadJob[]) => void,
        ): () => void;
        // migrate-upload-orchestration-out-of-engine §13.3 — symmetric
        // upload-side hydrate channel. Fires once per app session on
        // the supervisor's first connect. Reconnects mid-session do
        // NOT re-fire — the live event feed (sync:event-stream filtered
        // to the four upload kinds) drives in-flight progress instead.
        onActiveUploadsHydrate(
          callback: (jobs: readonly UploadJob[]) => void,
        ): () => void;
      };
      preferences: {
        setDefaultDownloadsFolder(folder: string): Promise<void>;
        getDefaultDownloadsFolder(): Promise<string | null>;
        // Post-archive bug-fix follow-up — `app.getPath("downloads")`
        // exposure for the first-run downloads modal pre-fill.
        getOSDefaultDownloadsFolder(): Promise<string>;
      };
      dialog: {
        // Electron's `SaveDialogOptions` and `SaveDialogReturnValue` are
        // re-declared here as a structural subset so the preload type
        // surface stays free of an `electron` import. The fields below
        // match the design V4 / spec.md "Default folder path" + Save-as
        // flow's actual usage.
        showSaveDialog(opts: {
          title?: string;
          defaultPath?: string;
          buttonLabel?: string;
          filters?: ReadonlyArray<{
            name: string;
            extensions: readonly string[];
          }>;
        }): Promise<{ canceled: boolean; filePath?: string }>;
        // add-engine-rename-download §21 prerequisite — directory-pick
        // surface for the first-run downloads modal's Browse button
        // (§21) and the Settings dialog's Change… button (§22).
        // Structural subset of Electron's `OpenDialogOptions` /
        // `OpenDialogReturnValue`; properties is typed as a readonly
        // string array — the renderer constrains the vocabulary at
        // the call site to `['openDirectory', 'createDirectory']`.
        showOpenDialog(opts: {
          title?: string;
          defaultPath?: string;
          buttonLabel?: string;
          properties?: readonly string[];
          filters?: ReadonlyArray<{
            name: string;
            extensions: readonly string[];
          }>;
        }): Promise<{ canceled: boolean; filePaths: readonly string[] }>;
      };
      sync: {
        listJobs(req: SyncListJobsRequest): Promise<SyncListJobsResponse>;
        getJob(req: SyncGetJobRequest): Promise<SyncGetJobResponse>;
        // migrate-upload-orchestration-out-of-engine §11 / §7.4 — the
        // `enqueueUpload` preload binding was deleted in chunk F. The
        // renderer's upload path is `window.api.files.upload`.
        enqueueMirror(
          req: SyncEnqueueMirrorRequest,
        ): Promise<SyncEnqueueMirrorResponse>;
        cancelJob(req: SyncCancelJobRequest): Promise<SyncCancelJobResponse>;
        cancelDownload(
          req: SyncCancelDownloadRequest,
        ): Promise<SyncCancelDownloadResponse>;
        // migrate-upload-orchestration-out-of-engine §7.3 / §7.9.
        cancelUpload(
          req: SyncCancelUploadRequest,
        ): Promise<SyncCancelUploadResponse>;
        authenticateStart(
          req: SyncAuthenticateStartRequest,
        ): Promise<SyncAuthenticateStartResponse>;
        authenticateComplete(
          req: SyncAuthenticateCompleteRequest,
        ): Promise<SyncAuthenticateCompleteResponse>;
        authenticateCancel(
          req: SyncAuthenticateCancelRequest,
        ): Promise<SyncAuthenticateCancelResponse>;
        // `getStatus` has a void request type — no argument, mirrors ping().
        getStatus(): Promise<SyncGetStatusResponse>;
        getRetryPolicy(
          req: SyncGetRetryPolicyRequest,
        ): Promise<SyncGetRetryPolicyResponse>;
        setRetryPolicy(
          req: SyncSetRetryPolicyRequest,
        ): Promise<SyncSetRetryPolicyResponse>;
        onEvent(callback: (event: SyncEvent) => void): () => void;
      };
      // migrate-upload-orchestration-out-of-engine §7.2 / §7.9 —
      // renderer-facing namespace for the new `uploads:*` commands.
      uploads: {
        listActive(): Promise<SyncUploadsListActiveResponse>;
      };
      webUtils: {
        getPathForFile(file: File): string;
      };
    };
  }
}

export {};
