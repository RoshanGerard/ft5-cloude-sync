// wire-fs-sync-service task 5.A.13 — handleSyncAuthenticateComplete [RED]
//
// Identity proxy over `SyncClient.authenticateComplete`. Replaces the
// second half of the old single-shot `handleSyncAuthenticate`: see
// design.md Decision 10 (two-step authenticate split — complete posts
// the user's OAuth `code` or credentials-form `values` against the
// correlation id returned by the matching start call), and Decision 11
// (the service-side handler currently ships as a stub that returns
// `{ tag: "not-implemented" }`; that is expected passthrough for this
// subagent's scope).
//
// Security invariant (design.md "Decision 1 — Credential ownership"):
// the desktop handler MUST NOT touch fs, safeStorage, keytar, encrypt
// anything, or otherwise persist / inspect credential-adjacent data.
// This handler forwards the renderer request to the service client and
// returns the reply untouched. The reference-identity test below pins
// that the request object is forwarded as-is.

import { describe, expect, it, vi } from "vitest";

import type { AuthResult } from "@ft5/ipc-contracts";
import type {
  SyncAuthenticateCompleteRequest,
  SyncAuthenticateCompleteResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../../sync/client.js";
import { SyncCommandError } from "../../../sync/client.js";
import { handleSyncAuthenticateComplete } from "../authenticate-complete.js";

function makeFakeClient(impl: (params: unknown) => Promise<unknown>): {
  client: SyncClient;
  authenticateComplete: ReturnType<typeof vi.fn>;
} {
  const authenticateComplete = vi.fn(impl);
  // Only `authenticateComplete` is exercised by the handler. Cast via
  // `unknown` so the partial shape type-checks without pretending to
  // implement the full `SyncClient`.
  const client = { authenticateComplete } as unknown as SyncClient;
  return { client, authenticateComplete };
}

describe("handleSyncAuthenticateComplete", () => {
  it("proxies an OAuth completion (kind: 'oauth', code) to client.authenticateComplete and returns the wire authResult", async () => {
    const wireAuthResult: AuthResult = {
      accessToken: "svc-issued-token",
      refreshToken: "svc-refresh",
      expiresAt: 1_700_000_000,
      meta: { tenant: "t-1" },
    };
    const wireResponse: SyncAuthenticateCompleteResponse = {
      authResult: wireAuthResult,
    };
    const req: SyncAuthenticateCompleteRequest = {
      correlationId: "corr-oauth",
      completion: { kind: "oauth", code: "auth-code-from-browser" },
    };
    const { client, authenticateComplete } = makeFakeClient(
      async () => wireResponse,
    );

    const res = await handleSyncAuthenticateComplete(req, client);

    expect(authenticateComplete).toHaveBeenCalledTimes(1);
    expect(authenticateComplete).toHaveBeenCalledWith({
      correlationId: "corr-oauth",
      completion: { kind: "oauth", code: "auth-code-from-browser" },
    });
    expect(res).toEqual(wireResponse);
  });

  it("proxies a credentials-form completion (kind: 'credentials-form', values) to client.authenticateComplete and returns the wire authResult", async () => {
    const wireAuthResult: AuthResult = { accessToken: "svc-issued-form-token" };
    const wireResponse: SyncAuthenticateCompleteResponse = {
      authResult: wireAuthResult,
    };
    const req: SyncAuthenticateCompleteRequest = {
      correlationId: "corr-form",
      completion: {
        kind: "credentials-form",
        values: { accessKeyId: "AKIA...", secretAccessKey: "secret..." },
      },
    };
    const { client, authenticateComplete } = makeFakeClient(
      async () => wireResponse,
    );

    const res = await handleSyncAuthenticateComplete(req, client);

    expect(authenticateComplete).toHaveBeenCalledTimes(1);
    expect(authenticateComplete).toHaveBeenCalledWith({
      correlationId: "corr-form",
      completion: {
        kind: "credentials-form",
        values: { accessKeyId: "AKIA...", secretAccessKey: "secret..." },
      },
    });
    expect(res).toEqual(wireResponse);
  });

  it("does not mutate or rebuild the request — the client receives the same reference", async () => {
    // Credential-ownership invariant: whatever the renderer hands us,
    // we hand the service. Pin by reference-identity so a future
    // refactor that silently rebuilds the request fails loudly. This
    // matters doubly for `credentials-form` — those `values` carry raw
    // credential material that must not be cloned / inspected / logged
    // on the desktop side.
    const req: SyncAuthenticateCompleteRequest = {
      correlationId: "corr-ref",
      completion: {
        kind: "credentials-form",
        values: { accessKeyId: "AKIA...", secretAccessKey: "secret..." },
      },
    };
    const { client, authenticateComplete } = makeFakeClient(async () => ({
      authResult: { accessToken: "tok" },
    }));

    await handleSyncAuthenticateComplete(req, client);

    const [params] = authenticateComplete.mock.calls[0]!;
    expect(params).toBe(req);
  });

  it("re-throws a SyncCommandError with tag 'not-implemented' unchanged", async () => {
    // Decision 11 — the service-side handler returns not-implemented
    // while the follow-up change is pending. The desktop must forward
    // the rejection verbatim so the renderer surfaces it as an invoke
    // failure; there is no wrapping or translation here.
    const err = new SyncCommandError("sync:authenticate-complete", {
      tag: "not-implemented",
      message:
        "authenticate flow pending follow-up change (see design.md Decision 11)",
    });
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncAuthenticateComplete(
        {
          correlationId: "corr-1",
          completion: { kind: "oauth", code: "code-x" },
        },
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
      handleSyncAuthenticateComplete(
        {
          correlationId: "corr-1",
          completion: { kind: "oauth", code: "code-x" },
        },
        client,
      ),
    ).rejects.toBe(err);
  });
});
