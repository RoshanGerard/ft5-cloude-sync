import type {
  FilesSearchRequest,
  FilesSearchResponse,
} from "@ft5/ipc-contracts";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

import { toFilesErrorEnvelope } from "./error-envelope.js";

export interface FilesSearchDeps {
  readonly syncClient: Pick<SyncClient, "request">;
}

export async function handleFilesSearch(
  req: FilesSearchRequest,
  deps: FilesSearchDeps = { syncClient: getSyncClient() },
): Promise<FilesSearchResponse> {
  try {
    const result = await deps.syncClient.request("files:search", {
      datasourceId: req.datasourceId,
      query: req.query,
      path: req.path,
    });
    return {
      ok: true,
      value: {
        entries: [...result.entries],
        truncated: result.truncated,
      },
    };
  } catch (err) {
    return { ok: false, error: toFilesErrorEnvelope(err) };
  }
}
