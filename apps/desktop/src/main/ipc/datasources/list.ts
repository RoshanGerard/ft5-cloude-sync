import type { DatasourcesListResponse } from "@ft5/ipc-contracts";

import { getDatasources } from "./store.js";

export function handleDatasourcesList(): DatasourcesListResponse {
  return { datasources: [...getDatasources()] };
}
