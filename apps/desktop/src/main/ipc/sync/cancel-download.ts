// add-download-resilience §12.6 (iter-5, Decision 16) — handleSyncCancelDownload
//
// Near-identity proxy over `SyncClient.cancelDownload`. The renderer
// response is a flat `{ cancelled: boolean }` — NOT the discriminated
// `{ cancelled: true } | { error: ... }` union of `cancelJob`. The
// service-side `sync:cancel-download` handler is idempotent: an unknown
// `downloadJobId` resolves with `{ cancelled: false }` rather than
// returning an error envelope. Hence no `try/catch` here for a fallible
// shape — any underlying SyncCommandError (e.g. service-disconnected)
// re-throws so the IPC layer surfaces it as an invoke rejection on the
// renderer side.
//
// Pre-iter-5, the desktop main↔preload bridge for `sync:cancel-download`
// was missing entirely; the renderer toaster's Cancel button hit the
// upload-job `cancelJob` channel by name collision instead of routing
// here. See design.md Decision 16.

import type {
  SyncCancelDownloadRequest,
  SyncCancelDownloadResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncCancelDownload(
  req: SyncCancelDownloadRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncCancelDownloadResponse> {
  return await client.cancelDownload({ downloadJobId: req.downloadJobId });
}
