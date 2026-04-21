// Source-health precondition. Refuses to proceed if the source root is
// missing, unreadable, a broken symlink, or a file (not a dir). Returning
// Unavailable means ZERO remote mutations should follow — the caller must
// treat this as a terminal reason to fail the job.
//
// Spec: "Source-health precondition refuses to run against an unhealthy
// source". This is the single fuse preventing "mounted drive disappeared
// → cloud wiped".

import * as fsp from "node:fs/promises";

export interface SourceHealthy {
  readonly kind: "healthy";
}
export interface SourceUnavailable {
  readonly kind: "unavailable";
  readonly errorCode: string;
  readonly message: string;
}

export type SourceHealth = SourceHealthy | SourceUnavailable;

export async function checkSourceHealth(sourcePath: string): Promise<SourceHealth> {
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(sourcePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return {
      kind: "unavailable",
      errorCode: code,
      message: `stat(${sourcePath}) failed: ${code}`,
    };
  }
  if (!stat.isDirectory()) {
    return {
      kind: "unavailable",
      errorCode: "ENOTDIR",
      message: `sourcePath ${sourcePath} is not a directory`,
    };
  }
  try {
    // readdir confirms we actually have permission to list the root.
    await fsp.readdir(sourcePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return {
      kind: "unavailable",
      errorCode: code,
      message: `readdir(${sourcePath}) failed: ${code}`,
    };
  }
  return { kind: "healthy" };
}
