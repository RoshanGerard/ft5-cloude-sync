// `files:search` command handler. Resolves the engine client and delegates
// to `client.search(query, { kind: "path", path })` — folder-scoped search.
//
// `truncated` is hard-coded to `false` in v1 for the same reason as
// `files:list`: the engine's search returns a single provider page with no
// continuation marker. When pagination lands via
// `add-engine-listdirectory-pagination`, this handler forwards the signal.

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import { withAuthRefresh } from "@ft5/fs-datasource-engine";
import type { DatasourceType } from "@ft5/ipc-contracts";

import type { CommandHandler } from "../ipc/server.js";

import { mapEngineEntryToFileEntry } from "./files-entry-mapping.js";
import { normalizeFilesError } from "./files-error-mapping.js";

export interface FilesSearchDeps {
  readonly resolveClient: (
    datasourceId: string,
  ) => Promise<DatasourceClient<DatasourceType>>;
}

export function makeFilesSearchHandler(
  deps: FilesSearchDeps,
): CommandHandler<"files:search"> {
  return async (params) => {
    let client: DatasourceClient<DatasourceType>;
    try {
      client = await deps.resolveClient(params.datasourceId);
    } catch (err) {
      return { ok: false, error: normalizeFilesError(err) };
    }
    try {
      // migrate-engine-retry-policy-to-consumer Decision 4 — engine no longer
      // auto-refreshes on `auth-expired`; handler owns refresh-once/retry-once
      // via `withAuthRefresh`.
      const engineEntries = await withAuthRefresh(client, () =>
        client.search(params.query, {
          kind: "path",
          path: params.path,
        }),
      );
      const entries = engineEntries.map(mapEngineEntryToFileEntry);
      return { ok: true, result: { entries, truncated: false } };
    } catch (err) {
      return { ok: false, error: normalizeFilesError(err) };
    }
  };
}
