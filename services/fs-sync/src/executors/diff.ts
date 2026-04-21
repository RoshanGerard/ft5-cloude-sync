// Diff algorithm for mirror-sync. Classifies each file against the
// persisted snapshot:
//   - local-only (size+mtime new OR (size+mtime differ AND sha256 differs))
//     → `upload-new` or `upload-changed`
//   - local-and-snapshot with matching (size, mtimeMs) → `skip`
//   - local-and-snapshot with differing (size, mtimeMs) but matching
//     sha256 → `skip-refresh-mtime` (no upload; update snapshot mtime)
//   - snapshot-only → `delete-remote`
//
// The hashing side-effect is managed by the caller: the classifier
// invokes `computeSha256(relPath)` lazily only when the cheap check
// mismatches. Passing the hash function as a parameter keeps the diff
// pure (no direct fs.* calls) so unit tests can feed in deterministic
// hashes.
//
// Spec: step (d) in "MirrorSyncJobExecutor performs one-way mirror sync".

import type { WalkedFile } from "./local-walker.js";

export interface SnapshotEntry {
  readonly relPath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string | null;
  readonly remoteHandle: string;
}

export type DiffOp =
  | {
      readonly kind: "upload-new";
      readonly relPath: string;
      readonly size: number;
      readonly mtimeMs: number;
      readonly sha256?: string;
    }
  | {
      readonly kind: "upload-changed";
      readonly relPath: string;
      readonly size: number;
      readonly mtimeMs: number;
      readonly sha256: string;
      readonly remoteHandle: string;
    }
  | {
      readonly kind: "skip";
      readonly relPath: string;
    }
  | {
      readonly kind: "skip-refresh-mtime";
      readonly relPath: string;
      readonly newMtimeMs: number;
    }
  | {
      readonly kind: "delete-remote";
      readonly relPath: string;
      readonly remoteHandle: string;
    };

export async function diffLocalAgainstSnapshot(
  local: ReadonlyArray<WalkedFile>,
  snapshot: ReadonlyArray<SnapshotEntry>,
  hashFile: (relPath: string) => Promise<string>,
): Promise<ReadonlyArray<DiffOp>> {
  const snapMap = new Map<string, SnapshotEntry>();
  for (const s of snapshot) snapMap.set(s.relPath, s);
  const seen = new Set<string>();
  const ops: DiffOp[] = [];

  for (const file of local) {
    seen.add(file.relPath);
    const snap = snapMap.get(file.relPath);
    if (!snap) {
      ops.push({
        kind: "upload-new",
        relPath: file.relPath,
        size: file.size,
        mtimeMs: file.mtimeMs,
      });
      continue;
    }
    if (file.size === snap.size && file.mtimeMs === snap.mtimeMs) {
      ops.push({ kind: "skip", relPath: file.relPath });
      continue;
    }
    // Size or mtime changed — hash to tie-break.
    const hash = await hashFile(file.relPath);
    if (snap.sha256 && hash === snap.sha256) {
      ops.push({
        kind: "skip-refresh-mtime",
        relPath: file.relPath,
        newMtimeMs: file.mtimeMs,
      });
    } else {
      ops.push({
        kind: "upload-changed",
        relPath: file.relPath,
        size: file.size,
        mtimeMs: file.mtimeMs,
        sha256: hash,
        remoteHandle: snap.remoteHandle,
      });
    }
  }

  for (const s of snapshot) {
    if (!seen.has(s.relPath)) {
      ops.push({
        kind: "delete-remote",
        relPath: s.relPath,
        remoteHandle: s.remoteHandle,
      });
    }
  }

  return ops;
}
