// wire-fs-sync-service task 5.4 — handleSyncGetJob [GREEN]
//
// Near-identity proxy over `SyncClient.getJob`. The only wrinkle is the
// result-shape difference between the wire and the renderer:
//   wire:     `{ job: JobSummary }` — throws `not-found` on miss
//   renderer: `{ job: JobSummary | null }` — absent job is null
// so the handler catches `SyncCommandError` with tag `not-found` and
// normalises it to `{ job: null }`. Any other error re-throws so the
// IPC layer surfaces it to the renderer as an invoke rejection.
//
// Registration in `ipc/index.ts` is deferred to task 5.14.

import type {
  SyncGetJobRequest,
  SyncGetJobResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { SyncCommandError } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncGetJob(
  req: SyncGetJobRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncGetJobResponse> {
  try {
    const wire = await client.getJob({ jobId: req.jobId });
    return { job: wire.job };
  } catch (err) {
    if (err instanceof SyncCommandError && err.tag === "not-found") {
      return { job: null };
    }
    throw err;
  }
}
