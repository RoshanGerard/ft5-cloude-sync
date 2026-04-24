import type {
  FilesRemoveEntryResult,
  FilesRemoveRequest,
  FilesRemoveResponse,
} from "@ft5/ipc-contracts";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

import { toFilesErrorEnvelope } from "./error-envelope.js";

export interface FilesRemoveDeps {
  readonly syncClient: Pick<SyncClient, "request">;
}

export async function handleFilesRemove(
  req: FilesRemoveRequest,
  deps: FilesRemoveDeps = { syncClient: getSyncClient() },
): Promise<FilesRemoveResponse> {
  try {
    const result = await deps.syncClient.request("files:remove", {
      datasourceId: req.datasourceId,
      paths: req.paths,
    });
    return {
      ok: true,
      value: { results: [...result.results] as FilesRemoveEntryResult[] },
    };
  } catch (err) {
    return { ok: false, error: toFilesErrorEnvelope(err) };
  }
}
