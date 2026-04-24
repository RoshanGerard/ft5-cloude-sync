// node-binary-resolver tests.
//
// The resolver (per `node-binary-resolver.spike.md`) picks the absolute
// path to a plain-Node binary the supervisor can spawn detached. It is
// production-only: dev mode throws because pnpm's parallel supervisor
// already started the service (design.md Decision 6).
//
// We inject `platform` / `arch` per the spike's follow-up #2 so every
// OS/arch branch is testable from any host. No filesystem I/O is
// performed by the resolver — the supervisor is responsible for
// surfacing a clear error if the path is missing (spike §5).

import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveServiceNodeBinary } from "./node-binary-resolver.js";

const FAKE_APP_PATH =
  process.platform === "win32"
    ? "C:\\Program Files\\FT5\\resources\\app.asar"
    : "/opt/FT5/resources/app.asar";

describe("resolveServiceNodeBinary", () => {
  it("throws in dev mode (isPackaged=false)", () => {
    expect(() =>
      resolveServiceNodeBinary({
        isPackaged: false,
        appPath: FAKE_APP_PATH,
      }),
    ).toThrow(
      "resolveServiceNodeBinary is production-only; in dev the service is started by `pnpm dev`.",
    );
  });

  it("returns win-x64 path on packaged Windows x64", () => {
    const result = resolveServiceNodeBinary({
      isPackaged: true,
      appPath: FAKE_APP_PATH,
      platform: "win32",
      arch: "x64",
    });
    expect(result).toBe(
      path.join(FAKE_APP_PATH, "..", "node", "win-x64", "node.exe"),
    );
  });

  it("returns win-arm64 path on packaged Windows arm64", () => {
    const result = resolveServiceNodeBinary({
      isPackaged: true,
      appPath: FAKE_APP_PATH,
      platform: "win32",
      arch: "arm64",
    });
    expect(result).toBe(
      path.join(FAKE_APP_PATH, "..", "node", "win-arm64", "node.exe"),
    );
  });

  it("returns darwin-x64 path on packaged macOS x64", () => {
    const result = resolveServiceNodeBinary({
      isPackaged: true,
      appPath: FAKE_APP_PATH,
      platform: "darwin",
      arch: "x64",
    });
    expect(result).toBe(
      path.join(FAKE_APP_PATH, "..", "node", "darwin-x64", "bin", "node"),
    );
  });

  it("returns darwin-arm64 path on packaged macOS arm64", () => {
    const result = resolveServiceNodeBinary({
      isPackaged: true,
      appPath: FAKE_APP_PATH,
      platform: "darwin",
      arch: "arm64",
    });
    expect(result).toBe(
      path.join(FAKE_APP_PATH, "..", "node", "darwin-arm64", "bin", "node"),
    );
  });

  it("returns linux-x64 path on packaged Linux x64", () => {
    const result = resolveServiceNodeBinary({
      isPackaged: true,
      appPath: FAKE_APP_PATH,
      platform: "linux",
      arch: "x64",
    });
    expect(result).toBe(
      path.join(FAKE_APP_PATH, "..", "node", "linux-x64", "bin", "node"),
    );
  });

  it("returns linux-arm64 path on packaged Linux arm64", () => {
    const result = resolveServiceNodeBinary({
      isPackaged: true,
      appPath: FAKE_APP_PATH,
      platform: "linux",
      arch: "arm64",
    });
    expect(result).toBe(
      path.join(FAKE_APP_PATH, "..", "node", "linux-arm64", "bin", "node"),
    );
  });

  it("throws on unsupported arch, naming the arch", () => {
    expect(() =>
      resolveServiceNodeBinary({
        isPackaged: true,
        appPath: FAKE_APP_PATH,
        platform: "linux",
        arch: "ia32",
      }),
    ).toThrow(/ia32/);
  });

  it("throws on unsupported platform, naming the platform", () => {
    expect(() =>
      resolveServiceNodeBinary({
        isPackaged: true,
        appPath: FAKE_APP_PATH,
        platform: "freebsd",
        arch: "x64",
      }),
    ).toThrow(/freebsd/);
  });
});
