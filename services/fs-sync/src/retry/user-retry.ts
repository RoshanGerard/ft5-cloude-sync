// User-level retry decision. Applies only to provider-error with
// retryable:true. Given the current attempt, createdAt, and the effective
// policy, decides whether to retry and with how long a backoff.
//
// Spec: "User-level retry policy for provider-error".

import { DatasourceErrorTag } from "@ft5/ipc-contracts";
import type { RetryPolicy } from "@ft5/ipc-contracts/sync-service";

export type UserRetryDecision =
  | {
      readonly branch: "retry";
      readonly delayMs: number;
    }
  | {
      readonly branch: "terminal";
      readonly reason: "not-retryable" | "max-attempts" | "max-age";
    };

export interface DecisionInputs {
  readonly errorTag: string;
  readonly retryable: boolean;
  readonly attempt: number;
  readonly createdAtMs: number;
  readonly now: number;
  readonly policy: RetryPolicy;
}

const TERMINAL_TAGS = new Set([
  "auth-revoked",
  "not-found",
  "conflict",
  "unsupported",
]);

export function decideUserRetry(inputs: DecisionInputs): UserRetryDecision {
  if (TERMINAL_TAGS.has(inputs.errorTag)) {
    return { branch: "terminal", reason: "not-retryable" };
  }
  if (inputs.errorTag !== DatasourceErrorTag.ProviderError) {
    // System-retry branch handles network-error / rate-limited / auth-expired.
    // Anything else is a tag we don't recognize — treat as terminal rather
    // than silently retry.
    return { branch: "terminal", reason: "not-retryable" };
  }
  if (!inputs.retryable) {
    return { branch: "terminal", reason: "not-retryable" };
  }
  if (inputs.attempt >= inputs.policy.maxAttempts) {
    return { branch: "terminal", reason: "max-attempts" };
  }
  if (
    inputs.policy.maxAgeMs != null &&
    inputs.now - inputs.createdAtMs >= inputs.policy.maxAgeMs
  ) {
    return { branch: "terminal", reason: "max-age" };
  }

  const delayMs =
    inputs.policy.backoffStrategy === "exponential"
      ? inputs.policy.backoffMs * 2 ** Math.max(0, inputs.attempt - 1)
      : inputs.policy.backoffMs;

  return { branch: "retry", delayMs };
}
