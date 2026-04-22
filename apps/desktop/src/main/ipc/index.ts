import { clipboard, dialog, ipcMain, type BrowserWindow } from "electron";

import {
  DATASOURCES_CHANNELS,
  FILES_CHANNELS,
  SYNC_CHANNELS,
} from "@ft5/ipc-contracts";
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
import type {
  SyncAuthenticateCompleteRequest,
  SyncAuthenticateStartRequest,
  SyncCancelJobRequest,
  SyncEnqueueMirrorRequest,
  SyncEnqueueUploadRequest,
  SyncGetJobRequest,
  SyncGetRetryPolicyRequest,
  SyncListJobsRequest,
  SyncSetRetryPolicyRequest,
} from "@ft5/ipc-contracts/sync-service-desktop";

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
import { handleSyncAuthenticateComplete } from "./sync/authenticate-complete.js";
import { handleSyncAuthenticateStart } from "./sync/authenticate-start.js";
import { handleSyncCancelJob } from "./sync/cancel-job.js";
import { handleSyncEnqueueMirror } from "./sync/enqueue-mirror.js";
import { handleSyncEnqueueUpload } from "./sync/enqueue-upload.js";
import { handleSyncGetJob } from "./sync/get-job.js";
import { handleSyncGetRetryPolicy } from "./sync/get-retry-policy.js";
import { handleSyncGetStatus } from "./sync/get-status.js";
import { handleSyncListJobs } from "./sync/list-jobs.js";
import { handleSyncSetRetryPolicy } from "./sync/set-retry-policy.js";

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

  // Sync IPC surface — proxied to the out-of-process fs-sync-service via
  // the bootstrapped SyncClient singleton. Availability gating is
  // structural: each handler's `client = getSyncClient()` default argument
  // throws a descriptive error if invoked before the supervisor has set
  // the client, which `ipcMain.handle` surfaces as a rejected IPC call.
  ipcMain.handle(
    SYNC_CHANNELS.listJobs,
    async (_event, req: SyncListJobsRequest) => handleSyncListJobs(req),
  );
  ipcMain.handle(
    SYNC_CHANNELS.getJob,
    async (_event, req: SyncGetJobRequest) => handleSyncGetJob(req),
  );
  ipcMain.handle(
    SYNC_CHANNELS.enqueueUpload,
    async (_event, req: SyncEnqueueUploadRequest) =>
      handleSyncEnqueueUpload(req),
  );
  ipcMain.handle(
    SYNC_CHANNELS.enqueueMirror,
    async (_event, req: SyncEnqueueMirrorRequest) =>
      handleSyncEnqueueMirror(req),
  );
  ipcMain.handle(
    SYNC_CHANNELS.cancelJob,
    async (_event, req: SyncCancelJobRequest) => handleSyncCancelJob(req),
  );
  ipcMain.handle(
    SYNC_CHANNELS.authenticateStart,
    async (_event, req: SyncAuthenticateStartRequest) =>
      handleSyncAuthenticateStart(req),
  );
  ipcMain.handle(
    SYNC_CHANNELS.authenticateComplete,
    async (_event, req: SyncAuthenticateCompleteRequest) =>
      handleSyncAuthenticateComplete(req),
  );
  ipcMain.handle(SYNC_CHANNELS.getStatus, () => handleSyncGetStatus());
  ipcMain.handle(
    SYNC_CHANNELS.getRetryPolicy,
    async (_event, req: SyncGetRetryPolicyRequest) =>
      handleSyncGetRetryPolicy(req),
  );
  ipcMain.handle(
    SYNC_CHANNELS.setRetryPolicy,
    async (_event, req: SyncSetRetryPolicyRequest) =>
      handleSyncSetRetryPolicy(req),
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
