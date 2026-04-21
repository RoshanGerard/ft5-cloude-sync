import {
  DatasourceError,
  type DatasourcesActionRequest,
  type DatasourcesActionResponse,
  type DatasourceStatus,
  type DatasourceSummary,
  type ProviderId,
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
  const { registry, factory, credentialStore, bus } = getEngine();

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
      ensureFound(req.datasourceId);
      // Fixture path — flag OFF. Mirrors the previous in-memory behaviour:
      // flip status to "syncing" and bump last_sync_at. Kept verbatim so
      // existing UI flows keep working during the engine-live rollout
      // (Migration Plan step 3 in design.md).
      if (!process.env.DATASOURCE_ENGINE_LIVE) {
        registry.setStatus(req.datasourceId, "syncing");
        registry.touchLastSyncAt(req.datasourceId);
        return { datasource: ensureFound(req.datasourceId) };
      }

      // Live path — actually ask the provider for its status via the
      // engine. `client.status()` returns a string union
      // (`DatasourceStatus`); failures land as `DatasourceError`.
      const providerId = registry.getProviderId(req.datasourceId);
      if (!providerId) {
        throw new Error(`datasource not found: ${req.datasourceId}`);
      }
      const creds = await credentialStore.get(req.datasourceId);
      if (!creds) {
        // Keyed error shape — status becomes "error" + errorReason so the
        // UI can surface a reconnect button.
        registry.setStatus(
          req.datasourceId,
          "error",
          "Credentials not found — reconnect required",
        );
        return { datasource: ensureFound(req.datasourceId) };
      }

      try {
        const client = factory.create(
          providerId as ProviderId,
          req.datasourceId,
          creds,
          { bus, credentialStore },
        );
        const state: DatasourceStatus = await client.status();
        // TODO(12.4): Runtime-validate `status.state ∈ DatasourceStatus` before
        // writing to the registry. Today all three concrete clients conform by
        // TypeScript; a future refactor could corrupt rows with an out-of-union
        // value. Pin this when the `authentication-failed` payload shape is
        // finalized (Phase 12 open question 12.4).
        registry.setStatus(req.datasourceId, state);
        registry.touchLastSyncAt(req.datasourceId);
      } catch (err) {
        const reason =
          err instanceof DatasourceError
            ? `${err.tag}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        registry.setStatus(req.datasourceId, "error", reason);
      }
      return { datasource: ensureFound(req.datasourceId) };
    }
  }
}
