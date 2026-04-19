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
