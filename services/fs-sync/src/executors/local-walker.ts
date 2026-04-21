// Streaming local filesystem walker. Skips symlinks that escape the root,
// hidden OS-noise files (.DS_Store, Thumbs.db), git metadata, and temp
// files. Emits { relPath, size, mtimeMs } per regular file.
//
// Spec: "MirrorSyncJobExecutor performs one-way mirror sync via snapshot
// diff" step (b).

import * as fsp from "node:fs/promises";
import * as path from "node:path";

export interface WalkedFile {
  readonly relPath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface WalkOptions {
  /**
   * Glob-ish suffix/substring patterns to ignore. The walker does a simple
   * substring / suffix check rather than pulling in a glob library, which
   * is sufficient for the v1 defaults and keeps the dep count down.
   */
  readonly ignore?: ReadonlyArray<string>;
}

const DEFAULT_IGNORE = [
  ".DS_Store",
  "Thumbs.db",
  ".git/",
  "/.git",
  ".tmp",
];

export async function walkLocalTree(
  root: string,
  options: WalkOptions = {},
): Promise<ReadonlyArray<WalkedFile>> {
  const ignore = options.ignore ?? DEFAULT_IGNORE;
  const out: WalkedFile[] = [];
  const absoluteRoot = path.resolve(root);
  await walk(absoluteRoot, absoluteRoot, ignore, out);
  return out;
}

async function walk(
  root: string,
  current: string,
  ignore: ReadonlyArray<string>,
  out: WalkedFile[],
): Promise<void> {
  const dir = await fsp.opendir(current);
  for await (const entry of dir) {
    const entryPath = path.join(current, entry.name);
    const rel = path.relative(root, entryPath).split(path.sep).join("/");
    if (shouldIgnore(rel, ignore)) continue;

    if (entry.isSymbolicLink()) {
      // Resolve and skip if it points outside the root.
      let resolved: string;
      try {
        resolved = await fsp.realpath(entryPath);
      } catch {
        continue; // broken symlink
      }
      const resolvedRel = path.relative(root, resolved);
      if (resolvedRel.startsWith("..") || path.isAbsolute(resolvedRel)) {
        continue; // escapes the root
      }
      // Follow: treat as whatever the target is.
      try {
        const st = await fsp.stat(resolved);
        if (st.isDirectory()) {
          await walk(root, resolved, ignore, out);
        } else if (st.isFile()) {
          out.push({
            relPath: rel,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        }
      } catch {
        continue;
      }
      continue;
    }

    if (entry.isDirectory()) {
      await walk(root, entryPath, ignore, out);
      continue;
    }

    if (!entry.isFile()) continue;

    try {
      const st = await fsp.stat(entryPath);
      out.push({
        relPath: rel,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // File disappeared between readdir and stat — skip.
      continue;
    }
  }
}

function shouldIgnore(relPath: string, ignore: ReadonlyArray<string>): boolean {
  for (const pat of ignore) {
    if (pat.endsWith("/")) {
      if (relPath.includes(`/${pat.slice(0, -1)}/`) || relPath.startsWith(pat.slice(0, -1) + "/")) {
        return true;
      }
    } else if (pat.startsWith("/")) {
      if (relPath.endsWith(pat) || relPath === pat.slice(1)) return true;
    } else if (relPath.endsWith(pat) || relPath === pat || relPath.includes(`/${pat}`)) {
      return true;
    }
  }
  return false;
}
