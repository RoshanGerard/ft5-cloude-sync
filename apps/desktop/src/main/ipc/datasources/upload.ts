import path from "node:path";

import {
  DatasourceError,
  type DatasourcesUploadProgressEvent,
  type DatasourcesUploadRequest,
  type DatasourcesUploadResponse,
  type ProviderId,
} from "@ft5/ipc-contracts";

import { getEngine } from "../../datasources/engine.js";

export interface UploadDeps {
  showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  sendProgress: (event: DatasourcesUploadProgressEvent) => void;
  nextTransactionId: () => string;
}

export async function handleDatasourcesUpload(
  req: DatasourcesUploadRequest,
  deps: UploadDeps,
): Promise<DatasourcesUploadResponse> {
  // Error shape contract: pre-dialog errors THROW (renderer surfaces as
  // IPC rejection); post-dialog errors emit a `failed` progress event AND
  // return a transactionId so the UI's upload-tracking state machine can
  // clean up. Do not normalize without also updating the renderer.
  const { registry, factory, credentialStore, bus } = getEngine();

  const providerId = registry.getProviderId(req.datasourceId);
  if (!providerId) {
    throw new Error(`datasource not found: ${req.datasourceId}`);
  }

  const selection = await deps.showOpenDialog();
  if (selection.canceled || selection.filePaths.length === 0) {
    throw new Error("upload cancelled by user");
  }

  const transactionId = deps.nextTransactionId();

  // Fixture path — flag OFF. Emit the canned uploading/completed pair
  // without touching the provider. Mirrors the prior in-memory behaviour
  // so the existing UI continues to work while the engine is rolled out.
  if (!process.env.DATASOURCE_ENGINE_LIVE) {
    const bytesTotal = selection.filePaths.length * 100;
    deps.sendProgress({
      transactionId,
      bytesUploaded: 0,
      bytesTotal,
      status: "uploading",
    });
    deps.sendProgress({
      transactionId,
      bytesUploaded: bytesTotal,
      bytesTotal,
      status: "completed",
    });
    return { transactionId };
  }

  // Live path — resolve credentials, construct a client, call
  // `client.uploadFile(parent, file)` with a path-form `Target`. Uploads
  // go to the root of the datasource for now — a follow-up change lands
  // the "pick target folder" UI.
  const creds = await credentialStore.get(req.datasourceId);
  if (!creds) {
    deps.sendProgress({
      transactionId,
      bytesUploaded: 0,
      bytesTotal: 0,
      status: "failed",
      error: "Credentials not found — reconnect required",
    });
    return { transactionId };
  }

  const client = factory.create(
    providerId as ProviderId,
    req.datasourceId,
    creds,
    { bus, credentialStore },
  );

  // Sequential upload per selected file. Byte counters reset per file
  // because the engine emits its own event stream; the renderer receives
  // the finer-grained provider events via the datasources:event bridge
  // (Phase 10). Here we send a simple two-stage uploading/completed pair
  // per file so the existing progress bar UI keeps working.
  //
  // TODO(phase-10): Coarse byte-counter — `bytesTotal` here tracks FILE COUNT,
  // not bytes. Fine-grained per-chunk `uploading` events arrive via the
  // bus bridge wired in Phase 10 (`datasources:event`). Until then, the UI
  // progress bar sees file-level milestones only. Serial upload + first-
  // failure-aborts is a documented transitional shape; a follow-up change
  // can parallelize and report per-file outcomes once the event bridge
  // lands.
  deps.sendProgress({
    transactionId,
    bytesUploaded: 0,
    bytesTotal: selection.filePaths.length,
    status: "uploading",
  });
  for (const filePath of selection.filePaths) {
    try {
      await client.uploadFile(
        { kind: "path", path: "/" },
        { path: filePath, name: path.basename(filePath) },
      );
    } catch (err) {
      const reason =
        err instanceof DatasourceError
          ? `${err.tag}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      deps.sendProgress({
        transactionId,
        bytesUploaded: 0,
        bytesTotal: selection.filePaths.length,
        status: "failed",
        error: reason,
      });
      return { transactionId };
    }
  }
  deps.sendProgress({
    transactionId,
    bytesUploaded: selection.filePaths.length,
    bytesTotal: selection.filePaths.length,
    status: "completed",
  });
  return { transactionId };
}
