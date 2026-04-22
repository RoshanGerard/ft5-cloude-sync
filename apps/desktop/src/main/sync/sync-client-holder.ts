// sync-client-holder — a module-scoped singleton slot for the
// bootstrapped `SyncClient`. Populated once by `bootstrap()` in
// `main/index.ts` (task 4.10) after `startSupervisor` resolves;
// consumed at call time by the sync IPC handlers registered in
// section 5 of the wire-fs-sync-service plan.
//
// Why a module-scoped holder instead of threading a reference through
// `registerIpcHandlers`? The handlers in section 5 are numerous and
// live under `main/ipc/sync/*.ts`; passing the client explicitly
// through each registration call adds boilerplate without testability
// benefit (handlers are already unit-tested with a mocked `SyncClient`
// directly, not via this holder). The holder keeps the wiring ergonomic
// while preserving a clear, testable contract:
//   - `setSyncClient` is once-only: a second call indicates bootstrap
//     was invoked twice, which is a programmer mistake worth failing
//     loudly.
//   - `getSyncClient` throws a descriptive error if called before set.
//     If supervisor bring-up fails and bootstrap chooses to continue
//     booting (see task 4.10 wiring), handler invocations will surface
//     this error to the renderer as a structured IPC failure rather
//     than silently hanging.

import type { SyncClient } from "./client.js";

let current: SyncClient | null = null;

export function setSyncClient(client: SyncClient): void {
  if (current) {
    throw new Error("sync client already set — bootstrap called twice?");
  }
  current = client;
}

export function getSyncClient(): SyncClient {
  if (!current) {
    throw new Error(
      "sync client not initialized — IPC handler invoked before supervisor started",
    );
  }
  return current;
}

/** Test-only reset; do not call from production code. */
export function __resetSyncClientForTesting(): void {
  current = null;
}
