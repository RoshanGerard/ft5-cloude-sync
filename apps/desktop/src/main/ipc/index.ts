import { dialog, ipcMain, type BrowserWindow } from "electron";

import { DATASOURCES_CHANNELS } from "@ft5/ipc-contracts";
import type {
  DatasourcesActionRequest,
  DatasourcesAddRequest,
  DatasourcesRemoveRequest,
  DatasourcesUploadRequest,
} from "@ft5/ipc-contracts";

import { handleDatasourcesAction } from "./datasources/action.js";
import { handleDatasourcesAdd } from "./datasources/add.js";
import { handleDatasourcesList } from "./datasources/list.js";
import { handleDatasourcesRemove } from "./datasources/remove.js";
import { handleDatasourcesUpload } from "./datasources/upload.js";
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
    async (_event, req: DatasourcesAddRequest) => handleDatasourcesAdd(req),
  );

  ipcMain.handle(
    DATASOURCES_CHANNELS.remove,
    async (_event, req: DatasourcesRemoveRequest) =>
      handleDatasourcesRemove(req),
  );

  ipcMain.handle(
    DATASOURCES_CHANNELS.action,
    async (_event, req: DatasourcesActionRequest) =>
      handleDatasourcesAction(req),
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
}
