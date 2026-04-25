// Phase 1 scaffold: the FS Datasource Engine is a framework-agnostic workspace
// package (no Electron imports). The runtime surface (EventBus,
// BaseDatasourceClient, ClientFactory, ProviderRegistry, concrete strategies)
// arrives in Phases 2–8. For now the package re-exports the shared contract
// types that live in `@ft5/ipc-contracts` so consumers can begin programming
// against the public types without yet instantiating any runtime.
export type {
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  DatasourceEvent,
  DatasourceErrorTag,
  DatasourceType,
  DatasourceFileEntry,
  FileMetadata,
  DatasourceMimeFamily,
  OAuthIntent,
  PayloadMap,
  ProviderMetadata,
  Quota,
  StoredCredentials,
  Target,
} from "@ft5/ipc-contracts";
export { DatasourceError } from "@ft5/ipc-contracts";

// Phase 2: event bus runtime. Framework-agnostic — pure Node, no Electron.
export { createEventBus } from "./event-bus.js";
export type {
  Clock,
  ClockTimer,
  EventBus,
  EventBusOptions,
} from "./event-bus.js";

// Phase 3: Template base class + Strategy interface. The three concrete
// strategies (S3, OneDrive, Google Drive) live under `./strategies/` and
// are wired by `createDefaultProviderRegistry` below.
export { BaseDatasourceClient } from "./base-client.js";
export type {
  BaseClientContext,
  BaseClientInit,
  DatasourceClient,
} from "./base-client.js";

// Phase 4: CredentialStore port. The concrete implementation
// (SqliteCredentialStore + safeStorage) lives in `apps/desktop` because it
// depends on Electron; the engine package stays framework-agnostic.
export type { CredentialStore } from "./credential-store.js";

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
  ProviderFactoryFn,
  ProviderRegistry,
  ProviderRegistryEntry,
} from "./factory.js";
