import type { FilesListRequest, FilesListResponse } from "@ft5/ipc-contracts";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

import { toFilesErrorEnvelope } from "./error-envelope.js";

export interface FilesListDeps {
  readonly syncClient: Pick<SyncClient, "request">;
}

export async function handleFilesList(
  req: FilesListRequest,
  deps: FilesListDeps = { syncClient: getSyncClient() },
): Promise<FilesListResponse> {
  try {
    const result = await deps.syncClient.request("files:list", {
      datasourceId: req.datasourceId,
      path: req.path,
      // Forward pagination params per-key: under exactOptionalPropertyTypes the
      // command's bare-optional `cursor?`/`pageSize?` reject an explicit
      // `undefined`, so only include each key when the renderer supplied it.
      ...(req.cursor !== undefined ? { cursor: req.cursor } : {}),
      ...(req.pageSize !== undefined ? { pageSize: req.pageSize } : {}),
    });
    return {
      ok: true,
      value: {
        entries: [...result.entries],
        truncated: result.truncated,
        nextCursor: result.nextCursor,
      },
    };
  } catch (err) {
    return { ok: false, error: toFilesErrorEnvelope(err) };
  }
}
