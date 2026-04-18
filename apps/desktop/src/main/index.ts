import { fileURLToPath } from "node:url";
import path from "node:path";
import { BrowserWindow, app, protocol, shell } from "electron";
import { buildMainWindowOptions } from "./window-options.js";
import { registerIpcHandlers } from "./ipc/index.js";

// Resolve `__dirname` in an ES module. `import.meta.url` is the file URL of
// THIS compiled module (which will live under `dist/main/` at runtime).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  // TODO(section-8): When Next.js static export (Section 6) + packaging
  // (Section 8) are wired, confirm this relative path against the packaged
  // layout. For now we assume the renderer output lives at `../renderer`
  // relative to the compiled `main/index.js` (i.e. `dist/renderer/` alongside
  // `dist/main/`).
  const rendererRoot = path.join(__dirname, "..", "renderer");
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

  const window = new BrowserWindow(buildMainWindowOptions());

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
