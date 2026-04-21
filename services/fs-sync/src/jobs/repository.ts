// Job DAO — thin typed wrapper over the `jobs` table. No business logic
// lives here; command handlers and the scheduler compose these primitives.

import type Database from "better-sqlite3";

import type {
  ConflictPolicy,
  JobKind,
  JobStatus,
  JobSummary,
} from "@ft5/ipc-contracts/sync-service";

import { assertLegalTransition } from "./state-machine.js";

interface JobRow {
  id: string;
  kind: JobKind;
  datasource_id: string;
  source_path: string;
  target_path: string | null;
  conflict_policy: ConflictPolicy;
  status: JobStatus;
  attempt: number;
  last_error_tag: string | null;
  last_error_message: string | null;
  retry_policy_json: string | null;
  payload_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface InsertJobInput {
  readonly id: string;
  readonly kind: JobKind;
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly targetPath?: string | undefined;
  readonly conflictPolicy: ConflictPolicy;
  readonly payloadJson?: string | undefined;
}

export class JobRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  insert(input: InsertJobInput): JobSummary {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, datasource_id, source_path, target_path,
                           conflict_policy, status, attempt, payload_json,
                           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.kind,
        input.datasourceId,
        input.sourcePath,
        input.targetPath ?? null,
        input.conflictPolicy,
        input.payloadJson ?? null,
        now,
        now,
      );
    const row = this.getById(input.id);
    if (!row) {
      throw new Error(`JobRepository.insert: row for ${input.id} vanished`);
    }
    return row;
  }

  getById(id: string): JobSummary | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(id) as JobRow | undefined;
    return row ? toSummary(row) : null;
  }

  listByStatus(status: JobStatus): ReadonlyArray<JobSummary> {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at")
      .all(status) as JobRow[];
    return rows.map(toSummary);
  }

  listAll(): ReadonlyArray<JobSummary> {
    const rows = this.db
      .prepare("SELECT * FROM jobs ORDER BY created_at")
      .all() as JobRow[];
    return rows.map(toSummary);
  }

  /**
   * Transition a job's status. Validates the edge BEFORE any DB write.
   * `updates` may carry auxiliary fields updated in the same row write.
   */
  transition(
    id: string,
    to: JobStatus,
    updates: {
      readonly lastErrorTag?: string | null | undefined;
      readonly lastErrorMessage?: string | null | undefined;
      readonly incrementAttempt?: boolean | undefined;
    } = {},
  ): JobSummary {
    const current = this.getById(id);
    if (!current) throw new Error(`JobRepository.transition: ${id} not found`);
    assertLegalTransition(id, current.status, to);
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE jobs
         SET status = ?,
             attempt = attempt + ?,
             last_error_tag = COALESCE(?, last_error_tag),
             last_error_message = COALESCE(?, last_error_message),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        to,
        updates.incrementAttempt ? 1 : 0,
        updates.lastErrorTag ?? null,
        updates.lastErrorMessage ?? null,
        now,
        id,
      );
    const row = this.getById(id);
    if (!row) throw new Error(`JobRepository.transition: ${id} vanished mid-update`);
    return row;
  }

  countByStatus(statuses: ReadonlyArray<JobStatus>): number {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(",");
    const row = this.db
      .prepare(`SELECT COUNT(*) as c FROM jobs WHERE status IN (${placeholders})`)
      .get(...statuses) as { c: number };
    return row.c;
  }
}

function toSummary(row: JobRow): JobSummary {
  return {
    id: row.id,
    kind: row.kind,
    datasourceId: row.datasource_id,
    sourcePath: row.source_path,
    targetPath: row.target_path,
    conflictPolicy: row.conflict_policy,
    status: row.status,
    attempt: row.attempt,
    lastErrorTag: row.last_error_tag,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
