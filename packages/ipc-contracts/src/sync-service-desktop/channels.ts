// Renderer-facing IPC channel names for `window.api.sync.*`.
//
// Each value is a stable string literal shared by the main-process handler
// registration (`ipcMain.handle(channel, ...)`) and the preload's
// `ipcRenderer.invoke(channel, ...)` call. The literal form survives
// minification / bundling and is cheap to grep for during a wire audit.
//
// `event` is the one-way main → renderer channel that carries the renderer-
// observable `SyncEvent` envelope (see `events.ts`). It is intentionally
// distinct from the pre-existing `datasources:event` channel so the two
// event streams remain separable at the transport layer.

export const SYNC_CHANNELS = {
  listJobs: "sync:list-jobs",
  getJob: "sync:get-job",
  enqueueUpload: "sync:enqueue-upload",
  enqueueMirror: "sync:enqueue-mirror",
  cancelJob: "sync:cancel-job",
  authenticate: "sync:authenticate",
  getStatus: "sync:get-status",
  getRetryPolicy: "sync:get-retry-policy",
  setRetryPolicy: "sync:set-retry-policy",
  event: "sync:event",
} as const;

export type SyncChannelName = (typeof SYNC_CHANNELS)[keyof typeof SYNC_CHANNELS];
