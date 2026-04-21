// Dedup-guarded enqueue for mirror-sync jobs. The dedup query + INSERT run
// inside a single `BEGIN IMMEDIATE` transaction so two concurrent
// `sync:enqueue-mirror` requests for the same (datasourceId, sourcePath)
// cannot both succeed.
//
// Spec: "Sync dedup rule rejects duplicate enqueues".

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { ConflictPolicy, JobStatus } from "@ft5/ipc-contracts/sync-service";

import { JobRepository } from "./repository.js";

export interface EnqueueMirrorInput {
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly conflictPolicy: ConflictPolicy;
  readonly payloadJson?: string | undefined;
}

export interface EnqueueMirrorResult {
  readonly jobId: string;
}

export class SyncAlreadyRunningError extends Error {
  readonly tag = "sync-already-running" as const;
  readonly existingJobId: string;
  readonly datasourceId: string;
  readonly sourcePath: string;
  constructor(existingJobId: string, datasourceId: string, sourcePath: string) {
    super(
      `sync job already running for datasource=${datasourceId} sourcePath=${sourcePath} (existingJobId=${existingJobId})`,
    );
    this.name = "SyncAlreadyRunningError";
    this.existingJobId = existingJobId;
    this.datasourceId = datasourceId;
    this.sourcePath = sourcePath;
  }
}

const ACTIVE_STATUSES: ReadonlyArray<JobStatus> = [
  "queued",
  "running",
  "waiting-network",
];

export function enqueueMirror(
  db: Database.Database,
  input: EnqueueMirrorInput,
): EnqueueMirrorResult {
  const jobId = randomUUID();

  // BEGIN IMMEDIATE acquires a write lock up front so a concurrent enqueue
  // can't sneak a matching row in between our SELECT and INSERT.
  const txn = db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT id FROM jobs
         WHERE kind = 'sync'
           AND datasource_id = ?
           AND source_path = ?
           AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})
         LIMIT 1`,
      )
      .get(input.datasourceId, input.sourcePath, ...ACTIVE_STATUSES) as
      | { id: string }
      | undefined;

    if (existing) {
      throw new SyncAlreadyRunningError(
        existing.id,
        input.datasourceId,
        input.sourcePath,
      );
    }

    new JobRepository(db).insert({
      id: jobId,
      kind: "sync",
      datasourceId: input.datasourceId,
      sourcePath: input.sourcePath,
      conflictPolicy: input.conflictPolicy,
      payloadJson: input.payloadJson,
    });
  });

  // better-sqlite3 supports .immediate() on transactions — this promotes
  // the default DEFERRED to IMMEDIATE acquisition. Re-throws inside the
  // txn roll back and propagate to the caller.
  txn.immediate();
  return { jobId };
}
