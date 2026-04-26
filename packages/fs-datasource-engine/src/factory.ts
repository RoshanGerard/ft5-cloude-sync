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
// Unknown `providerId` at `create` time throws `DatasourceError tag="invalid-datasource"`
// (per add-invalid-datasource-state Decision 2 — misconfigured datasource).
//
// Design note — return-type generic:
//   Public `ClientFactory.create<P>` is generic in the provider id and returns
//   `DatasourceClient<P>`, so callers that know the concrete provider at the
//   call site get a narrow return type without casts. Registry entries are a
//   mapped type (`{ [P in ProviderId]: ProviderFactoryFn<P> }`): each entry
//   at key `P` returns `DatasourceClient<P>`. This keeps concrete strategy
//   factories (Phases 6-8) from needing unsafe widening casts when Phase 6
//   tightens `ProviderMetadata<T>` in `@ft5/ipc-contracts`.

import { randomUUID } from "node:crypto";

import type { ProviderId, StoredCredentials } from "@ft5/ipc-contracts";
import {
  DatasourceError,
  DatasourceErrorTag,
  providers,
} from "@ft5/ipc-contracts";

import type { OAuthAppConfig, PreAuthConfig } from "./auth-types.js";
import type {
  BaseClientContext,
  DatasourceClient,
} from "./base-client.js";
import type { CredentialStore } from "./credential-store.js";
import type { EventBus } from "./event-bus.js";
// Provider strategies. Phases 6, 7, and 8 delivered the real S3, OneDrive,
// and Google Drive strategies respectively.
import {
  createS3Client,
  createS3ClientForAuth,
  validateS3CredentialShape,
} from "./strategies/s3-client.js";
import {
  createOneDriveClientForRegistry,
  createOneDriveClientForAuth,
  validateOneDriveCredentialShape,
} from "./strategies/onedrive-client.js";
import {
  createGoogleDriveClientForRegistry,
  createGoogleDriveClientForAuth,
  validateGoogleDriveCredentialShape,
} from "./strategies/googledrive-client.js";

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
 * Pre-auth factory signature — the no-credentials counterpart to
 * `ProviderFactoryFn`. Used by `factory.createForAuth(...)` to construct a
 * strategy BEFORE any user-side credentials exist (the very first call to
 * `engine.authenticate()` for a brand-new datasource). The `preAuth`
 * argument is the typed `PreAuthConfig` slot the strategy reads at
 * `doAuthenticateImpl()` time:
 *
 *   - OAuth-class providers (`google-drive`, `onedrive`) receive a non-null
 *     `PreAuthConfig` carrying `clientId` / `clientSecret` / `redirectUri`.
 *   - Credentials-form providers (`amazon-s3`) receive `null` — the
 *     strategy is constructed with stub-empty credentials and the
 *     `preAuth` slot is ignored.
 *
 * The factory itself enforces the OAuth-vs-credentials-form contract via
 * each registry entry's `authKind` declaration (see `ProviderRegistryEntry`).
 *
 * See `openspec/changes/implement-datasource-onboarding/design.md`
 * Decision 5 for the rationale (separate factory method vs overloading
 * `create`).
 */
export type PreAuthFactoryFn<P extends ProviderId = ProviderId> = (
  datasourceId: string,
  preAuth: PreAuthConfig | null,
  ctx: BaseClientContext,
) => DatasourceClient<P>;

/**
 * Per-provider credential-shape validator. Invoked by `factory.create`
 * BEFORE the strategy factory runs (per add-invalid-datasource-state
 * Decision 2 — single choke point). MUST throw `DatasourceError({ tag:
 * "invalid-datasource", retryable: false, datasourceId, message:
 * "<provider> credential is missing <field>" })` when the supplied
 * credentials do not satisfy the provider's expected shape; MUST
 * return without throwing on success.
 *
 * The validator receives `datasourceId` so the thrown error carries the
 * real id (rather than the `FACTORY_CONSTRUCTION_DS_ID` sentinel) — the
 * sync-service `normalizeFilesError` and the dashboard banner both
 * consume the id to identify which datasource needs reconfiguring.
 */
export type CredentialShapeValidator = (
  creds: StoredCredentials,
  datasourceId: string,
) => void;

/**
 * A single registry entry: bundles the strategy factory function with the
 * credential-shape validator that gates it, plus the pre-auth factory and
 * the `authKind` discriminator used by `factory.createForAuth(...)`.
 *
 * `authKind` declares whether the provider is OAuth-class (consumes an
 * `OAuthAppConfig` at authenticate-time) or credentials-form-class (the
 * user types credentials directly into a form, no app config needed).
 * `factory.createForAuth(providerId, oauthAppConfig, ctx)` validates the
 * shape of `oauthAppConfig` against this declaration:
 *
 *   - `authKind: "oauth"` + `oauthAppConfig: null` → throw
 *     `DatasourceError(invalid-datasource)`
 *   - `authKind: "credentials-form"` + `oauthAppConfig != null` → throw
 *     same shape
 *
 * Adding a new provider means exporting `create`, `createForAuth`, and
 * `validateCredentialShape` from the strategy module, declaring `authKind`,
 * and adding one entry here — no edits to `factory.create` /
 * `factory.createForAuth` themselves.
 */
export interface ProviderRegistryEntry<
  P extends ProviderId = ProviderId,
> {
  readonly create: ProviderFactoryFn<P>;
  readonly createForAuth: PreAuthFactoryFn<P>;
  readonly validateCredentialShape: CredentialShapeValidator;
  readonly authKind: "oauth" | "credentials-form";
}

/**
 * Map of ProviderId → registry entry, pinned per-key: the entry at key
 * `P` must return a `DatasourceClient<P>`. Must cover every `ProviderId`.
 */
export type ProviderRegistry = {
  [P in ProviderId]: ProviderRegistryEntry<P>;
};

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
   * @throws DatasourceError `tag="invalid-datasource"` if `providerId` is
   *   not in the registry (the datasource's stored providerId does not
   *   match any known provider strategy).
   */
  create<P extends ProviderId>(
    providerId: P,
    datasourceId: string,
    credentials: StoredCredentials,
    ctx: EngineContext,
  ): DatasourceClient<P>;

  /**
   * Construct a DatasourceClient for the no-credentials authenticate flow —
   * implement-datasource-onboarding §3 / spec scenario "Factory exposes
   * `createForAuth` for no-credentials authenticate flows".
   *
   * Sibling to `create`. Used exclusively when the caller has no
   * `StoredCredentials` yet (the very first call to `engine.authenticate()`
   * for a brand-new datasource, or a reconnect for a datasource whose
   * credentials were deleted). The credential store is NOT consulted.
   *
   * Per registry-entry `authKind` declaration:
   *   - OAuth-class provider (`authKind: "oauth"`): `oauthAppConfig` MUST
   *     be non-null. The strategy is constructed with `creds: null` and
   *     `preAuth: oauthAppConfig`. `doAuthenticateImpl()` reads clientId /
   *     clientSecret / redirectUri from the preAuth slot.
   *   - Credentials-form provider (`authKind: "credentials-form"`):
   *     `oauthAppConfig` MUST be null. The strategy is constructed with
   *     stub-empty credentials and `preAuth: null`. `doAuthenticateImpl()`
   *     returns a `CredentialsFormIntent` whose `submit()` validates and
   *     persists the user-supplied values.
   *
   * `datasourceId` is optional — when omitted, the factory mints a
   * temporary id (`"pre-auth-${randomUUID()}"`) so the strategy's
   * event-bus subscription has a stable key during construction. Callers
   * with an existing id (e.g. the renderer's Reconnect path) SHOULD pass
   * it through so events about the in-flight auth flow are addressable.
   *
   * @throws DatasourceError `tag="invalid-datasource"` if:
   *   - `providerId` is not in the registry (unknown provider), OR
   *   - `providerId`'s `authKind` is `"oauth"` but `oauthAppConfig` is
   *     `null`, OR
   *   - `providerId`'s `authKind` is `"credentials-form"` but
   *     `oauthAppConfig` is non-null.
   */
  createForAuth<P extends ProviderId>(
    providerId: P,
    oauthAppConfig: OAuthAppConfig | null,
    ctx: EngineContext,
    datasourceId?: string,
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
          tag: DatasourceErrorTag.InvalidDatasource,
          datasourceType: providerId,
          datasourceId,
          retryable: false,
          raw: "unknown-provider",
          message: `No strategy registered for provider '${providerId}'`,
        });
      }
      // Per-provider credential-shape validation BEFORE strategy
      // construction (per add-invalid-datasource-state Decision 2).
      // The validator throws DatasourceError({ tag: InvalidDatasource,
      // datasourceId }) with a field-naming message on shape failure;
      // success returns void. Passing `datasourceId` so the thrown
      // error carries the real id rather than the construction-sentinel.
      entry.validateCredentialShape(credentials, datasourceId);
      const descriptor = providers[providerId];
      // Construct a fresh BaseClientContext per call — the descriptor is
      // per-provider, so it cannot live inside the EngineContext.
      const baseCtx: BaseClientContext = {
        bus: ctx.bus,
        credentialStore: ctx.credentialStore,
        providerDescriptor: descriptor,
      };
      // `entry.create` is typed as `ProviderFactoryFn<P>` via the mapped
      // type, so the call returns `DatasourceClient<P>` directly.
      // NOTE: callers are responsible for calling `.dispose()` on returned
      // clients when they discard them — strategies that subscribe to the
      // bus (e.g., OneDriveClient) leak the subscription otherwise.
      return entry.create(datasourceId, credentials, baseCtx);
    },

    createForAuth<P extends ProviderId>(
      providerId: P,
      oauthAppConfig: OAuthAppConfig | null,
      ctx: EngineContext,
      datasourceId?: string,
    ): DatasourceClient<P> {
      // Mint a temporary id when the caller did not supply one. The
      // strategy's bus subscription is keyed on this id; a stable value
      // matters for the lifetime of this single authenticate flow.
      const effectiveDatasourceId =
        datasourceId ?? `pre-auth-${randomUUID()}`;

      const entry = registry[providerId];
      if (entry === undefined) {
        throw new DatasourceError({
          tag: DatasourceErrorTag.InvalidDatasource,
          datasourceType: providerId,
          datasourceId: effectiveDatasourceId,
          retryable: false,
          raw: "unknown-provider",
          message: `No strategy registered for provider '${providerId}' (createForAuth)`,
        });
      }

      // §3.5 — validate the oauthAppConfig argument against the entry's
      // declared `authKind`. Mismatch throws invalid-datasource so the
      // caller surfaces the misuse at IPC boundary rather than letting it
      // ride through to a confused strategy at authenticate-time.
      if (entry.authKind === "oauth" && oauthAppConfig === null) {
        throw new DatasourceError({
          tag: DatasourceErrorTag.InvalidDatasource,
          datasourceType: providerId,
          datasourceId: effectiveDatasourceId,
          retryable: false,
          raw: "createForAuth-missing-oauth-app-config",
          message: `createForAuth: provider '${providerId}' is OAuth-class but oauthAppConfig was null — missing OAuth app config (clientId / clientSecret / redirectUri)`,
        });
      }
      if (entry.authKind === "credentials-form" && oauthAppConfig !== null) {
        throw new DatasourceError({
          tag: DatasourceErrorTag.InvalidDatasource,
          datasourceType: providerId,
          datasourceId: effectiveDatasourceId,
          retryable: false,
          raw: "createForAuth-unexpected-oauth-app-config",
          message: `createForAuth: provider '${providerId}' is a credentials-form provider — does not consume an OAuth app config; pass null instead (misuse)`,
        });
      }

      const descriptor = providers[providerId];
      const baseCtx: BaseClientContext = {
        bus: ctx.bus,
        credentialStore: ctx.credentialStore,
        providerDescriptor: descriptor,
      };
      // `entry.createForAuth` is typed as `PreAuthFactoryFn<P>` via the
      // mapped type, so the call returns `DatasourceClient<P>` directly.
      // The strategy receives `preAuth` exactly as supplied — null for
      // credentials-form, non-null for OAuth — and routes via its own
      // internal precedence (see e.g. GoogleDriveClient.getOAuthAppConfig).
      return entry.createForAuth(effectiveDatasourceId, oauthAppConfig, baseCtx);
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
 * All three strategies are real implementations that pass the shared
 * `strategy-contract` suite. Adding a fourth provider: implement a
 * `ProviderFactoryFn`, register it here, and add it to the contract suite.
 */
export function createDefaultProviderRegistry(): ProviderRegistry {
  return {
    "amazon-s3": {
      create: createS3Client,
      createForAuth: createS3ClientForAuth,
      validateCredentialShape: validateS3CredentialShape,
      authKind: "credentials-form",
    },
    "google-drive": {
      create: createGoogleDriveClientForRegistry,
      createForAuth: createGoogleDriveClientForAuth,
      validateCredentialShape: validateGoogleDriveCredentialShape,
      authKind: "oauth",
    },
    onedrive: {
      create: createOneDriveClientForRegistry,
      createForAuth: createOneDriveClientForAuth,
      validateCredentialShape: validateOneDriveCredentialShape,
      authKind: "oauth",
    },
  };
}
