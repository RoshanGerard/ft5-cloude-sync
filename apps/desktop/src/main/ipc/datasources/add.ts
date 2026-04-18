import {
  providers,
  type DatasourcesAddRequest,
  type DatasourcesAddResponse,
  type DatasourceSummary,
} from "@ft5/ipc-contracts";

import { addDatasource } from "./store.js";

const DEFAULT_QUOTA_BY_PROVIDER: Record<string, number> = {
  "google-drive": 16_000_000_000,
  onedrive: 1_000_000_000_000,
};

export function handleDatasourcesAdd(
  req: DatasourcesAddRequest,
): DatasourcesAddResponse {
  const descriptor = providers[req.providerId as keyof typeof providers];
  if (!descriptor) {
    throw new Error(`unknown provider: ${req.providerId}`);
  }

  const base: Omit<DatasourceSummary, "id"> = {
    displayName: descriptor.displayName,
    providerId: descriptor.id,
    status: "connected",
    lastSyncAt: null,
    itemCount: 0,
  };

  const entry = descriptor.capabilities.quota
    ? {
        ...base,
        usage: {
          used: 0,
          quota: DEFAULT_QUOTA_BY_PROVIDER[descriptor.id] ?? 0,
        },
      }
    : base;

  const datasource = addDatasource(entry);
  return { datasource };
}
