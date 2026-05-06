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
  // migrate-upload-orchestration-out-of-engine §7.4 — `enqueueUpload`
  // (`"sync:enqueue-upload"`) REMOVED in chunk F. The renderer's upload
  // path is now `window.api.files.upload` (see `FILES_CHANNELS.upload`
  // in `packages/ipc-contracts/src/files-desktop.ts` or its equivalent).
  enqueueMirror: "sync:enqueue-mirror",
  cancelJob: "sync:cancel-job",
  // add-download-resilience §12.6 (Decision 16) — the desktop main↔preload
  // bridge for the existing `sync:cancel-download` service command (added
  // by `add-engine-rename-download` §13.15-§13.16). The wire-side handler
  // ships at `services/fs-sync/src/commands/handlers.ts:366`; the desktop
  // bridge was missing pre-iter-5, so the toaster's Cancel button hit the
  // upload-job cancel by name collision instead of routing here.
  cancelDownload: "sync:cancel-download",
  // migrate-upload-orchestration-out-of-engine §7.3 / §7.9 — the desktop
  // renderer-facing bridge for the `sync:cancel-upload` service command.
  // Mirrors `cancelDownload`: idempotent, infallible at the service
  // boundary (an unknown `uploadJobId` resolves `{ cancelled: false }`
  // rather than erroring). `uploadJobId` here is the service-minted
  // business-domain key on the direct-RPC `files:upload` path; the
  // pre-migration queue-based upload-cancel route (`cancelJob({ jobId })`
  // against a `kind: 'upload'` row) was deleted in chunk F.
  cancelUpload: "sync:cancel-upload",
  // migrate-upload-orchestration-out-of-engine §7.2 / §7.9 — the
  // desktop renderer-facing bridge for the new `uploads:list-active`
  // service command. Mirrors `downloads:list-active`: returns the live
  // snapshot of in-flight uploads from the service's `UploadRegistry`
  // for renderer hydrate-on-connect (Sonner toast strip).
  uploadsListActive: "uploads:list-active",
  // The retired single-shot `sync:authenticate` channel was removed by
  // `implement-datasource-onboarding` per design.md Decision 9. The
  // three-command split below replaces it.
  authenticateStart: "sync:authenticate-start",
  authenticateComplete: "sync:authenticate-complete",
  authenticateCancel: "sync:authenticate-cancel",
  // OAuth-app-config round-trip for a future settings UI; not consumed by
  // the renderer in this change. See design.md Decision 4.
  getConfig: "sync:get-config",
  setConfig: "sync:set-config",
  // Symmetric credential cleanup invoked by `datasources:remove`.
  deleteCredentials: "sync:delete-credentials",
  getStatus: "sync:get-status",
  getRetryPolicy: "sync:get-retry-policy",
  setRetryPolicy: "sync:set-retry-policy",
  event: "sync:event",
} as const;

export type SyncChannelName = (typeof SYNC_CHANNELS)[keyof typeof SYNC_CHANNELS];
