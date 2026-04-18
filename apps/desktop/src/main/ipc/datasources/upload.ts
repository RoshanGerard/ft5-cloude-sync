import type {
  DatasourcesUploadProgressEvent,
  DatasourcesUploadRequest,
  DatasourcesUploadResponse,
} from "@ft5/ipc-contracts";

import { getDatasources } from "./store.js";

export interface UploadDeps {
  showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  sendProgress: (event: DatasourcesUploadProgressEvent) => void;
  nextTransactionId: () => string;
}

export async function handleDatasourcesUpload(
  req: DatasourcesUploadRequest,
  deps: UploadDeps,
): Promise<DatasourcesUploadResponse> {
  const exists = getDatasources().some((ds) => ds.id === req.datasourceId);
  if (!exists) {
    throw new Error(`datasource not found: ${req.datasourceId}`);
  }

  const selection = await deps.showOpenDialog();
  if (selection.canceled || selection.filePaths.length === 0) {
    throw new Error("upload cancelled by user");
  }

  const transactionId = deps.nextTransactionId();
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
