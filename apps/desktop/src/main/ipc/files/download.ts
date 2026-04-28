import type {
  FilesDownloadRequest,
  FilesDownloadResponse,
} from "@ft5/ipc-contracts";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

import { toFilesErrorEnvelope } from "./error-envelope.js";

export interface FilesDownloadDeps {
  readonly syncClient: Pick<SyncClient, "request">;
}

export async function handleFilesDownload(
  req: FilesDownloadRequest,
  deps: FilesDownloadDeps = { syncClient: getSyncClient() },
): Promise<FilesDownloadResponse> {
  try {
    const result = await deps.syncClient.request("files:download", {
      datasourceId: req.datasourceId,
      path: req.path,
      toPath: req.toPath,
    });
    return {
      ok: true,
      value: { savedPath: result.savedPath, bytes: result.bytes },
    };
  } catch (err) {
    return { ok: false, error: toFilesErrorEnvelope(err) };
  }
}
