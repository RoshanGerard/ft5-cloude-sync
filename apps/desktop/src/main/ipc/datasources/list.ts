import type { DatasourcesListResponse } from "@ft5/ipc-contracts";

import { getEngine } from "../../datasources/engine.js";

// `list` is a pure query against the persistent registry. No engine call,
// so no feature flag — the registry is the source of truth under both
// `DATASOURCE_ENGINE_LIVE` regimes.
export function handleDatasourcesList(): DatasourcesListResponse {
  const { registry } = getEngine();
  return { datasources: registry.list() };
}
