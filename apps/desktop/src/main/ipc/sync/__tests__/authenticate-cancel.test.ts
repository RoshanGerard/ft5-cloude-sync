// implement-datasource-onboarding §Prerequisite A — handleSyncAuthenticateCancel
//
// Wraps `SyncClient.authenticateCancel()` so the renderer-facing envelope
// `{ ok: true, result } | { ok: false, error }` is constructed at the
// desktop boundary. Cancel is idempotent at the service: a second call
// returns `{ cancelled: false }` rather than erroring.

import { describe, expect, it, vi } from "vitest";

import type {
  SyncAuthenticateCancelRequest,
} from "@ft5/ipc-contracts/sync-service-desktop";
import type {
  SyncAuthenticateCancelError,
} from "@ft5/ipc-contracts/sync-service";

import type { SyncClient } from "../../../sync/client.js";
import { SyncCommandError } from "../../../sync/client.js";
import { handleSyncAuthenticateCancel } from "../authenticate-cancel.js";

function makeFakeClient(impl: (params: unknown) => Promise<unknown>): {
  client: SyncClient;
  authenticateCancel: ReturnType<typeof vi.fn>;
} {
  const authenticateCancel = vi.fn(impl);
  const client = { authenticateCancel } as unknown as SyncClient;
  return { client, authenticateCancel };
}

describe("handleSyncAuthenticateCancel", () => {
  it("wraps a {cancelled: true} result in the success envelope", async () => {
    const req: SyncAuthenticateCancelRequest = { correlationId: "corr-1" };
    const { client, authenticateCancel } = makeFakeClient(async () => ({
      cancelled: true,
    }));

    const res = await handleSyncAuthenticateCancel(req, client);

    expect(authenticateCancel).toHaveBeenCalledTimes(1);
    expect(authenticateCancel).toHaveBeenCalledWith({
      correlationId: "corr-1",
    });
    expect(res).toEqual({ ok: true, result: { cancelled: true } });
  });

  it("wraps idempotent {cancelled: false} (already terminal) in success envelope", async () => {
    const { client } = makeFakeClient(async () => ({ cancelled: false }));

    const res = await handleSyncAuthenticateCancel(
      { correlationId: "corr-already-done" },
      client,
    );

    expect(res).toEqual({ ok: true, result: { cancelled: false } });
  });

  it("translates SyncCommandError to {ok: false, error} envelope", async () => {
    const wireError: SyncAuthenticateCancelError = {
      tag: "correlation-not-found",
      correlationId: "corr-bad",
    };
    const err = new SyncCommandError("sync:authenticate-cancel", wireError);
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    const res = await handleSyncAuthenticateCancel(
      { correlationId: "corr-bad" },
      client,
    );

    expect(res).toEqual({ ok: false, error: wireError });
  });

  it("re-throws non-SyncCommandError failures (e.g. service-disconnected)", async () => {
    const err = new Error("service-disconnected");
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncAuthenticateCancel({ correlationId: "corr-x" }, client),
    ).rejects.toBe(err);
  });
});
