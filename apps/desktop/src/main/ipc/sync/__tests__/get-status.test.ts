// wire-fs-sync-service task 5.13 — handleSyncGetStatus [RED]
//
// Near-identity proxy over `SyncClient.getStatus`. The renderer-facing
// `SyncGetStatusRequest` is `void` (no params) and the wire params shape
// is `Record<string, never>` — the handler passes an empty object through.
//
// Shape difference: the wire result exposes `monitorConnected: boolean`
// which is NOT part of the renderer `SyncGetStatusResponse`. The handler
// projects the wire result down to the renderer-visible fields
// (`version`, `serviceUuid`, `runningJobs`, `queuedJobs`,
// `waitingNetworkJobs`) and drops the service-internal flag. This is the
// only deviation from pure identity — flagged in the GREEN commit too.
//
// Registration in `ipc/index.ts` is deferred to task 5.14.

import { describe, expect, it, vi } from "vitest";

import type { SyncClient } from "../../../sync/client.js";
import { SyncCommandError } from "../../../sync/client.js";
import { handleSyncGetStatus } from "../get-status.js";

function makeFakeClient(impl: (params: unknown) => Promise<unknown>): {
  client: SyncClient;
  getStatus: ReturnType<typeof vi.fn>;
} {
  const getStatus = vi.fn(impl);
  // Only `getStatus` is exercised by the handler. Cast via `unknown`
  // so the partial shape type-checks without pretending to implement
  // the full `SyncClient`.
  const client = { getStatus } as unknown as SyncClient;
  return { client, getStatus };
}

describe("handleSyncGetStatus", () => {
  it("invokes client.getStatus with an empty params object and returns renderer-visible fields", async () => {
    const wireResult = {
      version: "1.2.3",
      serviceUuid: "svc-uuid-1",
      runningJobs: 2,
      queuedJobs: 5,
      waitingNetworkJobs: 1,
      monitorConnected: true,
    } as const;
    const { client, getStatus } = makeFakeClient(async () => wireResult);

    const res = await handleSyncGetStatus(undefined, client);

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledWith({});
    // `monitorConnected` is dropped — it is a wire-level diagnostic not
    // part of the renderer-facing contract.
    expect(res).toEqual({
      version: "1.2.3",
      serviceUuid: "svc-uuid-1",
      runningJobs: 2,
      queuedJobs: 5,
      waitingNetworkJobs: 1,
    });
    expect((res as Record<string, unknown>).monitorConnected).toBeUndefined();
  });

  it("re-throws SyncCommandError failures", async () => {
    const err = new SyncCommandError("sync:get-status", {
      tag: "internal-error",
      message: "boom",
    });
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(handleSyncGetStatus(undefined, client)).rejects.toBe(err);
  });

  it("re-throws non-SyncCommandError failures (e.g. service-disconnected)", async () => {
    const err = new Error("service-disconnected");
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(handleSyncGetStatus(undefined, client)).rejects.toBe(err);
  });
});
