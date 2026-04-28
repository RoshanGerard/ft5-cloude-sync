// Boundary validator for renderer-supplied `toPath` values on the
// `files:download` RPC (per add-engine-rename-download spec.md
// "Requirement: `toPath` validation at the service boundary"). The
// validator is intentionally synchronous-where-possible plus one async
// `fs.access` probe; it returns either `{ ok: true }` or
// `{ ok: false, reason: string }` where `reason` matches the canonical
// per-check phrase the spec scenarios assert on:
//
// 1. `not absolute`                              — `path.isAbsolute(toPath)` is false
// 2. `contains traversal`                        — `path.normalize(toPath) !== toPath`
// 3. `parent directory not writable`             — `fs.access(parent, W_OK)` rejects
// 4. `cannot write inside service data directory` — toPath is inside `~/ft5/sync_app/`
//
// The handler maps a failed validation to
// `{ ok: false, error: { tag: "other", message: \`toPath validation: <reason>\`, retryable: false } }`
// and short-circuits BEFORE any engine call (per spec line 117).
//
// Why dependency-inject `fs.access` and `homedir`. The handler's tests
// run synchronously against a fake filesystem; injecting these two boundary
// functions lets each test pin a writable / unwritable parent and a fixed
// home directory without touching real disk or os state.

import * as nodePath from "node:path";

export type ValidatorReason =
  | "not absolute"
  | "contains traversal"
  | "parent directory not writable"
  | "cannot write inside service data directory";

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ValidatorReason };

export interface PathValidatorDeps {
  /**
   * Probe the parent directory's writability. Default impl uses
   * `node:fs/promises`'s `access` with `W_OK`. Returns `true` when
   * writable, `false` on any rejection (ENOENT, EACCES, etc.).
   */
  readonly canWrite: (path: string) => Promise<boolean>;
  /** Resolve the user's home directory. Default impl wraps `os.homedir`. */
  readonly homedir: () => string;
}

const SERVICE_DATA_SUBDIR = nodePath.join("ft5", "sync_app");

/**
 * Run the four toPath validators in order. The order matters: cheap
 * synchronous checks fail fast before the async `fs.access` probe.
 *
 * Returns the FIRST failure encountered — the spec scenarios assert
 * specific messages, so a single-failure return shape is the right
 * primitive. Callers do NOT batch-render every failure; the renderer
 * surfaces one validation message and the user fixes one thing.
 */
export async function validateToPath(
  toPath: string,
  deps: PathValidatorDeps,
): Promise<ValidationResult> {
  // 1. Absolute path required.
  if (!nodePath.isAbsolute(toPath)) {
    return { ok: false, reason: "not absolute" };
  }

  // 2. No `..` segments after normalize. `path.normalize` resolves
  // `..` segments where it can; if the normalized form differs from the
  // input, the input contained traversal that was either resolved
  // (e.g. `/a/b/../c` → `/a/c`) or unresolvable (e.g. trailing `..`).
  // Either way — reject.
  if (nodePath.normalize(toPath) !== toPath) {
    return { ok: false, reason: "contains traversal" };
  }

  // 4. (run before the async probe to keep validation deterministic in
  // tests that don't wire `canWrite`.) Block writes inside the service's
  // data directory `~/ft5/sync_app/`. Use platform-native path comparison
  // — Windows is case-insensitive at the FS layer, but spec scenarios
  // exercise Unix-flavoured paths only; `startsWith` on the
  // platform-canonical separator is the simplest correct primitive.
  const home = deps.homedir();
  const serviceDataDir = nodePath.join(home, SERVICE_DATA_SUBDIR);
  // Anchor the prefix at a separator so a sibling path like
  // `/home/user/ft5/sync_app_other` is NOT mistakenly rejected.
  const serviceDataPrefix = serviceDataDir + nodePath.sep;
  if (toPath === serviceDataDir || toPath.startsWith(serviceDataPrefix)) {
    return { ok: false, reason: "cannot write inside service data directory" };
  }

  // 3. Parent must be writable. Async — runs last.
  const parent = nodePath.dirname(toPath);
  const writable = await deps.canWrite(parent);
  if (!writable) {
    return { ok: false, reason: "parent directory not writable" };
  }

  return { ok: true };
}
