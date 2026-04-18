import { _electron as electron, expect, test } from "@playwright/test";
import path from "node:path";
import process from "node:process";

// Playwright's Electron launcher takes an absolute path to the built binary.
// electron-builder emits platform-specific layouts under `apps/desktop/release/`;
// pick the right one for the current OS.
const platformExe = {
  win32: "release/win-unpacked/FT5 Claude Sync.exe",
  darwin: "release/mac/FT5 Claude Sync.app/Contents/MacOS/FT5 Claude Sync",
  linux: "release/linux-unpacked/ft5-cloude-sync",
} as const;

const rel = platformExe[process.platform as keyof typeof platformExe];
const exePath = path.resolve(__dirname, "..", rel);

test("ping page renders a 13-digit ts", async () => {
  const app = await electron.launch({ executablePath: exePath });
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    // The renderer calls window.api.ping() on mount; the main handler returns
    // { ok: true, ts: Date.now() } and the page renders String(ts). A 13-digit
    // integer matches any current-era ms-epoch timestamp.
    const body = window.locator("body");
    await expect(body).toContainText(/\b\d{13}\b/, { timeout: 10_000 });
  } finally {
    await app.close();
  }
});
