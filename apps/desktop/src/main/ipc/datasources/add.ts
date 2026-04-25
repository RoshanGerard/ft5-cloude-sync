import {
  providers,
  type DatasourcesAddRequest,
  type DatasourcesAddResponse,
  type DatasourceSummary,
} from "@ft5/ipc-contracts";

import { getEngine } from "../../datasources/engine.js";

const DEFAULT_QUOTA_BY_PROVIDER: Record<string, number> = {
  "google-drive": 16_000_000_000,
  onedrive: 1_000_000_000_000,
};

let addCounter = 0;
function mintId(providerId: string): string {
  return `ds-${providerId}-${Date.now()}-${String(++addCounter)}`;
}

export async function handleDatasourcesAdd(
  req: DatasourcesAddRequest,
): Promise<DatasourcesAddResponse> {
  const descriptor = providers[req.providerId as keyof typeof providers];
  if (!descriptor) {
    throw new Error(`unknown provider: ${req.providerId}`);
  }

  const id = mintId(descriptor.id);
  const base: DatasourceSummary = {
    id,
    displayName: descriptor.displayName,
    providerId: descriptor.id,
    status: "connected",
    lastSyncAt: null,
    itemCount: 0,
    errorKind: null,
  };

  const summary: DatasourceSummary = descriptor.capabilities.quota
    ? {
        ...base,
        usage: {
          used: 0,
          quota: DEFAULT_QUOTA_BY_PROVIDER[descriptor.id] ?? 0,
        },
      }
    : base;

  const { registry } = getEngine();
  // Intentional: `req.credentials` is ignored here. The fs-sync service
  // owns credentials end-to-end (wire-fs-sync-service section 9); the
  // desktop main process no longer persists them. The IPC contract still
  // accepts the field on the wire so existing renderer code continues to
  // compile, but a follow-up change will wire `add` to the service's
  // `sync:authenticate-*` flow and drop it from the contract.
  const persisted = registry.add(summary);
  return { datasource: persisted };
}
