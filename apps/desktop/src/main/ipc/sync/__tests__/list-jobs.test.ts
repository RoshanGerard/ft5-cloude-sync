// wire-fs-sync-service task 5.1 — handleSyncListJobs [RED]
//
// The handler is a near-identity proxy over `SyncClient.listJobs`, with
// two wrinkles:
//   1. The renderer-facing filter uses `statuses` (plural); the wire
//      command uses `status` (singular). The handler translates.
//   2. The response is enriched with `derivedSyncingDatasourceIds` —
//      the set of datasourceIds whose jobs have kind='sync' AND status
//      in {running, queued, waiting-network}. Deduped.

import { describe, expect, it, vi } from "vitest";

import type {
  JobStatus,
  JobSummary,
} from "@ft5/ipc-contracts/sync-service";
import type { SyncListJobsRequest } from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../../sync/client.js";
import { handleSyncListJobs } from "../list-jobs.js";

// Minimal fixture builder; only the fields the handler reads need real values.
function job(partial: Partial<JobSummary> & Pick<JobSummary, "id">): JobSummary {
  return {
    kind: "sync",
    datasourceId: "ds-default",
    sourcePath: "/src",
    targetPath: null,
    conflictPolicy: "skip",
    status: "running" as JobStatus,
    attempt: 0,
    lastErrorTag: null,
    lastErrorMessage: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function makeFakeClient(jobs: ReadonlyArray<JobSummary>): {
  client: SyncClient;
  listJobs: ReturnType<typeof vi.fn>;
} {
  const listJobs = vi.fn().mockResolvedValue({ jobs });
  // Only `listJobs` is exercised by the handler. Cast via `unknown` so the
  // partial shape type-checks without pretending to implement the full class.
  const client = { listJobs } as unknown as SyncClient;
  return { client, listJobs };
}

describe("handleSyncListJobs", () => {
  it("proxies to client.listJobs with translated wire params (statuses → status)", async () => {
    const { client, listJobs } = makeFakeClient([]);
    const req: SyncListJobsRequest = {
      filter: { statuses: ["running"], datasourceId: "ds-1" },
    };

    await handleSyncListJobs(req, client);

    expect(listJobs).toHaveBeenCalledTimes(1);
    expect(listJobs).toHaveBeenCalledWith({
      filter: { status: ["running"], datasourceId: "ds-1" },
    });
  });

  it("passes undefined filter through when req.filter is absent", async () => {
    const { client, listJobs } = makeFakeClient([]);
    const req: SyncListJobsRequest = {};

    await handleSyncListJobs(req, client);

    expect(listJobs).toHaveBeenCalledTimes(1);
    expect(listJobs).toHaveBeenCalledWith({ filter: undefined });
  });

  it("returns the jobs array the client produced", async () => {
    const jobs = [job({ id: "j-1", datasourceId: "ds-1" })];
    const { client } = makeFakeClient(jobs);

    const res = await handleSyncListJobs({}, client);

    expect(res.jobs).toBe(jobs);
  });

  it("includes a single matching sync job's datasourceId in derivedSyncingDatasourceIds", async () => {
    const { client } = makeFakeClient([
      job({ id: "j-1", kind: "sync", status: "running", datasourceId: "ds-1" }),
    ]);

    const res = await handleSyncListJobs({}, client);

    expect(res.derivedSyncingDatasourceIds).toEqual(["ds-1"]);
  });

  it("excludes sync jobs whose status is not running/queued/waiting-network", async () => {
    const { client } = makeFakeClient([
      job({ id: "j-1", kind: "sync", status: "completed", datasourceId: "ds-1" }),
      job({ id: "j-2", kind: "sync", status: "failed", datasourceId: "ds-2" }),
      job({ id: "j-3", kind: "sync", status: "cancelled", datasourceId: "ds-3" }),
    ]);

    const res = await handleSyncListJobs({}, client);

    expect(res.derivedSyncingDatasourceIds).toEqual([]);
  });

  it("excludes upload-kind jobs even when status is running", async () => {
    const { client } = makeFakeClient([
      job({ id: "j-1", kind: "upload", status: "running", datasourceId: "ds-1" }),
    ]);

    const res = await handleSyncListJobs({}, client);

    expect(res.derivedSyncingDatasourceIds).toEqual([]);
  });

  it("includes sync jobs with status queued or waiting-network", async () => {
    const { client } = makeFakeClient([
      job({ id: "j-1", kind: "sync", status: "queued", datasourceId: "ds-1" }),
      job({
        id: "j-2",
        kind: "sync",
        status: "waiting-network",
        datasourceId: "ds-2",
      }),
    ]);

    const res = await handleSyncListJobs({}, client);

    expect([...res.derivedSyncingDatasourceIds].sort()).toEqual(["ds-1", "ds-2"]);
  });

  it("deduplicates derivedSyncingDatasourceIds across multiple jobs on the same datasource", async () => {
    const { client } = makeFakeClient([
      job({ id: "j-1", kind: "sync", status: "running", datasourceId: "ds-1" }),
      job({ id: "j-2", kind: "sync", status: "queued", datasourceId: "ds-1" }),
      job({
        id: "j-3",
        kind: "sync",
        status: "waiting-network",
        datasourceId: "ds-1",
      }),
    ]);

    const res = await handleSyncListJobs({}, client);

    expect(res.derivedSyncingDatasourceIds).toEqual(["ds-1"]);
  });

  it("returns an empty derivedSyncingDatasourceIds when there are no jobs", async () => {
    const { client } = makeFakeClient([]);

    const res = await handleSyncListJobs({}, client);

    expect(res.jobs).toEqual([]);
    expect(res.derivedSyncingDatasourceIds).toEqual([]);
  });
});
