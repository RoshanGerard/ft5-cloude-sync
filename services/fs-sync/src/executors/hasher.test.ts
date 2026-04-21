import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashFileSha256 } from "./hasher.js";

let cleanup: string[] = [];
afterEach(async () => {
  for (const f of cleanup) {
    try {
      await fsp.rm(f, { force: true });
    } catch {
      /* tolerated */
    }
  }
  cleanup = [];
});

function scratch(): string {
  const f = path.join(
    os.tmpdir(),
    `ft5-sync-hash-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`,
  );
  cleanup.push(f);
  return f;
}

describe("hashFileSha256", () => {
  it("matches the reference sha256 for a small file", async () => {
    const content = "the quick brown fox";
    const ref = createHash("sha256").update(content).digest("hex");
    const f = scratch();
    await fsp.writeFile(f, content);
    expect(await hashFileSha256(f)).toBe(ref);
  });

  it("handles a 5 MB file without loading it into memory (correctness check)", async () => {
    // Build a 5 MB buffer deterministically (zeros); sha256 of zeros is well-
    // defined.
    const size = 5 * 1024 * 1024;
    const buf = Buffer.alloc(size, 0);
    const f = scratch();
    await fsp.writeFile(f, buf);

    const ref = createHash("sha256").update(buf).digest("hex");
    expect(await hashFileSha256(f)).toBe(ref);
  }, 15_000);
});
