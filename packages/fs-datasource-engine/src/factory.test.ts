// Phase 5 — ClientFactory + ProviderRegistry.
//
// Covers the spec requirement "Factory + Registry construct clients by
// provider id" (see `specs/fs-datasource-engine/spec.md`): two scenarios
// (unknown providerId throws Unsupported; known providerId returns a
// configured DatasourceClient<T>). Plus defence-in-depth integrity checks on
// the registry and stateless-factory semantics.

import { describe, expect, it, vi } from "vitest";

import type { ProviderId } from "@ft5/ipc-contracts";
import { providers } from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

import type { CredentialStore } from "./credential-store.js";
import type {
  BaseClientContext,
  DatasourceClient,
} from "./base-client.js";
import {
  createClientFactory,
  createDefaultProviderRegistry,
  type CredentialShapeValidator,
  type EngineContext,
  type PreAuthFactoryFn,
  type ProviderFactoryFn,
  type ProviderRegistry,
  type ProviderRegistryEntry,
} from "./factory.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCredentialStore(): CredentialStore {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEngineContext(): EngineContext {
  return {
    credentialStore: makeCredentialStore(),
  };
}

const mockCreds = {
  providerId: "amazon-s3" as ProviderId,
  authResult: { accessToken: "x" },
  createdAt: 0,
  updatedAt: 0,
};

/**
 * Build a minimal object that is structurally a DatasourceClient<T>. This
 * avoids any dependency on the real stubs for the core factory-wiring tests
 * (they verify plumbing, not strategy behaviour).
 */
function makeFakeClient<T extends ProviderId>(
  type: T,
  datasourceId: string,
): DatasourceClient<T> {
  return {
    type,
    datasourceId,
    status: vi.fn(),
    testConnection: vi.fn(),
    authenticate: vi.fn(),
    listDirectory: vi.fn(),
    search: vi.fn(),
    getMetadata: vi.fn(),
    uploadFile: vi.fn(),
    delete: vi.fn(),
    getQuota: vi.fn(),
  } as unknown as DatasourceClient<T>;
}

/**
 * Build a typed spy factory fn narrowed to a specific `ProviderId`. Using the
 * narrow type keeps the spy assignable to the mapped-type `ProviderRegistry`
 * entry's `.create` slot (the registry entry is now an object per
 * add-invalid-datasource-state Decision 2).
 */
function makeSpyFactoryFn<P extends ProviderId>(): ProviderFactoryFn<P> {
  return vi.fn<ProviderFactoryFn<P>>();
}

/**
 * Build a typed spy registry entry: `{ create, validateCredentialShape }`.
 * The validator defaults to a no-op spy so existing tests that only care
 * about `create` invocation behaviour continue to pass; tests that need
 * to assert validator behaviour read `entry.validateCredentialShape`.
 */
function makeSpyRegistryEntry<P extends ProviderId>(): ProviderRegistryEntry<P> {
  return {
    create: makeSpyFactoryFn<P>(),
    createForAuth: vi.fn<PreAuthFactoryFn<P>>(),
    validateCredentialShape: vi.fn<CredentialShapeValidator>(),
    // Default value chosen so the §3.5 createForAuth path can be
    // exercised with non-null oauthAppConfig in the spy registry without
    // tripping the credentials-form rejection arm. Tests that need a
    // credentials-form discriminator override this field on the entry.
    authKind: "oauth",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createClientFactory", () => {
  it("throws DatasourceError InvalidDatasource when providerId is not in the registry", () => {
    const ctx = makeEngineContext();
    const s3Entry = makeSpyRegistryEntry<"amazon-s3">();
    const registry: ProviderRegistry = {
      "amazon-s3": s3Entry,
      // Other two slots present so the constructor integrity check passes —
      // we still deliberately attack with an id that is not in the registry.
      "google-drive": makeSpyRegistryEntry<"google-drive">(),
      onedrive: makeSpyRegistryEntry<"onedrive">(),
    };
    const factory = createClientFactory(registry);

    expect(() =>
      factory.create(
        "dropbox" as unknown as ProviderId,
        "ds-1",
        mockCreds,
        ctx,
      ),
    ).toThrow(DatasourceError);

    // Error should carry the InvalidDatasource tag and a recognisable raw marker.
    try {
      factory.create(
        "dropbox" as unknown as ProviderId,
        "ds-1",
        mockCreds,
        ctx,
      );
    } catch (err) {
      expect(err).toBeInstanceOf(DatasourceError);
      const e = err as DatasourceError;
      expect(e.tag).toBe("invalid-datasource");
      expect(e.raw).toBe("unknown-provider");
      expect(e.datasourceId).toBe("ds-1");
      expect(e.retryable).toBe(false);
    }

    // None of the registered provider factories should have been invoked.
    expect(s3Entry.create).not.toHaveBeenCalled();
    expect(registry["google-drive"].create).not.toHaveBeenCalled();
    expect(registry.onedrive.create).not.toHaveBeenCalled();
  });

  it("returns a DatasourceClient<T> for a known provider id", () => {
    const ctx = makeEngineContext();
    const fake = makeFakeClient("amazon-s3", "ds-1");
    const create: ProviderFactoryFn<"amazon-s3"> = vi
      .fn<ProviderFactoryFn<"amazon-s3">>()
      .mockReturnValue(fake);
    const registry: ProviderRegistry = {
      "amazon-s3": {
        create,
        createForAuth: vi.fn<PreAuthFactoryFn<"amazon-s3">>(),
        validateCredentialShape: vi.fn(),
        authKind: "credentials-form",
      },
      "google-drive": makeSpyRegistryEntry<"google-drive">(),
      onedrive: makeSpyRegistryEntry<"onedrive">(),
    };
    const factory = createClientFactory(registry);

    const client = factory.create("amazon-s3", "ds-1", mockCreds, ctx);

    expect(client).toBe(fake);
    expect(client.type).toBe("amazon-s3");
    // Public DatasourceClient surface — every method present as a function.
    for (const m of [
      "status",
      "testConnection",
      "authenticate",
      "listDirectory",
      "search",
      "getMetadata",
      "uploadFile",
      "delete",
      "getQuota",
    ] as const) {
      expect(typeof client[m]).toBe("function");
    }

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("wires credentialStore and providerDescriptor into the BaseClientContext", () => {
    const ctx = makeEngineContext();
    let captured: {
      datasourceId: string;
      credentials: unknown;
      ctx: BaseClientContext;
    } | null = null;
    const create: ProviderFactoryFn<"amazon-s3"> = vi
      .fn<ProviderFactoryFn<"amazon-s3">>()
      .mockImplementation((datasourceId, credentials, baseCtx) => {
        captured = { datasourceId, credentials, ctx: baseCtx };
        return makeFakeClient("amazon-s3", datasourceId);
      });
    const registry: ProviderRegistry = {
      "amazon-s3": {
        create,
        createForAuth: vi.fn<PreAuthFactoryFn<"amazon-s3">>(),
        validateCredentialShape: vi.fn(),
        authKind: "credentials-form",
      },
      "google-drive": makeSpyRegistryEntry<"google-drive">(),
      onedrive: makeSpyRegistryEntry<"onedrive">(),
    };
    const factory = createClientFactory(registry);

    factory.create("amazon-s3", "ds-42", mockCreds, ctx);

    expect(captured).not.toBeNull();
    const c = captured!;
    expect(c.datasourceId).toBe("ds-42");
    expect(c.credentials).toBe(mockCreds);
    // Referentially equal store propagates into the BaseClientContext.
    expect(c.ctx.credentialStore).toBe(ctx.credentialStore);
    // Descriptor is resolved from the shared @ft5/ipc-contracts export.
    expect(c.ctx.providerDescriptor).toBe(providers["amazon-s3"]);
  });

  it("is stateless — each create() call returns a fresh instance", () => {
    const ctx = makeEngineContext();
    const create: ProviderFactoryFn<"amazon-s3"> = vi
      .fn<ProviderFactoryFn<"amazon-s3">>()
      .mockImplementation((datasourceId) =>
        makeFakeClient("amazon-s3", datasourceId),
      );
    const registry: ProviderRegistry = {
      "amazon-s3": {
        create,
        createForAuth: vi.fn<PreAuthFactoryFn<"amazon-s3">>(),
        validateCredentialShape: vi.fn(),
        authKind: "credentials-form",
      },
      "google-drive": makeSpyRegistryEntry<"google-drive">(),
      onedrive: makeSpyRegistryEntry<"onedrive">(),
    };
    const factory = createClientFactory(registry);

    const a = factory.create("amazon-s3", "ds-1", mockCreds, ctx);
    const b = factory.create("amazon-s3", "ds-1", mockCreds, ctx);

    expect(a).not.toBe(b);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("validates registry integrity at construction — every registered id has a descriptor", () => {
    const badRegistry = {
      "amazon-s3": makeSpyRegistryEntry<"amazon-s3">(),
      "google-drive": makeSpyRegistryEntry<"google-drive">(),
      onedrive: makeSpyRegistryEntry<"onedrive">(),
      // Intentionally corrupt: an id that is not in the providers descriptor
      // table. Cast bypasses the ProviderId union so we can exercise the
      // defensive path.
      corrupted: makeSpyRegistryEntry<ProviderId>(),
    } as unknown as ProviderRegistry;

    expect(() => createClientFactory(badRegistry)).toThrow(DatasourceError);

    try {
      createClientFactory(badRegistry);
    } catch (err) {
      expect(err).toBeInstanceOf(DatasourceError);
      const e = err as DatasourceError;
      expect(e.tag).toBe("unsupported");
      expect(e.raw).toBe("registry-descriptor-missing");
    }
  });

  it("throws if the registry is missing a known provider", () => {
    // An incomplete registry (here: only `amazon-s3`) should fail at
    // construction with a clear `registry-provider-missing` marker.
    const incomplete = {
      "amazon-s3": makeSpyRegistryEntry<"amazon-s3">(),
    } as unknown as ProviderRegistry;

    expect(() => createClientFactory(incomplete)).toThrow(DatasourceError);

    try {
      createClientFactory(incomplete);
    } catch (err) {
      expect(err).toBeInstanceOf(DatasourceError);
      const e = err as DatasourceError;
      expect(e.tag).toBe("unsupported");
      expect(e.raw).toBe("registry-provider-missing");
    }
  });
});

describe("createDefaultProviderRegistry", () => {
  it("contains exactly the three known providers, each with a create + validateCredentialShape function pair", () => {
    const registry = createDefaultProviderRegistry();
    const keys = Object.keys(registry).sort();
    expect(keys).toEqual(["amazon-s3", "google-drive", "onedrive"]);
    for (const k of keys as ProviderId[]) {
      expect(typeof registry[k].create).toBe("function");
      expect(typeof registry[k].validateCredentialShape).toBe("function");
    }
  });

  it("constructs a client for every known providerId via the default registry", () => {
    const ctx = makeEngineContext();
    const factory = createClientFactory(createDefaultProviderRegistry());

    // Phase 6 made the `amazon-s3` entry a real strategy that validates
    // credentials at construction — supply a minimally-valid meta shape for
    // S3. Phase 7 does the same for `onedrive`: the real `OneDriveClient`
    // expects OAuth config (`clientId`, `tenantId`, `redirectUri`) in
    // `authResult.meta` at construction time. Phase 8 does the same for
    // `google-drive`: the real `GoogleDriveClient` expects OAuth config
    // (`clientId`, `clientSecret`, `redirectUri`) in `authResult.meta`.
    const credsFor: Record<ProviderId, typeof mockCreds> = {
      "amazon-s3": {
        providerId: "amazon-s3",
        authResult: {
          accessToken: "",
          meta: {
            accessKeyId: "AKIA-DUMMY",
            secretAccessKey: "SK-DUMMY",
            region: "us-east-1",
            bucket: "dummy-bucket",
          },
        },
        createdAt: 0,
        updatedAt: 0,
      },
      "google-drive": {
        providerId: "google-drive",
        authResult: {
          // Non-empty placeholder — `validateGoogleDriveCredentialShape`
          // (per add-invalid-datasource-state Decision 2) rejects empty
          // accessToken at factory.create. The string contents are not
          // exercised by the construction-only assertion below.
          accessToken: "dummy-access-token",
          refreshToken: "",
          meta: {
            clientId: "dummy-client-id",
            clientSecret: "dummy-client-secret",
            redirectUri: "http://localhost/callback",
          },
        },
        createdAt: 0,
        updatedAt: 0,
      },
      onedrive: {
        providerId: "onedrive",
        authResult: {
          // Non-empty placeholder — see google-drive note above; the
          // OneDrive validator applies the same length check.
          accessToken: "dummy-access-token",
          refreshToken: "",
          meta: {
            clientId: "dummy-client-id",
            tenantId: "common",
            redirectUri: "http://localhost/callback",
          },
        },
        createdAt: 0,
        updatedAt: 0,
      },
    };

    const ids: ProviderId[] = ["amazon-s3", "google-drive", "onedrive"];
    for (const id of ids) {
      const client = factory.create(id, `ds-${id}`, credsFor[id], ctx);
      expect(client.type).toBe(id);
      expect(client.datasourceId).toBe(`ds-${id}`);
      // Public surface still present.
      expect(typeof client.status).toBe("function");
      expect(typeof client.uploadFile).toBe("function");
      expect(typeof client.delete).toBe("function");
    }
  });
});
