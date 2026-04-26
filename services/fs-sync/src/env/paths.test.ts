import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveCredentialsPath,
  resolveDataDir,
  resolveDbPath,
  resolveLogPath,
  resolvePidPath,
  resolveServiceConfigPath,
  resolveSocketPath,
} from "./paths.js";

const PROD = { dev: false } as const;
const DEV = { dev: true } as const;
const ROOT = path.join(os.homedir(), "ft5", "sync_app");

describe("resolveDataDir", () => {
  it("returns $HOME/ft5/sync_app in prod mode with no override", () => {
    expect(resolveDataDir(PROD, {})).toBe(ROOT);
  });

  it("returns $HOME/ft5/sync_app/dev in dev mode", () => {
    expect(resolveDataDir(DEV, {})).toBe(path.join(ROOT, "dev"));
  });

  it("honours FT5_SYNC_DATA_DIR over both prod and dev defaults", () => {
    const override = path.join(os.tmpdir(), "ft5-test");
    expect(resolveDataDir(PROD, { FT5_SYNC_DATA_DIR: override })).toBe(override);
    expect(resolveDataDir(DEV, { FT5_SYNC_DATA_DIR: override })).toBe(override);
  });

  it("treats an empty FT5_SYNC_DATA_DIR as absent (falls back to default)", () => {
    expect(resolveDataDir(PROD, { FT5_SYNC_DATA_DIR: "" })).toBe(ROOT);
  });
});

describe("file-path helpers", () => {
  it("resolveCredentialsPath joins credentials.json onto the data dir", () => {
    expect(resolveCredentialsPath(PROD, {})).toBe(
      path.join(ROOT, "credentials.json"),
    );
  });

  it("resolveDbPath joins sync.db", () => {
    expect(resolveDbPath(PROD, {})).toBe(path.join(ROOT, "sync.db"));
  });

  it("resolveLogPath joins service.log", () => {
    expect(resolveLogPath(PROD, {})).toBe(path.join(ROOT, "service.log"));
  });

  it("resolvePidPath picks service.pid vs service-dev.pid by mode", () => {
    expect(resolvePidPath(PROD, {})).toBe(path.join(ROOT, "service.pid"));
    expect(resolvePidPath(DEV, {})).toBe(
      path.join(ROOT, "dev", "service-dev.pid"),
    );
  });

  it("resolveServiceConfigPath joins config.json onto the data dir (prod + dev)", () => {
    expect(resolveServiceConfigPath(PROD, {})).toBe(
      path.join(ROOT, "config.json"),
    );
    expect(resolveServiceConfigPath(DEV, {})).toBe(
      path.join(ROOT, "dev", "config.json"),
    );
  });

  it("resolveServiceConfigPath honours FT5_SYNC_DATA_DIR override", () => {
    const override = path.join(os.tmpdir(), "ft5-cfg-test");
    expect(
      resolveServiceConfigPath(PROD, { FT5_SYNC_DATA_DIR: override }),
    ).toBe(path.join(override, "config.json"));
  });
});

describe("resolveSocketPath", () => {
  it("uses the Windows named-pipe path on win32", () => {
    if (process.platform !== "win32") return;
    expect(resolveSocketPath(PROD, {})).toBe("\\\\.\\pipe\\ft5-sync");
    expect(resolveSocketPath(DEV, {})).toBe("\\\\.\\pipe\\ft5-sync-dev");
  });

  it("uses $HOME/ft5/sync_app/sync.sock on Unix prod", () => {
    if (process.platform === "win32") return;
    expect(resolveSocketPath(PROD, {})).toBe(path.join(ROOT, "sync.sock"));
    expect(resolveSocketPath(DEV, {})).toBe(
      path.join(ROOT, "dev", "sync-dev.sock"),
    );
  });
});
