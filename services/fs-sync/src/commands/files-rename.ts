// `files:rename` command handler (per add-engine-rename-download §12).
// Resolves the engine client for the request's `datasourceId` via the
// existing `ClientFactory` machinery (same path used by `files:list`,
// `files:stat`, `files:search`, `files:remove`) and forwards the call to
// `client.rename(target, newName, conflictPolicy)`.
//
// Per design.md Decision 1 the handler does NOT inspect or carry `kind` —
// the strategy resolves kind within its own provider context (Drive's
// metadata, OneDrive's facet check, S3's `HeadObject` + `ListObjectsV2`
// introspection). The `Target` is built from `path` plus the optional
// `handle` (the same handle-first convention `files:remove` uses for
// providers like Google Drive that permit ambiguous (parent, name)
// tuples).
//
// Errors normalize through `normalizeFilesError` which carries the
// engine's `tag: "conflict"` through to the wire envelope as
// `tag: "conflict", existingPath: <raw.existingPath>` (per design.md
// Decision 7) so the renderer's ConflictResolutionDialog can prompt
// with the colliding sibling path.

import type { DatasourceClient, Target } from "@ft5/fs-datasource-engine";
import { withAuthRefresh } from "@ft5/fs-datasource-engine";
import type { DatasourceType } from "@ft5/ipc-contracts";

import type { CommandHandler } from "../ipc/server.js";

import { mapEngineEntryToFileEntry } from "./files-entry-mapping.js";
import { normalizeFilesError } from "./files-error-mapping.js";

export interface FilesRenameDeps {
  readonly resolveClient: (
    datasourceId: string,
  ) => Promise<DatasourceClient<DatasourceType>>;
}

export function makeFilesRenameHandler(
  deps: FilesRenameDeps,
): CommandHandler<"files:rename"> {
  return async (params) => {
    let client: DatasourceClient<DatasourceType>;
    try {
      client = await deps.resolveClient(params.datasourceId);
    } catch (err) {
      return { ok: false, error: normalizeFilesError(err) };
    }
    // Handle-first when a handle is supplied — unambiguous on every
    // provider (notably Drive, where two entries can share a path but
    // always have distinct handles). Path-form is the fallback for
    // legacy / handle-less callers.
    const target: Target =
      params.handle !== undefined
        ? { kind: "handle", handle: params.handle }
        : { kind: "path", path: params.path };
    try {
      // migrate-engine-retry-policy-to-consumer Decision 4 — engine no longer
      // auto-refreshes on `auth-expired`; handler owns refresh-once/retry-once
      // via `withAuthRefresh` (spec: `files:rename` "wrapped in the engine's
      // withAuthRefresh helper").
      const engineEntry = await withAuthRefresh(client, () =>
        client.rename(target, params.newName, params.conflictPolicy),
      );
      return {
        ok: true,
        result: { entry: mapEngineEntryToFileEntry(engineEntry) },
      };
    } catch (err) {
      return { ok: false, error: normalizeFilesError(err) };
    }
  };
}
