// Unit tests for the `"keep-both"` suffix-loop helper (per
// add-download-overwrite-confirm tasks.md §3.2). Pure-function tests
// — the helper's only dep is `open(path, "wx")`, faked here with an
// in-memory existence set. The production impl wires `fs.open` through
// the handler's `FsBoundary` (see `files-download.ts`).
//
// Test cases:
// - simple: name (1).ext is free → returns it.
// - iterative: (1) and (2) taken → returns (3).ext.
// - no-extension: `Makefile` → `Makefile (1)`.
// - dotfile: `.bashrc` (path.parse name === ".bashrc") → `.bashrc (1)`.
// - the helper does NOT probe toPath itself (it goes straight to (1)).

import { describe, expect, it, vi } from "vitest";
import * as nodePath from "node:path";

import {
  resolveKeepBothSuffix,
  type KeepBothSuffixDeps,
} from "../keep-both-suffix.js";

// In-memory fake of the `O_CREAT|O_EXCL` open primitive. `existing`
// holds paths the FS already has — opening one with `"wx"` rejects
// EEXIST. Successful opens add the path to `existing` (matching
// real `O_CREAT|O_EXCL` semantics — the file is created as a 0-byte
// entry on success).
function makeFakeOpen(existing: Set<string>): KeepBothSuffixDeps["open"] {
  return async (path: string, flags: "wx") => {
    if (flags !== "wx") throw new Error(`unexpected flags: ${flags}`);
    if (existing.has(path)) {
      const err = new Error(`EEXIST: file already exists, open '${path}'`) as
        & Error
        & { code: string };
      err.code = "EEXIST";
      throw err;
    }
    existing.add(path);
    return {
      close: async () => undefined,
    };
  };
}

describe("resolveKeepBothSuffix — simple case (§3.2)", () => {
  it("returns name (1).ext when (1) is free", async () => {
    const existing = new Set<string>([
      nodePath.join("/dir", "welcome.pdf"),
    ]);
    const open = vi.fn(makeFakeOpen(existing));
    const deps: KeepBothSuffixDeps = { open };

    const result = await resolveKeepBothSuffix(
      nodePath.join("/dir", "welcome.pdf"),
      deps,
    );

    expect(result).toBe(nodePath.join("/dir", "welcome (1).pdf"));
    // Helper goes straight to (1); does NOT re-probe toPath itself.
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      nodePath.join("/dir", "welcome (1).pdf"),
      "wx",
    );
    // The helper closes the handle before returning — assert post-call
    // state is the 0-byte sentinel (path now exists).
    expect(existing.has(nodePath.join("/dir", "welcome (1).pdf"))).toBe(true);
  });
});

describe("resolveKeepBothSuffix — iterative case (§3.4)", () => {
  it("returns (3).pdf when (1) and (2) are both taken", async () => {
    const existing = new Set<string>([
      nodePath.join("/dir", "welcome.pdf"),
      nodePath.join("/dir", "welcome (1).pdf"),
      nodePath.join("/dir", "welcome (2).pdf"),
    ]);
    const open = vi.fn(makeFakeOpen(existing));

    const result = await resolveKeepBothSuffix(
      nodePath.join("/dir", "welcome.pdf"),
      { open },
    );

    expect(result).toBe(nodePath.join("/dir", "welcome (3).pdf"));
    // Three open attempts: (1) EEXIST, (2) EEXIST, (3) success.
    expect(open).toHaveBeenCalledTimes(3);
  });
});

describe("resolveKeepBothSuffix — no-extension case (§3.2)", () => {
  it("returns Makefile (1) for a name with no extension", async () => {
    const existing = new Set<string>([
      nodePath.join("/dir", "Makefile"),
    ]);
    const open = vi.fn(makeFakeOpen(existing));

    const result = await resolveKeepBothSuffix(
      nodePath.join("/dir", "Makefile"),
      { open },
    );

    expect(result).toBe(nodePath.join("/dir", "Makefile (1)"));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      nodePath.join("/dir", "Makefile (1)"),
      "wx",
    );
  });
});

describe("resolveKeepBothSuffix — dotfile edge case", () => {
  // `path.parse(".bashrc")` produces `{ name: ".bashrc", ext: "" }` on
  // POSIX (a "dotfile" is NOT treated as having an extension). The
  // helper should reassemble correctly to `.bashrc (1)`, NOT ` (1).bashrc`.
  it("returns .bashrc (1) for a leading-dot name with no extension", async () => {
    const existing = new Set<string>([
      nodePath.join("/dir", ".bashrc"),
    ]);
    const open = vi.fn(makeFakeOpen(existing));

    const result = await resolveKeepBothSuffix(
      nodePath.join("/dir", ".bashrc"),
      { open },
    );

    expect(result).toBe(nodePath.join("/dir", ".bashrc (1)"));
  });
});

describe("resolveKeepBothSuffix — closes handle before returning", () => {
  // Defensive: the helper MUST close the handle returned by `open`
  // before returning. Otherwise the cycle loop's subsequent
  // `createWriteStream(path, { flags: "w" })` may race with the
  // open handle (different OS behavior across platforms).
  it("calls handle.close() exactly once", async () => {
    const existing = new Set<string>([
      nodePath.join("/dir", "x.txt"),
    ]);
    const close = vi.fn(async () => undefined);
    const open = vi.fn(async (path: string) => {
      if (existing.has(path)) {
        const err = new Error(`EEXIST: ${path}`) as Error & { code: string };
        err.code = "EEXIST";
        throw err;
      }
      existing.add(path);
      return { close };
    });

    await resolveKeepBothSuffix(
      nodePath.join("/dir", "x.txt"),
      { open: open as unknown as KeepBothSuffixDeps["open"] },
    );

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("resolveKeepBothSuffix — non-EEXIST errors propagate", () => {
  // EACCES / EIO / etc. are NOT swallowed — the handler's outer catch
  // routes them via normalizeFilesError. Helper just re-throws.
  it("re-throws errors that are not EEXIST", async () => {
    const open = vi.fn(async () => {
      const err = new Error("EACCES: permission denied") as Error & {
        code: string;
      };
      err.code = "EACCES";
      throw err;
    });

    await expect(
      resolveKeepBothSuffix(
        nodePath.join("/dir", "x.txt"),
        { open: open as unknown as KeepBothSuffixDeps["open"] },
      ),
    ).rejects.toMatchObject({ code: "EACCES" });
  });
});
