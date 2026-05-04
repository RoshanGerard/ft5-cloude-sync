// `"keep-both"` suffix-loop helper for the `files:download` conflict
// gate (per add-download-overwrite-confirm design.md Decision 2).
//
// Pure function over `(toPath, deps.open)` returning the resolved free
// path. Race-free against the local FS via Node `fs.open(candidate,
// "wx")` (the equivalent of `O_CREAT|O_EXCL`): if a sibling process
// creates the candidate between our probe and our open, the open
// rejects with `EEXIST` and we try the next integer.
//
// On success the candidate path now exists as a 0-byte file (the
// `O_CREAT|O_EXCL` open created it); the helper closes the handle
// before returning. The caller's cycle loop subsequently re-opens the
// path with `flags: "w", start: 0` and writes the actual download
// payload — the 0-byte sentinel is overwritten.
//
// Convention: parenthesized integer starting at `(1)`, incrementing.
// `name (1).ext`, `name (2).ext`, ... matches the rename strategy's
// `keep-both` suffix (per add-engine-rename-download Decision 7).
//
// Edge cases:
// - `name.ext` with no extension (e.g., `Makefile`) → `Makefile (1)`.
// - Dotfile (`.bashrc`) → `.bashrc (1)` (path.parse treats the
//   leading-dot name as the full `name` with empty `ext`, which
//   reassembles correctly via `name + " (N)" + ext`).
// - The helper does NOT probe `toPath` itself — it goes straight to
//   `(1)`, `(2)`, .... The caller is responsible for confirming the
//   conflict exists at `toPath` before calling.
// - Non-EEXIST errors (EACCES, EIO, ENOSPC, filename-too-long, ...)
//   propagate to the caller; the handler's outer catch routes them
//   via `normalizeFilesError`.

import * as nodePath from "node:path";

/**
 * Dependency bundle. The single primitive is the `O_CREAT|O_EXCL`
 * atomic open — Node's `fs.open(path, "wx")` returns a handle on
 * success, throws `EEXIST` when the path already exists. Tests inject
 * an in-memory fake; production wires the real `fs.open` through the
 * handler's `FsBoundary`.
 */
export interface KeepBothSuffixDeps {
  open(path: string, flags: "wx"): Promise<{ close: () => Promise<void> }>;
}

/**
 * Resolve a free filename by iteratively probing `name (1).ext`,
 * `name (2).ext`, ... via `O_CREAT|O_EXCL`. Returns the first
 * candidate that opens successfully. Closes the handle before
 * returning.
 *
 * Caller MUST confirm the original `toPath` already conflicts before
 * calling — the helper goes straight to `(1)` without probing
 * `toPath`. If a `"keep-both"` dispatch arrives with no existing
 * file at `toPath`, the caller leaves `effectiveTargetPath ===
 * toPath` and skips the helper entirely.
 *
 * @param toPath The original conflicting destination.
 * @param deps   Open primitive (real `fs.open` in production).
 * @returns      The resolved free path.
 */
export async function resolveKeepBothSuffix(
  toPath: string,
  deps: KeepBothSuffixDeps,
): Promise<string> {
  const parsed = nodePath.parse(toPath);
  // path.parse leaves `dir` empty for relative-name inputs; reassemble
  // safely via path.format (which skips empty `dir` cleanly).
  let suffix = 1;
  // Unbounded in this design (per design.md Decision 2 edge cases) —
  // ENOSPC / filename-too-long / pathological collision counts surface
  // as the underlying error.
  for (;;) {
    const candidateBase = `${parsed.name} (${suffix})${parsed.ext}`;
    const candidate = nodePath.format({
      dir: parsed.dir,
      base: candidateBase,
    });
    try {
      const handle = await deps.open(candidate, "wx");
      // Close before returning so the caller's `createWriteStream(path,
      // { flags: "w" })` opens cleanly. Close failure is unexpected
      // (handle was just opened); propagate so the caller surfaces it
      // rather than masking.
      await handle.close();
      return candidate;
    } catch (err) {
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "EEXIST"
      ) {
        suffix++;
        continue;
      }
      // Anything else (EACCES, EIO, ENOSPC, name-too-long, ...) —
      // propagate to the caller's terminal-catch.
      throw err;
    }
  }
}
