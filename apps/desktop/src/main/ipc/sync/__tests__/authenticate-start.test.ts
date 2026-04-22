// wire-fs-sync-service task 5.A.13 — handleSyncAuthenticateStart [RED]
//
// Identity proxy over `SyncClient.authenticateStart`. Replaces half of
// the old single-shot `handleSyncAuthenticate`: see design.md Decision 10
// (two-step authenticate split — the start call returns a pure-data
// `SerializableAuthIntent` + a correlation id), and Decision 11 (the
// service-side handler currently ships as a stub that returns
// `{ tag: "not-implemented" }`; that's expected passthrough for this
// subagent's scope).
//
// Security invariant (design.md "Decision 1 — Credential ownership"):
// the desktop handler MUST NOT touch fs, safeStorage, keytar, encrypt
// anything, or otherwise persist / inspect credential-adjacent data.
// This handler simply forwards the renderer request to the service
// client and returns the reply untouched. The reference-identity test
// below pins that the request object is forwarded as-is.

import { describe, expect, it, vi } from "vitest";

import type {
  SyncAuthenticateStartRequest,
  SyncAuthenticateStartResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../../sync/client.js";
import { SyncCommandError } from "../../../sync/client.js";
import { handleSyncAuthenticateStart } from "../authenticate-start.js";

function makeFakeClient(impl: (params: unknown) => Promise<unknown>): {
  client: SyncClient;
  authenticateStart: ReturnType<typeof vi.fn>;
} {
  const authenticateStart = vi.fn(impl);
  // Only `authenticateStart` is exercised by the handler. Cast via
  // `unknown` so the partial shape type-checks without pretending to
  // implement the full `SyncClient`.
  const client = { authenticateStart } as unknown as SyncClient;
  return { client, authenticateStart };
}

describe("handleSyncAuthenticateStart", () => {
  it("proxies to client.authenticateStart with the wire params and returns the wire response", async () => {
    const wireResponse: SyncAuthenticateStartResponse = {
      correlationId: "corr-1",
      intent: {
        kind: "oauth",
        authorizeUrl: "https://provider.example/authorize?state=xyz",
      },
    };
    const req: SyncAuthenticateStartRequest = {
      datasourceId: "ds-1",
      type: "amazon-s3",
    };
    const { client, authenticateStart } = makeFakeClient(
      async () => wireResponse,
    );

    const res = await handleSyncAuthenticateStart(req, client);

    expect(authenticateStart).toHaveBeenCalledTimes(1);
    expect(authenticateStart).toHaveBeenCalledWith({
      datasourceId: "ds-1",
      type: "amazon-s3",
    });
    expect(res).toEqual(wireResponse);
  });

  it("returns an OAuth intent untouched (authorizeUrl passes through verbatim)", async () => {
    // The service's success reply carries a `SerializableAuthIntent`
    // — OAuth case is `{ kind: "oauth", authorizeUrl }`. The handler
    // must return it byte-for-byte so the renderer observes exactly
    // what the service produced (no reshape, no wrapping).
    const wireResponse: SyncAuthenticateStartResponse = {
      correlationId: "corr-oauth",
      intent: {
        kind: "oauth",
        authorizeUrl: "https://example.com/auth",
      },
    };
    const { client } = makeFakeClient(async () => wireResponse);

    const res = await handleSyncAuthenticateStart(
      { datasourceId: "ds-oauth", type: "amazon-s3" },
      client,
    );

    expect(res).toEqual(wireResponse);
    expect(res.intent).toEqual({
      kind: "oauth",
      authorizeUrl: "https://example.com/auth",
    });
  });

  it("does not mutate or rebuild the request — the client receives the same reference", async () => {
    // Credential-ownership invariant: whatever the renderer hands us,
    // we hand the service. No cloning, no normalisation, no field
    // stripping. Pin this by reference-identity so a future refactor
    // that silently rebuilds the request fails loudly.
    const req: SyncAuthenticateStartRequest = {
      datasourceId: "ds-ref",
      type: "amazon-s3",
    };
    const { client, authenticateStart } = makeFakeClient(async () => ({
      correlationId: "corr-x",
      intent: { kind: "oauth", authorizeUrl: "https://x" },
    }));

    await handleSyncAuthenticateStart(req, client);

    const [params] = authenticateStart.mock.calls[0]!;
    expect(params).toBe(req);
  });

  it("re-throws a SyncCommandError with tag 'not-implemented' unchanged", async () => {
    // Decision 11 — the service-side handler returns not-implemented
    // while the follow-up change is pending. The desktop must forward
    // the rejection verbatim so the renderer surfaces it as an invoke
    // failure; there is no wrapping or translation here.
    const err = new SyncCommandError("sync:authenticate-start", {
      tag: "not-implemented",
      message:
        "authenticate flow pending follow-up change (see design.md Decision 11)",
    });
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncAuthenticateStart(
        { datasourceId: "ds-1", type: "amazon-s3" },
        client,
      ),
    ).rejects.toBe(err);
  });

  it("re-throws non-SyncCommandError failures unchanged (e.g. service-disconnected)", async () => {
    const err = new Error("service-disconnected");
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncAuthenticateStart(
        { datasourceId: "ds-1", type: "amazon-s3" },
        client,
      ),
    ).rejects.toBe(err);
  });
});
