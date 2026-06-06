// migrate-upload-orchestration-out-of-engine §13.2 — handleSyncCancelUpload
//
// Near-identity proxy over `SyncClient.cancelUpload`. The renderer
// response is a flat `{ cancelled: boolean }` — NOT a discriminated union.
// The service-side `sync:cancel-upload` handler is idempotent: an unknown
// `uploadJobId` resolves with `{ cancelled: false }` rather than returning
// an error envelope. Hence no `try/catch` here for a fallible shape — any
// underlying SyncCommandError (e.g. service-disconnected) re-throws so
// the IPC layer surfaces it as an invoke rejection on the renderer side.
//
// Mirror of `cancel-download.ts` — the upload-side analogue. Pre-chunk-E
// the renderer's upload-toaster's Cancel button had no path to a service-
// side AbortController.abort() call (the engine's `cancelUpload` method
// was deleted in chunk B); chunks C/D added the wire command + handler,
// and this bridge is the desktop main↔preload glue.

import type {
  SyncCancelUploadRequest,
  SyncCancelUploadResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncCancelUpload(
  req: SyncCancelUploadRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncCancelUploadResponse> {
  return await client.cancelUpload({ uploadJobId: req.uploadJobId });
}
