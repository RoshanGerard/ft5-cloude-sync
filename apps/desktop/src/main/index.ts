import { readFile } from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, app, net, protocol, shell } from "electron";
import { buildMainWindowOptions } from "./window-options.js";
import { registerIpcHandlers } from "./ipc/index.js";
import { enforceSingleInstance } from "./single-instance.js";
import { willNavigatePolicy, windowOpenPolicy } from "./navigation-policy.js";

// The compiled output is CJS (see `electron.vite.config.ts`), so `__dirname`
// is a built-in and points at `dist/main/` at runtime.

// Register the `app://` scheme as a privileged origin BEFORE `app.whenReady()`.
// Load URLs use an explicit `local` hostname (`app://local/...`) rather than
// embedding the filename as host (`app://index.html` — the original buggy
// form). Under `standard: true`, Chromium parses `app://index.html` as
// host="index.html", which it refuses to treat as a proper origin, denying
// secure-context APIs (localStorage throws SecurityError) and emitting the
// "Unsafe attempt to load URL ... Domains, protocols and ports must match"
// warning on every navigation. `app://local/...` gives host="local", a
// valid hostname, producing the origin `app://local` — secure-context APIs
// work, the warning clears. Privileges:
//   - `standard: true`: required for origin semantics (and localStorage).
//   - `secure: true`: grants secure-context APIs to this origin.
//   - `supportFetchAPI: true`: lets `fetch("app://...")` work from renderer.
//   - `corsEnabled: true`: same-origin and CORS handling for cross-asset loads.
// Electron enforces this call must happen at top-level module load, before
// `app.whenReady()` — registering later is a no-op. Guardrail at
// `apps/desktop/src/main/__tests__/scheme-privileges.test.ts` enforces this.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

// Enforce one app instance. If another instance already holds the lock, exit
// immediately — the already-running instance will be focused by OS shell
// behavior (we can wire a second-instance listener later when that matters).
if (enforceSingleInstance(app) === "acquired") {
  void bootstrap();
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
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

  // `protocol.handle` is the modern Electron 25+ API (replaces the
  // deprecated `registerFileProtocol`). The handler receives a `Request`
  // and returns a `Response` — standard fetch semantics, which plays
  // correctly with the `standard: true` scheme privilege. Returning a
  // Response means Chromium's loader gets proper Content-Type and body
  // handling, which fixes sub-resource loads (CSS, fonts, JS chunks)
  // that the old `callback({ path })` style mishandled under standard
  // scheme semantics.
  //
  // URL resolution for Next.js static export:
  //   `app://local/`               -> `<rendererRoot>/index.html`
  //   `app://local/index.html`     -> `<rendererRoot>/index.html`
  //   `app://local/diagnostics`    -> `<rendererRoot>/diagnostics.html`
  //                                    (falls through to the /index.html
  //                                    form below if the `.html` file is
  //                                    absent)
  //   `app://local/diagnostics/`   -> `<rendererRoot>/diagnostics/index.html`
  //   `app://local/_next/.../x.css` -> `<rendererRoot>/_next/.../x.css`
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    let relative = url.pathname.replace(/^\/+/, "");
    if (relative === "" || relative.endsWith("/")) {
      relative += "index.html";
    }

    const candidates: string[] = [path.normalize(path.join(rendererRoot, relative))];
    // Next.js static export writes both `foo.html` and `foo/index.html`
    // for nested routes. If the first candidate is a bare route name
    // (no extension), try `<name>.html` then `<name>/index.html` as
    // fallbacks. This matches how a classic static file server would
    // serve the export.
    if (!path.extname(relative)) {
      candidates.push(
        path.normalize(path.join(rendererRoot, `${relative}.html`)),
        path.normalize(path.join(rendererRoot, relative, "index.html")),
      );
    }

    for (const resolved of candidates) {
      if (!resolved.startsWith(rendererRoot)) continue;
      try {
        const body = await readFile(resolved);
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": contentTypeForPath(resolved) },
        });
      } catch {
        // Try the next candidate.
      }
    }
    return new Response("Not Found", { status: 404 });
  });

  // `__dirname` resolves to `dist/main/` at runtime in both packaged and dev
  // builds, and the preload bundle is emitted to `dist/preload/index.js`, so
  // a single relative path works in both modes (no `app.isPackaged` branch).
  const preloadPath = path.join(__dirname, "..", "preload", "index.js");
  const window = new BrowserWindow(buildMainWindowOptions(preloadPath));

  // Register IPC handlers AFTER window creation so upload progress events can
  // be routed to the correct renderer via webContents.send.
  registerIpcHandlers(window);

  // Silence the `net` import lint — `net.fetch` is available for future
  // handler work that needs to chain to file:// URLs. Kept imported here
  // so the protocol handler can be extended to proxy external origins if
  // ever needed.
  void net;

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

  // Load via a proper hostname ("local") — see the comment on
  // `registerSchemesAsPrivileged` above. `app://local/index.html` produces
  // the origin `app://local`, which Chromium recognizes as a valid origin,
  // granting secure-context APIs (localStorage, fetch, etc.) and clearing
  // the "Unsafe attempt to load URL" same-origin warning.
  await window.loadURL("app://local/index.html");
  window.show();
}
