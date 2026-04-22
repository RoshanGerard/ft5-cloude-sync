// wire-fs-sync-service task 5.13 — handleSyncSetRetryPolicy [RED]
//
// Identity proxy over `SyncClient.setRetryPolicy`. Renderer
// `SyncSetRetryPolicyRequest` and wire
// `CommandParams<"sync:set-retry-policy">` are structurally identical
// (`{ scope, datasourceId?, maxAttempts, backoffMs, backoffStrategy,
// maxAgeMs? }`), as are the result shapes (`{ policy: RetryPolicy }`).
// The handler forwards the request unchanged and returns the wire
// result unchanged.
//
// There is no renderer-observable error branch on this channel — every
// service-side failure (validation-error, service-disconnected, …)
// re-throws so the IPC invoke rejects.
//
// Registration in `ipc/index.ts` is deferred to task 5.14.

import { describe, expect, it, vi } from "vitest";

import type { SyncSetRetryPolicyRequest } from "@ft5/ipc-contracts/sync-service-desktop";
import type { RetryPolicy } from "@ft5/ipc-contracts/sync-service";

import type { SyncClient } from "../../../sync/client.js";
import { SyncCommandError } from "../../../sync/client.js";
import { handleSyncSetRetryPolicy } from "../set-retry-policy.js";

function makeFakeClient(impl: (params: unknown) => Promise<unknown>): {
  client: SyncClient;
  setRetryPolicy: ReturnType<typeof vi.fn>;
} {
  const setRetryPolicy = vi.fn(impl);
  // Only `setRetryPolicy` is exercised by the handler. Cast via `unknown`
  // so the partial shape type-checks without pretending to implement the
  // full `SyncClient`.
  const client = { setRetryPolicy } as unknown as SyncClient;
  return { client, setRetryPolicy };
}

describe("handleSyncSetRetryPolicy", () => {
  it("proxies a global-scope policy unchanged and returns the wire policy", async () => {
    const req: SyncSetRetryPolicyRequest = {
      scope: "global",
      maxAttempts: 7,
      backoffMs: 500,
      backoffStrategy: "exponential",
      maxAgeMs: 120_000,
    };
    const wirePolicy: RetryPolicy = {
      scope: "global",
      datasourceId: null,
      maxAttempts: 7,
      backoffMs: 500,
      backoffStrategy: "exponential",
      maxAgeMs: 120_000,
    };
    const { client, setRetryPolicy } = makeFakeClient(async () => ({
      policy: wirePolicy,
    }));

    const res = await handleSyncSetRetryPolicy(req, client);

    expect(setRetryPolicy).toHaveBeenCalledTimes(1);
    // Deep structural equality of the argument the fake receives —
    // pins that the payload is passed through unchanged.
    expect(setRetryPolicy).toHaveBeenCalledWith({
      scope: "global",
      maxAttempts: 7,
      backoffMs: 500,
      backoffStrategy: "exponential",
      maxAgeMs: 120_000,
    });
    expect(res).toEqual({ policy: wirePolicy });
  });

  it("proxies a datasource-scope policy (including datasourceId) unchanged", async () => {
    const req: SyncSetRetryPolicyRequest = {
      scope: "datasource",
      datasourceId: "ds-9",
      maxAttempts: 3,
      backoffMs: 250,
      backoffStrategy: "fixed",
    };
    const wirePolicy: RetryPolicy = {
      scope: "datasource",
      datasourceId: "ds-9",
      maxAttempts: 3,
      backoffMs: 250,
      backoffStrategy: "fixed",
      maxAgeMs: null,
    };
    const { client, setRetryPolicy } = makeFakeClient(async () => ({
      policy: wirePolicy,
    }));

    const res = await handleSyncSetRetryPolicy(req, client);

    expect(setRetryPolicy).toHaveBeenCalledTimes(1);
    expect(setRetryPolicy).toHaveBeenCalledWith({
      scope: "datasource",
      datasourceId: "ds-9",
      maxAttempts: 3,
      backoffMs: 250,
      backoffStrategy: "fixed",
    });
    expect(res).toEqual({ policy: wirePolicy });
  });

  it("re-throws SyncCommandError failures (e.g. validation-error)", async () => {
    const err = new SyncCommandError("sync:set-retry-policy", {
      tag: "validation-error",
      message: "maxAttempts must be >= 1",
    });
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncSetRetryPolicy(
        {
          scope: "global",
          maxAttempts: 0,
          backoffMs: 100,
          backoffStrategy: "fixed",
        },
        client,
      ),
    ).rejects.toBe(err);
  });

  it("re-throws non-SyncCommandError failures (e.g. service-disconnected)", async () => {
    const err = new Error("service-disconnected");
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncSetRetryPolicy(
        {
          scope: "global",
          maxAttempts: 3,
          backoffMs: 100,
          backoffStrategy: "fixed",
        },
        client,
      ),
    ).rejects.toBe(err);
  });
});
