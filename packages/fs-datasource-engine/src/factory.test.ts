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

import { createEventBus } from "./event-bus.js";
import type { CredentialStore } from "./credential-store.js";
import type {
  BaseClientContext,
  DatasourceClient,
} from "./base-client.js";
import {
  createClientFactory,
  createDefaultProviderRegistry,
  type EngineContext,
  type ProviderFactoryFn,
  type ProviderRegistry,
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
    bus: createEventBus(),
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
    createFile: vi.fn(),
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    deleteDirectory: vi.fn(),
    getQuota: vi.fn(),
  } as unknown as DatasourceClient<T>;
}

/**
 * Build a typed spy factory fn narrowed to a specific `ProviderId`. Using the
 * narrow type keeps the spy assignable to the mapped-type `ProviderRegistry`
 * entry (which is `ProviderFactoryFn<P>` per key).
 */
function makeSpyFactoryFn<P extends ProviderId>(): ProviderFactoryFn<P> {
  return vi.fn<ProviderFactoryFn<P>>();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createClientFactory", () => {
  it("throws DatasourceError Unsupported when providerId is not in the registry", () => {
    const ctx = makeEngineContext();
    const spy = makeSpyFactoryFn<"amazon-s3">();
    const registry: ProviderRegistry = {
      "amazon-s3": spy,
      // Other two slots present so the constructor integrity check passes —
      // we still deliberately attack with an id that is not in the registry.
      "google-drive": makeSpyFactoryFn<"google-drive">(),
      onedrive: makeSpyFactoryFn<"onedrive">(),
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

    // Error should carry the unsupported tag and a recognisable raw marker.
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
      expect(e.tag).toBe("unsupported");
      expect(e.raw).toBe("unknown-provider");
      expect(e.datasourceId).toBe("ds-1");
      expect(e.retryable).toBe(false);
    }

    // None of the registered provider factories should have been invoked.
    expect(spy).not.toHaveBeenCalled();
    expect(registry["google-drive"]).not.toHaveBeenCalled();
    expect(registry.onedrive).not.toHaveBeenCalled();
  });

  it("returns a DatasourceClient<T> for a known provider id", () => {
    const ctx = makeEngineContext();
    const fake = makeFakeClient("amazon-s3", "ds-1");
    const spy: ProviderFactoryFn<"amazon-s3"> = vi
      .fn<ProviderFactoryFn<"amazon-s3">>()
      .mockReturnValue(fake);
    const registry: ProviderRegistry = {
      "amazon-s3": spy,
      "google-drive": makeSpyFactoryFn<"google-drive">(),
      onedrive: makeSpyFactoryFn<"onedrive">(),
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
      "createFile",
      "uploadFile",
      "deleteFile",
      "deleteDirectory",
      "getQuota",
    ] as const) {
      expect(typeof client[m]).toBe("function");
    }

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("wires bus, credentialStore, and providerDescriptor into the BaseClientContext", () => {
    const ctx = makeEngineContext();
    let captured: {
      datasourceId: string;
      credentials: unknown;
      ctx: BaseClientContext;
    } | null = null;
    const spy: ProviderFactoryFn<"amazon-s3"> = vi
      .fn<ProviderFactoryFn<"amazon-s3">>()
      .mockImplementation((datasourceId, credentials, baseCtx) => {
        captured = { datasourceId, credentials, ctx: baseCtx };
        return makeFakeClient("amazon-s3", datasourceId);
      });
    const registry: ProviderRegistry = {
      "amazon-s3": spy,
      "google-drive": makeSpyFactoryFn<"google-drive">(),
      onedrive: makeSpyFactoryFn<"onedrive">(),
    };
    const factory = createClientFactory(registry);

    factory.create("amazon-s3", "ds-42", mockCreds, ctx);

    expect(captured).not.toBeNull();
    const c = captured!;
    expect(c.datasourceId).toBe("ds-42");
    expect(c.credentials).toBe(mockCreds);
    // Referentially equal bus + store propagate into the BaseClientContext.
    expect(c.ctx.bus).toBe(ctx.bus);
    expect(c.ctx.credentialStore).toBe(ctx.credentialStore);
    // Descriptor is resolved from the shared @ft5/ipc-contracts export.
    expect(c.ctx.providerDescriptor).toBe(providers["amazon-s3"]);
  });

  it("is stateless — each create() call returns a fresh instance", () => {
    const ctx = makeEngineContext();
    const spy: ProviderFactoryFn<"amazon-s3"> = vi
      .fn<ProviderFactoryFn<"amazon-s3">>()
      .mockImplementation((datasourceId) =>
        makeFakeClient("amazon-s3", datasourceId),
      );
    const registry: ProviderRegistry = {
      "amazon-s3": spy,
      "google-drive": makeSpyFactoryFn<"google-drive">(),
      onedrive: makeSpyFactoryFn<"onedrive">(),
    };
    const factory = createClientFactory(registry);

    const a = factory.create("amazon-s3", "ds-1", mockCreds, ctx);
    const b = factory.create("amazon-s3", "ds-1", mockCreds, ctx);

    expect(a).not.toBe(b);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("validates registry integrity at construction — every registered id has a descriptor", () => {
    const badRegistry = {
      "amazon-s3": makeSpyFactoryFn<"amazon-s3">(),
      "google-drive": makeSpyFactoryFn<"google-drive">(),
      onedrive: makeSpyFactoryFn<"onedrive">(),
      // Intentionally corrupt: an id that is not in the providers descriptor
      // table. Cast bypasses the ProviderId union so we can exercise the
      // defensive path.
      corrupted: vi.fn<ProviderFactoryFn>(),
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
      "amazon-s3": makeSpyFactoryFn<"amazon-s3">(),
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
  it("contains exactly the three known providers, each a function", () => {
    const registry = createDefaultProviderRegistry();
    const keys = Object.keys(registry).sort();
    expect(keys).toEqual(["amazon-s3", "google-drive", "onedrive"]);
    for (const k of keys as ProviderId[]) {
      expect(typeof registry[k]).toBe("function");
    }
  });

  it("constructs a client for every known providerId via the default registry", () => {
    const ctx = makeEngineContext();
    const factory = createClientFactory(createDefaultProviderRegistry());

    // Phase 6 made the `amazon-s3` entry a real strategy that validates
    // credentials at construction — supply a minimally-valid meta shape for
    // S3; the OAuth stubs still ignore credentials.
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
      "google-drive": mockCreds,
      onedrive: mockCreds,
    };

    const ids: ProviderId[] = ["amazon-s3", "google-drive", "onedrive"];
    for (const id of ids) {
      const client = factory.create(id, `ds-${id}`, credsFor[id], ctx);
      expect(client.type).toBe(id);
      expect(client.datasourceId).toBe(`ds-${id}`);
      // Public surface still present.
      expect(typeof client.status).toBe("function");
      expect(typeof client.uploadFile).toBe("function");
      expect(typeof client.deleteDirectory).toBe("function");
    }
  });
});
