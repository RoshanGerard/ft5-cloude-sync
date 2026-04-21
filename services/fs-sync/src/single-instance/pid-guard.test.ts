import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AlreadyRunningError,
  acquirePidGuard,
} from "./pid-guard.js";

let cleanup: string[] = [];

afterEach(async () => {
  for (const f of cleanup) {
    try {
      await fsp.unlink(f);
    } catch {
      /* tolerated */
    }
  }
  cleanup = [];
});

function scratchPid(): string {
  const f = path.join(
    os.tmpdir(),
    `ft5-sync-pid-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`,
  );
  cleanup.push(f);
  return f;
}

describe("acquirePidGuard", () => {
  it("writes the current pid on a fresh acquire", async () => {
    const f = scratchPid();
    await acquirePidGuard(f, {
      currentPid: 4242,
      isLiveService: () => false,
    });
    const content = await fsp.readFile(f, "utf8");
    expect(content.trim()).toBe("4242");
  });

  it("throws AlreadyRunningError when a live service PID is recorded", async () => {
    const f = scratchPid();
    await fsp.writeFile(f, "9999\n");
    const spy = vi.fn().mockReturnValue(true);
    await expect(
      acquirePidGuard(f, { currentPid: 1001, isLiveService: spy }),
    ).rejects.toBeInstanceOf(AlreadyRunningError);
    expect(spy).toHaveBeenCalledWith(9999);
  });

  it("overwrites a stale PID and proceeds", async () => {
    const f = scratchPid();
    await fsp.writeFile(f, "9999\n");
    const release = await acquirePidGuard(f, {
      currentPid: 1001,
      isLiveService: () => false,
    });
    const content = await fsp.readFile(f, "utf8");
    expect(content.trim()).toBe("1001");
    await release();
  });

  it("overwrites a PID whose image name is a mismatch (stale reuse)", async () => {
    const f = scratchPid();
    await fsp.writeFile(f, "1\n");
    // Simulate: PID 1 is alive (init) but not the service — isLiveService
    // returns false because it checks BOTH liveness AND image-match.
    const release = await acquirePidGuard(f, {
      currentPid: 1001,
      isLiveService: () => false,
    });
    expect((await fsp.readFile(f, "utf8")).trim()).toBe("1001");
    await release();
  });

  it("tolerates a malformed PID file (overwrites it)", async () => {
    const f = scratchPid();
    await fsp.writeFile(f, "not-a-number\n");
    const release = await acquirePidGuard(f, {
      currentPid: 1001,
      isLiveService: () => {
        throw new Error("should not be called for malformed pid");
      },
    });
    expect((await fsp.readFile(f, "utf8")).trim()).toBe("1001");
    await release();
  });

  it("release() removes the PID file when the caller still owns it", async () => {
    const f = scratchPid();
    const release = await acquirePidGuard(f, {
      currentPid: 1001,
      isLiveService: () => false,
    });
    await release();
    await expect(fsp.stat(f)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("release() leaves the PID file alone when it's been re-claimed", async () => {
    const f = scratchPid();
    const release = await acquirePidGuard(f, {
      currentPid: 1001,
      isLiveService: () => false,
    });
    // Another instance claims the file (stale PID path).
    await fsp.writeFile(f, "7777\n");
    await release();
    expect((await fsp.readFile(f, "utf8")).trim()).toBe("7777");
  });
});
