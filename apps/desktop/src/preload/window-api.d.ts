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
import type { DownloadJob } from "@ft5/ipc-contracts/sync-service";
import type {
  SyncAuthenticateCancelRequest,
  SyncAuthenticateCancelResponse,
  SyncAuthenticateCompleteRequest,
  SyncAuthenticateCompleteResponse,
  SyncAuthenticateStartRequest,
  SyncAuthenticateStartResponse,
  SyncCancelJobRequest,
  SyncCancelJobResponse,
  SyncEnqueueMirrorRequest,
  SyncEnqueueMirrorResponse,
  SyncEnqueueUploadRequest,
  SyncEnqueueUploadResponse,
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
        onUploadProgress(
          transactionId: string,
          callback: (event: DatasourcesUploadProgressEvent) => void,
        ): () => void;
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
        openSavedPath(savedPath: string): Promise<void>;
        showSavedInFolder(savedPath: string): Promise<void>;
        onActiveDownloadsHydrate(
          callback: (jobs: readonly DownloadJob[]) => void,
        ): () => void;
      };
      preferences: {
        setDefaultDownloadsFolder(folder: string): Promise<void>;
        getDefaultDownloadsFolder(): Promise<string | null>;
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
        enqueueUpload(
          req: SyncEnqueueUploadRequest,
        ): Promise<SyncEnqueueUploadResponse>;
        enqueueMirror(
          req: SyncEnqueueMirrorRequest,
        ): Promise<SyncEnqueueMirrorResponse>;
        cancelJob(req: SyncCancelJobRequest): Promise<SyncCancelJobResponse>;
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
      webUtils: {
        getPathForFile(file: File): string;
      };
    };
  }
}

export {};
