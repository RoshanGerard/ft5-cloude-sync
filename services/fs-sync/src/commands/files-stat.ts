// `files:stat` command handler. Resolves the engine client and delegates
// to `client.getMetadata({ kind: "path", path })`. Errors normalize through
// `normalizeFilesError`.

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import { withAuthRefresh } from "@ft5/fs-datasource-engine";
import type { DatasourceType } from "@ft5/ipc-contracts";

import type { CommandHandler } from "../ipc/server.js";

import { mapEngineEntryToFileEntry } from "./files-entry-mapping.js";
import { normalizeFilesError } from "./files-error-mapping.js";

export interface FilesStatDeps {
  readonly resolveClient: (
    datasourceId: string,
  ) => Promise<DatasourceClient<DatasourceType>>;
}

export function makeFilesStatHandler(
  deps: FilesStatDeps,
): CommandHandler<"files:stat"> {
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
      const engineEntry = await withAuthRefresh(client, () =>
        client.getMetadata({
          kind: "path",
          path: params.path,
        }),
      );
      return { ok: true, result: { entry: mapEngineEntryToFileEntry(engineEntry) } };
    } catch (err) {
      return { ok: false, error: normalizeFilesError(err) };
    }
  };
}
