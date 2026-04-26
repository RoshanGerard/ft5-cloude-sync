// Resolves every on-disk path the service uses. All reads/writes flow
// through these helpers so tests can pin `FT5_SYNC_DATA_DIR` or the `--dev`
// flag without mutating global state in production code.
//
// Spec: base spec requirement "Data directory layout at `$HOME/ft5/sync_app`"
// and design.md D5 + D17.

import * as os from "node:os";
import * as path from "node:path";

export interface PathOptions {
  readonly dev: boolean;
}

/**
 * Root data directory. Honours `FT5_SYNC_DATA_DIR` over everything else;
 * otherwise `$HOME/ft5/sync_app/` (prod) or `$HOME/ft5/sync_app/dev/` (dev).
 *
 * Pass `env` only in tests that need to override `process.env` — production
 * callers pass no second argument.
 */
export function resolveDataDir(
  options: PathOptions,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env["FT5_SYNC_DATA_DIR"];
  if (override !== undefined && override !== "") {
    return override;
  }
  const root = path.join(os.homedir(), "ft5", "sync_app");
  return options.dev ? path.join(root, "dev") : root;
}

export function resolveCredentialsPath(
  options: PathOptions,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(resolveDataDir(options, env), "credentials.json");
}

/**
 * OAuth-app config path used by `ServiceConfigStore`. The config file holds
 * per-provider `clientId`/`clientSecret` for OAuth-class providers (see
 * `services/fs-sync/config.example.json` for the canonical schema). Lives
 * alongside `credentials.json` under the same data dir so the user's
 * `~/ft5/sync_app/` (or dev `~/ft5/sync_app/dev/`) holds a single co-located
 * configuration surface.
 */
export function resolveServiceConfigPath(
  options: PathOptions,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(resolveDataDir(options, env), "config.json");
}

export function resolveDbPath(
  options: PathOptions,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(resolveDataDir(options, env), "sync.db");
}

/**
 * IPC transport path. On Windows this is a named-pipe string (`\\.\pipe\...`
 * — not a filesystem path), so it ignores the data dir and uses a constant
 * per the base spec. On Unix it's a socket file under the data dir.
 */
export function resolveSocketPath(
  options: PathOptions,
  env?: NodeJS.ProcessEnv,
): string {
  if (process.platform === "win32") {
    return options.dev ? "\\\\.\\pipe\\ft5-sync-dev" : "\\\\.\\pipe\\ft5-sync";
  }
  const basename = options.dev ? "sync-dev.sock" : "sync.sock";
  return path.join(resolveDataDir(options, env), basename);
}

export function resolvePidPath(
  options: PathOptions,
  env?: NodeJS.ProcessEnv,
): string {
  const basename = options.dev ? "service-dev.pid" : "service.pid";
  return path.join(resolveDataDir(options, env), basename);
}

export function resolveLogPath(
  options: PathOptions,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(resolveDataDir(options, env), "service.log");
}
