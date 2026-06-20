// Tests for `isEnvironmentallyRetryable` — the environmental-retry
// classification predicate (add-download-resilience §2 / §6.1, Decision 2).
// Moved from `commands/__tests__/files-download.test.ts` alongside the
// function's extraction to `util/retry-classification.ts`.

import { describe, it, expect } from "vitest";

import { DatasourceError, DatasourceErrorTag } from "@ft5/ipc-contracts";

import { isEnvironmentallyRetryable } from "../retry-classification.js";

describe("isEnvironmentallyRetryable (§6.1, Decision 2 four-clause AND)", () => {
  // Full Cartesian: every DatasourceErrorTag value × { retryable: true, false }.
  // The truth table per design.md Decision 2:
  //   - Returns TRUE iff err is DatasourceError AND tag in
  //     {network-error, rate-limited, provider-error} AND retryable === true
  //     AND tag !== "auth-expired" (defensive double-guard against future
  //     taxonomy expansion that adds a retryable=true auth-expired variant).
  //   - All other DatasourceError combinations return FALSE.
  //   - Non-DatasourceError values (Error, string, null, undefined, plain
  //     object) return FALSE.
  const tags = [
    "auth-expired",
    "auth-revoked",
    "not-found",
    "conflict",
    "unsupported",
    "rate-limited",
    "network-error",
    "provider-error",
    "cancelled",
    "invalid-datasource",
  ] as const;

  const allowlist = new Set([
    "network-error",
    "rate-limited",
    "provider-error",
  ]);

  for (const tag of tags) {
    for (const retryable of [true, false]) {
      const expected =
        retryable === true &&
        tag !== DatasourceErrorTag.AuthExpired &&
        allowlist.has(tag);
      it(`returns ${expected} for DatasourceError { tag: "${tag}", retryable: ${retryable} }`, () => {
        const err = new DatasourceError({
          tag,
          datasourceType: "google-drive",
          datasourceId: "ds-1",
          retryable,
        });
        expect(isEnvironmentallyRetryable(err)).toBe(expected);
      });
    }
  }

  it("explicitly: auth-expired with retryable=true returns false (excluded by clause 2 even if a future tag-mapping change put it in the allowlist)", () => {
    const err = new DatasourceError({
      tag: DatasourceErrorTag.AuthExpired,
      datasourceType: "google-drive",
      datasourceId: "ds-1",
      retryable: true,
    });
    expect(isEnvironmentallyRetryable(err)).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isEnvironmentallyRetryable(new Error("boom"))).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isEnvironmentallyRetryable("network-error")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isEnvironmentallyRetryable(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isEnvironmentallyRetryable(undefined)).toBe(false);
  });

  it("returns false for a plain object that mimics the shape", () => {
    expect(
      isEnvironmentallyRetryable({
        tag: DatasourceErrorTag.NetworkError,
        retryable: true,
      }),
    ).toBe(false);
  });
});
