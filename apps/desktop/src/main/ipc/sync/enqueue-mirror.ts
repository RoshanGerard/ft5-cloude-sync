// wire-fs-sync-service task 5.8 — handleSyncEnqueueMirror [GREEN]
//
// Near-identity proxy over `SyncClient.enqueueMirror`. The renderer
// response type is a discriminated union
//   `{ jobId } | { error: SyncAlreadyRunningErrorShape }`
// because `sync-already-running` is the one documented fallible
// outcome the UI needs to branch on (it fires its own "another
// sync is already in progress" banner). Every OTHER wire error
// (`validation-error`, service-disconnected, …) re-throws so the
// renderer surfaces it as an IPC invoke rejection.
//
// `conflictPolicy` is optional and `exactOptionalPropertyTypes` is
// on — we must omit the key entirely when absent, not forward
// `conflictPolicy: undefined`.
//
// Note on the error's `message` field: `SyncCommandError` reformats
// the underlying `ErrorShape.message` into a prefixed string
// ("sync:enqueue-mirror failed: sync-already-running — <orig>") and
// does not preserve the original separately. Reconstructing an
// `ErrorShape` from the caught error therefore uses `err.message`
// directly; this is imperfect but matches the narrow scope of
// tasks 5.7–5.8 (modifying `SyncClient`/`SyncCommandError` belongs
// to a separate change).
//
// Registration in `ipc/index.ts` is deferred to task 5.14.

import type {
  CommandParams,
  SyncAlreadyRunningErrorShape,
} from "@ft5/ipc-contracts/sync-service";
import type {
  SyncEnqueueMirrorRequest,
  SyncEnqueueMirrorResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { SyncCommandError } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

type WireParams = CommandParams<"sync:enqueue-mirror">;

export async function handleSyncEnqueueMirror(
  req: SyncEnqueueMirrorRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncEnqueueMirrorResponse> {
  const params: { -readonly [K in keyof WireParams]: WireParams[K] } = {
    datasourceId: req.datasourceId,
    sourcePath: req.sourcePath,
  };
  if (req.conflictPolicy !== undefined) {
    params.conflictPolicy = req.conflictPolicy;
  }

  try {
    return await client.enqueueMirror(params);
  } catch (err) {
    if (err instanceof SyncCommandError && err.tag === "sync-already-running") {
      const errorShape: SyncAlreadyRunningErrorShape = {
        tag: "sync-already-running",
        message: err.message,
        details: err.details as SyncAlreadyRunningErrorShape["details"],
      };
      return { error: errorShape };
    }
    throw err;
  }
}
