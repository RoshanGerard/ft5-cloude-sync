// wire-fs-sync-service task 5.6 — handleSyncEnqueueUpload [GREEN]
//
// Identity proxy over `SyncClient.enqueueUpload`. The renderer
// response type is a flat `{ jobId: string }` (mirrors the wire
// result exactly), so no shape adaptation is needed. Wire errors —
// only `validation-error` is documented here — propagate as thrown
// `SyncCommandError` values; the renderer surfaces them as IPC
// invoke rejections. The fallible calls with structured `{ error }`
// responses are `enqueueMirror` and `cancelJob`, handled by their
// own modules.
//
// Registration in `ipc/index.ts` is deferred to task 5.14.

import type {
  SyncEnqueueUploadRequest,
  SyncEnqueueUploadResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncEnqueueUpload(
  req: SyncEnqueueUploadRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncEnqueueUploadResponse> {
  return client.enqueueUpload(req);
}
