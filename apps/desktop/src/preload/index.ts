import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { DATASOURCES_CHANNELS } from "@ft5/ipc-contracts";
import type {
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
  PingResponse,
} from "@ft5/ipc-contracts";

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
    upload: (
      req: DatasourcesUploadRequest,
    ): Promise<DatasourcesUploadResponse> =>
      ipcRenderer.invoke(DATASOURCES_CHANNELS.upload, req),
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
  },
};

contextBridge.exposeInMainWorld("api", api);
