// `sync:cancel-upload` command handler (per
// migrate-upload-orchestration-out-of-engine §10.2 + spec.md
// "Requirement: `sync:cancel-upload` RPC"). Mirror of
// `sync:cancel-download`.
//
// Idempotent: cancel of an unknown / already-terminal job resolves with
// `{ cancelled: false }` rather than erroring; cancel of a live job
// invokes `entry.abortController.abort()`, the in-flight strategy
// rejects with `DatasourceError { tag: "cancelled" }`, the
// `files:upload` handler emits a single `upload-cancelled` event, and
// the original `files:upload` promise rejects with the cancelled
// envelope.
//
// The handler does NOT delete the registry entry — that's the
// `files:upload` handler's catch-path responsibility (per spec.md). A
// repeat cancel arriving before the catch path runs sees the same entry
// and returns `cancelled: true` again — calling `.abort()` on a
// signal that is already aborted is a no-op.

import type { CommandHandler } from "../ipc/server.js";

import type { UploadRegistry } from "../uploads/registry.js";

export interface SyncCancelUploadDeps {
  readonly registry: UploadRegistry;
}

export function makeSyncCancelUploadHandler(
  deps: SyncCancelUploadDeps,
): CommandHandler<"sync:cancel-upload"> {
  return async (params) => {
    const entry = deps.registry.get(params.uploadJobId);
    if (entry === undefined) {
      return { ok: true, result: { cancelled: false } };
    }
    entry.abortController.abort();
    return { ok: true, result: { cancelled: true } };
  };
}
