// `files:list` command handler. Resolves the engine client for the given
// datasourceId and delegates to `client.listDirectory({ kind: "path", path })`.
// Engine throws normalize to the 4-tag envelope via `normalizeFilesError`.
//
// `truncated` is hard-coded to `false` in v1: the engine's `listDirectory`
// returns at most one provider page and does not expose a continuation
// token. The follow-up change `add-engine-listdirectory-pagination` is
// tracked in design.md; when it lands, this handler will pass through the
// engine's truncation signal.

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import type { DatasourceType } from "@ft5/ipc-contracts";

import type { CommandHandler } from "../ipc/server.js";

import { mapEngineEntryToFileEntry } from "./files-entry-mapping.js";
import { normalizeFilesError } from "./files-error-mapping.js";

export interface FilesListDeps {
  readonly resolveClient: (
    datasourceId: string,
  ) => Promise<DatasourceClient<DatasourceType>>;
}

export function makeFilesListHandler(
  deps: FilesListDeps,
): CommandHandler<"files:list"> {
  return async (params) => {
    let client: DatasourceClient<DatasourceType>;
    try {
      client = await deps.resolveClient(params.datasourceId);
    } catch (err) {
      return { ok: false, error: normalizeFilesError(err) };
    }
    try {
      const engineEntries = await client.listDirectory({
        kind: "path",
        path: params.path,
      });
      const entries = engineEntries.map(mapEngineEntryToFileEntry);
      return {
        ok: true,
        result: { entries, truncated: false },
      };
    } catch (err) {
      return { ok: false, error: normalizeFilesError(err) };
    }
  };
}
