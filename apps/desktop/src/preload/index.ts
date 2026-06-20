import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

import { DATASOURCES_CHANNELS, FILES_CHANNELS } from "@ft5/ipc-contracts";
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
import { SYNC_CHANNELS } from "@ft5/ipc-contracts/sync-service-desktop";

// Local mirror of `DownloadJob` from the wire subpath (sync-service/commands).
// The preload's import-boundary test (sync-surface.import-boundary.test.ts)
// forbids importing from `@ft5/ipc-contracts/sync-service` here — that
// subpath is reserved for the main ↔ service daemon hop and must not bleed
// into the renderer-facing layer. The renderer-facing barrel
// (`sync-service-desktop`) does NOT re-export `DownloadJob`, and extending
// it is out-of-scope for this change. Mirroring the structural shape locally
// is the standing pattern: same fields as `DownloadJob`, identity coverage
// of the wire shape sits in the contract package's `__tests__/`. The
// `window-api.d.ts` keeps the typed import (the import-boundary test scopes
// to `preload/index.ts` only).
interface DownloadJob {
  readonly downloadJobId: string;
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly bytesDownloaded: number;
  readonly contentLength: number | null;
  readonly startedAt: number;
}

// migrate-upload-orchestration-out-of-engine §13.3 — local mirror of
// `UploadJob` (parallel to `DownloadJob` above). Same import-boundary
// rationale: the preload's import-boundary test forbids the
// `@ft5/ipc-contracts/sync-service` subpath here. The renderer-facing
// barrel `sync-service-desktop` does NOT re-export `UploadJob`, so we
// mirror the structural shape locally for the
// `onActiveUploadsHydrate(callback)` parameter type. The
// `window-api.d.ts` keeps the typed import (the import-boundary test
// scopes to `preload/index.ts` only). Identity coverage of the wire
// shape sits in the contract package's `__tests__/`.
interface UploadJob {
  readonly uploadJobId: string;
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly bytesUploaded: number;
  readonly contentLength: number | null;
  readonly startedAt: number;
}
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
    // migrate-upload-orchestration-out-of-engine §7.9 — `onUploadProgress`
    // (the legacy per-transactionId progress subscription on the
    // `datasources:upload:progress` channel) is REMOVED. Upload events
    // now flow on `sync:event-stream` keyed by `uploadJobId` alongside
    // download events; the renderer's upload toaster subscribes via
    // `window.api.sync.onEvent` filtered to the four upload event
    // kinds (`uploading` / `file-created` / `upload-failed` /
    // `upload-cancelled`). See `upload-job-toast.ts`'s
    // `resolveEventApi` for the production fallback.
    //
    // migrate-engine-events-to-consumer §4 — the broad `onEvent`
    // subscription over `DATASOURCES_CHANNELS.event` is REMOVED. The dead
    // engine `datasources:event` bridge had no production emitter or
    // consumer; datasource-facing events flow on `window.api.sync.onEvent`.
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
    // add-engine-rename-download §18.3-§18.4: the download-success toast's
    // primary "Open" CTA delegates to the main process, which invokes
    // `shell.openPath(savedPath)`. The preload routes through IPC rather
    // than exposing the shell binding directly because shell APIs only
    // exist in main; the same pattern is used by `clipboard.writeText`.
    openSavedPath: (savedPath: string): Promise<void> =>
      ipcRenderer.invoke("files:openSavedPath", savedPath),
    // §18.5-§18.6: companion to openSavedPath — invokes
    // `shell.showItemInFolder(savedPath)` in the main process so the
    // user can locate the just-downloaded file in the OS file manager.
    showSavedInFolder: (savedPath: string): Promise<void> =>
      ipcRenderer.invoke("files:showSavedInFolder", savedPath),
    // §18.9-§18.10: one-way main → renderer event channel that fires
    // EXACTLY ONCE per app session — on the supervisor's first connect.
    // The main process queries `downloads:list-active` against the
    // sync-service registry and forwards the response so the renderer
    // can spawn one Sonner toast per in-flight download (Decision 4).
    // Reconnects mid-session do NOT re-fire; the renderer's existing
    // event subscriptions resume. Mirrors `sync.onEvent` in shape: each
    // invocation registers its own listener, the returned dispose
    // function removes that specific
    // listener (not all listeners on the channel).
    onActiveDownloadsHydrate: (
      callback: (jobs: readonly DownloadJob[]) => void,
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        payload: readonly DownloadJob[],
      ): void => {
        callback(payload);
      };
      ipcRenderer.on("files:hydrate-active-downloads", listener);
      return () => {
        ipcRenderer.removeListener(
          "files:hydrate-active-downloads",
          listener,
        );
      };
    },
    // migrate-upload-orchestration-out-of-engine §13.3 — symmetric
    // upload-side hydrate channel. Same shape as the download
    // equivalent: one-way main → renderer, fires EXACTLY ONCE per app
    // session on the supervisor's first connect with the active-
    // uploads snapshot from `uploads:list-active`. Reconnects mid-
    // session do NOT re-fire; the renderer's live `sync:event-stream`
    // subscription (filtered to the four upload kinds) drives in-
    // flight progress instead.
    onActiveUploadsHydrate: (
      callback: (jobs: readonly UploadJob[]) => void,
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        payload: readonly UploadJob[],
      ): void => {
        callback(payload);
      };
      ipcRenderer.on("files:hydrate-active-uploads", listener);
      return () => {
        ipcRenderer.removeListener(
          "files:hydrate-active-uploads",
          listener,
        );
      };
    },
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
    // migrate-upload-orchestration-out-of-engine §11 / §7.4 — the
    // `enqueueUpload` preload binding was deleted in chunk F. The
    // renderer reaches the upload path via `window.api.files.upload`
    // (the direct-RPC handler at `apps/desktop/src/main/ipc/files/upload.ts`).
    enqueueMirror: (
      req: SyncEnqueueMirrorRequest,
    ): Promise<SyncEnqueueMirrorResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.enqueueMirror, req),
    cancelJob: (
      req: SyncCancelJobRequest,
    ): Promise<SyncCancelJobResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.cancelJob, req),
    // add-download-resilience §12.6 (iter-5, Decision 16) — the renderer
    // toaster's Cancel button uses this method, NOT cancelJob. The two
    // are distinct: cancelJob targets upload jobs ({ jobId }), this one
    // targets in-flight downloads ({ downloadJobId }). Pre-iter-5 the
    // toaster collision-routed via cancelJob, which is why this bridge
    // was added.
    cancelDownload: (
      req: SyncCancelDownloadRequest,
    ): Promise<SyncCancelDownloadResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.cancelDownload, req),
    // migrate-upload-orchestration-out-of-engine §7.3 / §7.9 — renderer
    // toaster's Cancel button on an in-flight upload routes here, NOT
    // through `cancelJob` (which targets the legacy queue-based upload
    // job id) and NOT through `cancelDownload` (different id namespace).
    // The bridge is a thin pass-through to the service's
    // `sync:cancel-upload` command; idempotent on unknown `uploadJobId`.
    cancelUpload: (
      req: SyncCancelUploadRequest,
    ): Promise<SyncCancelUploadResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.cancelUpload, req),
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
    // One-way main → renderer event stream. Each invocation registers its
    // own listener, so multiple subscribers can coexist independently; the
    // returned dispose function removes that specific listener (not all
    // listeners on the channel).
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
  // migrate-upload-orchestration-out-of-engine §7.2 / §7.9 —
  // renderer-facing surface for the new uploads:* commands. Mirrors
  // download's split between renderer-facing and one-way main→renderer
  // hydrate: `listActive` is a renderer-callable RPC (parallel to a
  // future `downloads.listActive`, currently unused on the download side
  // because download hydrates one-way through `files.onActiveDownloadsHydrate`)
  // intended for explicit re-fetch by the renderer (e.g. on tab focus
  // recovery). The one-way upload hydrate channel + listener arrive in
  // a later chunk along with the desktop main bridge — this surface is
  // additive in chunk C and runtime-functional once chunk F lands the
  // main-side handler at `sync-service-desktop` channel
  // `uploads:list-active`.
  uploads: {
    listActive: (): Promise<SyncUploadsListActiveResponse> =>
      ipcRenderer.invoke(SYNC_CHANNELS.uploadsListActive),
  },
  // add-engine-rename-download §18.1-§18.2: download-default-folder
  // preferences API. The renderer's downloads-store (built in §20) is
  // the durable owner via localStorage; this preload routes through
  // a main-process in-memory mirror so the surface stays uniform with
  // the rest of `window.api` and so callers outside the store (e.g.
  // the §22 first-download modal) can read/write without touching
  // localStorage directly. Channel naming mirrors the inline-string
  // pattern used by `clipboard:writeText`.
  preferences: {
    setDefaultDownloadsFolder: (folder: string): Promise<void> =>
      ipcRenderer.invoke("preferences:setDefaultDownloadsFolder", folder),
    getDefaultDownloadsFolder: (): Promise<string | null> =>
      ipcRenderer.invoke("preferences:getDefaultDownloadsFolder"),
    // Post-archive bug-fix follow-up — exposes `app.getPath("downloads")`
    // so the first-run downloads modal can pre-fill a REAL absolute
    // path instead of the placeholder `"~/Downloads/ft5"` that fails
    // the service-side `path.isAbsolute` validator on every host.
    getOSDefaultDownloadsFolder: (): Promise<string> =>
      ipcRenderer.invoke("preferences:getOSDefaultDownloadsFolder"),
  },
  // §18.7-§18.8: thin pass-through to Electron's `dialog.showSaveDialog`
  // for the download orchestrator's Shift+Click / Always-ask paths
  // (design.md V4). The preload forwards the renderer-supplied options
  // verbatim; the main-process handler attaches the BrowserWindow ref
  // and invokes Electron's `dialog`. The wire shape for `opts` is
  // intentionally `unknown` here — Electron's `SaveDialogOptions` type
  // pulls in `electron`, which the renderer cannot import. The
  // renderer-scoped `window-api.d.ts` widens this to a structural
  // subset of the SaveDialogOptions fields the renderer actually uses.
  dialog: {
    showSaveDialog: (opts: unknown): Promise<unknown> =>
      ipcRenderer.invoke("dialog:showSaveDialog", opts),
    // add-engine-rename-download §21 prerequisite — pass-through to
    // Electron's `dialog.showOpenDialog`. Used by the first-run
    // downloads modal's Browse button (§21) and the Settings dialog's
    // Change… button (§22) for directory-pick. Same `unknown` wire
    // shape as showSaveDialog; the renderer-scoped `window-api.d.ts`
    // widens this to a structural subset of the OpenDialogOptions
    // fields the renderer actually uses.
    showOpenDialog: (opts: unknown): Promise<unknown> =>
      ipcRenderer.invoke("dialog:showOpenDialog", opts),
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
