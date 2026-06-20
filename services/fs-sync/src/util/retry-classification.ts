// Retry-classification predicate, shared across fs-sync command handlers.
//
// `isEnvironmentallyRetryable` decides whether a rejected engine operation is
// an *environmental* failure worth retrying (the "Layer 3" environmental
// retry per add-download-resilience design.md Decision 8). Both
// `files:download` and `files:list` gate their retry loops on it, so it lives
// here in `util/` rather than inside either command handler — extracted from
// `commands/files-download.ts` once `files:list` became the second consumer
// (the cross-handler import was the extract signal).
//
// Pure predicate over `unknown`; no I/O and no dependency beyond the engine's
// `DatasourceError` type.

import { DatasourceError, DatasourceErrorTag } from "@ft5/ipc-contracts";

/**
 * Predicate gating the environmental retry layer (Layer 3 per
 * add-download-resilience design.md Decision 8). Returns true iff the error is
 * a `DatasourceError` whose tag is in the strict allowlist `{network-error,
 * rate-limited, provider-error}`, the strategy marked it `retryable: true`,
 * AND the tag is not `auth-expired` (Layer 2's slot — never folded in).
 *
 * The four-clause AND is intentional. The `tag !== "auth-expired"` clause is
 * structurally redundant against the allowlist today, but it is a defensive
 * double-guard against future taxonomy expansion: if a strategy ever marked an
 * `auth-expired` instance retryable=true and a future mapping accidentally
 * added it to the allowlist, this guard still routes it to Layer 2. See
 * add-download-resilience design.md Decision 2.
 *
 * Strategy bugs (a non-retryable tag marked retryable=true) flow through to
 * terminal because the allowlist excludes them.
 */
export function isEnvironmentallyRetryable(
  err: unknown,
): err is DatasourceError {
  return (
    err instanceof DatasourceError &&
    err.tag !== DatasourceErrorTag.AuthExpired &&
    err.retryable === true &&
    (err.tag === DatasourceErrorTag.NetworkError ||
      err.tag === DatasourceErrorTag.RateLimited ||
      err.tag === DatasourceErrorTag.ProviderError)
  );
}
