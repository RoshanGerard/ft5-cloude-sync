// Unit tests for `createHashComputer` (per add-engine-rename-download
// §13.14 — the post-download integrity check that the `files:download`
// handler runs against `readProviderHash`'s lowercase-hex digest).
//
// These tests pin three properties:
//   1. The digest is lowercase hex — the comparison in
//      `files-download.ts` line 649 is a literal string equality, both
//      sides lowercased.
//   2. Each of the three supported algorithms (`md5`, `sha1`, `sha256`)
//      computes the canonical digest for known vectors. Catches a typo
//      that would land md5 bytes through a sha1 hasher (or vice versa),
//      which would fail every download against a provider-advertised
//      hash without a clear failure mode.
//   3. The implementation is stateless / re-entrant — calling
//      `hashFile` twice in parallel returns each call's correct digest.

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHashComputer } from "../hash-computer.js";

let scratchDir: string;

beforeEach(async () => {
  scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ft5-hash-"));
});

afterEach(async () => {
  try {
    await fsp.rm(scratchDir, { recursive: true, force: true });
  } catch {
    /* tolerated */
  }
});

describe("createHashComputer", () => {
  it("computes md5 of a known string as lowercase hex", async () => {
    const filePath = path.join(scratchDir, "abc.bin");
    await fsp.writeFile(filePath, "abc");
    const hasher = createHashComputer();
    const digest = await hasher.hashFile(filePath, "md5");
    // md5("abc") = 900150983cd24fb0d6963f7d28e17f72
    expect(digest).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(digest).toBe(digest.toLowerCase());
  });

  it("computes sha1 of a known string as lowercase hex", async () => {
    const filePath = path.join(scratchDir, "abc.bin");
    await fsp.writeFile(filePath, "abc");
    const hasher = createHashComputer();
    const digest = await hasher.hashFile(filePath, "sha1");
    // sha1("abc") = a9993e364706816aba3e25717850c26c9cd0d89d
    expect(digest).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  it("computes sha256 of an empty file as lowercase hex", async () => {
    const filePath = path.join(scratchDir, "empty.bin");
    await fsp.writeFile(filePath, "");
    const hasher = createHashComputer();
    const digest = await hasher.hashFile(filePath, "sha256");
    // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(digest).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("returns the correct digest for each call when invoked in parallel", async () => {
    const fileA = path.join(scratchDir, "a.bin");
    const fileB = path.join(scratchDir, "b.bin");
    await fsp.writeFile(fileA, "abc");
    await fsp.writeFile(fileB, "");
    const hasher = createHashComputer();
    // Single hasher instance, two concurrent calls: each must return its
    // own digest. Catches a regression where a shared `createHash`
    // instance leaks state across calls.
    const [digestA, digestB] = await Promise.all([
      hasher.hashFile(fileA, "md5"),
      hasher.hashFile(fileB, "md5"),
    ]);
    expect(digestA).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(digestB).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });
});
