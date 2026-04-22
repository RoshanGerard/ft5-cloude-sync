// Desktop-side mirror of `services/fs-sync/src/env/paths.ts` —
// `resolveSocketPath` specifically. The desktop supervisor (task 4.10)
// must dial the same pipe path the service listens on; mirroring the
// resolution logic here keeps the two processes in sync while
// preserving the architectural rule that the service has no desktop
// imports and vice versa (see `openspec/project.md`).
//
// The helper is pure: `platform` and `homedir` are injectable seams
// for unit-testability (see `pipe-paths.test.ts`). Production callers
// pass only `{ dev }` and inherit the process/OS defaults.

import * as os from "node:os";
import * as path from "node:path";

export interface ResolveSyncPipePathOptions {
  readonly dev: boolean;
  /** Defaults to `process.platform`. Inject in tests. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `os.homedir`. Inject in tests. */
  readonly homedir?: () => string;
}

/**
 * Returns the IPC pipe path for the desktop↔fs-sync-service transport.
 * Windows: named pipe (`\\.\pipe\ft5-sync[-dev]`).
 * Unix: socket file under `$HOME/ft5/sync_app/sync[-dev].sock`.
 * MUST match `resolveSocketPath` in the service.
 */
export function resolveSyncPipePath(
  options: ResolveSyncPipePathOptions,
): string {
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir;

  if (platform === "win32") {
    return options.dev ? "\\\\.\\pipe\\ft5-sync-dev" : "\\\\.\\pipe\\ft5-sync";
  }
  const basename = options.dev ? "sync-dev.sock" : "sync.sock";
  return path.join(homedir(), "ft5", "sync_app", basename);
}
