// implement-datasource-onboarding §Prerequisite A — handleSyncAuthenticateComplete
//
// Wraps `SyncClient.authenticateComplete()` so the renderer-facing envelope
// `{ ok: true, result } | { ok: false, error }` is constructed at the
// desktop boundary. Per design Decision 7 only credentials-form completions
// cross the wire — OAuth completions land on the service's loopback HTTP
// listener and never reach this handler.
//
// Security invariant — credential ownership lives on the service.
// The handler forwards values verbatim and never inspects, persists, or
// logs the credentials.

import { describe, expect, it, vi } from "vitest";

import type { DatasourceSummary } from "@ft5/ipc-contracts";
import type {
  SyncAuthenticateCompleteRequest,
} from "@ft5/ipc-contracts/sync-service-desktop";
import type {
  SyncAuthenticateCompleteError,
} from "@ft5/ipc-contracts/sync-service";

import type { SyncClient } from "../../../sync/client.js";
import { SyncCommandError } from "../../../sync/client.js";
import { handleSyncAuthenticateComplete } from "../authenticate-complete.js";

function makeFakeClient(impl: (params: unknown) => Promise<unknown>): {
  client: SyncClient;
  authenticateComplete: ReturnType<typeof vi.fn>;
} {
  const authenticateComplete = vi.fn(impl);
  const client = { authenticateComplete } as unknown as SyncClient;
  return { client, authenticateComplete };
}

const FIXTURE_SUMMARY: DatasourceSummary = {
  id: "ds-form",
  providerId: "amazon-s3",
  displayName: "S3 bucket",
  status: "connected",
  errorReason: null,
  errorKind: null,
  paused: false,
  lastSyncAt: null,
  itemCount: 0,
};

describe("handleSyncAuthenticateComplete", () => {
  it("wraps a credentials-form completion result in {ok: true, result} envelope", async () => {
    const wireResult = {
      datasourceId: "ds-form",
      summary: FIXTURE_SUMMARY,
    };
    const req: SyncAuthenticateCompleteRequest = {
      correlationId: "corr-form",
      completion: {
        kind: "credentials-form",
        values: {
          accessKeyId: "FIXTURE-access-key-id",
          secretAccessKey: "FIXTURE-secret-access-key",
        },
      },
    };
    const { client, authenticateComplete } = makeFakeClient(
      async () => wireResult,
    );

    const res = await handleSyncAuthenticateComplete(req, client);

    expect(authenticateComplete).toHaveBeenCalledTimes(1);
    expect(authenticateComplete).toHaveBeenCalledWith(req);
    expect(res).toEqual({ ok: true, result: wireResult });
  });

  it("does not mutate or rebuild the request — the client receives the same reference", async () => {
    const req: SyncAuthenticateCompleteRequest = {
      correlationId: "corr-ref",
      completion: {
        kind: "credentials-form",
        values: {
          accessKeyId: "FIXTURE-access-key-id",
          secretAccessKey: "FIXTURE-secret-access-key",
        },
      },
    };
    const { client, authenticateComplete } = makeFakeClient(async () => ({
      datasourceId: "ds-x",
      summary: FIXTURE_SUMMARY,
    }));

    await handleSyncAuthenticateComplete(req, client);

    const [params] = authenticateComplete.mock.calls[0]!;
    expect(params).toBe(req);
  });

  it("translates SyncCommandError(correlation-expired) to {ok: false, error} envelope", async () => {
    const wireError: SyncAuthenticateCompleteError = {
      tag: "correlation-expired",
      correlationId: "corr-stale",
    };
    const err = new SyncCommandError("sync:authenticate-complete", wireError);
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    const res = await handleSyncAuthenticateComplete(
      {
        correlationId: "corr-stale",
        completion: {
          kind: "credentials-form",
          values: {},
        },
      },
      client,
    );

    expect(res).toEqual({ ok: false, error: wireError });
  });

  it("translates intent-kind-mismatch tag through the envelope", async () => {
    const wireError: SyncAuthenticateCompleteError = {
      tag: "intent-kind-mismatch",
      expected: "oauth",
      actual: "credentials-form",
    };
    const err = new SyncCommandError("sync:authenticate-complete", wireError);
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    const res = await handleSyncAuthenticateComplete(
      {
        correlationId: "corr-1",
        completion: {
          kind: "credentials-form",
          values: {},
        },
      },
      client,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.tag).toBe("intent-kind-mismatch");
  });

  it("re-throws non-SyncCommandError failures unchanged (e.g. service-disconnected)", async () => {
    const err = new Error("service-disconnected");
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncAuthenticateComplete(
        {
          correlationId: "corr-1",
          completion: {
            kind: "credentials-form",
            values: {},
          },
        },
        client,
      ),
    ).rejects.toBe(err);
  });
});
