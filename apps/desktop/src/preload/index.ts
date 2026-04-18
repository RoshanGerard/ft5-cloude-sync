import { contextBridge, ipcRenderer } from "electron";

import type { PingResponse } from "@ft5/ipc-contracts";

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
const api = {
  ping: (): Promise<PingResponse> => ipcRenderer.invoke("ping"),
};

contextBridge.exposeInMainWorld("api", api);
