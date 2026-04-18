import path from "node:path";
import { BrowserWindow, app, protocol, shell } from "electron";
import { buildMainWindowOptions } from "./window-options.js";
import { registerIpcHandlers } from "./ipc/index.js";

// The compiled output is CJS (see `electron.vite.config.ts`), so `__dirname`
// is a built-in and points at `dist/main/` at runtime.

// Enforce one app instance. If another instance already holds the lock, exit
// immediately — the already-running instance will be focused by OS shell
// behavior (we can wire a second-instance listener later when that matters).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
} else {
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
  window.webContents.on("will-navigate", (event, targetUrl) => {
    const target = new URL(targetUrl);
    if (target.protocol === "app:") {
      return;
    }
    event.preventDefault();
    if (target.protocol === "https:") {
      void shell.openExternal(targetUrl);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (target.protocol === "app:") {
      // Still deny: we never open secondary windows even for our own origin
      // in this skeleton. Later changes can relax this if needed.
      return { action: "deny" };
    }
    if (target.protocol === "https:") {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  await window.loadURL("app://index.html");
  window.show();
}
