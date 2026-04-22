// wire-fs-sync-service task 5.10 — handleSyncCancelJob [GREEN]
//
// Near-identity proxy over `SyncClient.cancelJob`. The renderer
// response is a discriminated union
//   `{ cancelled: true } | { error: NotCancelableErrorShape }`
// because `not-cancelable` is the one documented fallible outcome
// the UI branches on (it surfaces "this job can no longer be
// cancelled" inline rather than as a generic error toast). Any
// OTHER wire error — `not-found` and service-disconnected in
// particular — re-throws so the renderer IPC invoke rejects.
//
// Note on the error's `message` field: `SyncCommandError` reformats
// the underlying `ErrorShape.message` and does not preserve the
// original separately. The reconstructed renderer `ErrorShape` uses
// `err.message` directly; recovering the raw service message belongs
// to a separate change on `SyncClient`.
//
// Registration in `ipc/index.ts` is deferred to task 5.14.

import type { NotCancelableErrorShape } from "@ft5/ipc-contracts/sync-service";
import type {
  SyncCancelJobRequest,
  SyncCancelJobResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { SyncCommandError } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncCancelJob(
  req: SyncCancelJobRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncCancelJobResponse> {
  try {
    return await client.cancelJob({ jobId: req.jobId });
  } catch (err) {
    if (err instanceof SyncCommandError && err.tag === "not-cancelable") {
      const errorShape: NotCancelableErrorShape = {
        tag: "not-cancelable",
        message: err.message,
        details: err.details,
      };
      return { error: errorShape };
    }
    throw err;
  }
}
