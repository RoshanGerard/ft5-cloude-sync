// Crash recovery. Runs AFTER migrations + integrity check but BEFORE the
// IPC listener is bound to new clients. For every row in status='running'
// at startup (i.e., the service died mid-execution), transitions back to
// 'queued' with attempt++ and lastErrorTag='service-restart'. Queues a
// 'job-recovered' event for emission once the listener opens.
//
// Spec: "Service crash recovery re-queues running jobs on startup".
// Rows in 'waiting-network' are left untouched — they're the probe's
// responsibility.

import type Database from "better-sqlite3";

export interface RecoveredJob {
  readonly jobId: string;
  readonly newAttempt: number;
}

export function recoverRunningJobs(
  db: Database.Database,
): ReadonlyArray<RecoveredJob> {
  const now = Date.now();
  const rows = db
    .prepare(`SELECT id, attempt FROM jobs WHERE status = 'running'`)
    .all() as Array<{ id: string; attempt: number }>;
  if (rows.length === 0) return [];

  const update = db.prepare(
    `UPDATE jobs
     SET status = 'queued',
         attempt = attempt + 1,
         last_error_tag = 'service-restart',
         payload_json = NULL,
         updated_at = ?
     WHERE id = ? AND status = 'running'`,
  );
  const txn = db.transaction((rs: typeof rows) => {
    for (const r of rs) update.run(now, r.id);
  });
  txn(rows);

  return rows.map((r) => ({ jobId: r.id, newAttempt: r.attempt + 1 }));
}
