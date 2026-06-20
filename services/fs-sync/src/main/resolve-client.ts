// Per-datasource resolver. Reads credentials from the store, then asks
// the factory to construct a fresh client. Executors invoke this via
// the `deps.resolveClient` port — no strategy SDKs imported here.
//
// Extracted from bootstrap.ts so the InvalidDatasource throw path is
// directly unit-testable per add-invalid-datasource-state §5.

import {
  type ClientFactory,
  type CredentialStore,
  type DatasourceClient,
} from "@ft5/fs-datasource-engine";
import {
  DatasourceError,
  DatasourceErrorTag,
  type DatasourceType,
  type ProviderId,
} from "@ft5/ipc-contracts";

export interface ResolveClientDeps {
  readonly credentialStore: CredentialStore;
  readonly factory: ClientFactory;
}

export type ResolveClient = (
  datasourceId: string,
) => Promise<DatasourceClient<DatasourceType>>;

export function createResolveClient(deps: ResolveClientDeps): ResolveClient {
  return async (datasourceId) => {
    const creds = await deps.credentialStore.get(datasourceId);
    if (creds === null) {
      // Per add-invalid-datasource-state Decision 2 — `resolveClient`
      // is the single service-side choke point for misconfigured
      // datasources. The renderer's `<InvalidDatasourceState>` (file
      // explorer) and `<InvalidDatasourceBanner>` (dashboard card) both
      // render the actionable Reconnect / Remove affordances when this
      // tag surfaces. `datasourceType` is a placeholder ("google-drive")
      // because the real provider id is unknown when credentials are
      // missing — the FilesErrorEnvelope drops this field anyway, so
      // it does not affect the renderer.
      throw new DatasourceError({
        tag: DatasourceErrorTag.InvalidDatasource,
        datasourceType: "google-drive",
        datasourceId,
        retryable: false,
        raw: "no-credentials-registered",
        message: "Credentials are missing — reconnect this datasource",
      });
    }
    return deps.factory.create(
      creds.providerId as ProviderId,
      datasourceId,
      creds,
      { credentialStore: deps.credentialStore },
    ) as DatasourceClient<DatasourceType>;
  };
}
