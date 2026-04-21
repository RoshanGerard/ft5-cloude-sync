// ClientFactory + ProviderRegistry — Phase 5 of add-fs-datasource-engine.
//
// The factory is a thin, stateless constructor-over-a-registry:
//
//   registry: { [P in ProviderId]: ProviderFactoryFn<P> }
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
//     `@ft5/ipc-contracts`'s `providers` export, AND every known descriptor
//     must have a corresponding registry entry — else `createClientFactory`
//     throws `DatasourceError tag="unsupported"`.
//
// Unknown `providerId` at `create` time throws `DatasourceError tag="unsupported"`.
//
// Design note — return-type generic:
//   Public `ClientFactory.create<P>` is generic in the provider id and returns
//   `DatasourceClient<P>`, so callers that know the concrete provider at the
//   call site get a narrow return type without casts. Registry entries are a
//   mapped type (`{ [P in ProviderId]: ProviderFactoryFn<P> }`): each entry
//   at key `P` returns `DatasourceClient<P>`. This keeps concrete strategy
//   factories (Phases 6-8) from needing unsafe widening casts when Phase 6
//   tightens `ProviderMetadata<T>` in `@ft5/ipc-contracts`.

import type { ProviderId, StoredCredentials } from "@ft5/ipc-contracts";
import { DatasourceError, providers } from "@ft5/ipc-contracts";

import type {
  BaseClientContext,
  DatasourceClient,
} from "./base-client.js";
import type { CredentialStore } from "./credential-store.js";
import type { EventBus } from "./event-bus.js";
// Provider strategies. Phases 6, 7, and 8 delivered the real S3, OneDrive,
// and Google Drive strategies respectively.
import { createS3Client } from "./strategies/s3-client.js";
import { createOneDriveClientForRegistry } from "./strategies/onedrive-client.js";
import { createGoogleDriveClientForRegistry } from "./strategies/googledrive-client.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Sentinel `datasourceId` used for errors raised during factory construction,
 * before any real datasource is in play. Exported so downstream log filters
 * and telemetry can detect bootstrap-time registry misconfiguration.
 */
export const FACTORY_CONSTRUCTION_DS_ID = "<factory-construction>";

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
 * a concrete strategy (extending `BaseDatasourceClient<P>`) given the
 * datasourceId, credentials, and the full `BaseClientContext` (which the
 * main factory assembles from the `EngineContext` + resolved descriptor).
 *
 * Generic in `P extends ProviderId` so the registry mapped-type can pin each
 * entry's return type to its concrete provider — preventing unsafe widening
 * at call sites.
 */
export type ProviderFactoryFn<P extends ProviderId = ProviderId> = (
  datasourceId: string,
  credentials: StoredCredentials,
  ctx: BaseClientContext,
) => DatasourceClient<P>;

/**
 * Map of ProviderId → factory fn, pinned per-key: the entry at key `P` must
 * return a `DatasourceClient<P>`. Must cover every `ProviderId`.
 */
export type ProviderRegistry = { [P in ProviderId]: ProviderFactoryFn<P> };

export interface ClientFactory {
  /**
   * Construct a DatasourceClient for the given provider + datasource.
   *
   * Each call returns a FRESH instance — the factory is stateless.
   * Callers that want to reuse clients across multiple IPC invocations
   * should cache at their own level.
   *
   * Generic in `P` so callers that pass a literal `providerId` get a
   * correspondingly narrow `DatasourceClient<P>` back with no casts.
   *
   * @throws DatasourceError `tag="unsupported"` if `providerId` is not in
   *   the registry.
   */
  create<P extends ProviderId>(
    providerId: P,
    datasourceId: string,
    credentials: StoredCredentials,
    ctx: EngineContext,
  ): DatasourceClient<P>;
}

// ---------------------------------------------------------------------------
// Factory implementation
// ---------------------------------------------------------------------------

/**
 * Create a `ClientFactory` backed by the supplied registry.
 *
 * Eagerly validates the registry in both directions:
 *   1. every registered providerId has a matching descriptor in
 *      `@ft5/ipc-contracts`'s `providers` export;
 *   2. every known descriptor has a corresponding registry entry —
 *      a caller who passes an empty (or partial) registry fails fast at
 *      construction with a clear message rather than at first-call time.
 */
export function createClientFactory(registry: ProviderRegistry): ClientFactory {
  // Integrity check 1: every registered key must resolve to a descriptor.
  for (const key of Object.keys(registry) as ProviderId[]) {
    if (!(key in providers)) {
      throw new DatasourceError({
        tag: "unsupported",
        datasourceType: key,
        datasourceId: FACTORY_CONSTRUCTION_DS_ID,
        retryable: false,
        raw: "registry-descriptor-missing",
        message: `Provider registry contains '${key}' but no descriptor is registered in @ft5/ipc-contracts.providers`,
      });
    }
  }

  // Integrity check 2: every known descriptor must have a registry entry.
  // Catches empty or partial registries at bootstrap instead of at
  // first-`create` time.
  for (const expectedId of Object.keys(providers) as ProviderId[]) {
    if (!(expectedId in registry)) {
      throw new DatasourceError({
        tag: "unsupported",
        datasourceType: expectedId,
        datasourceId: FACTORY_CONSTRUCTION_DS_ID,
        retryable: false,
        raw: "registry-provider-missing",
        message: `Registry is missing provider '${expectedId}' — every known descriptor must have a registered factory`,
      });
    }
  }

  return {
    create<P extends ProviderId>(
      providerId: P,
      datasourceId: string,
      credentials: StoredCredentials,
      ctx: EngineContext,
    ): DatasourceClient<P> {
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
      // `registry[providerId]` is typed as `ProviderFactoryFn<P>` via the
      // mapped type, so the call returns `DatasourceClient<P>` directly.
      // NOTE: callers are responsible for calling `.dispose()` on returned
      // clients when they discard them — strategies that subscribe to the
      // bus (e.g., OneDriveClient) leak the subscription otherwise. Phase 10
      // will own the cross-IPC lifecycle.
      return entry(datasourceId, credentials, baseCtx);
    },
  };
}

// ---------------------------------------------------------------------------
// Default registry
// ---------------------------------------------------------------------------

/**
 * Returns the default production registry, mapping each `ProviderId` to its
 * concrete strategy factory. Consumers typically pass the result to
 * `createClientFactory` at main-process bootstrap.
 *
 * Individual strategies are introduced incrementally across Phases 6–8;
 * each entry carries a `TODO(phase-N)` comment documenting when its stub
 * is replaced by a real implementation.
 */
export function createDefaultProviderRegistry(): ProviderRegistry {
  return {
    "amazon-s3": createS3Client,
    "google-drive": createGoogleDriveClientForRegistry,
    onedrive: createOneDriveClientForRegistry,
  };
}
