// migrate-upload-orchestration-out-of-engine §10 / §13 — handleUploadsListActive
//
// Thin proxy over `SyncClient.uploadsListActive` (→ service command
// `uploads:list-active`). Returns the current `UploadRegistry` snapshot
// projected onto the wire `UploadJob[]` shape. The desktop bridge is
// intentionally request-able (parallel to the download-side
// `files:hydrate-active-downloads` one-way channel) so the renderer can
// re-fetch the snapshot without waiting for a fresh supervisor connect
// (e.g. on tab-focus recovery).
//
// Errors from the service re-throw verbatim; the renderer's
// `window.api.uploads.listActive()` rejects on transport-level failures
// (service-disconnected, malformed frames, etc.). The hydrate path
// inside `main/index.ts` swallows the rejection separately so a
// transient service blip doesn't poison bootstrap.

import type { SyncUploadsListActiveResponse } from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleUploadsListActive(
  client: SyncClient = getSyncClient(),
): Promise<SyncUploadsListActiveResponse> {
  return await client.uploadsListActive({});
}
