import type { FilesStatRequest, FilesStatResponse } from "@ft5/ipc-contracts";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

import { toFilesErrorEnvelope } from "./error-envelope.js";

export interface FilesStatDeps {
  readonly syncClient: Pick<SyncClient, "request">;
}

export async function handleFilesStat(
  req: FilesStatRequest,
  deps: FilesStatDeps = { syncClient: getSyncClient() },
): Promise<FilesStatResponse> {
  try {
    const result = await deps.syncClient.request("files:stat", {
      datasourceId: req.datasourceId,
      path: req.path,
    });
    return { ok: true, value: { entry: result.entry } };
  } catch (err) {
    return { ok: false, error: toFilesErrorEnvelope(err) };
  }
}
