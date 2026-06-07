// `files:list` command handler. Resolves the engine client for the given
// datasourceId and delegates to `client.listDirectory({ kind: "path", path },
// { cursor, pageSize })`. Engine throws normalize to the wire envelope via
// `normalizeFilesError`.
//
// Pagination (add-engine-listdirectory-pagination Decisions 1, 4, 6):
//   - Forwards `params.cursor` / `params.pageSize` to the engine, which
//     returns one provider page plus an opaque `nextCursor`.
//   - Surfaces `nextCursor` on the response and derives
//     `truncated = nextCursor !== null` (was hard-coded `false`).
//   - Wraps the engine call in a fixed-schedule environmental-retry loop
//     (the OUTER ring) around `withAuthRefresh` (the INNER one-shot auth
//     ring). The env loop re-attempts up to 3 additional times (4 total) on
//     a retryable `network-error` / `rate-limited` / `provider-error`,
//     waiting 2s / 5s / 7s between attempts (Decision 4). A non-retryable
//     error (`retryable: false`) — e.g. OneDrive's deterministic
//     malformed-cursor `provider-error` — surfaces immediately without
//     consuming the budget. `auth-expired` is handled by the inner
//     `withAuthRefresh`; a post-refresh `auth-expired` reaching the env loop
//     is not in the retry set and surfaces terminal.

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import { withAuthRefresh } from "@ft5/fs-datasource-engine";
import type { DatasourceType } from "@ft5/ipc-contracts";

import type { CommandHandler } from "../ipc/server.js";

import { mapEngineEntryToFileEntry } from "./files-entry-mapping.js";
import { normalizeFilesError } from "./files-error-mapping.js";
import { isEnvironmentallyRetryable } from "./files-download.js";

// Fixed back-off schedule for the env-retry loop: the wait BEFORE attempt
// `n+1` (1-indexed by attempt boundary). 2000ms before attempt 2, 5000ms
// before attempt 3, 7000ms before attempt 4 — 4 attempts total, ~14s wall
// budget (Decision 4). `BACKOFFS_MS.length` is the retry count (3); attempt 1
// has no preceding wait.
const BACKOFFS_MS = [2000, 5000, 7000] as const;

// Hand-rolled delay promise — no new dependency (no p-retry). A bare
// `setTimeout` the test's fake timers can advance.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface FilesListDeps {
  readonly resolveClient: (
    datasourceId: string,
  ) => Promise<DatasourceClient<DatasourceType>>;
}

export function makeFilesListHandler(
  deps: FilesListDeps,
): CommandHandler<"files:list"> {
  return async (params) => {
    let client: DatasourceClient<DatasourceType>;
    try {
      client = await deps.resolveClient(params.datasourceId);
    } catch (err) {
      return { ok: false, error: normalizeFilesError(err) };
    }
    try {
      // Env-retry loop (OUTER) composed around withAuthRefresh (INNER,
      // one-shot). The inner wrap handles `auth-expired` (refresh once,
      // retry once); the outer loop handles retryable environmental
      // failures on a fixed schedule.
      const target = { kind: "path" as const, path: params.path };
      // Build the options per-key. Under `exactOptionalPropertyTypes` the
      // engine's bare-optional `{ cursor?: string; pageSize?: number }` cannot
      // receive an explicit `undefined`, so each field is set only when the
      // request carries it. Absent-key and undefined-value are
      // indistinguishable to the strategies (they check `=== undefined`, never
      // `'cursor' in options`), so the first-page call's observable behavior
      // matches the spec scenario's "cursor and pageSize are both undefined".
      const options: { cursor?: string; pageSize?: number } = {};
      if (params.cursor !== undefined) options.cursor = params.cursor;
      if (params.pageSize !== undefined) options.pageSize = params.pageSize;
      const callEngine = () =>
        withAuthRefresh(client, () => client.listDirectory(target, options));

      let attempt = 0;
      for (;;) {
        try {
          const { entries: engineEntries, nextCursor } = await callEngine();
          const entries = engineEntries.map(mapEngineEntryToFileEntry);
          return {
            ok: true,
            result: { entries, truncated: nextCursor !== null, nextCursor },
          };
        } catch (err) {
          // Retry only when the rejection is a retryable environmental
          // error AND the budget is not exhausted. `isEnvironmentallyRetryable`
          // gates on tag ∈ {network-error, rate-limited, provider-error} AND
          // `retryable === true` (and excludes `auth-expired`), so a
          // non-retryable `provider-error { retryable: false }` short-circuits
          // here without consuming the budget.
          if (attempt >= BACKOFFS_MS.length || !isEnvironmentallyRetryable(err)) {
            throw err;
          }
          const scheduled = BACKOFFS_MS[attempt]!;
          // For rate-limited rejections carrying retryAfterMs, honor
          // max(retryAfterMs, scheduledBackoff) for this attempt.
          const wait =
            err.tag === "rate-limited" && typeof err.retryAfterMs === "number"
              ? Math.max(err.retryAfterMs, scheduled)
              : scheduled;
          attempt += 1;
          await delay(wait);
        }
      }
    } catch (err) {
      // Exhaustion (final attempt rejected) or an immediate non-retryable
      // failure both land here → normalized to the wire envelope unchanged.
      return { ok: false, error: normalizeFilesError(err) };
    }
  };
}
