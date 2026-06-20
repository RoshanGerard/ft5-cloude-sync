import { describe, expect, it, vi } from "vitest";

import { DatasourceError, DatasourceErrorTag } from "@ft5/ipc-contracts";

import { withAuthRefresh } from "./with-auth-refresh.js";

// ---------------------------------------------------------------------------
// withAuthRefresh — the default, replaceable one-shot refresh-then-retry
// policy exported from @ft5/fs-datasource-engine
// (migrate-engine-retry-policy-to-consumer Decision 3).
//
// The helper is framework-agnostic: it only depends on the public
// `refreshCredentials()` primitive (via `Pick<DatasourceClient, …>`) and the
// exported `DatasourceError` class + `auth-expired` tag. These tests use a
// minimal fake client exposing only `refreshCredentials` to prove the helper
// never reaches for anything else on the client.
// ---------------------------------------------------------------------------

function authExpired(): DatasourceError<"amazon-s3"> {
  return new DatasourceError<"amazon-s3">({
    tag: DatasourceErrorTag.AuthExpired,
    datasourceType: "amazon-s3",
    datasourceId: "ds-1",
    retryable: false,
    message: "token expired",
  });
}

function networkError(): DatasourceError<"amazon-s3"> {
  return new DatasourceError<"amazon-s3">({
    tag: DatasourceErrorTag.NetworkError,
    datasourceType: "amazon-s3",
    datasourceId: "ds-1",
    retryable: true,
    message: "connection reset",
  });
}

describe("withAuthRefresh", () => {
  it("op throws auth-expired then succeeds → refreshCredentials called once, resolves with 2nd result", async () => {
    const refreshCredentials = vi.fn(async () => ({ accessToken: "fresh" }));
    let attempt = 0;
    const op = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw authExpired();
      return "second-result";
    });

    const result = await withAuthRefresh({ refreshCredentials }, op);

    expect(result).toBe("second-result");
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("op throws auth-expired twice → refreshCredentials called once, rejects with the 2nd error", async () => {
    const refreshCredentials = vi.fn(async () => ({ accessToken: "fresh" }));
    const errors = [authExpired(), authExpired()];
    let attempt = 0;
    const op = vi.fn(async () => {
      const err = errors[attempt];
      attempt += 1;
      throw err;
    });

    let caught: unknown;
    try {
      await withAuthRefresh({ refreshCredentials }, op);
    } catch (e) {
      caught = e;
    }

    // Rejects with the SECOND (retry) error — no third op call, no second refresh.
    expect(caught).toBe(errors[1]);
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("op throws a network-error-tagged DatasourceError → refreshCredentials NOT called, propagates immediately", async () => {
    const refreshCredentials = vi.fn(async () => ({ accessToken: "fresh" }));
    const err = networkError();
    const op = vi.fn(async () => {
      throw err;
    });

    let caught: unknown;
    try {
      await withAuthRefresh({ refreshCredentials }, op);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(err);
    expect(refreshCredentials).not.toHaveBeenCalled();
    // No retry — op invoked exactly once.
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("op throws a non-DatasourceError (raw) → refreshCredentials NOT called, propagates immediately", async () => {
    const refreshCredentials = vi.fn(async () => ({ accessToken: "fresh" }));
    const raw = new Error("not normalized");
    const op = vi.fn(async () => {
      throw raw;
    });

    let caught: unknown;
    try {
      await withAuthRefresh({ refreshCredentials }, op);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(raw);
    expect(refreshCredentials).not.toHaveBeenCalled();
    expect(op).toHaveBeenCalledTimes(1);
  });
});
