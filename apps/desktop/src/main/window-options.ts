import type { BrowserWindowConstructorOptions } from "electron";

// Builds the `BrowserWindowConstructorOptions` for the app's primary window.
//
// The four `webPreferences` flags below are the non-negotiable Electron
// security defaults called out in `openspec/project.md#Shared`. They are
// asserted in a unit test (`__tests__/window-options.test.ts`) so that any
// accidental weakening breaks the build before it reaches review.
//
// This module intentionally does NOT `import { BrowserWindow } from "electron"`
// at runtime — the unit test runs in Node (not Electron), and importing the
// `electron` package from a plain Node process fails. `import type` is erased
// at transpile time, so the test harness never tries to resolve the module.
export function buildMainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  };
}
