// wire-fs-sync-service task 5.2 — handleSyncListJobs [GREEN]
//
// Renderer-facing IPC handler for `SYNC_CHANNELS.listJobs`. Proxies
// to the supervisor-owned SyncClient and enriches the wire result
// with a derived "which datasources are actively syncing?" set —
// the only piece of business logic in this otherwise pass-through
// section-5 surface.
//
// The handler translates the renderer filter (`statuses`, plural, no
// `kind` field) to the wire filter (`status`, singular, optional
// `kind`). The rename is intentional on both contracts and not
// something this handler is at liberty to change.
//
// Dependency-injection seam: the second parameter defaults to the
// supervisor-provisioned client via `getSyncClient()`, matching the
// "real-by-default, test-overrides" pattern used elsewhere under
// `ipc/` (see `datasources/upload.ts`'s `UploadDeps`). Registration
// in `ipc/index.ts` is deferred to task 5.14.

import type {
  CommandParams,
  JobSummary,
} from "@ft5/ipc-contracts/sync-service";
import type {
  SyncListJobsRequest,
  SyncListJobsResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncListJobs(
  req: SyncListJobsRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncListJobsResponse> {
  const wireParams: CommandParams<"sync:list-jobs"> = req.filter
    ? { filter: translateFilter(req.filter) }
    : {};

  const wire = await client.listJobs(wireParams);
  return {
    jobs: wire.jobs,
    derivedSyncingDatasourceIds: computeSyncingSet(wire.jobs),
  };
}

type WireFilter = NonNullable<CommandParams<"sync:list-jobs">["filter"]>;

function translateFilter(
  rendererFilter: NonNullable<SyncListJobsRequest["filter"]>,
): WireFilter {
  const out: { -readonly [K in keyof WireFilter]: WireFilter[K] } = {};
  if (rendererFilter.statuses !== undefined) {
    out.status = rendererFilter.statuses;
  }
  if (rendererFilter.datasourceId !== undefined) {
    out.datasourceId = rendererFilter.datasourceId;
  }
  return out;
}

function computeSyncingSet(
  jobs: ReadonlyArray<JobSummary>,
): ReadonlyArray<string> {
  const set = new Set<string>();
  for (const job of jobs) {
    if (job.kind !== "sync") continue;
    if (
      job.status !== "running" &&
      job.status !== "queued" &&
      job.status !== "waiting-network"
    ) {
      continue;
    }
    set.add(job.datasourceId);
  }
  return [...set];
}
