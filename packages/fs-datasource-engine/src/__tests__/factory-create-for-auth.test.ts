// implement-datasource-onboarding §3 — `ClientFactory.createForAuth(...)`.
//
// Sibling to `factory.create(...)` for the no-credentials authenticate flow.
// The new method dispatches on `providerId` via the existing
// `ProviderRegistry`. OAuth-class providers (`google-drive`, `onedrive`)
// receive an `OAuthAppConfig` that the strategy reads via the
// `PreAuthConfig` constructor slot (§2.4). Credentials-form providers
// (`amazon-s3`) receive `null` — the strategy is constructed without
// user-side credentials and `authenticate()` returns a
// `CredentialsFormIntent`.
//
// Tests cover:
//   §3.1 happy path for an OAuth provider — authorize URL carries clientId,
//        redirectUri, and the PKCE code_challenge.
//   §3.2 happy path for a credentials-form provider — the returned client's
//        authenticate() yields a CredentialsFormIntent.
//   §3.3 rejection arms:
//        - OAuth provider with `null` config → invalid-datasource throw.
//        - Credentials-form provider with non-null config → invalid-datasource throw.
//        - Unknown providerId → invalid-datasource throw.
//
// See `openspec/changes/implement-datasource-onboarding/design.md`
// Decision 5 for the architectural framing.

import { describe, expect, it } from "vitest";

import type {
  CredentialsFormIntent,
  OAuthIntent,
  ProviderId,
} from "@ft5/ipc-contracts";
import { DatasourceError, DatasourceErrorTag } from "@ft5/ipc-contracts";

import type { OAuthAppConfig } from "../auth-types.js";
import type { CredentialStore } from "../credential-store.js";
import {
  createClientFactory,
  createDefaultProviderRegistry,
  type EngineContext,
} from "../factory.js";
import { GoogleDriveClient } from "../strategies/googledrive-client.js";
import { S3Client } from "../strategies/s3-client.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeStore(): CredentialStore {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  };
}

function makeContext(): EngineContext {
  return {
    credentialStore: makeStore(),
  };
}

const sampleOAuthConfig: OAuthAppConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "http://127.0.0.1:55555/callback",
};

// ---------------------------------------------------------------------------
// §3.1 — OAuth provider happy path
// ---------------------------------------------------------------------------

describe("ClientFactory.createForAuth — OAuth provider (§3.1)", () => {
  it("returns a GoogleDriveClient whose authenticate() produces an OAuthIntent with PKCE-bearing authorizeUrl", async () => {
    const ctx = makeContext();
    const factory = createClientFactory(createDefaultProviderRegistry());

    const client = factory.createForAuth(
      "google-drive",
      sampleOAuthConfig,
      ctx,
      "ds-create-for-auth-gd",
    );

    expect(client).toBeInstanceOf(GoogleDriveClient);

    const intent = (await client.authenticate()) as OAuthIntent;
    expect(intent.kind).toBe("oauth");
    expect(intent.authorizeUrl).toContain(
      `client_id=${sampleOAuthConfig.clientId}`,
    );
    // Encoded redirect_uri.
    expect(intent.authorizeUrl).toContain(
      "redirect_uri=http%3A%2F%2F127.0.0.1%3A55555%2Fcallback",
    );
    // PKCE parameters MUST be present on the authorize URL.
    expect(intent.authorizeUrl).toContain("code_challenge=");
    expect(intent.authorizeUrl).toContain("code_challenge_method=S256");

    client.dispose();
  });

  it("does not consult the credentialStore during construction or authenticate()", async () => {
    let getCalls = 0;
    let putCalls = 0;
    const trackingStore: CredentialStore = {
      get: async () => {
        getCalls += 1;
        return null;
      },
      put: async () => {
        putCalls += 1;
      },
      delete: async () => undefined,
    };
    const ctx: EngineContext = {
      credentialStore: trackingStore,
    };
    const factory = createClientFactory(createDefaultProviderRegistry());

    const client = factory.createForAuth(
      "google-drive",
      sampleOAuthConfig,
      ctx,
      "ds-create-for-auth-gd-no-store",
    );

    await client.authenticate();
    expect(getCalls).toBe(0);
    expect(putCalls).toBe(0);

    client.dispose();
  });
});

// ---------------------------------------------------------------------------
// §3.2 — Credentials-form provider happy path
// ---------------------------------------------------------------------------

describe("ClientFactory.createForAuth — credentials-form provider (§3.2)", () => {
  it("returns an S3Client whose authenticate() produces a CredentialsFormIntent", async () => {
    const ctx = makeContext();
    const factory = createClientFactory(createDefaultProviderRegistry());

    const client = factory.createForAuth(
      "amazon-s3",
      null,
      ctx,
      "ds-create-for-auth-s3",
    );

    expect(client).toBeInstanceOf(S3Client);

    const intent = (await client.authenticate()) as CredentialsFormIntent;
    expect(intent.kind).toBe("credentials-form");
    expect(typeof intent.schema).toBe("string");
    expect((intent.schema as string).length).toBeGreaterThan(0);
    expect(typeof intent.submit).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// §3.3 — Rejection arms
// ---------------------------------------------------------------------------

describe("ClientFactory.createForAuth — rejection arms (§3.3)", () => {
  it("throws DatasourceError(invalid-datasource) when an OAuth provider is given null oauthAppConfig", () => {
    const ctx = makeContext();
    const factory = createClientFactory(createDefaultProviderRegistry());

    let caught: unknown;
    try {
      factory.createForAuth("google-drive", null, ctx, "ds-no-config");
      throw new Error("expected throw");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    const e = caught as DatasourceError;
    expect(e.tag).toBe(DatasourceErrorTag.InvalidDatasource);
    expect(e.tag).toBe("invalid-datasource");
    expect(e.retryable).toBe(false);
    // The message MUST identify the missing OAuth app config.
    expect(e.message.toLowerCase()).toMatch(/oauth.*config|config.*missing|missing.*oauth/);
    expect(e.message).toContain("google-drive");
  });

  it("throws DatasourceError(invalid-datasource) when a credentials-form provider is given non-null oauthAppConfig", () => {
    const ctx = makeContext();
    const factory = createClientFactory(createDefaultProviderRegistry());

    let caught: unknown;
    try {
      factory.createForAuth(
        "amazon-s3",
        sampleOAuthConfig,
        ctx,
        "ds-misuse",
      );
      throw new Error("expected throw");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    const e = caught as DatasourceError;
    expect(e.tag).toBe(DatasourceErrorTag.InvalidDatasource);
    expect(e.retryable).toBe(false);
    // The message MUST identify the misuse — credentials-form provider
    // does not consume an OAuth app config.
    expect(e.message.toLowerCase()).toMatch(
      /credentials-form|misuse|does not (consume|accept|take)|unexpected.*oauth/,
    );
    expect(e.message).toContain("amazon-s3");
  });

  it("throws DatasourceError(invalid-datasource) when providerId is unknown", () => {
    const ctx = makeContext();
    const factory = createClientFactory(createDefaultProviderRegistry());

    let caught: unknown;
    try {
      factory.createForAuth(
        "dropbox" as unknown as ProviderId,
        sampleOAuthConfig,
        ctx,
        "ds-unknown",
      );
      throw new Error("expected throw");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    const e = caught as DatasourceError;
    expect(e.tag).toBe(DatasourceErrorTag.InvalidDatasource);
    expect(e.retryable).toBe(false);
    // The message MUST name the unknown provider.
    expect(e.message).toContain("dropbox");
  });
});
