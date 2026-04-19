// Phase 5 placeholder for the Amazon S3 strategy.
//
// The real `S3Client` lands in Phase 6 (wires `@aws-sdk/client-s3` +
// `@aws-sdk/lib-storage`). Until then, this stub lets the Phase-5 factory
// plumbing be exercised end-to-end: construction succeeds, the returned
// object satisfies `DatasourceClient<"amazon-s3">`, and any attempt to
// exercise a real operation throws a normalized `provider-error` with
// `raw: "not-yet-implemented:<method>"`.
//
// When Phase 6 lands, DELETE this file and replace the registry entry in
// `../factory.ts` with the real `S3Client` factory.

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

type S3Type = "amazon-s3";

class S3ClientStub extends BaseDatasourceClient<S3Type> {
  readonly type: S3Type = "amazon-s3";

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
  ): Promise<FileEntry<S3Type>[]> {
    void target;
    throw this.notYetImplemented("doListDirectory");
  }

  protected override async doSearchImpl(
    query: string,
    scope?: Target,
  ): Promise<FileEntry<S3Type>[]> {
    void query;
    void scope;
    throw this.notYetImplemented("doSearch");
  }

  protected override async doGetMetadataImpl(
    target: Target,
  ): Promise<FileMetadata<S3Type>> {
    void target;
    throw this.notYetImplemented("doGetMetadata");
  }

  protected override async doCreateFileImpl(
    parent: Target,
    name: string,
    content: { path: string },
  ): Promise<FileEntry<S3Type>> {
    void parent;
    void name;
    void content;
    throw this.notYetImplemented("doCreateFile");
  }

  protected override async doUploadFileImpl(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
  ): Promise<FileEntry<S3Type>> {
    void parent;
    void file;
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

  protected override normalizeErrorImpl(raw: unknown): DatasourceError<S3Type> {
    // Pass-through for already-normalized errors keeps stub emission paths
    // predictable when the base routes a `notYetImplemented` exception
    // through the normalizer.
    if (raw instanceof DatasourceError) {
      return raw as DatasourceError<S3Type>;
    }
    return new DatasourceError<S3Type>({
      tag: "provider-error",
      datasourceType: "amazon-s3",
      datasourceId: this.datasourceId,
      retryable: false,
      raw,
    });
  }

  private notYetImplemented(method: string): DatasourceError<S3Type> {
    return new DatasourceError<S3Type>({
      tag: "provider-error",
      datasourceType: "amazon-s3",
      datasourceId: this.datasourceId,
      retryable: false,
      raw: `not-yet-implemented:${method}`,
      message: `S3Client.${method} not implemented — Phase 6 will land this`,
    });
  }
}

export const createS3ClientStub: ProviderFactoryFn<"amazon-s3"> = (
  datasourceId,
  credentials,
  ctx,
) => {
  // Credentials will be consumed by the real strategy in Phase 6.
  void credentials;
  return new S3ClientStub({ datasourceId, ctx });
};
