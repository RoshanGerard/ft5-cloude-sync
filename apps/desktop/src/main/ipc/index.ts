import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow } from "electron";

import {
  DATASOURCES_CHANNELS,
  FILES_CHANNELS,
  SYNC_CHANNELS,
} from "@ft5/ipc-contracts";
import type {
  DatasourcesActionRequest,
  DatasourcesAddRequest,
  DatasourcesRemoveRequest,
  FilesDownloadRequest,
  FilesListRequest,
  FilesRemoveRequest,
  FilesRenameRequest,
  FilesSearchRequest,
  FilesStatRequest,
  FilesUploadRequest,
} from "@ft5/ipc-contracts";
import type {
  SyncAuthenticateCancelRequest,
  SyncAuthenticateCompleteRequest,
  SyncAuthenticateStartRequest,
  SyncCancelDownloadRequest,
  SyncCancelJobRequest,
  SyncCancelUploadRequest,
  SyncEnqueueMirrorRequest,
  SyncGetJobRequest,
  SyncGetRetryPolicyRequest,
  SyncListJobsRequest,
  SyncSetRetryPolicyRequest,
} from "@ft5/ipc-contracts/sync-service-desktop";

import { handleDatasourcesAction } from "./datasources/action.js";
import { handleDatasourcesAdd } from "./datasources/add.js";
import { handleDatasourcesList } from "./datasources/list.js";
import { handlePickFilesToUpload } from "./datasources/pick-files-to-upload.js";
import { handleDatasourcesRemove } from "./datasources/remove.js";
import {
  handleDialogShowOpenDialog,
  handleDialogShowSaveDialog,
  type OpenDialogOptionsLike,
  type SaveDialogOptionsLike,
} from "./dialog.js";
import { handleFilesDownload } from "./files/download.js";
import { handleFilesList } from "./files/list.js";
import {
  handleFilesOpenSavedPath,
  handleFilesShowSavedInFolder,
} from "./files/open-saved.js";
import { handleFilesRemove } from "./files/remove.js";
import { handleFilesRename } from "./files/rename.js";
import { handleFilesSearch } from "./files/search.js";
import { handleFilesStat } from "./files/stat.js";
import { handleFilesUpload } from "./files/upload.js";
import { handlePing } from "./ping.js";
import {
  handleGetDefaultDownloadsFolder,
  handleGetOSDefaultDownloadsFolder,
  handleSetDefaultDownloadsFolder,
} from "./preferences.js";
import { handleSyncAuthenticateCancel } from "./sync/authenticate-cancel.js";
import { handleSyncAuthenticateComplete } from "./sync/authenticate-complete.js";
import { handleSyncAuthenticateStart } from "./sync/authenticate-start.js";
import { handleSyncCancelDownload } from "./sync/cancel-download.js";
import { handleSyncCancelJob } from "./sync/cancel-job.js";
import { handleSyncCancelUpload } from "./sync/cancel-upload.js";
import { handleUploadsListActive } from "./sync/uploads-list-active.js";
import { handleSyncEnqueueMirror } from "./sync/enqueue-mirror.js";
import { handleSyncGetJob } from "./sync/get-job.js";
import { handleSyncGetRetryPolicy } from "./sync/get-retry-policy.js";
import { handleSyncGetStatus } from "./sync/get-status.js";
import { handleSyncListJobs } from "./sync/list-jobs.js";
import { handleSyncSetRetryPolicy } from "./sync/set-retry-policy.js";

// Central IPC handler registration. Called once from `main/index.ts` after
// `app.whenReady()`. Keeping the `ipcMain.handle` calls here (rather than
// beside each handler) isolates the Electron import from the pure handlers,
// so those handlers can be unit-tested under plain Node.
//
// Note: `datasources:start-consent` / `datasources:cancel-consent` channels
// were retired in implement-datasource-onboarding §19. The renderer now
// drives the OAuth flow through the service via `sync:authenticate-{start,
// complete,cancel}` (per design.md Decision 3). The desktop main no longer
// hosts an OAuth consent broker; `registerIpcHandlers` no longer takes a
// broker argument.
export function registerIpcHandlers(
  targetWindow: BrowserWindow | null = null,
): void {
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

  // Datasources pick-files — opens the native OS "Open File" dialog in
  // multi-select mode and returns the picked paths to the renderer. The
  // renderer then dispatches each path through `files.upload`
  // (separating the picker from the enqueue is what lets the drag-drop
  // path and the upload-dialog destination-picker path share the same
  // upload code). The retired upload request type + matching handler
  // pair this replaces is gone — see
  // `openspec/changes/add-file-explorer-drag-drop-upload/design.md`.
  ipcMain.handle(
    DATASOURCES_CHANNELS.pickFilesToUpload,
    // The request is `Record<string, never>` — no renderer-supplied fields.
    // We don't bind `event` or `req` so the lint "no-unused-vars" rule
    // doesn't flag them; `ipcMain.handle` doesn't require declared params.
    async () =>
      handlePickFilesToUpload({
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
      }),
  );

  // Files IPC surface. list/stat/search/remove delegate to the fs-sync
  // service via SyncClient.request("files:*"); rename and download still
  // delegate to the in-memory mock (`add-engine-rename-download` follow-up).
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
  // Files upload — renderer-supplied `{ sourcePath, targetPath,
  // conflictPolicy }`. Thin proxy over the service's `files:upload`
  // direct-RPC handler (see `files/upload.ts`). Lifecycle events
  // (`uploading` / `file-created` / `upload-failed` /
  // `upload-cancelled`) flow on `sync:event-stream` keyed by service-
  // minted `uploadJobId`. The legacy `DATASOURCES_CHANNELS.uploadProgress`
  // translation layer was removed by
  // migrate-upload-orchestration-out-of-engine §13.4.
  ipcMain.handle(
    FILES_CHANNELS.upload,
    (_event, req: FilesUploadRequest) => handleFilesUpload(req),
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
  // migrate-upload-orchestration-out-of-engine §11 / §7.4 — the
  // `SYNC_CHANNELS.enqueueUpload` IPC handler was deleted in chunk F.
  // Single-file uploads now flow through the `files:upload` direct-RPC
  // (`./files/upload.ts` / `FILES_CHANNELS.upload`).
  ipcMain.handle(
    SYNC_CHANNELS.enqueueMirror,
    async (_event, req: SyncEnqueueMirrorRequest) =>
      handleSyncEnqueueMirror(req),
  );
  ipcMain.handle(
    SYNC_CHANNELS.cancelJob,
    async (_event, req: SyncCancelJobRequest) => handleSyncCancelJob(req),
  );
  // add-download-resilience §12.6 (iter-5, Decision 16) — bridge for the
  // existing sync:cancel-download wire command. Pre-iter-5 the renderer
  // hit cancelJob by name collision; the toaster's Cancel button now
  // routes through this handler.
  ipcMain.handle(
    SYNC_CHANNELS.cancelDownload,
    async (_event, req: SyncCancelDownloadRequest) =>
      handleSyncCancelDownload(req),
  );
  // migrate-upload-orchestration-out-of-engine §13.2 — desktop bridge for
  // the new `sync:cancel-upload` service command. Mirrors cancelDownload:
  // idempotent at the service boundary, flat `{ cancelled: boolean }`
  // response, transport-level errors re-throw to the renderer.
  ipcMain.handle(
    SYNC_CHANNELS.cancelUpload,
    async (_event, req: SyncCancelUploadRequest) =>
      handleSyncCancelUpload(req),
  );
  // migrate-upload-orchestration-out-of-engine §10 / §13 — desktop bridge
  // for the new `uploads:list-active` service command. Returns the
  // current `UploadRegistry` snapshot. The renderer calls this on
  // app-init for the upload-toaster hydrate path (parallel to the
  // download-side `files:hydrate-active-downloads` channel which fires
  // one-way from main); exposing a request-able variant lets the
  // renderer re-fetch on tab focus etc. without waiting for a fresh
  // supervisor connect.
  ipcMain.handle(
    SYNC_CHANNELS.uploadsListActive,
    async () => handleUploadsListActive(),
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
  ipcMain.handle(
    SYNC_CHANNELS.authenticateCancel,
    async (_event, req: SyncAuthenticateCancelRequest) =>
      handleSyncAuthenticateCancel(req),
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

  // add-engine-rename-download §18.1-§18.2 — preferences API for the
  // download default-folder. The renderer's downloads-store (§20) is the
  // durable owner via localStorage; this handler holds an in-memory
  // mirror so callers outside the store have a uniform `window.api.*`
  // binding. No on-disk persistence in main; the renderer reseeds the
  // slot at startup.
  ipcMain.handle(
    "preferences:setDefaultDownloadsFolder",
    (_event, folder: string) => handleSetDefaultDownloadsFolder(folder),
  );
  ipcMain.handle("preferences:getDefaultDownloadsFolder", () =>
    handleGetDefaultDownloadsFolder(),
  );

  // Post-archive bug-fix follow-up — exposure for `app.getPath("downloads")`
  // so the first-run downloads modal can pre-fill a REAL absolute path
  // instead of the broken `"~/Downloads/ft5"` placeholder. See
  // `preferences.ts` for the handler-side rationale.
  ipcMain.handle("preferences:getOSDefaultDownloadsFolder", () =>
    handleGetOSDefaultDownloadsFolder({
      getOSDefaultDownloadsFolder: () => app.getPath("downloads"),
    }),
  );

  // §18.3-§18.6 — download-success toast CTAs (Open + Show in folder).
  // Thin proxies over Electron's `shell.openPath` /
  // `shell.showItemInFolder`. The Electron `shell` import lives here;
  // the handler modules are unit-testable under plain Node via DI.
  ipcMain.handle("files:openSavedPath", (_event, savedPath: string) =>
    handleFilesOpenSavedPath(savedPath, {
      openPath: (path) => shell.openPath(path),
    }),
  );
  ipcMain.handle("files:showSavedInFolder", (_event, savedPath: string) =>
    handleFilesShowSavedInFolder(savedPath, {
      showItemInFolder: (path) => shell.showItemInFolder(path),
    }),
  );

  // §18.7-§18.8 — `dialog.showSaveDialog` thin pass-through. Bound to
  // the BrowserWindow when one is available so the dialog renders as a
  // sheet on macOS / a window-modal on Windows; falls back to the
  // standalone signature when no window is registered yet (parity with
  // `pickFilesToUpload`'s targetWindow handling).
  ipcMain.handle(
    "dialog:showSaveDialog",
    async (_event, opts: SaveDialogOptionsLike) =>
      handleDialogShowSaveDialog(opts, {
        showSaveDialog: async (o) => {
          // Electron's `SaveDialogOptions.filters` is mutable
          // (`FileFilter[]`); our handler-side type is readonly to keep
          // the cross-process boundary safe. Defensive copy at the seam
          // bridges the two without loosening either side.
          const electronOpts = {
            ...(o.title !== undefined ? { title: o.title } : {}),
            ...(o.defaultPath !== undefined
              ? { defaultPath: o.defaultPath }
              : {}),
            ...(o.buttonLabel !== undefined
              ? { buttonLabel: o.buttonLabel }
              : {}),
            ...(o.filters !== undefined
              ? {
                  filters: o.filters.map((f) => ({
                    name: f.name,
                    extensions: [...f.extensions],
                  })),
                }
              : {}),
          };
          const result = targetWindow
            ? await dialog.showSaveDialog(targetWindow, electronOpts)
            : await dialog.showSaveDialog(electronOpts);
          return {
            canceled: result.canceled,
            ...(result.filePath !== undefined
              ? { filePath: result.filePath }
              : {}),
          };
        },
      }),
  );

  // add-engine-rename-download §21 prerequisite — `dialog.showOpenDialog`
  // pass-through. Used by the first-run downloads modal's Browse button
  // (§21) and the Settings dialog's Change… button (§22). Mirrors the
  // showSaveDialog binding above: targetWindow-aware, defensive copy of
  // mutable Electron fields at the seam.
  ipcMain.handle(
    "dialog:showOpenDialog",
    async (_event, opts: OpenDialogOptionsLike) =>
      handleDialogShowOpenDialog(opts, {
        showOpenDialog: async (o) => {
          // Electron's `OpenDialogOptions.properties` is mutable (a
          // string-union array); our handler-side type is readonly to
          // keep the cross-process boundary safe. Defensive copy at
          // the seam.
          const electronOpts = {
            ...(o.title !== undefined ? { title: o.title } : {}),
            ...(o.defaultPath !== undefined
              ? { defaultPath: o.defaultPath }
              : {}),
            ...(o.buttonLabel !== undefined
              ? { buttonLabel: o.buttonLabel }
              : {}),
            ...(o.properties !== undefined
              ? {
                  // Cast at the seam: Electron's properties is a
                  // string-union literal-array type, but we accept any
                  // readonly string[] from the renderer. The renderer
                  // pins the vocabulary at the call site. Use
                  // NonNullable to strip the `undefined` that
                  // Parameters<...>["properties"] inherits, since
                  // `exactOptionalPropertyTypes` forbids assigning
                  // `undefined` to an optional field.
                  properties: [...o.properties] as NonNullable<
                    Parameters<typeof dialog.showOpenDialog>[0]["properties"]
                  >,
                }
              : {}),
            ...(o.filters !== undefined
              ? {
                  filters: o.filters.map((f) => ({
                    name: f.name,
                    extensions: [...f.extensions],
                  })),
                }
              : {}),
          };
          const result = targetWindow
            ? await dialog.showOpenDialog(targetWindow, electronOpts)
            : await dialog.showOpenDialog(electronOpts);
          return {
            canceled: result.canceled,
            filePaths: result.filePaths,
          };
        },
      }),
  );
}
