// Resolves the plain-Node binary the supervisor spawns the fs-sync
// service with. See `node-binary-resolver.spike.md` §§2, 5 for
// rationale; this module is the §5 reference implementation with the
// follow-up #2 `platform`/`arch` seams adopted for testability.
//
// Scope: pure path computation, synchronous, zero filesystem I/O. The
// supervisor is responsible for stat-ing the returned path and
// surfacing a clear error if the bundled binary is missing — keeping
// this function pure makes its unit tests trivial (see
// `node-binary-resolver.test.ts`).
//
// Dev mode is NOT supported: pnpm's parallel supervisor already
// started the service (design.md Decision 6, :136-144). Calling this
// resolver in dev is a programmer mistake; we throw rather than
// silently returning a bogus path.

import * as path from "node:path";

export interface ResolveServiceNodeBinaryOptions {
  readonly isPackaged: boolean;
  readonly appPath: string;
  /** Defaults to `process.platform`. Inject in tests. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `process.arch`. Inject in tests. */
  readonly arch?: NodeJS.Architecture;
}

/**
 * Returns an absolute path to the bundled Node binary for the current
 * platform/arch in packaged builds. Throws in dev, on unsupported
 * arch, or on unsupported platform.
 */
export function resolveServiceNodeBinary(
  opts: ResolveServiceNodeBinaryOptions,
): string {
  if (!opts.isPackaged) {
    throw new Error(
      "resolveServiceNodeBinary is production-only; in dev the service is started by `pnpm dev`.",
    );
  }
  const arch = opts.arch ?? process.arch;
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported arch for bundled Node: ${arch}`);
  }
  const platform = opts.platform ?? process.platform;
  const resourcesRoot = path.join(opts.appPath, "..", "node");
  switch (platform) {
    case "win32":
      return path.join(resourcesRoot, `win-${arch}`, "node.exe");
    case "darwin":
      return path.join(resourcesRoot, `darwin-${arch}`, "bin", "node");
    case "linux":
      return path.join(resourcesRoot, `linux-${arch}`, "bin", "node");
    default:
      throw new Error(`Unsupported platform for bundled Node: ${platform}`);
  }
}
