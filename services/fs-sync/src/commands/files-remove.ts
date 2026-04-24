// `files:remove` command handler. Resolves the engine client once, then
// processes every path in parallel via `Promise.allSettled`. Each path is
// stat'd to decide between `deleteFile` and `deleteDirectory`. Per-path
// results are aggregated into the envelope. The outer `ok` stays `true`
// as long as the command itself executed (i.e. resolveClient succeeded);
// per-path errors land in `results[i].error`.

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import type {
  DatasourceType,
  FilesRemoveEntryResult,
} from "@ft5/ipc-contracts";

import type { CommandHandler } from "../ipc/server.js";

import { normalizeFilesError } from "./files-error-mapping.js";

export interface FilesRemoveDeps {
  readonly resolveClient: (
    datasourceId: string,
  ) => Promise<DatasourceClient<DatasourceType>>;
}

export function makeFilesRemoveHandler(
  deps: FilesRemoveDeps,
): CommandHandler<"files:remove"> {
  return async (params) => {
    let client: DatasourceClient<DatasourceType>;
    try {
      client = await deps.resolveClient(params.datasourceId);
    } catch (err) {
      return { ok: false, error: normalizeFilesError(err) };
    }
    const settled = await Promise.allSettled(
      params.paths.map(async (path): Promise<FilesRemoveEntryResult> => {
        try {
          // Engine vocab uses "folder"; the UI's FileEntry vocab uses
          // "directory". At the engine seam we switch on the engine value.
          const entry = await client.getMetadata({ kind: "path", path });
          if (entry.kind === "folder") {
            await client.deleteDirectory({ kind: "path", path });
          } else {
            await client.deleteFile({ kind: "path", path });
          }
          return { path, ok: true };
        } catch (err) {
          const normalized = normalizeFilesError(err);
          return {
            path,
            ok: false,
            error: { tag: normalized.tag, message: normalized.message },
          };
        }
      }),
    );
    // Every inner promise catches its own error, so nothing rejects here —
    // Promise.allSettled is defensive against a stray throw in the mapper.
    const results: FilesRemoveEntryResult[] = settled.map((s, i) =>
      s.status === "fulfilled"
        ? s.value
        : {
            path: params.paths[i]!,
            ok: false,
            error: {
              tag: "other",
              message:
                s.reason instanceof Error ? s.reason.message : String(s.reason),
            },
          },
    );
    return { ok: true, result: { results } };
  };
}
