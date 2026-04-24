// wire-fs-sync-service task 5.13 — handleSyncSetRetryPolicy [GREEN]
//
// Identity proxy over `SyncClient.setRetryPolicy`. The renderer
// `SyncSetRetryPolicyRequest` and the wire
// `CommandParams<"sync:set-retry-policy">` are structurally identical
// (`{ scope, datasourceId?, maxAttempts, backoffMs, backoffStrategy,
// maxAgeMs? }`), as are the renderer and wire result shapes
// (`{ policy: RetryPolicy }`), so forwarding is a one-liner with no
// translation or enrichment.
//
// Every service-side failure (validation-error, service-disconnected,
// …) re-throws so the IPC layer surfaces it as an invoke rejection —
// there is no `{ result } | { error }` union on this call.
//
// Registration in `ipc/index.ts` is deferred to task 5.14.

import type {
  SyncSetRetryPolicyRequest,
  SyncSetRetryPolicyResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncSetRetryPolicy(
  req: SyncSetRetryPolicyRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncSetRetryPolicyResponse> {
  return client.setRetryPolicy(req);
}
