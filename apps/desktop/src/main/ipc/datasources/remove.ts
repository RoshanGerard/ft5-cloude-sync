// `datasources:remove` — local registry removal + best-effort service-side
// credential cleanup.
//
// Lifecycle:
//   1. `registry.remove(id)` — local SQLite row deletion, transactional.
//      Throws if the id is unknown so the renderer surfaces the dead-link
//      via the standard IPC failure path.
//   2. `syncClient.deleteCredentials({datasourceId})` — symmetric counterpart
//      to authenticate per implement-datasource-onboarding design Decision
//      12. The service deletes its `~/ft5/sync_app/credentials.json` entry
//      so the per-user credential file does not accumulate dead state.
//
// The service-side cleanup is **best-effort** per design Risks §1: any
// rejection (service down, IPC error, transport closed) is logged as a
// structured warning but does NOT prevent the local remove from
// succeeding. This is the documented orphan-credentials window — bounded
// by structurally being closed in the follow-up `move-datasource-registry-
// to-service` change.

import type {
  DatasourcesRemoveRequest,
  DatasourcesRemoveResponse,
} from "@ft5/ipc-contracts";

import { getEngine } from "../../datasources/engine.js";
import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleDatasourcesRemove(
  req: DatasourcesRemoveRequest,
  client?: SyncClient,
): Promise<DatasourcesRemoveResponse> {
  const { registry } = getEngine();
  const removed = registry.remove(req.datasourceId);
  if (!removed) {
    throw new Error(`datasource not found: ${req.datasourceId}`);
  }

  // Best-effort credential cleanup. We resolve the SyncClient lazily AND
  // wrap the entire call so that a missing supervisor (`getSyncClient()`
  // throws when bootstrap has not initialized it) never blocks the
  // user-facing remove. Per design Decision 12 + Risks §1.
  try {
    const resolved = client ?? getSyncClient();
    await resolved.deleteCredentials({ datasourceId: req.datasourceId });
  } catch (err) {
    console.warn(
      "[datasources:remove] sync:delete-credentials failed (best-effort cleanup, local remove succeeded):",
      {
        datasourceId: req.datasourceId,
        errorMessage: (err as Error).message,
      },
    );
  }

  return { ok: true };
}
