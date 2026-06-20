import { describe, expect, it } from "vitest";

import { DatasourceErrorTag } from "@ft5/ipc-contracts";

import { DEFAULT_POLICY } from "./policy-store.js";

import { decideUserRetry } from "./user-retry.js";

const NOW = 1_700_000_000_000;

const baseInputs = {
  errorTag: DatasourceErrorTag.ProviderError,
  retryable: true,
  attempt: 1,
  createdAtMs: NOW,
  now: NOW,
  policy: DEFAULT_POLICY,
};

describe("decideUserRetry", () => {
  it("retryable provider-error with attempt < maxAttempts → retry", () => {
    const r = decideUserRetry({ ...baseInputs, attempt: 1 });
    expect(r.branch).toBe("retry");
    if (r.branch === "retry") expect(r.delayMs).toBeGreaterThan(0);
  });

  it("retryable=false → terminal not-retryable", () => {
    const r = decideUserRetry({ ...baseInputs, retryable: false });
    expect(r).toEqual({ branch: "terminal", reason: "not-retryable" });
  });

  it.each(["auth-revoked", "not-found", "conflict", "unsupported"])(
    "terminal tag %s → terminal not-retryable regardless of retryable:true",
    (tag) => {
      const r = decideUserRetry({ ...baseInputs, errorTag: tag });
      expect(r).toEqual({ branch: "terminal", reason: "not-retryable" });
    },
  );

  it("attempt >= maxAttempts → terminal max-attempts", () => {
    const r = decideUserRetry({
      ...baseInputs,
      attempt: DEFAULT_POLICY.maxAttempts,
    });
    expect(r).toEqual({ branch: "terminal", reason: "max-attempts" });
  });

  it("now - createdAt >= maxAgeMs → terminal max-age", () => {
    const r = decideUserRetry({
      ...baseInputs,
      policy: { ...DEFAULT_POLICY, maxAgeMs: 1000 },
      now: NOW + 1500,
    });
    expect(r).toEqual({ branch: "terminal", reason: "max-age" });
  });

  it("exponential backoff: attempt 1 → base, attempt 2 → base*2, attempt 3 → base*4", () => {
    const p = {
      ...DEFAULT_POLICY,
      backoffMs: 100,
      backoffStrategy: "exponential" as const,
      maxAttempts: 10,
    };
    const r1 = decideUserRetry({ ...baseInputs, attempt: 1, policy: p });
    const r2 = decideUserRetry({ ...baseInputs, attempt: 2, policy: p });
    const r3 = decideUserRetry({ ...baseInputs, attempt: 3, policy: p });
    if (r1.branch !== "retry" || r2.branch !== "retry" || r3.branch !== "retry")
      throw new Error("expected retry");
    expect(r1.delayMs).toBe(100);
    expect(r2.delayMs).toBe(200);
    expect(r3.delayMs).toBe(400);
  });

  it("fixed backoff: every attempt uses backoffMs unchanged", () => {
    const p = {
      ...DEFAULT_POLICY,
      backoffMs: 100,
      backoffStrategy: "fixed" as const,
      maxAttempts: 5,
    };
    for (const a of [1, 2, 3, 4]) {
      const r = decideUserRetry({ ...baseInputs, attempt: a, policy: p });
      if (r.branch === "retry") expect(r.delayMs).toBe(100);
    }
  });

  it("network-error falls through to terminal here (system-retry owns it)", () => {
    const r = decideUserRetry({ ...baseInputs, errorTag: DatasourceErrorTag.NetworkError });
    expect(r.branch).toBe("terminal");
  });
});
