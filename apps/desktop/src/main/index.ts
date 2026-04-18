import path from "node:path";
import { BrowserWindow, app, protocol, shell } from "electron";
import { buildMainWindowOptions } from "./window-options.js";
import { registerIpcHandlers } from "./ipc/index.js";
import { enforceSingleInstance } from "./single-instance.js";
import { willNavigatePolicy, windowOpenPolicy } from "./navigation-policy.js";

// The compiled output is CJS (see `electron.vite.config.ts`), so `__dirname`
// is a built-in and points at `dist/main/` at runtime.

// Enforce one app instance. If another instance already holds the lock, exit
// immediately — the already-running instance will be focused by OS shell
// behavior (we can wire a second-instance listener later when that matters).
if (enforceSingleInstance(app) === "acquired") {
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // Register `app://` to serve the renderer's exported static files.
  //
  // Packaged: electron-builder copies `src/renderer/out/` into the app's
  // `resources/renderer/` directory (see `electron-builder.yml`
  // `extraResources`), so `process.resourcesPath + "/renderer"` is the root.
  // Dev (unpackaged): the main bundle runs from `dist/main/`, and Next.js
  // emits to `src/renderer/out/`, so we resolve back up out of `dist/main/`
  // to the repo's renderer output directory.
  const rendererRoot = app.isPackaged
    ? path.join(process.resourcesPath, "renderer")
    : path.join(__dirname, "../../src/renderer/out");
  protocol.registerFileProtocol("app", (request, callback) => {
    const url = new URL(request.url);
    // Strip the leading slash so `app://index.html` resolves to
    // `<rendererRoot>/index.html` and never escapes the renderer root.
    const relative = url.pathname.replace(/^\/+/, "") || "index.html";
    const resolved = path.normalize(path.join(rendererRoot, relative));
    if (!resolved.startsWith(rendererRoot)) {
      callback({ error: -6 /* net::ERR_FILE_NOT_FOUND */ });
      return;
    }
    callback({ path: resolved });
  });

  registerIpcHandlers();

  // `__dirname` resolves to `dist/main/` at runtime in both packaged and dev
  // builds, and the preload bundle is emitted to `dist/preload/index.js`, so
  // a single relative path works in both modes (no `app.isPackaged` branch).
  const preloadPath = path.join(__dirname, "..", "preload", "index.js");
  const window = new BrowserWindow(buildMainWindowOptions(preloadPath));

  // Deflect any attempt to navigate away from `app://`. For `https://` we
  // hand the URL off to the OS browser via `shell.openExternal`; for any
  // other protocol we deny silently. This matches the threat model where
  // the renderer is loaded exclusively from our own static bundle and no
  // in-window navigation to third-party origins is ever desired.
  //
  // The policy itself lives in `./navigation-policy.ts` as a pure function
  // so it can be unit tested without booting Electron. `will-navigate`
  // short-circuits on `app:` URLs so internal navigation continues to work
  // (the policy helper returns `deny` for `app:`, but the caller never
  // applies that decision to internal traffic).
  window.webContents.on("will-navigate", (event, targetUrl) => {
    let target: URL;
    try {
      target = new URL(targetUrl);
    } catch {
      event.preventDefault();
      return;
    }
    if (target.protocol === "app:") {
      return;
    }
    const decision = willNavigatePolicy(targetUrl);
    event.preventDefault();
    if ("openExternal" in decision) {
      void shell.openExternal(decision.openExternal);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    // Secondary windows are always denied, even for our own `app:` origin.
    // For `https:` the helper additionally asks us to open externally.
    const decision = windowOpenPolicy(url);
    if ("openExternal" in decision) {
      void shell.openExternal(decision.openExternal);
    }
    return { action: "deny" };
  });

  await window.loadURL("app://index.html");
  window.show();
}
