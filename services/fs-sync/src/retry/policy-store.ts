// Retry-policy DAO backed by the `retry_policies` table. Per-datasource
// policies override the global policy; defaults apply when nothing is set.
//
// Spec: "User-level retry policy for provider-error".

import type Database from "better-sqlite3";
import type {
  BackoffStrategy,
  RetryPolicy,
  RetryPolicyScope,
} from "@ft5/ipc-contracts/sync-service";

export const DEFAULT_POLICY: RetryPolicy = {
  scope: "global",
  datasourceId: null,
  maxAttempts: 3,
  backoffMs: 5000,
  backoffStrategy: "exponential",
  maxAgeMs: 86_400_000,
};

export class PolicyStore {
  constructor(private readonly db: Database.Database) {}

  get(scope: RetryPolicyScope, datasourceId?: string): RetryPolicy | null {
    const row = this.db
      .prepare(
        `SELECT scope, datasource_id, max_attempts, backoff_ms,
                backoff_strategy, max_age_ms
         FROM retry_policies WHERE scope = ? AND datasource_id = ?`,
      )
      .get(scope, datasourceId ?? "") as
      | {
          scope: RetryPolicyScope;
          datasource_id: string;
          max_attempts: number;
          backoff_ms: number;
          backoff_strategy: BackoffStrategy;
          max_age_ms: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      scope: row.scope,
      datasourceId: row.datasource_id === "" ? null : row.datasource_id,
      maxAttempts: row.max_attempts,
      backoffMs: row.backoff_ms,
      backoffStrategy: row.backoff_strategy,
      maxAgeMs: row.max_age_ms,
    };
  }

  upsert(policy: RetryPolicy): void {
    this.db
      .prepare(
        `INSERT INTO retry_policies
           (scope, datasource_id, max_attempts, backoff_ms, backoff_strategy, max_age_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, datasource_id) DO UPDATE SET
           max_attempts = excluded.max_attempts,
           backoff_ms = excluded.backoff_ms,
           backoff_strategy = excluded.backoff_strategy,
           max_age_ms = excluded.max_age_ms`,
      )
      .run(
        policy.scope,
        policy.datasourceId ?? "",
        policy.maxAttempts,
        policy.backoffMs,
        policy.backoffStrategy,
        policy.maxAgeMs,
      );
  }

  /**
   * Effective policy for a given datasource. Prefers a per-datasource row,
   * falls back to the global row, then to DEFAULT_POLICY.
   */
  effectiveFor(datasourceId: string): RetryPolicy {
    return (
      this.get("datasource", datasourceId) ??
      this.get("global") ??
      DEFAULT_POLICY
    );
  }
}
