// Dev-mode path selection. Confirms that --dev routes every runtime
// artifact onto a distinct path from prod (different pipe name, different
// data dir, different PID file) so a dev service can run alongside a prod
// service without interference.
//
// Spec: "Dev mode uses distinct pipe, data dir, and PID file".

import { describe, expect, it } from "vitest";

import {
  resolveDataDir,
  resolveDbPath,
  resolvePidPath,
  resolveSocketPath,
} from "../env/paths.js";

describe("dev vs prod path selection", () => {
  it("resolveDataDir('dev') is under a 'dev' subdir", () => {
    const prod = resolveDataDir({ dev: false }, {});
    const dev = resolveDataDir({ dev: true }, {});
    expect(dev).not.toBe(prod);
    expect(dev.endsWith("dev")).toBe(true);
  });

  it("resolveSocketPath is distinct between dev and prod", () => {
    const prod = resolveSocketPath({ dev: false }, {});
    const dev = resolveSocketPath({ dev: true }, {});
    expect(dev).not.toBe(prod);
    if (process.platform === "win32") {
      expect(prod).toBe("\\\\.\\pipe\\ft5-sync");
      expect(dev).toBe("\\\\.\\pipe\\ft5-sync-dev");
    } else {
      expect(prod.endsWith("/sync.sock")).toBe(true);
      expect(dev.endsWith("/sync-dev.sock")).toBe(true);
    }
  });

  it("resolvePidPath is distinct between dev and prod", () => {
    const prod = resolvePidPath({ dev: false }, {});
    const dev = resolvePidPath({ dev: true }, {});
    expect(prod.endsWith("service.pid")).toBe(true);
    expect(dev.endsWith("service-dev.pid")).toBe(true);
    expect(dev).not.toBe(prod);
  });

  it("FT5_SYNC_DATA_DIR overrides both dev and prod defaults equivalently", () => {
    const override = "/tmp/custom";
    expect(resolveDataDir({ dev: false }, { FT5_SYNC_DATA_DIR: override })).toBe(
      override,
    );
    expect(resolveDataDir({ dev: true }, { FT5_SYNC_DATA_DIR: override })).toBe(
      override,
    );
  });

  it("resolveDbPath uses the data-dir-relative sync.db under both modes", () => {
    const prod = resolveDbPath({ dev: false }, {});
    const dev = resolveDbPath({ dev: true }, {});
    expect(prod.endsWith("sync.db")).toBe(true);
    expect(dev.endsWith("sync.db")).toBe(true);
    expect(dev).not.toBe(prod); // still distinct because the data-dir differs
  });
});
