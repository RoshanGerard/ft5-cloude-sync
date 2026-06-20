// Phase 1 scaffold: the FS Datasource Engine is a framework-agnostic workspace
// package (no Electron imports). The runtime surface (BaseDatasourceClient,
// ClientFactory, ProviderRegistry, concrete strategies) arrives in
// Phases 3–8. For now the package re-exports the shared contract types that
// live in `@ft5/ipc-contracts` so consumers can begin programming against the
// public types without yet instantiating any runtime.
export type {
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  DatasourceErrorTag,
  DatasourceType,
  DatasourceFileEntry,
  FileMetadata,
  DatasourceMimeFamily,
  OAuthIntent,
  ProviderMetadata,
  Quota,
  StoredCredentials,
  Target,
} from "@ft5/ipc-contracts";
export { DatasourceError } from "@ft5/ipc-contracts";

// migrate-engine-events-to-consumer Decision 1: the engine no longer owns an
// event bus. Public methods return typed results or throw a normalized
// `DatasourceError` with no bus side effects; downstream consumers (fs-sync)
// own all event emission. The former `createEventBus` / `EventBus` /
// `EventBusOptions` / `Clock` / `ClockTimer` exports are removed.

// Phase 3: Template base class + Strategy interface. The three concrete
// strategies (S3, OneDrive, Google Drive) live under `./strategies/` and
// are wired by `createDefaultProviderRegistry` below.
export { BaseDatasourceClient } from "./base-client.js";
export type {
  BaseClientContext,
  BaseClientInit,
  ConflictPolicy,
  DatasourceClient,
  DownloadOptions,
  DownloadResult,
} from "./base-client.js";

// migrate-engine-retry-policy-to-consumer Decision 3: the default,
// replaceable one-shot refresh-then-retry policy. Callers wrap a single
// engine op in `withAuthRefresh(client, () => client.op(...))` to reproduce
// the auth-expired refresh-and-retry the base used to bake in via the
// removed `withRefresh`.
export { withAuthRefresh } from "./with-auth-refresh.js";

// Phase 4: CredentialStore port. The concrete implementation
// (SqliteCredentialStore + safeStorage) lives in `apps/desktop` because it
// depends on Electron; the engine package stays framework-agnostic.
export type { CredentialStore } from "./credential-store.js";

// implement-datasource-onboarding §2: OAuth application registration config.
// `OAuthAppConfig` is the canonical shape consumed by the
// `factory.createForAuth(...)` path (§3) and the per-strategy
// `preAuth?: PreAuthConfig` constructor slot (§2.4-§2.7). `PreAuthConfig`
// is a structural alias of `OAuthAppConfig` used at the strategy
// constructor parameter site to clarify intent.
export type { OAuthAppConfig, PreAuthConfig } from "./auth-types.js";

// ProviderRegistry + ClientFactory. The factory is stateless — each
// `create` call returns a fresh DatasourceClient — and validates registry
// integrity eagerly at construction. `createDefaultProviderRegistry` wires
// three real provider strategies that pass the shared `strategy-contract`
// suite: `strategies/s3-client.ts`, `strategies/onedrive-client.ts`, and
// `strategies/googledrive-client.ts`. The integrity validation still
// applies to any future registration.
export {
  createClientFactory,
  createDefaultProviderRegistry,
} from "./factory.js";
export type {
  ClientFactory,
  CredentialShapeValidator,
  EngineContext,
  PreAuthFactoryFn,
  ProviderFactoryFn,
  ProviderRegistry,
  ProviderRegistryEntry,
} from "./factory.js";
