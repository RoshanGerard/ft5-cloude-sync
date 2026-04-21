// Standing regression test over the per-OS installer scripts. The real
// installer paths need VM / real OS to exercise; this suite asserts that
// each expected script exists and carries the spec-mandated command
// template. Full execution coverage lives in a CI matrix (windows /
// macOS / linux runners) wired in phase 22.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const installerRoot = path.resolve(__dirname, "..", "installer");

function read(rel: string): string {
  return fs.readFileSync(path.join(installerRoot, rel), "utf8");
}

describe("Windows installer scripts", () => {
  it("register.ps1 invokes schtasks /Create /SC ONLOGON /RL LIMITED with /TN ft5-sync", () => {
    const src = read("windows/register.ps1");
    expect(src).toMatch(/schtasks[\s\S]*?\/Create/);
    expect(src).toMatch(/\/SC\s+ONLOGON/);
    expect(src).toMatch(/\/TN\s+\$taskName|\/TN\s+"?ft5-sync"?/);
    expect(src).toMatch(/\/RL\s+LIMITED/);
  });

  it("unregister.ps1 invokes schtasks /Delete on the ft5-sync task", () => {
    const src = read("windows/unregister.ps1");
    expect(src).toMatch(/schtasks\s+\/Delete/);
    expect(src).toMatch(/\$taskName|ft5-sync/);
  });
});

describe("macOS installer scripts", () => {
  it("register.sh writes a LaunchAgent plist and launchctl loads it", () => {
    const src = read("macos/register.sh");
    expect(src).toContain("Library/LaunchAgents");
    expect(src).toContain("tech.forti5.ft5-sync");
    expect(src).toMatch(/RunAtLoad\s*<\/key>\s*<true\/>/);
    expect(src).toMatch(/KeepAlive\s*<\/key>\s*<true\/>/);
    expect(src).toContain("launchctl load");
  });

  it("unregister.sh invokes launchctl unload and deletes the plist", () => {
    const src = read("macos/unregister.sh");
    expect(src).toContain("launchctl unload");
    expect(src).toContain("rm -f");
  });
});

describe("Linux installer scripts", () => {
  it("register.sh writes a systemd --user unit, enables it, and invokes loginctl enable-linger", () => {
    const src = read("linux/register.sh");
    expect(src).toContain(".config/systemd/user");
    expect(src).toContain("ft5-sync.service");
    expect(src).toContain("systemctl --user enable --now ft5-sync.service");
    expect(src).toContain("loginctl enable-linger");
    // XDG autostart fallback is present for distros without systemd --user.
    expect(src).toContain("autostart");
    expect(src).toContain("ft5-sync.desktop");
  });

  it("unregister.sh invokes systemctl --user disable and deletes both the unit and autostart entry", () => {
    const src = read("linux/unregister.sh");
    expect(src).toContain("systemctl --user disable --now ft5-sync.service");
    expect(src).toContain("ft5-sync.service");
    expect(src).toContain("ft5-sync.desktop");
  });
});
