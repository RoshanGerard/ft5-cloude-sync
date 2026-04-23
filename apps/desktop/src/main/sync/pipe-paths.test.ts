// Pipe-path helper tests.
//
// Task 4.10 wires `startSupervisor` into the desktop entry point; that
// wiring needs a desktop-side mirror of the service's `resolveSocketPath`
// (see `services/fs-sync/src/env/paths.ts`). The helper is pure: it
// takes an explicit `dev` flag and — for testability — injected
// `platform` / `homedir` / `env` seams that default to `process.platform` /
// `os.homedir()` / `process.env`. Tests assert all four (platform × dev)
// branches PLUS the `FT5_SYNC_DATA_DIR` override that keeps the desktop
// in lockstep with the service's `resolveDataDir`.

import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSyncPipePath } from "./pipe-paths.js";

describe("resolveSyncPipePath", () => {
  it("returns the dev Windows named pipe when platform=win32 and dev=true", () => {
    expect(
      resolveSyncPipePath({
        dev: true,
        platform: "win32",
        homedir: () => "C:\\Users\\test",
      }),
    ).toBe("\\\\.\\pipe\\ft5-sync-dev");
  });

  it("returns the prod Windows named pipe when platform=win32 and dev=false", () => {
    expect(
      resolveSyncPipePath({
        dev: false,
        platform: "win32",
        homedir: () => "C:\\Users\\test",
      }),
    ).toBe("\\\\.\\pipe\\ft5-sync");
  });

  it("returns the dev Unix socket path under $HOME/ft5/sync_app/dev when platform=linux and dev=true", () => {
    // MIRROR INVARIANT: must match service's `resolveDataDir({dev:true})` +
    // `sync-dev.sock` basename (services/fs-sync/src/env/paths.ts:30-32 + 60).
    expect(
      resolveSyncPipePath({
        dev: true,
        platform: "linux",
        homedir: () => "/home/alice",
        env: {},
      }),
    ).toBe(
      path.join("/home/alice", "ft5", "sync_app", "dev", "sync-dev.sock"),
    );
  });

  it("returns the prod Unix socket path under $HOME/ft5/sync_app when platform=darwin and dev=false", () => {
    expect(
      resolveSyncPipePath({
        dev: false,
        platform: "darwin",
        homedir: () => "/Users/bob",
        env: {},
      }),
    ).toBe(path.join("/Users/bob", "ft5", "sync_app", "sync.sock"));
  });

  it("honours FT5_SYNC_DATA_DIR over the home-relative default on Unix", () => {
    // Mirrors service's resolveDataDir override branch (paths.ts:26-29).
    expect(
      resolveSyncPipePath({
        dev: true,
        platform: "linux",
        homedir: () => "/home/ignored",
        env: { FT5_SYNC_DATA_DIR: "/custom/data/dir" },
      }),
    ).toBe(path.join("/custom/data/dir", "sync-dev.sock"));
    expect(
      resolveSyncPipePath({
        dev: false,
        platform: "darwin",
        homedir: () => "/Users/ignored",
        env: { FT5_SYNC_DATA_DIR: "/custom/data/dir" },
      }),
    ).toBe(path.join("/custom/data/dir", "sync.sock"));
  });

  it("ignores FT5_SYNC_DATA_DIR on Windows (named-pipe namespace is global)", () => {
    expect(
      resolveSyncPipePath({
        dev: true,
        platform: "win32",
        homedir: () => "C:\\Users\\test",
        env: { FT5_SYNC_DATA_DIR: "C:\\custom\\data" },
      }),
    ).toBe("\\\\.\\pipe\\ft5-sync-dev");
  });

  it("treats empty FT5_SYNC_DATA_DIR as unset", () => {
    expect(
      resolveSyncPipePath({
        dev: true,
        platform: "linux",
        homedir: () => "/home/alice",
        env: { FT5_SYNC_DATA_DIR: "" },
      }),
    ).toBe(
      path.join("/home/alice", "ft5", "sync_app", "dev", "sync-dev.sock"),
    );
  });

  it("defaults platform/homedir/env from process/os when omitted (smoke)", () => {
    // Just assert the call does not throw and returns a non-empty string.
    // The exact shape depends on the host running the test — we cover the
    // four logical branches with explicit injections above.
    const result = resolveSyncPipePath({ dev: true });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
