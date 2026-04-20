import { clipboard, dialog, ipcMain, type BrowserWindow } from "electron";

import { DATASOURCES_CHANNELS, FILES_CHANNELS } from "@ft5/ipc-contracts";
import type {
  DatasourcesActionRequest,
  DatasourcesAddRequest,
  DatasourcesRemoveRequest,
  DatasourcesUploadRequest,
  FilesDownloadRequest,
  FilesListRequest,
  FilesRemoveRequest,
  FilesRenameRequest,
  FilesSearchRequest,
  FilesStatRequest,
} from "@ft5/ipc-contracts";

import { handleDatasourcesAction } from "./datasources/action.js";
import { handleDatasourcesAdd } from "./datasources/add.js";
import { handleDatasourcesList } from "./datasources/list.js";
import { handleDatasourcesRemove } from "./datasources/remove.js";
import { handleDatasourcesUpload } from "./datasources/upload.js";
import { handleFilesDownload } from "./files/download.js";
import { handleFilesList } from "./files/list.js";
import { handleFilesRemove } from "./files/remove.js";
import { handleFilesRename } from "./files/rename.js";
import { handleFilesSearch } from "./files/search.js";
import { handleFilesStat } from "./files/stat.js";
import { handlePing } from "./ping.js";

// Central IPC handler registration. Called once from `main/index.ts` after
// `app.whenReady()`. Keeping the `ipcMain.handle` calls here (rather than
// beside each handler) isolates the Electron import from the pure handlers,
// so those handlers can be unit-tested under plain Node.
export function registerIpcHandlers(targetWindow: BrowserWindow | null = null): void {
  ipcMain.handle("ping", () => handlePing());

  ipcMain.handle(DATASOURCES_CHANNELS.list, () => handleDatasourcesList());

  ipcMain.handle(
    DATASOURCES_CHANNELS.add,
    (_event, req: DatasourcesAddRequest) => handleDatasourcesAdd(req),
  );

  ipcMain.handle(
    DATASOURCES_CHANNELS.remove,
    (_event, req: DatasourcesRemoveRequest) => handleDatasourcesRemove(req),
  );

  ipcMain.handle(
    DATASOURCES_CHANNELS.action,
    (_event, req: DatasourcesActionRequest) => handleDatasourcesAction(req),
  );

  let uploadCounter = 0;
  ipcMain.handle(
    DATASOURCES_CHANNELS.upload,
    (_event, req: DatasourcesUploadRequest) =>
      handleDatasourcesUpload(req, {
        showOpenDialog: async () => {
          const result = targetWindow
            ? await dialog.showOpenDialog(targetWindow, {
                properties: ["openFile", "multiSelections"],
              })
            : await dialog.showOpenDialog({
                properties: ["openFile", "multiSelections"],
              });
          return { canceled: result.canceled, filePaths: result.filePaths };
        },
        sendProgress: (event) => {
          targetWindow?.webContents.send(
            DATASOURCES_CHANNELS.uploadProgress,
            event,
          );
        },
        nextTransactionId: () => `tx-${Date.now()}-${String(++uploadCounter)}`,
      }),
  );

  // Files IPC surface — handlers delegate to the in-memory mock file system.
  ipcMain.handle(FILES_CHANNELS.list, (_event, req: FilesListRequest) =>
    handleFilesList(req),
  );
  ipcMain.handle(FILES_CHANNELS.stat, (_event, req: FilesStatRequest) =>
    handleFilesStat(req),
  );
  ipcMain.handle(
    FILES_CHANNELS.search,
    (_event, req: FilesSearchRequest) => handleFilesSearch(req),
  );
  ipcMain.handle(
    FILES_CHANNELS.rename,
    (_event, req: FilesRenameRequest) => handleFilesRename(req),
  );
  ipcMain.handle(
    FILES_CHANNELS.remove,
    (_event, req: FilesRemoveRequest) => handleFilesRemove(req),
  );
  ipcMain.handle(
    FILES_CHANNELS.download,
    (_event, req: FilesDownloadRequest) => handleFilesDownload(req),
  );

  // Clipboard bridge — goes through Electron's main-process `clipboard`
  // module rather than `navigator.clipboard.writeText` in the renderer.
  // The web API requires transient activation + a focused document,
  // which Radix's focus-trap inside Dialog doesn't always satisfy in
  // packaged builds, so copy buttons were silently no-op-ing on the
  // Properties modal. The main-process clipboard has no such
  // constraints; the preload exposes it as `window.api.clipboard`.
  ipcMain.handle("clipboard:writeText", (_event, text: string) => {
    clipboard.writeText(text);
  });
}
