import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkSourceHealth } from "./source-health.js";

let cleanup: string[] = [];
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

function scratch(): string {
  const d = path.join(
    os.tmpdir(),
    `ft5-sync-health-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  cleanup.push(d);
  return d;
}

describe("checkSourceHealth", () => {
  it("returns healthy for an existing, readable directory", async () => {
    const d = scratch();
    await fsp.mkdir(d, { recursive: true });
    const h = await checkSourceHealth(d);
    expect(h.kind).toBe("healthy");
  });

  it("returns unavailable/ENOENT for a missing path", async () => {
    const h = await checkSourceHealth(path.join(scratch(), "does-not-exist"));
    expect(h.kind).toBe("unavailable");
    if (h.kind === "unavailable") expect(h.errorCode).toBe("ENOENT");
  });

  it("returns unavailable/ENOTDIR for a regular file", async () => {
    const d = scratch();
    await fsp.mkdir(d, { recursive: true });
    const f = path.join(d, "file.txt");
    await fsp.writeFile(f, "hi");
    const h = await checkSourceHealth(f);
    expect(h.kind).toBe("unavailable");
    if (h.kind === "unavailable") expect(h.errorCode).toBe("ENOTDIR");
  });
});
