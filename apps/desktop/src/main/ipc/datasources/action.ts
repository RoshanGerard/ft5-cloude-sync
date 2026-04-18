import type {
  DatasourcesActionRequest,
  DatasourcesActionResponse,
  DatasourceStatus,
} from "@ft5/ipc-contracts";

import { updateDatasource } from "./store.js";

const ACTION_TO_STATUS: Record<DatasourcesActionRequest["action"], DatasourceStatus> = {
  pause: "paused",
  resume: "connected",
  "sync-now": "syncing",
};

export function handleDatasourcesAction(
  req: DatasourcesActionRequest,
): DatasourcesActionResponse {
  const status = ACTION_TO_STATUS[req.action];
  const patch = req.action === "sync-now"
    ? { status, lastSyncAt: Date.now() }
    : { status };

  const datasource = updateDatasource(req.datasourceId, patch);
  if (!datasource) {
    throw new Error(`datasource not found: ${req.datasourceId}`);
  }
  return { datasource };
}
