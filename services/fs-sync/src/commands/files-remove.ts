// `files:remove` command handler. Resolves the engine client once, then
// processes every target in parallel via `Promise.allSettled`. Each
// target is addressed by `handle` (the authoritative engine ID) rather
// than by path — providers like Google Drive permit multiple entries
// with the same path, so a path-based `getMetadata` + `deleteFile` pair
// is ambiguity-vulnerable. Handle-based addressing avoids that entirely
// and also lets us drop the `getMetadata` round-trip: the caller already
// supplies `kind`, so the handler passes it straight to the engine's
// unified `delete(target, entryKind)` (unify-engine-delete-method).
//
// Per-target outcomes are aggregated into the envelope. The outer `ok`
// stays `true` as long as the command itself executed (i.e. resolveClient
// succeeded); per-target errors land in `results[i].error`.
//
// When the sibling change `add-engine-rename-download` lands, its
// `files:rename` / `files:download` handlers SHOULD follow the same
// handle-first pattern — every `files:*` call that mutates or returns a
// single entry is ambiguity-vulnerable on path-only addressing.

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import { withAuthRefresh } from "@ft5/fs-datasource-engine";
import type {
  DatasourceType,
  FilesRemoveEntryResult,
} from "@ft5/ipc-contracts";
import { FilesErrorTag } from "@ft5/ipc-contracts";

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
      params.targets.map(async (target): Promise<FilesRemoveEntryResult> => {
        try {
          // Address by handle — the engine's Target union supports both
          // `{ kind: "path" }` and `{ kind: "handle" }`, and the handle
          // form is unambiguous on every provider. Pass the caller-supplied
          // `kind` (UI's vocab: "directory" / "file") to the unified
          // `delete(target, entryKind)` (unify-engine-delete-method); the
          // engine refuses `"directory"` with `unsupported` in the base
          // (Decision 10) and the caller surfaces that as a per-target error.
          // migrate-engine-retry-policy-to-consumer Decision 4 — engine no
          // longer auto-refreshes on `auth-expired`; each per-target delete
          // owns its own refresh-once/retry-once via `withAuthRefresh`.
          await withAuthRefresh(client, () =>
            client.delete(
              { kind: "handle", handle: target.handle },
              target.kind,
            ),
          );
          return { path: target.path, handle: target.handle, ok: true };
        } catch (err) {
          const normalized = normalizeFilesError(err);
          return {
            path: target.path,
            handle: target.handle,
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
            path: params.targets[i]!.path,
            handle: params.targets[i]!.handle,
            ok: false,
            error: {
              tag: FilesErrorTag.Other,
              message:
                s.reason instanceof Error ? s.reason.message : String(s.reason),
            },
          },
    );
    return { ok: true, result: { results } };
  };
}
