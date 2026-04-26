// implement-datasource-onboarding §Prerequisite A — handleSyncAuthenticateStart
//
// Wraps `SyncClient.authenticateStart()` so the renderer-facing envelope
// `{ ok: true, result } | { ok: false, error }` is constructed at the
// desktop boundary. The wire `CommandResult<"sync:authenticate-start">`
// is the bare result; `SyncCommandError` from the client carries the
// wire's typed error union under `.raw`.
//
// Security invariant — credential ownership lives on the service.
// This handler:
//   - carries the request params straight through to the service,
//   - wraps the reply in the renderer's discriminated envelope without
//     mutating its content,
//   - does NOT persist, encrypt, cache, or inspect any credential
//     material.

import { describe, expect, it, vi } from "vitest";

import type {
  SyncAuthenticateStartRequest,
} from "@ft5/ipc-contracts/sync-service-desktop";
import type {
  SyncAuthenticateStartError,
} from "@ft5/ipc-contracts/sync-service";

import type { SyncClient } from "../../../sync/client.js";
import { SyncCommandError } from "../../../sync/client.js";
import { handleSyncAuthenticateStart } from "../authenticate-start.js";

function makeFakeClient(impl: (params: unknown) => Promise<unknown>): {
  client: SyncClient;
  authenticateStart: ReturnType<typeof vi.fn>;
} {
  const authenticateStart = vi.fn(impl);
  const client = { authenticateStart } as unknown as SyncClient;
  return { client, authenticateStart };
}

describe("handleSyncAuthenticateStart", () => {
  it("wraps an OAuth-kind result in {ok: true, result} envelope", async () => {
    const wireResult = {
      correlationId: "corr-oauth",
      kind: "oauth" as const,
    };
    const req: SyncAuthenticateStartRequest = {
      providerId: "google-drive",
    };
    const { client, authenticateStart } = makeFakeClient(
      async () => wireResult,
    );

    const res = await handleSyncAuthenticateStart(req, client);

    expect(authenticateStart).toHaveBeenCalledTimes(1);
    expect(authenticateStart).toHaveBeenCalledWith({
      providerId: "google-drive",
    });
    expect(res).toEqual({ ok: true, result: wireResult });
  });

  it("wraps a credentials-form result with formSchema verbatim", async () => {
    const wireResult = {
      correlationId: "corr-form",
      kind: "credentials-form" as const,
      formSchema: "aws-access-key" as const,
    };
    const { client } = makeFakeClient(async () => wireResult);

    const res = await handleSyncAuthenticateStart(
      { providerId: "amazon-s3" },
      client,
    );

    expect(res).toEqual({ ok: true, result: wireResult });
    if (res.ok) {
      expect(res.result.kind).toBe("credentials-form");
    }
  });

  it("does not mutate or rebuild the request — the client receives the same reference", async () => {
    const req: SyncAuthenticateStartRequest = {
      providerId: "google-drive",
      datasourceId: "ds-ref",
    };
    const { client, authenticateStart } = makeFakeClient(async () => ({
      correlationId: "corr-x",
      kind: "oauth" as const,
    }));

    await handleSyncAuthenticateStart(req, client);

    const [params] = authenticateStart.mock.calls[0]!;
    expect(params).toBe(req);
  });

  it("translates SyncCommandError to {ok: false, error} envelope", async () => {
    const wireError: SyncAuthenticateStartError = {
      tag: "service-config-missing",
      path: "/home/u/ft5/sync_app/config.json",
      providerId: "google-drive",
    };
    const err = new SyncCommandError("sync:authenticate-start", wireError);
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    const res = await handleSyncAuthenticateStart(
      { providerId: "google-drive" },
      client,
    );

    expect(res).toEqual({ ok: false, error: wireError });
  });

  it("translates engine-error tag through the envelope", async () => {
    const wireError: SyncAuthenticateStartError = {
      tag: "engine-error",
      message: "google-drive provider failed during authenticate",
    };
    const err = new SyncCommandError("sync:authenticate-start", wireError);
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    const res = await handleSyncAuthenticateStart(
      { providerId: "google-drive" },
      client,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.tag).toBe("engine-error");
  });

  it("re-throws non-SyncCommandError failures unchanged (e.g. service-disconnected)", async () => {
    const err = new Error("service-disconnected");
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncAuthenticateStart({ providerId: "amazon-s3" }, client),
    ).rejects.toBe(err);
  });
});
