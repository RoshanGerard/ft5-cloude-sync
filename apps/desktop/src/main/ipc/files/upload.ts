// add-file-explorer-drag-drop-upload task 2.2 — renderer-facing
// `files.upload` handler [GREEN].
//
// A thin proxy over `SyncClient.enqueueUpload` (→ sync-service
// `sync:enqueue-upload`). Unlike the retired `datasources.upload`
// handler, this one opens NO picker and derives NO paths — the
// renderer supplies `sourcePath`, `targetPath`, and `conflictPolicy`
// straight from either the OS drop payload or the upload-dialog
// destination picker. Progress events continue to reach the renderer
// through the sync event-bridge's translation into
// `DATASOURCES_CHANNELS.uploadProgress`, keyed by the returned
// `jobId`.
//
// The `deps` DI seam matches the pattern used by the other `files/*`
// handlers (`list.ts`, `remove.ts`, etc.): `syncClient` is a
// structural subset of `SyncClient` so tests can inject a stub without
// constructing a real socket. Errors from the service are mapped
// through `toFilesErrorEnvelope`, which preserves `tag` / `retryable`
// / `retryAfterMs` on `SyncCommandError` and collapses anything else
// into `{ tag: "other", retryable: false }`.

import type { FilesUploadRequest, FilesUploadResponse } from "@ft5/ipc-contracts";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

import { toFilesErrorEnvelope } from "./error-envelope.js";

export interface FilesUploadDeps {
  readonly syncClient: Pick<SyncClient, "enqueueUpload">;
}

export async function handleFilesUpload(
  req: FilesUploadRequest,
  deps: FilesUploadDeps = { syncClient: getSyncClient() },
): Promise<FilesUploadResponse> {
  try {
    const { jobId } = await deps.syncClient.enqueueUpload({
      datasourceId: req.datasourceId,
      sourcePath: req.sourcePath,
      targetPath: req.targetPath,
      conflictPolicy: req.conflictPolicy,
    });
    return { ok: true, value: { jobId } };
  } catch (err) {
    return { ok: false, error: toFilesErrorEnvelope(err) };
  }
}
