// System-level retry classifier. Non-configurable by user policy.
//
// Per design.md D12:
//   network-error → waiting-network (scheduler arms the probe)
//   rate-limited  → wait retryAfterMs (or default 5000ms) then ONE retry
//   auth-expired  → passthrough (engine's BaseDatasourceClient refreshes
//                  single-flight; the scheduler should never see this tag
//                  in a finalized executor result because the engine
//                  resolves it internally. If we DO see it, treat as a
//                  transient provider-error and let user-retry handle it.)
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
  // auth-expired: the engine resolves internally. If it bubbles up here
  // (unexpected), fall through to terminal — user retry may intervene.
  return { branch: "terminal" };
}
