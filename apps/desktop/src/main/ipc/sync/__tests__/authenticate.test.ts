// wire-fs-sync-service task 5.11 — handleSyncAuthenticate [RED]
//
// Identity proxy over `SyncClient.authenticate`. The renderer-facing
// response is flat `{ authResult: AuthResult }` — there is NO structured
// `{ result } | { error }` union here: per the hybrid typing decision in
// `requests.ts`, only `enqueueMirror` and `cancelJob` expose fallible
// wire outcomes as renderer-observable error branches. All failures
// from `sync:authenticate` (validation-error, authentication-failed,
// service-disconnected, …) re-throw so the IPC invoke rejects.
//
// Security invariant (see wire-fs-sync-service design.md "Decision 1 —
// Credential ownership"): the handler MUST carry the intent to the
// service unchanged and return the service's reply unchanged. The
// desktop must never persist, encrypt, stash, or log any token or
// credential. That invariant is enforced here by the "no mutation"
// assertion — the exact same intent reference the handler receives is
// the reference passed to the client, and the exact same authResult the
// client returns is the value the handler returns.

import { describe, expect, it, vi } from "vitest";

import type {
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  OAuthIntent,
} from "@ft5/ipc-contracts";
import type { SyncAuthenticateRequest } from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../../sync/client.js";
import { SyncCommandError } from "../../../sync/client.js";
import { handleSyncAuthenticate } from "../authenticate.js";

function makeFakeClient(impl: (params: unknown) => Promise<unknown>): {
  client: SyncClient;
  authenticate: ReturnType<typeof vi.fn>;
} {
  const authenticate = vi.fn(impl);
  // Only `authenticate` is exercised by the handler. Cast via `unknown`
  // so the partial shape type-checks without pretending to implement
  // the full `SyncClient`.
  const client = { authenticate } as unknown as SyncClient;
  return { client, authenticate };
}

describe("handleSyncAuthenticate", () => {
  it("proxies an OAuth intent to client.authenticate and returns the wire authResult", async () => {
    const oauthIntent: OAuthIntent = {
      kind: "oauth",
      authorizeUrl: "https://provider.example/authorize?state=xyz",
      completeWith: async () => ({ accessToken: "should-not-be-observed" }),
    };
    const req: SyncAuthenticateRequest = {
      datasourceId: "ds-1",
      type: "s3",
      intent: oauthIntent,
    };
    const wireAuthResult: AuthResult = {
      accessToken: "svc-issued-token",
      refreshToken: "svc-refresh",
      expiresAt: 1_700_000_000,
      meta: { tenant: "t-1" },
    };
    const { client, authenticate } = makeFakeClient(async () => ({
      authResult: wireAuthResult,
    }));

    const res = await handleSyncAuthenticate(req, client);

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith({
      datasourceId: "ds-1",
      type: "s3",
      intent: oauthIntent,
    });
    expect(res).toEqual({ authResult: wireAuthResult });
  });

  it("proxies a credentials-form intent to client.authenticate and returns the wire authResult", async () => {
    const formIntent: CredentialsFormIntent = {
      kind: "credentials-form",
      // A minimal shape — only the handler's structural pass-through
      // matters for this test, not schema semantics.
      schema: { fields: [] } as unknown as CredentialsFormIntent["schema"],
      submit: async () => ({ accessToken: "should-not-be-observed" }),
    };
    const req: SyncAuthenticateRequest = {
      datasourceId: "ds-2",
      type: "s3",
      intent: formIntent,
    };
    const wireAuthResult: AuthResult = { accessToken: "svc-issued-form-token" };
    const { client, authenticate } = makeFakeClient(async () => ({
      authResult: wireAuthResult,
    }));

    const res = await handleSyncAuthenticate(req, client);

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith({
      datasourceId: "ds-2",
      type: "s3",
      intent: formIntent,
    });
    expect(res).toEqual({ authResult: wireAuthResult });
  });

  it("does not mutate the intent — passes the same reference to the client", async () => {
    // The security contract: whatever intent the renderer presents, the
    // service receives unchanged. No cloning, no normalisation, no
    // stripping. This test pins that by reference-identity so a future
    // refactor that silently rebuilds the intent object fails loudly.
    const intent: AuthIntent = {
      kind: "oauth",
      authorizeUrl: "https://provider.example/authorize",
      completeWith: async () => ({ accessToken: "ignored" }),
    };
    const req: SyncAuthenticateRequest = {
      datasourceId: "ds-3",
      type: "s3",
      intent,
    };
    const { client, authenticate } = makeFakeClient(async () => ({
      authResult: { accessToken: "tok" },
    }));

    await handleSyncAuthenticate(req, client);

    const [params] = authenticate.mock.calls[0]!;
    expect((params as { intent: AuthIntent }).intent).toBe(intent);
  });

  it("re-throws authentication-failed (not a renderer-observable fallible outcome)", async () => {
    const err = new SyncCommandError("sync:authenticate", {
      tag: "authentication-failed",
      message: "provider rejected credentials",
      details: {
        providerId: "s3",
        tag: "authentication-failed",
        message: "bad key",
      } as never,
    });
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncAuthenticate(
        {
          datasourceId: "ds-1",
          type: "s3",
          intent: {
            kind: "oauth",
            authorizeUrl: "https://x",
            completeWith: async () => ({ accessToken: "t" }),
          },
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
      handleSyncAuthenticate(
        {
          datasourceId: "ds-1",
          type: "s3",
          intent: {
            kind: "credentials-form",
            schema: { fields: [] } as unknown as CredentialsFormIntent["schema"],
            submit: async () => ({ accessToken: "t" }),
          },
        },
        client,
      ),
    ).rejects.toBe(err);
  });
});
