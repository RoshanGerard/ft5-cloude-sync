import type {
  FilesRenameRequest,
  FilesRenameResponse,
} from "@ft5/ipc-contracts";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

import { toFilesErrorEnvelope } from "./error-envelope.js";

export interface FilesRenameDeps {
  readonly syncClient: Pick<SyncClient, "request">;
}

export async function handleFilesRename(
  req: FilesRenameRequest,
  deps: FilesRenameDeps = { syncClient: getSyncClient() },
): Promise<FilesRenameResponse> {
  try {
    const result = await deps.syncClient.request("files:rename", {
      datasourceId: req.datasourceId,
      path: req.path,
      newName: req.newName,
      conflictPolicy: req.conflictPolicy,
    });
    return { ok: true, value: { entry: result.entry } };
  } catch (err) {
    return { ok: false, error: toFilesErrorEnvelope(err) };
  }
}
