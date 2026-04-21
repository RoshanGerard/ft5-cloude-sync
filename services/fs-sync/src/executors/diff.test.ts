import { describe, expect, it, vi } from "vitest";

import { diffLocalAgainstSnapshot, type SnapshotEntry } from "./diff.js";

describe("diffLocalAgainstSnapshot", () => {
  it("classifies a never-seen file as upload-new (no hash computed)", async () => {
    const hash = vi.fn();
    const ops = await diffLocalAgainstSnapshot(
      [{ relPath: "a.txt", size: 5, mtimeMs: 100 }],
      [],
      hash,
    );
    expect(ops).toEqual([
      { kind: "upload-new", relPath: "a.txt", size: 5, mtimeMs: 100 },
    ]);
    expect(hash).not.toHaveBeenCalled();
  });

  it("classifies matching (size, mtime) as skip (no hash computed)", async () => {
    const hash = vi.fn();
    const snap: SnapshotEntry = {
      relPath: "a.txt",
      size: 5,
      mtimeMs: 100,
      sha256: "hhhh",
      remoteHandle: "r-1",
    };
    const ops = await diffLocalAgainstSnapshot(
      [{ relPath: "a.txt", size: 5, mtimeMs: 100 }],
      [snap],
      hash,
    );
    expect(ops).toEqual([{ kind: "skip", relPath: "a.txt" }]);
    expect(hash).not.toHaveBeenCalled();
  });

  it("hashes on (size, mtime) change; matching hash → skip-refresh-mtime", async () => {
    const hash = vi.fn().mockResolvedValue("hhhh");
    const snap: SnapshotEntry = {
      relPath: "a.txt",
      size: 5,
      mtimeMs: 100,
      sha256: "hhhh",
      remoteHandle: "r-1",
    };
    const ops = await diffLocalAgainstSnapshot(
      [{ relPath: "a.txt", size: 5, mtimeMs: 200 }],
      [snap],
      hash,
    );
    expect(ops).toEqual([
      { kind: "skip-refresh-mtime", relPath: "a.txt", newMtimeMs: 200 },
    ]);
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it("hashes on (size, mtime) change; differing hash → upload-changed", async () => {
    const hash = vi.fn().mockResolvedValue("new-hash");
    const snap: SnapshotEntry = {
      relPath: "a.txt",
      size: 5,
      mtimeMs: 100,
      sha256: "old-hash",
      remoteHandle: "r-1",
    };
    const ops = await diffLocalAgainstSnapshot(
      [{ relPath: "a.txt", size: 7, mtimeMs: 200 }],
      [snap],
      hash,
    );
    expect(ops).toEqual([
      {
        kind: "upload-changed",
        relPath: "a.txt",
        size: 7,
        mtimeMs: 200,
        sha256: "new-hash",
        remoteHandle: "r-1",
      },
    ]);
  });

  it("classifies snapshot-only entries as delete-remote", async () => {
    const snap: SnapshotEntry = {
      relPath: "gone.txt",
      size: 5,
      mtimeMs: 100,
      sha256: "x",
      remoteHandle: "r-gone",
    };
    const ops = await diffLocalAgainstSnapshot([], [snap], vi.fn());
    expect(ops).toEqual([
      { kind: "delete-remote", relPath: "gone.txt", remoteHandle: "r-gone" },
    ]);
  });

  it("orders local ops before delete-remote ops", async () => {
    const ops = await diffLocalAgainstSnapshot(
      [{ relPath: "new.txt", size: 1, mtimeMs: 1 }],
      [
        {
          relPath: "gone.txt",
          size: 2,
          mtimeMs: 2,
          sha256: null,
          remoteHandle: "r",
        },
      ],
      vi.fn(),
    );
    expect(ops.map((o) => o.kind)).toEqual(["upload-new", "delete-remote"]);
  });
});
