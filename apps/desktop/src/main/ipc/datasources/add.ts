import {
  providers,
  type AuthResult,
  type DatasourcesAddRequest,
  type DatasourcesAddResponse,
  type DatasourceSummary,
  type ProviderId,
  type StoredCredentials,
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

// The IPC request carries a `credentials: Record<string, unknown>` blob —
// provider-specific fields collected by the renderer's auth form. Wrap that
// opaque blob into the engine's `StoredCredentials` shape so the credential
// store's future `get(id)` returns something the engine's
// `ClientFactory.create(providerId, id, creds, ctx)` can consume.
// The real credential shape is strategy-specific; `authResult.meta` is the
// container for provider-specific extras (e.g., S3's region / bucket).
function wrapCredentials(
  providerId: ProviderId,
  raw: Record<string, unknown>,
): StoredCredentials {
  const now = Date.now();
  const accessToken =
    typeof raw.accessToken === "string" ? raw.accessToken : "";
  // Under exactOptionalPropertyTypes, optional fields must be OMITTED when
  // unavailable rather than set to `undefined`. Build the authResult
  // object incrementally so unset fields never appear.
  const authResult: AuthResult = {
    accessToken,
    meta: raw,
  };
  if (typeof raw.refreshToken === "string") {
    authResult.refreshToken = raw.refreshToken;
  }
  if (typeof raw.expiresAt === "number") {
    authResult.expiresAt = raw.expiresAt;
  }
  return {
    providerId,
    authResult,
    createdAt: now,
    updatedAt: now,
  };
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
  const credentials = wrapCredentials(descriptor.id, req.credentials);
  const persisted = await registry.add(summary, credentials);
  return { datasource: persisted };
}
