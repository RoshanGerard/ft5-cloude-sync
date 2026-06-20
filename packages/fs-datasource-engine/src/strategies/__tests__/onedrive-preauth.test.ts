// OneDriveClient — `preAuth?: PreAuthConfig` constructor slot tests.
//
// implement-datasource-onboarding §2.5. Mirrors the GoogleDrive preauth
// suite. The new slot lets the strategy be constructed without
// `StoredCredentials` (the createForAuth path that lands in §3) by sourcing
// OAuth app config (clientId / clientSecret / redirectUri) from a typed
// `PreAuthConfig` instead of the legacy `creds.authResult.meta` slot.
//
// `OAuthAppConfig` deliberately omits `tenantId` — see design.md
// Decision 13's OneDrive clarification. On the preAuth path the strategy
// defaults `tenantId` to `"common"` (Microsoft's multi-tenant authority).

import { describe, expect, it } from "vitest";

import type { OAuthIntent } from "@ft5/ipc-contracts";
import { DatasourceError, providers } from "@ft5/ipc-contracts";

import type { PreAuthConfig } from "../../auth-types.js";
import type { BaseClientContext, CredentialStore } from "../../base-client.js";
import {
  OneDriveClient,
  type GraphClientLike,
  type GraphRequestBuilderLike,
} from "../onedrive-client.js";

// ---------------------------------------------------------------------------
// Tiny harness — just enough to construct and call authenticate
// ---------------------------------------------------------------------------

function makeContext(): BaseClientContext {
  const credentialStore: CredentialStore = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  };
  return {
    credentialStore,
    providerDescriptor: providers["onedrive"],
  };
}

function makeFakeGraph(): GraphClientLike {
  // doAuthenticateImpl never invokes the SDK — only builds an authorize URL.
  // Provide a minimal builder that throws on every verb so unintended calls
  // surface immediately.
  return {
    api: () => {
      const builder: GraphRequestBuilderLike = {
        header: () => builder,
        headers: () => builder,
        query: () => builder,
        select: () => builder,
        expand: () => builder,
        get: async () => {
          throw new Error("unexpected SDK call in authenticate-only test");
        },
        post: async () => {
          throw new Error("unexpected SDK call in authenticate-only test");
        },
        put: async () => {
          throw new Error("unexpected SDK call in authenticate-only test");
        },
        patch: async () => {
          throw new Error("unexpected SDK call in authenticate-only test");
        },
        delete: async () => {
          throw new Error("unexpected SDK call in authenticate-only test");
        },
      };
      return builder;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OneDriveClient — preAuth (no creds)", () => {
  it("constructs with creds=null + preAuth set; authorizeUrl carries clientId + redirectUri from preAuth and defaults tenantId to 'common'", async () => {
    const preAuth: PreAuthConfig = {
      clientId: "preauth-client-id",
      clientSecret: "preauth-client-secret",
      redirectUri: "http://127.0.0.1:55555/callback",
    };
    const ctx = makeContext();
    const graphFactory = (): GraphClientLike => makeFakeGraph();

    const client = new OneDriveClient(
      { datasourceId: "ds-od-preauth", ctx },
      null,
      { graphFactory },
      preAuth,
    );

    const intent = (await client.authenticate()) as OAuthIntent;
    expect(intent.kind).toBe("oauth");
    expect(intent.authorizeUrl).toContain("client_id=preauth-client-id");
    expect(intent.authorizeUrl).toContain(
      "redirect_uri=http%3A%2F%2F127.0.0.1%3A55555%2Fcallback",
    );
    // Default multi-tenant authority on the preAuth path.
    expect(intent.authorizeUrl).toContain(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );

    client.dispose();
  });

  it("threads preAuth.clientId + redirectUri into the token-exchange POST body and posts to the 'common' tenant authority", async () => {
    const preAuth: PreAuthConfig = {
      clientId: "preauth-client-id",
      clientSecret: "preauth-client-secret",
      redirectUri: "http://127.0.0.1:55555/callback",
    };
    const ctx = makeContext();
    const graphFactory = (): GraphClientLike => makeFakeGraph();

    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    const fetchImpl = (async (
      url: string,
      init: { body: string },
    ): Promise<Response> => {
      capturedUrl = url;
      capturedBody = init.body;
      return new Response(
        JSON.stringify({
          access_token: "new-at",
          refresh_token: "new-rt",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = new OneDriveClient(
      { datasourceId: "ds-od-preauth-2", ctx },
      null,
      { graphFactory, fetchImpl },
      preAuth,
    );

    const intent = (await client.authenticate()) as OAuthIntent;
    await intent.completeWith("auth-code-xyz");

    expect(capturedUrl).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    );
    const params = new URLSearchParams(capturedBody ?? "");
    expect(params.get("client_id")).toBe("preauth-client-id");
    expect(params.get("redirect_uri")).toBe(
      "http://127.0.0.1:55555/callback",
    );
    expect(params.get("code")).toBe("auth-code-xyz");

    client.dispose();
  });

  it("throws DatasourceError(invalid-datasource) at authenticate() time when both creds and preAuth are missing", async () => {
    const ctx = makeContext();
    const graphFactory = (): GraphClientLike => makeFakeGraph();

    const client = new OneDriveClient(
      { datasourceId: "ds-od-no-config", ctx },
      null,
      { graphFactory },
      undefined,
    );

    await expect(client.authenticate()).rejects.toBeInstanceOf(DatasourceError);
    try {
      await client.authenticate();
    } catch (err) {
      expect(err).toBeInstanceOf(DatasourceError);
      const e = err as DatasourceError<"onedrive">;
      expect(e.tag).toBe("invalid-datasource");
      expect(e.retryable).toBe(false);
    }

    client.dispose();
  });

  it("treats preAuth: null as equivalent to undefined (factory.createForAuth dispatch shape symmetry)", async () => {
    // The factory contract is `OAuthAppConfig | null`. Passing null for an
    // OAuth provider would be a programmer error caught at the factory
    // level (§3 spec scenario), but at the constructor level the strategy
    // accepts null and treats it as "no preAuth" — same downstream
    // behavior as undefined.
    const ctx = makeContext();
    const graphFactory = (): GraphClientLike => makeFakeGraph();

    const client = new OneDriveClient(
      { datasourceId: "ds-od-null-preauth", ctx },
      null,
      { graphFactory },
      null,
    );

    await expect(client.authenticate()).rejects.toThrow(
      /missing-oauth-app-config|cannot resolve OAuth app config/i,
    );

    client.dispose();
  });
});
