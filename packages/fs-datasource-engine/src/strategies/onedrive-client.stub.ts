// Phase 5 placeholder for the OneDrive strategy.
//
// The real `OneDriveClient` lands in Phase 7 (wires
// `@microsoft/microsoft-graph-client`). Until then, this stub lets the
// Phase-5 factory plumbing be exercised end-to-end. Any `doX` call throws a
// normalized `provider-error` with `raw: "not-yet-implemented:<method>"`.
//
// When Phase 7 lands, DELETE this file and replace the registry entry in
// `../factory.ts` with the real `OneDriveClient` factory.

import type {
  AuthIntent,
  AuthResult,
  DatasourceStatus,
  FileEntry,
  FileMetadata,
  Quota,
  Target,
} from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

import { BaseDatasourceClient } from "../base-client.js";
import type { ProviderFactoryFn } from "../factory.js";

type OneDriveType = "onedrive";

class OneDriveClientStub extends BaseDatasourceClient<OneDriveType> {
  readonly type: OneDriveType = "onedrive";

  protected override async doStatusImpl(): Promise<DatasourceStatus> {
    throw this.notYetImplemented("doStatus");
  }

  protected override async doTestConnectionImpl(): Promise<void> {
    throw this.notYetImplemented("doTestConnection");
  }

  protected override async doAuthenticateImpl(): Promise<AuthIntent> {
    throw this.notYetImplemented("doAuthenticate");
  }

  protected override async doListDirectoryImpl(
    target: Target,
  ): Promise<FileEntry<OneDriveType>[]> {
    void target;
    throw this.notYetImplemented("doListDirectory");
  }

  protected override async doSearchImpl(
    query: string,
    scope?: Target,
  ): Promise<FileEntry<OneDriveType>[]> {
    void query;
    void scope;
    throw this.notYetImplemented("doSearch");
  }

  protected override async doGetMetadataImpl(
    target: Target,
  ): Promise<FileMetadata<OneDriveType>> {
    void target;
    throw this.notYetImplemented("doGetMetadata");
  }

  protected override async doCreateFileImpl(
    parent: Target,
    name: string,
    content: { path: string },
  ): Promise<FileEntry<OneDriveType>> {
    void parent;
    void name;
    void content;
    throw this.notYetImplemented("doCreateFile");
  }

  protected override async doUploadFileImpl(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<FileEntry<OneDriveType>> {
    void parent;
    void file;
    void onProgress;
    throw this.notYetImplemented("doUploadFile");
  }

  protected override async doDeleteFileImpl(target: Target): Promise<void> {
    void target;
    throw this.notYetImplemented("doDeleteFile");
  }

  protected override async doGetQuotaImpl(): Promise<Quota> {
    throw this.notYetImplemented("doGetQuota");
  }

  protected override async refreshTokenImpl(): Promise<AuthResult> {
    throw this.notYetImplemented("refreshToken");
  }

  protected override normalizeErrorImpl(
    raw: unknown,
  ): DatasourceError<OneDriveType> {
    if (raw instanceof DatasourceError) {
      return raw as DatasourceError<OneDriveType>;
    }
    return new DatasourceError<OneDriveType>({
      tag: "provider-error",
      datasourceType: "onedrive",
      datasourceId: this.datasourceId,
      retryable: false,
      raw,
    });
  }

  private notYetImplemented(method: string): DatasourceError<OneDriveType> {
    return new DatasourceError<OneDriveType>({
      tag: "provider-error",
      datasourceType: "onedrive",
      datasourceId: this.datasourceId,
      retryable: false,
      raw: `not-yet-implemented:${method}`,
      message: `OneDriveClient.${method} not implemented — Phase 7 will land this`,
    });
  }
}

export const createOneDriveClientStub: ProviderFactoryFn<"onedrive"> = (
  datasourceId,
  credentials,
  ctx,
) => {
  void credentials;
  return new OneDriveClientStub({ datasourceId, ctx });
};
