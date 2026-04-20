import type { FileEntry } from "@ft5/ipc-contracts";

import type { ExplorerState, PendingOp } from "./store";

// Hides the pendingOps key asymmetry: rename stores by entry.id, remove
// stores by entry.path (see store.ts `remove` / `rename`). Callers ask
// "is this entry in flight?" without knowing which key-shape the op used.

export function entryPendingOp(
  state: ExplorerState,
  entry: Pick<FileEntry, "id" | "path">,
): PendingOp | null {
  return (
    state.pendingOps[entry.id] ?? state.pendingOps[entry.path] ?? null
  );
}

export function entryError(
  state: ExplorerState,
  entry: Pick<FileEntry, "id">,
): string | null {
  if (state.lastError === null) return null;
  return state.lastError.entryId === entry.id ? state.lastError.reason : null;
}
