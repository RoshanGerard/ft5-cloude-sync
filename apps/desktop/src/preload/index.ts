import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

import { DATASOURCES_CHANNELS, FILES_CHANNELS } from "@ft5/ipc-contracts";
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
import { SYNC_CHANNELS } from "@ft5/ipc-contracts/sync-service-desktop";
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

// The preload runs in the sandboxed, isolated world between Electron's main
// process and the renderer. It is the ONLY place the renderer can reach the
// main process, and the ONLY place allowed to import from `electron`.
//
// We surface a single, namespaced `window.api` object. Each member is a thin
// wrapper around `ipcRenderer.invoke(channel)` with an explicit return type,
// rather than a post-hoc `as Promise<...>` cast: giving the function an
// annotated return type narrows the `Promise<any>` from `invoke` at the
// definition site and keeps the exposed surface honest to the IPC contract
// without needing a type assertion in the call expression.
//
// Datasource transaction-id filtering for upload progress is done HERE (not
// in the renderer) so renderer subscribers only ever receive events for the
// transaction they asked about; unrelated emissions are dropped before ever
// crossing the contextBridge.
const api = {
  ping: (): Promise<PingResponse> => ipcRenderer.invoke("ping"),
  datasources: {
    list: (): Promise<DatasourcesListResponse> =>
      ipcRenderer.invoke(DATASOURCES_CHANNELS.list),
    add: (req: DatasourcesAddRequest): Promise<DatasourcesAddResponse> =>
      ipcRenderer.invoke(DATASOURCES_CHANNELS.add, req),
    remove: (
      req: DatasourcesRemoveRequest,
    ): Promise<DatasourcesRemoveResponse> =>
      ipcRenderer.invoke(DATASOURCES_CHANNELS.remove, req),
    action: (
      req: DatasourcesActionRequest,
    ): Promise<DatasourcesActionResponse> =>
      ipcRenderer.invoke(DATASOURCES_CHANNELS.action, req),
    // Opens the OS-native multi-select "Open File" dialog in the main
    // process and returns the user's selection. Request type is
    // `Record<string, never>` so the preload takes NO arg and passes only
    // the channel to `invoke`, mirroring the `ping()`/`getStatus()`
    // void-request pattern above.
    pickFilesToUpload: (): Promise<DatasourcesPickFilesResponse> =>
      ipcRenderer.invoke(DATASOURCES_CHANNELS.pickFilesToUpload),
    onUploadProgress: (
      transactionId: string,
      callback: (event: DatasourcesUploadProgressEvent) => void,
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        payload: DatasourcesUploadProgressEvent,
      ): void => {
        if (payload.transactionId === transactionId) {
          callback(payload);
        }
      };
      ipcRenderer.on(DATASOURCES_CHANNELS.uploadProgress, listener);
      return () => {
        ipcRenderer.removeListener(
          DATASOURCES_CHANNELS.uploadProgress,
          listener,
        );
      };
    },
    // Broad subscription to the engine's event stream over
    // `DATASOURCES_CHANNELS.event`. Unlike `onUploadProgress`, there is no
    // filter here — every `DatasourceEvent<T, K>` that crosses the main →
    // renderer bridge is delivered to the callback, and the caller narrows
    // via `switch (e.datasourceType)` / `switch (e.event)`.
    //
    // Each invocation registers its own listener, so multiple subscribers
    // can coexist independently; the returned dispose function removes that
    // specific listener (not all listeners on the channel).
    onEvent: (
      callback: (event: AnyDatasourceEvent) => void,
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        payload: AnyDatasourceEvent,
      ): void => {
        callback(payload);
      };
      ipcRenderer.on(DATASOURCES_CHANNELS.event, listener);
      return () => {
        ipcRenderer.removeListener(DATASOURCES_CHANNELS.event, listener);
      };
    },
  },
  files: {
    list: (req: FilesListRequest): Promise<FilesListResponse> =>
      ipcRenderer.invoke(FILES_CHANNELS.list, req),
    stat: (req: FilesStatRequest): Promise<FilesStatResponse> =>
      ipcRenderer.invoke(FILES_CHANNELS.stat, req),
    search: (req: FilesSearchRequest): Promise<FilesSearchResponse> =>
      ipcRenderer.invoke(FILES_CHANNELS.search, req),
    rename: (req: FilesRenameRequest): Promise<FilesRenameResponse> =>
      ipcRenderer.invoke(FILES_CHANNELS.rename, req),
    remove: (req: FilesRemoveRequest): Promise<FilesRemoveResponse> =>
      ipcRenderer.invoke(FILES_CHANNELS.remove, req),
    download: (req: FilesDownloadRequest): Promise<FilesDownloadResponse> =>
      ipcRenderer.invoke(FILES_CHANNELS.download, req),
    upload: (req: FilesUploadRequest): Promise<FilesUploadResponse> =>
      ipcRenderer.invoke(FILES_CHANNELS.upload, req),
  },
  clipboard: {
    // Main-process clipboard bridge. `navigator.clipboard.writeText` is
    // flaky under Radix focus-trap in packaged builds — this path always
    // works because Electron's `clipboard` module has no transient-
    // activation requirement.
    writeText: (text: string): Promise<void> =>
      ipcRenderer.invoke("clipboard:writeText", text),
  },
  sync: {
    listJobs: (
      req: SyncListJobsRequest,
    ): Promise<SyncListJobsResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.listJobs, req),
    getJob: (
      req: SyncGetJobRequest,
    ): Promise<SyncGetJobResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.getJob, req),
    enqueueUpload: (
      req: SyncEnqueueUploadRequest,
    ): Promise<SyncEnqueueUploadResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.enqueueUpload, req),
    enqueueMirror: (
      req: SyncEnqueueMirrorRequest,
    ): Promise<SyncEnqueueMirrorResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.enqueueMirror, req),
    cancelJob: (
      req: SyncCancelJobRequest,
    ): Promise<SyncCancelJobResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.cancelJob, req),
    authenticateStart: (
      req: SyncAuthenticateStartRequest,
    ): Promise<SyncAuthenticateStartResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.authenticateStart, req),
    authenticateComplete: (
      req: SyncAuthenticateCompleteRequest,
    ): Promise<SyncAuthenticateCompleteResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.authenticateComplete, req),
    authenticateCancel: (
      req: SyncAuthenticateCancelRequest,
    ): Promise<SyncAuthenticateCancelResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.authenticateCancel, req),
    // `getStatus` has a void request type — invoke with channel only,
    // mirroring the `ping()` pattern above.
    getStatus: (): Promise<SyncGetStatusResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.getStatus),
    getRetryPolicy: (
      req: SyncGetRetryPolicyRequest,
    ): Promise<SyncGetRetryPolicyResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.getRetryPolicy, req),
    setRetryPolicy: (
      req: SyncSetRetryPolicyRequest,
    ): Promise<SyncSetRetryPolicyResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.setRetryPolicy, req),
    // One-way main → renderer event stream. Mirrors the `datasources.onEvent`
    // pattern: each invocation registers its own listener, so multiple
    // subscribers can coexist independently; the returned dispose function
    // removes that specific listener (not all listeners on the channel).
    onEvent: (
      callback: (event: SyncEvent) => void,
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        payload: SyncEvent,
      ): void => {
        callback(payload);
      };
      ipcRenderer.on(SYNC_CHANNELS.event, listener);
      return () => {
        ipcRenderer.removeListener(SYNC_CHANNELS.event, listener);
      };
    },
  },
  // Electron 32+ removed `File.path`. The drag-drop upload flow needs
  // the absolute filesystem path of each dropped File so the main-
  // process upload handler can stream it. `webUtils.getPathForFile` is
  // the supported replacement; the contextBridge proxies the File
  // object into the preload context where the real `webUtils` lives.
  webUtils: {
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  },
};

contextBridge.exposeInMainWorld("api", api);
