import type {
  DatasourcesRemoveRequest,
  DatasourcesRemoveResponse,
} from "@ft5/ipc-contracts";

import { getEngine } from "../../datasources/engine.js";

export async function handleDatasourcesRemove(
  req: DatasourcesRemoveRequest,
): Promise<DatasourcesRemoveResponse> {
  const { registry } = getEngine();
  const removed = registry.remove(req.datasourceId);
  if (!removed) {
    throw new Error(`datasource not found: ${req.datasourceId}`);
  }
  return { ok: true };
}
