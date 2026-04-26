// `sync:delete-credentials` handler — implement-datasource-onboarding
// §13 + design.md Decision 12 (symmetric counterpart to authenticate).
//
// Behaviour (per spec ADDED Requirement
// "sync:delete-credentials removes the per-user credential entry"):
//   - Pre-check via `credentialStore.get(datasourceId)` to distinguish
//     "deleted" vs "did not exist" — the engine port's `delete(...)` is
//     a `Promise<void>` so we can't get the boolean from the store
//     itself.
//   - Pre-check null → return `{ok: true, result: {deleted: false}}`,
//     do NOT call delete (avoids a write of identical state).
//   - Pre-check non-null → call `credentialStore.delete(datasourceId)`.
//     On success return `{ok: true, result: {deleted: true}}`.
//   - On delete throw: log structured warning
//     `bridge-credential-delete-failed` with `{datasourceId,
//     errorMessage}` and return `{ok: true, result: {deleted: false}}`.
//     Best-effort cleanup — the desktop's datasources:remove path needs
//     the local registry-row delete to succeed regardless of whether the
//     credential file write succeeded.
//
// Race note: between the get and the delete, a concurrent call could
// race. This is acceptable in v1 because (a) credential file writes go
// through a single file with no locking either way, and (b) the engine's
// CredentialStore.delete is documented idempotent.

import type { CredentialStore } from "@ft5/fs-datasource-engine";

import type { CommandHandler } from "../ipc/server.js";

export interface DeleteCredentialsHandlerLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface DeleteCredentialsHandlerDeps {
  readonly credentialStore: CredentialStore;
  readonly logger?: DeleteCredentialsHandlerLogger;
}

export function makeDeleteCredentialsHandler(
  deps: DeleteCredentialsHandlerDeps,
): CommandHandler<"sync:delete-credentials"> {
  return async (params) => {
    const { datasourceId } = params;

    // Pre-check: does an entry exist? If get throws (corrupt file,
    // permissions widened), treat as "best-effort cleanup failed" so the
    // dashboard remove path still succeeds.
    let existed: boolean;
    try {
      const found = await deps.credentialStore.get(datasourceId);
      existed = found !== null;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      deps.logger?.warn("bridge-credential-delete-failed", {
        datasourceId,
        errorMessage,
        phase: "pre-check-get",
      });
      return { ok: true, result: { deleted: false } };
    }

    if (!existed) {
      // Nothing to do — return false without calling delete (avoids a
      // no-op write of identical file content).
      return { ok: true, result: { deleted: false } };
    }

    try {
      await deps.credentialStore.delete(datasourceId);
      return { ok: true, result: { deleted: true } };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      deps.logger?.warn("bridge-credential-delete-failed", {
        datasourceId,
        errorMessage,
        phase: "delete",
      });
      return { ok: true, result: { deleted: false } };
    }
  };
}
