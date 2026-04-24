import type {
  DatasourcesActionRequest,
  DatasourcesActionResponse,
  DatasourceSummary,
} from "@ft5/ipc-contracts";

import { getEngine } from "../../datasources/engine.js";

function findSummary(id: string): DatasourceSummary | null {
  const { registry } = getEngine();
  return registry.list().find((ds) => ds.id === id) ?? null;
}

function ensureFound(id: string): DatasourceSummary {
  const summary = findSummary(id);
  if (!summary) {
    throw new Error(`datasource not found: ${id}`);
  }
  return summary;
}

export async function handleDatasourcesAction(
  req: DatasourcesActionRequest,
): Promise<DatasourcesActionResponse> {
  const { registry } = getEngine();

  switch (req.action) {
    case "pause": {
      ensureFound(req.datasourceId);
      registry.setPaused(req.datasourceId, true);
      return { datasource: ensureFound(req.datasourceId) };
    }
    case "resume": {
      ensureFound(req.datasourceId);
      registry.setPaused(req.datasourceId, false);
      return { datasource: ensureFound(req.datasourceId) };
    }
    case "sync-now": {
      // The live engine branch was removed in wire-fs-sync-service section 9
      // together with the desktop-side credential store. Actual sync work is
      // the fs-sync service's responsibility; this handler now only updates
      // the local bookkeeping row so the UI surfaces the syncing indicator.
      ensureFound(req.datasourceId);
      registry.setStatus(req.datasourceId, "syncing");
      registry.touchLastSyncAt(req.datasourceId);
      return { datasource: ensureFound(req.datasourceId) };
    }
  }
}
