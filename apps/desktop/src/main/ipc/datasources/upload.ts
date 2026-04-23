// wire-fs-sync-service task 8.2 — service-proxy upload handler [GREEN].
//
// The desktop IPC upload handler is now a thin proxy over the
// fs-sync-service. All in-process engine coupling (registry lookup,
// credential decryption, provider factory, per-file uploadFile call,
// DATASOURCE_ENGINE_LIVE flag branch) is gone; the service owns uploads
// unconditionally. Progress events reach the renderer through the
// sync event-bridge (section 7), which translates job-progress into
// `DATASOURCES_CHANNELS.uploadProgress` — the handler itself no longer
// emits progress, so `sendProgress`/`nextTransactionId` are dropped
// from the deps surface.
//
// See openspec/changes/wire-fs-sync-service/design.md Decision 3.

import path from "node:path";

import type {
  DatasourcesUploadRequest,
  DatasourcesUploadResponse,
} from "@ft5/ipc-contracts";

import type { SyncClient } from "../../sync/client.js";

export interface UploadDeps {
  showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  syncClient: Pick<SyncClient, "enqueueUpload">;
}

export async function handleDatasourcesUpload(
  req: DatasourcesUploadRequest,
  deps: UploadDeps,
): Promise<DatasourcesUploadResponse> {
  const selection = await deps.showOpenDialog();
  if (selection.canceled || selection.filePaths.length === 0) {
    throw new Error("upload cancelled by user");
  }

  // Single-file selection only — multi-file is out of scope for this
  // change. The renderer call site already hands one file at a time.
  const sourcePath = selection.filePaths[0]!;
  const targetPath = "/" + path.basename(sourcePath);

  const { jobId } = await deps.syncClient.enqueueUpload({
    datasourceId: req.datasourceId,
    sourcePath,
    targetPath,
    conflictPolicy: "overwrite",
  });

  return { transactionId: jobId };
}
