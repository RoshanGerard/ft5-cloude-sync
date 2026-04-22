// wire-fs-sync-service task 5.13 — handleSyncGetRetryPolicy [GREEN]
//
// Identity proxy over `SyncClient.getRetryPolicy`. The renderer
// `SyncGetRetryPolicyRequest` (`{ scope, datasourceId? }`) and the wire
// `CommandParams<"sync:get-retry-policy">` are structurally identical,
// as are the renderer and wire result shapes (`{ policy: RetryPolicy }`),
// so forwarding is a one-liner with no translation or enrichment.
//
// Every service-side failure (not-found, service-disconnected, …)
// re-throws so the IPC layer surfaces it as an invoke rejection — there
// is no `{ result } | { error }` union on this call.
//
// Registration in `ipc/index.ts` is deferred to task 5.14.

import type {
  SyncGetRetryPolicyRequest,
  SyncGetRetryPolicyResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncGetRetryPolicy(
  req: SyncGetRetryPolicyRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncGetRetryPolicyResponse> {
  return client.getRetryPolicy(req);
}
