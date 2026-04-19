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
  FileEntry,
  FileMetadata,
  MimeFamily,
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

// Phase 3: Template base class + Strategy interface.
// Concrete strategies (S3, OneDrive, Google Drive) land in Phases 6-8.
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
