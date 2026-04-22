// Pipe-path helper tests.
//
// Task 4.10 wires `startSupervisor` into the desktop entry point; that
// wiring needs a desktop-side mirror of the service's `resolveSocketPath`
// (see `services/fs-sync/src/env/paths.ts`). The helper is pure: it
// takes an explicit `dev` flag and — for testability — injected
// `platform` / `homedir` seams that default to `process.platform` /
// `os.homedir()`. Tests assert all four branches (platform × dev).

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

  it("returns the dev Unix socket path under $HOME/ft5/sync_app when platform=linux and dev=true", () => {
    expect(
      resolveSyncPipePath({
        dev: true,
        platform: "linux",
        homedir: () => "/home/alice",
      }),
    ).toBe(path.join("/home/alice", "ft5", "sync_app", "sync-dev.sock"));
  });

  it("returns the prod Unix socket path under $HOME/ft5/sync_app when platform=darwin and dev=false", () => {
    expect(
      resolveSyncPipePath({
        dev: false,
        platform: "darwin",
        homedir: () => "/Users/bob",
      }),
    ).toBe(path.join("/Users/bob", "ft5", "sync_app", "sync.sock"));
  });

  it("defaults platform/homedir from process/os when omitted (smoke)", () => {
    // Just assert the call does not throw and returns a non-empty string.
    // The exact shape depends on the host running the test — we cover the
    // four logical branches with explicit injections above.
    const result = resolveSyncPipePath({ dev: true });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
