// Unit tests for `validateToPath` (per add-engine-rename-download §13.3 +
// spec.md "Requirement: `toPath` validation at the service boundary").
//
// The spec scenarios use Unix-flavoured paths; the validator uses
// `node:path` which switches separator based on platform. To keep these
// tests platform-independent we use `path.posix` literals in the inputs
// AND drive the validator through a `node:path` import that respects
// the host OS. On Windows, an absolute Unix-style path like
// `/Users/alice/Downloads/welcome.pdf` is NOT absolute by Windows rules,
// so we additionally derive an absolute path from the test temp dir
// where needed.

import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as nodePath from "node:path";

import { validateToPath } from "../path-validator.js";

describe("validateToPath", () => {
  it("rejects relative paths with reason 'not absolute'", async () => {
    const result = await validateToPath("Downloads/welcome.pdf", {
      canWrite: async () => true,
      homedir: () => "/home/alice",
    });
    expect(result).toEqual({ ok: false, reason: "not absolute" });
  });

  it("rejects path traversal with reason 'contains traversal'", async () => {
    // Build the traversal-bearing input WITHOUT going through `path.join`
    // (which would collapse `..` at construction time and defeat the
    // whole test). The validator's defence is `path.normalize(input) !==
    // input` — so the input must literally contain the unresolved
    // segments at the moment it's passed in.
    const home = os.homedir();
    const sep = nodePath.sep;
    const traversal =
      home + sep + "Downloads" + sep + ".." + sep + ".." + sep + ".." + sep +
      "etc" + sep + "passwd";
    const result = await validateToPath(traversal, {
      canWrite: async () => true,
      homedir: () => home,
    });
    expect(result).toEqual({ ok: false, reason: "contains traversal" });
  });

  it("rejects writes inside the service data directory with reason 'cannot write inside service data directory'", async () => {
    const home = "/home/alice";
    const inside = nodePath.join(home, "ft5", "sync_app", "credentials.json");
    const result = await validateToPath(inside, {
      canWrite: async () => true,
      homedir: () => home,
    });
    expect(result).toEqual({
      ok: false,
      reason: "cannot write inside service data directory",
    });
  });

  it("rejects an unwritable parent directory with reason 'parent directory not writable'", async () => {
    const home = os.homedir();
    const target = nodePath.join(home, "Downloads", "welcome.pdf");
    const result = await validateToPath(target, {
      canWrite: async () => false,
      homedir: () => home,
    });
    expect(result).toEqual({
      ok: false,
      reason: "parent directory not writable",
    });
  });

  it("accepts a normalized absolute path with a writable parent that is OUTSIDE the service data dir", async () => {
    const home = os.homedir();
    const target = nodePath.join(home, "Downloads", "welcome.pdf");
    const result = await validateToPath(target, {
      canWrite: async () => true,
      homedir: () => home,
    });
    expect(result).toEqual({ ok: true });
  });

  it("does NOT reject sibling paths that merely share a prefix with the service data dir", async () => {
    const home = "/home/alice";
    // `~/ft5/sync_app_other/...` is NOT inside `~/ft5/sync_app/...` —
    // the validator must anchor the comparison at a separator.
    const target = nodePath.join(home, "ft5", "sync_app_other", "file.pdf");
    const result = await validateToPath(target, {
      canWrite: async () => true,
      homedir: () => home,
    });
    expect(result).toEqual({ ok: true });
  });
});
