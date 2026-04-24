// wire-fs-sync-service task 5.13 — handleSyncGetStatus [GREEN]
//
// Near-identity proxy over `SyncClient.getStatus`. NOT a pure identity
// proxy: the wire result carries an additional `monitorConnected: boolean`
// flag (a service-internal health signal) that is NOT part of the
// renderer-facing `SyncGetStatusResponse`. The handler projects the wire
// result down to the renderer's field set. The renderer request type is
// `void`; the wire params shape is `Record<string, never>` so the handler
// passes an empty object through.
//
// Every service-side failure (validation-error, service-disconnected, …)
// re-throws so the IPC layer surfaces it as an invoke rejection — there
// is no `{ result } | { error }` union on this call.
//
// Registration in `ipc/index.ts` is deferred to task 5.14.

import type {
  SyncGetStatusRequest,
  SyncGetStatusResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncGetStatus(
  req: SyncGetStatusRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncGetStatusResponse> {
  // `req` is typed as `void` on the renderer contract; reference it so the
  // parameter isn't flagged as unused while remaining in the signature for
  // symmetry with the other section-5 handlers and to preserve the slot
  // should a future request shape grow fields.
  void req;
  const wire = await client.getStatus({});
  return {
    version: wire.version,
    serviceUuid: wire.serviceUuid,
    runningJobs: wire.runningJobs,
    queuedJobs: wire.queuedJobs,
    waitingNetworkJobs: wire.waitingNetworkJobs,
  };
}
