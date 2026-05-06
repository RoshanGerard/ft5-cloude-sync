// migrate-upload-orchestration-out-of-engine §13.1 — renderer-facing
// `files.upload` handler post chunk-D direct-RPC cutover.
//
// Pre-migration (add-file-explorer-drag-drop-upload era) this delegated
// to `SyncClient.enqueueUpload` (the queue-based `sync:enqueue-upload`
// command). The migration replaced the queue with a direct RPC: the
// service's `files:upload` handler validates the request, mints a
// service-level `uploadJobId`, registers the in-flight job in the
// `UploadRegistry`, and invokes `client.uploadFile(parent, file, {
// signal, onProgress })` on the resolved engine client. Lifecycle events
// (`uploading` / `file-created` / `upload-failed` / `upload-cancelled`)
// flow on `sync:event-stream`, keyed by `uploadJobId`.
//
// The desktop bridge is now structurally identical to `files/download.ts`:
// a thin proxy over `SyncClient.request("files:upload", req)` with error
// normalization through `toFilesErrorEnvelope`. The wire response carries
// `{ uploadJobId }`, which we surface as `value.jobId` (the
// `FilesUploadValue.jobId` field is the canonical service-minted upload
// job id post-migration — see `packages/ipc-contracts/src/files.ts`
// `FilesUploadValue.jobId` JSDoc for the field's history).
//
// Concurrent-target conflict (Decision 10). The service rejects a
// SECOND request to an in-flight `(datasourceId, targetPath)` BEFORE
// minting the second job. The wire error envelope carries
// `existingUploadJobId` (the first job's id) and `existingPath` (the
// disputed target). Both fields cross the bridge intact via
// `toFilesErrorEnvelope`'s extended tag set; the renderer's Sonner
// error toast surfaces `existingUploadJobId` as a pointer to the
// existing toast.

import type { FilesUploadRequest, FilesUploadResponse } from "@ft5/ipc-contracts";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

import { toFilesErrorEnvelope } from "./error-envelope.js";

export interface FilesUploadDeps {
  readonly syncClient: Pick<SyncClient, "request">;
}

export async function handleFilesUpload(
  req: FilesUploadRequest,
  deps: FilesUploadDeps = { syncClient: getSyncClient() },
): Promise<FilesUploadResponse> {
  try {
    const result = await deps.syncClient.request("files:upload", {
      datasourceId: req.datasourceId,
      sourcePath: req.sourcePath,
      targetPath: req.targetPath,
      conflictPolicy: req.conflictPolicy,
    });
    return { ok: true, value: { jobId: result.uploadJobId } };
  } catch (err) {
    return { ok: false, error: toFilesErrorEnvelope(err) };
  }
}
