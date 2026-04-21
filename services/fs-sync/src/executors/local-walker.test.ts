import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { walkLocalTree } from "./local-walker.js";

let root = "";
let cleanup: string[] = [];

beforeEach(async () => {
  root = path.join(
    os.tmpdir(),
    `ft5-sync-walk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  cleanup.push(root);
  await fsp.mkdir(root, { recursive: true });
});

afterEach(async () => {
  for (const f of cleanup) {
    try {
      await fsp.rm(f, { recursive: true, force: true });
    } catch {
      /* tolerated */
    }
  }
  cleanup = [];
});

async function seed(rel: string, content = "x"): Promise<void> {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content);
}

describe("walkLocalTree", () => {
  it("returns every regular file as { relPath, size, mtimeMs }", async () => {
    await seed("a.txt", "hello");
    await seed("dir/b.txt", "world!!");
    const files = await walkLocalTree(root);
    const byRel = new Map(files.map((f) => [f.relPath, f]));
    expect(byRel.has("a.txt")).toBe(true);
    expect(byRel.has("dir/b.txt")).toBe(true);
    expect(byRel.get("a.txt")?.size).toBe(5);
    expect(byRel.get("dir/b.txt")?.size).toBe(7);
  });

  it("skips default-ignored files (.DS_Store, Thumbs.db, .git/**, *.tmp)", async () => {
    await seed(".DS_Store", "");
    await seed("Thumbs.db", "");
    await seed(".git/HEAD", "");
    await seed("scratch.tmp", "");
    await seed("real.txt", "k");
    const files = await walkLocalTree(root);
    const rels = files.map((f) => f.relPath);
    expect(rels).toEqual(["real.txt"]);
  });

  it.skipIf(process.platform === "win32")(
    "skips a symlink that escapes the root",
    async () => {
      const outside = path.join(
        os.tmpdir(),
        `ft5-sync-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      cleanup.push(outside);
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, "secret.txt"), "leak");
      await fsp.symlink(outside, path.join(root, "link-out"));
      await seed("inside.txt", "ok");
      const files = await walkLocalTree(root);
      const rels = files.map((f) => f.relPath);
      expect(rels).toEqual(["inside.txt"]);
    },
  );
});
