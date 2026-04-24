// Desktop-side mirror of `services/fs-sync/src/env/paths.ts` —
// `resolveSocketPath` specifically. The desktop supervisor (task 4.10)
// must dial the same pipe path the service listens on; mirroring the
// resolution logic here keeps the two processes in sync while
// preserving the architectural rule that the service has no desktop
// imports and vice versa (see `openspec/project.md`).
//
// MIRROR INVARIANT: every branch below MUST match the service's
// `resolveDataDir` + `resolveSocketPath` exactly. The service is the
// canonical source — if a mismatch is suspected, read
// `services/fs-sync/src/env/paths.ts` and reconcile here.
//
// The helper is pure: `platform`, `homedir`, and `env` are injectable
// seams for unit-testability (see `pipe-paths.test.ts`). Production
// callers pass only `{ dev }` and inherit the process/OS defaults.

import * as os from "node:os";
import * as path from "node:path";

export interface ResolveSyncPipePathOptions {
  readonly dev: boolean;
  /** Defaults to `process.platform`. Inject in tests. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `os.homedir`. Inject in tests. */
  readonly homedir?: () => string;
  /** Defaults to `process.env`. Inject in tests. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Returns the IPC pipe path for the desktop↔fs-sync-service transport.
 * Windows: named pipe (`\\.\pipe\ft5-sync[-dev]`).
 * Unix: socket file under `$HOME/ft5/sync_app[/dev]/sync[-dev].sock`.
 *
 * Honours `FT5_SYNC_DATA_DIR` over the default home-relative path on Unix,
 * matching the service's `resolveDataDir` behaviour. Windows ignores the
 * env var because the named-pipe namespace is global, not filesystem-bound.
 *
 * MUST stay in lockstep with `resolveSocketPath` in
 * `services/fs-sync/src/env/paths.ts` — see MIRROR INVARIANT above.
 */
export function resolveSyncPipePath(
  options: ResolveSyncPipePathOptions,
): string {
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    return options.dev ? "\\\\.\\pipe\\ft5-sync-dev" : "\\\\.\\pipe\\ft5-sync";
  }

  const homedir = options.homedir ?? os.homedir;
  const env = options.env ?? process.env;
  const override = env["FT5_SYNC_DATA_DIR"];
  const dataDir =
    override !== undefined && override !== ""
      ? override
      : options.dev
        ? path.join(homedir(), "ft5", "sync_app", "dev")
        : path.join(homedir(), "ft5", "sync_app");
  const basename = options.dev ? "sync-dev.sock" : "sync.sock";
  return path.join(dataDir, basename);
}
