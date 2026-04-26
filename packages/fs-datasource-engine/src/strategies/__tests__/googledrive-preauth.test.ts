// GoogleDriveClient — `preAuth?: PreAuthConfig` constructor slot tests.
//
// implement-datasource-onboarding §2.3 + §2.4. The new slot lets the strategy
// be constructed without `StoredCredentials` (the createForAuth path that
// will land in §3) by sourcing OAuth app config (clientId / clientSecret /
// redirectUri) from a typed `PreAuthConfig` instead of the legacy
// `creds.authResult.meta` slot.
//
// Read precedence at `doAuthenticateImpl()` time: (a) `preAuth` if set;
// (b) the strategy's existing `creds` (legacy meta path during transition);
// (c) throw `DatasourceError(invalid-datasource)` when neither is available.
//
// These tests construct the strategy directly via the class constructor —
// not via `createGoogleDriveClient` — so they can pass `creds: null`
// (the createForAuth shape).

import { describe, expect, it } from "vitest";

import type { OAuthIntent } from "@ft5/ipc-contracts";
import { DatasourceError, providers } from "@ft5/ipc-contracts";

import type { PreAuthConfig } from "../../auth-types.js";
import type { BaseClientContext, CredentialStore } from "../../base-client.js";
import { createEventBus } from "../../event-bus.js";
import {
  GoogleDriveClient,
  type GoogleDriveClientLike,
} from "../googledrive-client.js";

// ---------------------------------------------------------------------------
// Tiny harness — just enough to construct the strategy and call authenticate
// ---------------------------------------------------------------------------

function makeContext(): BaseClientContext {
  const bus = createEventBus();
  const credentialStore: CredentialStore = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  };
  return {
    bus,
    credentialStore,
    providerDescriptor: providers["google-drive"],
  };
}

function makeFakeDrive(): GoogleDriveClientLike {
  // doAuthenticateImpl never invokes the SDK — it only builds an authorize
  // URL — so any bare object that satisfies the duck-typed shape works.
  // We supply stubs that throw if anything unexpectedly calls them.
  return {
    files: {
      list: async () => {
        throw new Error("unexpected files.list call in authenticate-only test");
      },
      get: async () => {
        throw new Error("unexpected files.get call in authenticate-only test");
      },
      create: async () => {
        throw new Error(
          "unexpected files.create call in authenticate-only test",
        );
      },
      delete: async () => {
        throw new Error(
          "unexpected files.delete call in authenticate-only test",
        );
      },
    },
    about: {
      get: async () => {
        throw new Error("unexpected about.get call in authenticate-only test");
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GoogleDriveClient — preAuth (no creds)", () => {
  it("constructs with creds=null + preAuth set; authenticate() returns an OAuthIntent that carries clientId + redirectUri from preAuth", async () => {
    const preAuth: PreAuthConfig = {
      clientId: "preauth-client-id",
      clientSecret: "preauth-client-secret",
      redirectUri: "http://127.0.0.1:55555/callback",
    };
    const ctx = makeContext();
    const driveFactory = (): GoogleDriveClientLike => makeFakeDrive();

    // Direct constructor — bypass `createGoogleDriveClient` so we can pass
    // creds=null. The createForAuth factory path (§3) will exercise the
    // same shape end-to-end.
    const client = new GoogleDriveClient(
      { datasourceId: "ds-gd-preauth", ctx },
      null,
      { driveFactory },
      preAuth,
    );

    const intent = (await client.authenticate()) as OAuthIntent;
    expect(intent.kind).toBe("oauth");
    expect(intent.authorizeUrl).toContain("client_id=preauth-client-id");
    expect(intent.authorizeUrl).toContain(
      "redirect_uri=http%3A%2F%2F127.0.0.1%3A55555%2Fcallback",
    );

    client.dispose();
  });

  it("threads the preAuth.clientSecret + redirectUri into the token-exchange POST body", async () => {
    const preAuth: PreAuthConfig = {
      clientId: "preauth-client-id",
      clientSecret: "preauth-client-secret",
      redirectUri: "http://127.0.0.1:55555/callback",
    };
    const ctx = makeContext();
    const driveFactory = (): GoogleDriveClientLike => makeFakeDrive();

    let capturedBody: string | undefined;
    const fetchImpl = (async (
      _url: string,
      init: { body: string },
    ): Promise<Response> => {
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

    const client = new GoogleDriveClient(
      { datasourceId: "ds-gd-preauth-2", ctx },
      null,
      { driveFactory, fetchImpl },
      preAuth,
    );

    const intent = (await client.authenticate()) as OAuthIntent;
    await intent.completeWith("auth-code-xyz");

    // The exchange body is form-encoded; parse via URLSearchParams to
    // assert without depending on field order.
    const params = new URLSearchParams(capturedBody ?? "");
    expect(params.get("client_id")).toBe("preauth-client-id");
    expect(params.get("client_secret")).toBe("preauth-client-secret");
    expect(params.get("redirect_uri")).toBe(
      "http://127.0.0.1:55555/callback",
    );
    expect(params.get("code")).toBe("auth-code-xyz");

    client.dispose();
  });

  it("throws DatasourceError(invalid-datasource) at authenticate() time when both creds and preAuth are missing", async () => {
    const ctx = makeContext();
    const driveFactory = (): GoogleDriveClientLike => makeFakeDrive();

    const client = new GoogleDriveClient(
      { datasourceId: "ds-gd-no-config", ctx },
      null,
      { driveFactory },
      undefined,
    );

    await expect(client.authenticate()).rejects.toBeInstanceOf(DatasourceError);
    try {
      await client.authenticate();
    } catch (err) {
      expect(err).toBeInstanceOf(DatasourceError);
      const e = err as DatasourceError<"google-drive">;
      expect(e.tag).toBe("invalid-datasource");
      expect(e.retryable).toBe(false);
    }

    client.dispose();
  });
});
