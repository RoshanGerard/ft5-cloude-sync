// wire-fs-sync-service task 5.13 — handleSyncGetRetryPolicy [RED]
//
// Identity proxy over `SyncClient.getRetryPolicy`. Renderer
// `SyncGetRetryPolicyRequest` (`{ scope, datasourceId? }`) and wire
// `CommandParams<"sync:get-retry-policy">` are structurally identical,
// as are the renderer and wire result shapes (`{ policy: RetryPolicy }`).
// The handler forwards the request unchanged and returns the wire result
// unchanged.
//
// There is no renderer-observable error branch on this channel — every
// service-side failure (not-found, service-disconnected, …) re-throws so
// the IPC invoke rejects.
//
// Registration in `ipc/index.ts` is deferred to task 5.14.

import { describe, expect, it, vi } from "vitest";

import type { SyncGetRetryPolicyRequest } from "@ft5/ipc-contracts/sync-service-desktop";
import type { RetryPolicy } from "@ft5/ipc-contracts/sync-service";

import type { SyncClient } from "../../../sync/client.js";
import { SyncCommandError } from "../../../sync/client.js";
import { handleSyncGetRetryPolicy } from "../get-retry-policy.js";

function makeFakeClient(impl: (params: unknown) => Promise<unknown>): {
  client: SyncClient;
  getRetryPolicy: ReturnType<typeof vi.fn>;
} {
  const getRetryPolicy = vi.fn(impl);
  // Only `getRetryPolicy` is exercised by the handler. Cast via `unknown`
  // so the partial shape type-checks without pretending to implement the
  // full `SyncClient`.
  const client = { getRetryPolicy } as unknown as SyncClient;
  return { client, getRetryPolicy };
}

describe("handleSyncGetRetryPolicy", () => {
  it("proxies a global-scope request and returns the wire policy unchanged", async () => {
    const req: SyncGetRetryPolicyRequest = { scope: "global" };
    const wirePolicy: RetryPolicy = {
      scope: "global",
      datasourceId: null,
      maxAttempts: 5,
      backoffMs: 1000,
      backoffStrategy: "exponential",
      maxAgeMs: 60_000,
    };
    const { client, getRetryPolicy } = makeFakeClient(async () => ({
      policy: wirePolicy,
    }));

    const res = await handleSyncGetRetryPolicy(req, client);

    expect(getRetryPolicy).toHaveBeenCalledTimes(1);
    expect(getRetryPolicy).toHaveBeenCalledWith({ scope: "global" });
    expect(res).toEqual({ policy: wirePolicy });
  });

  it("proxies a datasource-scope request (scope + datasourceId) unchanged", async () => {
    const req: SyncGetRetryPolicyRequest = {
      scope: "datasource",
      datasourceId: "ds-7",
    };
    const wirePolicy: RetryPolicy = {
      scope: "datasource",
      datasourceId: "ds-7",
      maxAttempts: 3,
      backoffMs: 250,
      backoffStrategy: "fixed",
      maxAgeMs: null,
    };
    const { client, getRetryPolicy } = makeFakeClient(async () => ({
      policy: wirePolicy,
    }));

    const res = await handleSyncGetRetryPolicy(req, client);

    expect(getRetryPolicy).toHaveBeenCalledTimes(1);
    expect(getRetryPolicy).toHaveBeenCalledWith({
      scope: "datasource",
      datasourceId: "ds-7",
    });
    expect(res).toEqual({ policy: wirePolicy });
  });

  it("re-throws SyncCommandError failures (e.g. not-found)", async () => {
    const err = new SyncCommandError("sync:get-retry-policy", {
      tag: "not-found",
      message: "no policy for datasource",
    });
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncGetRetryPolicy(
        { scope: "datasource", datasourceId: "missing" },
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
      handleSyncGetRetryPolicy({ scope: "global" }, client),
    ).rejects.toBe(err);
  });
});
