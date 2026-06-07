// System-level retry classifier. Non-configurable by user policy.
//
// Per design.md D12:
//   network-error → waiting-network (scheduler arms the probe)
//   rate-limited  → wait retryAfterMs (or default 5000ms) then ONE retry
//   auth-expired  → passthrough (per migrate-engine-retry-policy-to-consumer
//                  the engine NO LONGER auto-refreshes; the mirror-sync
//                  executor wraps its engine calls in `withAuthRefresh`
//                  (refresh once, retry once), so a refreshable token is
//                  resolved before the executor result finalizes. If
//                  auth-expired DOES bubble up here it is a post-refresh
//                  dead token → terminal; the scheduler does not intercept.)
//   everything else → terminal (user-retry may still kick in — see
//                     phase 13)

export type SystemRetryBranch =
  | {
      readonly branch: "waiting-network";
    }
  | {
      readonly branch: "retry-after";
      readonly retryAfterMs: number;
    }
  | {
      readonly branch: "terminal";
    };

export function classifySystemRetry(
  errorTag: string,
  retryAfterMs?: number,
): SystemRetryBranch {
  if (errorTag === "network-error") {
    return { branch: "waiting-network" };
  }
  if (errorTag === "rate-limited") {
    return {
      branch: "retry-after",
      retryAfterMs: retryAfterMs ?? 5000,
    };
  }
  // auth-expired: the mirror-sync executor refreshes via `withAuthRefresh`
  // before the result finalizes (engine no longer auto-refreshes). If it
  // bubbles up here it is a post-refresh dead token → fall through to terminal.
  return { branch: "terminal" };
}
