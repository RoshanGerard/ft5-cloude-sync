// ClientFactory + ProviderRegistry — Phase 5 of add-fs-datasource-engine.
//
// The factory is a thin, stateless constructor-over-a-registry:
//
//   registry: Record<ProviderId, ProviderFactoryFn>
//   factory  = createClientFactory(registry)
//   client   = factory.create(providerId, datasourceId, credentials, ctx)
//
// Each `create` call looks up the registered factory for `providerId`,
// resolves the corresponding `ProviderDescriptor` from `@ft5/ipc-contracts`,
// assembles a fresh `BaseClientContext` that pairs the supplied
// `EngineContext` (bus + credentialStore) with the descriptor, and delegates
// to the registered factory. The main factory itself:
//   * does NOT cache — every call returns a fresh client. Callers that want
//     to reuse clients across IPC invocations own that caching at their
//     layer (e.g., a main-process handler registry keyed by
//     `(providerId, datasourceId)`).
//   * does NOT verify credentials — that is the caller's concern.
//   * DOES validate registry integrity eagerly at construction: every
//     registered key must have a matching descriptor in
//     `@ft5/ipc-contracts`'s `providers` export, else
//     `createClientFactory` throws `DatasourceError tag="unsupported"`.
//
// Unknown `providerId` at `create` time throws `DatasourceError tag="unsupported"`.
//
// Design note — return-type generic:
//   Public `ClientFactory.create` returns `DatasourceClient<ProviderId>` (the
//   union). Callers that know the concrete provider at the call site can
//   narrow via the inferred `providerId` type parameter, but the default
//   signature carries the widest safe type. Registry factory functions
//   return `DatasourceClient<ProviderId>`; each concrete strategy pins its
//   `T` internally (`S3Client extends BaseDatasourceClient<"amazon-s3">`)
//   and widens on return — the factory's public boundary is deliberately
//   non-narrowing to keep the registry homogeneous.

import type { ProviderId, StoredCredentials } from "@ft5/ipc-contracts";
import { DatasourceError, providers } from "@ft5/ipc-contracts";

import type {
  BaseClientContext,
  DatasourceClient,
} from "./base-client.js";
import type { CredentialStore } from "./credential-store.js";
import type { EventBus } from "./event-bus.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-process context shared across every client the factory produces.
 * Callers construct one `EngineContext` at bootstrap and pass the same
 * instance into every `ClientFactory.create` call for the lifetime of the
 * process.
 */
export interface EngineContext {
  bus: EventBus;
  credentialStore: CredentialStore;
}

/**
 * Registry entry signature. Each registered factory knows how to construct
 * a concrete strategy (extending `BaseDatasourceClient<T>`) given the
 * datasourceId, credentials, and the full `BaseClientContext` (which the
 * main factory assembles from the `EngineContext` + resolved descriptor).
 */
export type ProviderFactoryFn = (
  datasourceId: string,
  credentials: StoredCredentials,
  ctx: BaseClientContext,
) => DatasourceClient<ProviderId>;

/** Map of ProviderId → factory fn. Must cover every `ProviderId`. */
export type ProviderRegistry = Record<ProviderId, ProviderFactoryFn>;

export interface ClientFactory {
  /**
   * Construct a DatasourceClient for the given provider + datasource.
   *
   * Each call returns a FRESH instance — the factory is stateless.
   * Callers that want to reuse clients across multiple IPC invocations
   * should cache at their own level.
   *
   * @throws DatasourceError `tag="unsupported"` if `providerId` is not in
   *   the registry.
   */
  create(
    providerId: ProviderId,
    datasourceId: string,
    credentials: StoredCredentials,
    ctx: EngineContext,
  ): DatasourceClient<ProviderId>;
}

// ---------------------------------------------------------------------------
// Factory implementation
// ---------------------------------------------------------------------------

/**
 * Create a `ClientFactory` backed by the supplied registry.
 *
 * Eagerly validates that every registered providerId has a matching
 * descriptor in `@ft5/ipc-contracts`'s `providers` export — a misconfigured
 * registry fails at bootstrap, not at first-call time.
 */
export function createClientFactory(registry: ProviderRegistry): ClientFactory {
  // Integrity check: every registered key must resolve to a descriptor.
  for (const key of Object.keys(registry) as ProviderId[]) {
    if (!(key in providers)) {
      throw new DatasourceError({
        tag: "unsupported",
        datasourceType: key,
        datasourceId: "<factory-construction>",
        retryable: false,
        raw: "registry-descriptor-missing",
        message: `Provider registry contains '${key}' but no descriptor is registered in @ft5/ipc-contracts.providers`,
      });
    }
  }

  return {
    create(providerId, datasourceId, credentials, ctx) {
      const entry = registry[providerId];
      if (entry === undefined) {
        throw new DatasourceError({
          tag: "unsupported",
          datasourceType: providerId,
          datasourceId,
          retryable: false,
          raw: "unknown-provider",
          message: `No strategy registered for provider '${providerId}'`,
        });
      }
      const descriptor = providers[providerId];
      // Construct a fresh BaseClientContext per call — the descriptor is
      // per-provider, so it cannot live inside the EngineContext.
      const baseCtx: BaseClientContext = {
        bus: ctx.bus,
        credentialStore: ctx.credentialStore,
        providerDescriptor: descriptor,
      };
      return entry(datasourceId, credentials, baseCtx);
    },
  };
}

// ---------------------------------------------------------------------------
// Default registry — wires the three placeholder strategy stubs.
// Phases 6–8 replace each stub with a real strategy class.
// ---------------------------------------------------------------------------

// Imported here (and re-exported from index.ts) to keep the registry
// construction centralised. Stubs live under `./strategies/`.
import { createS3ClientStub } from "./strategies/s3-client.stub.js";
import { createOneDriveClientStub } from "./strategies/onedrive-client.stub.js";
import { createGoogleDriveClientStub } from "./strategies/googledrive-client.stub.js";

/**
 * Default registry used by production bootstrap (Phase 9+). Every
 * `ProviderId` points at a placeholder stub until Phases 6–8 wire the real
 * strategies in one-by-one. The stubs throw `not-yet-implemented:<method>`
 * from every `doX` call — callers should not exercise behaviour against a
 * stub.
 */
export function createDefaultProviderRegistry(): ProviderRegistry {
  return {
    "amazon-s3": createS3ClientStub,
    "google-drive": createGoogleDriveClientStub,
    onedrive: createOneDriveClientStub,
  };
}
