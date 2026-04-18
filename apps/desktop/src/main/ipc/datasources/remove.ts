import type {
  DatasourcesRemoveRequest,
  DatasourcesRemoveResponse,
} from "@ft5/ipc-contracts";

import { removeDatasource } from "./store.js";

export function handleDatasourcesRemove(
  req: DatasourcesRemoveRequest,
): DatasourcesRemoveResponse {
  const removed = removeDatasource(req.datasourceId);
  if (!removed) {
    throw new Error(`datasource not found: ${req.datasourceId}`);
  }
  return { ok: true };
}
