import { readFile } from "node:fs/promises";
import path from "node:path";

import { BrowserWindow, app, net, protocol, shell } from "electron";
import { buildMainWindowOptions } from "./window-options.js";
import { registerIpcHandlers } from "./ipc/index.js";
import { enforceSingleInstance } from "./single-instance.js";
import { willNavigatePolicy, windowOpenPolicy } from "./navigation-policy.js";
import { openDatabase, runMigrations } from "./db/database.js";
import { DEFAULT_MIGRATIONS } from "./db/migrations.js";
import { initEngine } from "./datasources/engine.js";
import { startSupervisor } from "./sync/supervisor.js";
import { createSyncEventBridge } from "./sync/event-bridge.js";
import { hydrateActiveDownloadsOnce } from "./sync/on-connect-hydrate-downloads.js";
import { hydrateActiveUploadsOnce } from "./sync/on-connect-hydrate-uploads.js";
import { resolveSyncPipePath } from "./sync/pipe-paths.js";
import { resolveServiceNodeBinary } from "./sync/node-binary-resolver.js";
import { getSyncClient, setSyncClient } from "./sync/sync-client-holder.js";
import type { SyncEventBridgeHandle } from "./sync/event-bridge.js";

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

  // Open the main-process SQLite database + run migrations BEFORE handler
  // registration. `initEngine(db)` then constructs the process-wide
  // singleton (registry + factory) that every IPC handler reads via
  // `getEngine()`. Initialized once per process lifetime. Credentials are
  // the fs-sync service's concern and are NOT part of the desktop engine
  // (wire-fs-sync-service section 9).
  const dbPath = path.join(app.getPath("userData"), "ft5.db");
  const db = openDatabase(dbPath);
  runMigrations(db, DEFAULT_MIGRATIONS);
  initEngine(db);

  // Bring up the fs-sync-service transport BEFORE IPC handler
  // registration so section-5 sync handlers can rely on
  // `getSyncClient()` returning a live client at call time.
  //
  // Mode is `dev` when running unpackaged (from `electron-vite dev` /
  // `pnpm dev`), `prod` when packaged. See design.md Decision 6.
  // In dev, the service is owned by pnpm's parallel supervisor — we
  // ONLY connect, never spawn. In prod, we connect-first and fall
  // through to detached spawn on ENOENT/ECONNREFUSED.
  //
  // If supervisor bring-up fails (expected when `pnpm dev` is not
  // running in dev), we continue booting with an uninitialized holder.
  // Subsequent sync IPC calls will throw a clear "sync client not
  // initialized" error via `getSyncClient()`, which the renderer
  // surfaces as a structured IPC failure. Crashing bootstrap here
  // would hide unrelated failures (renderer, datasources) behind a
  // single missing-service black screen; logging and degrading is the
  // documented trade-off (task 4.10 wiring spec).
  const isDev = !app.isPackaged;

  // Declared here so it's accessible both in the try block and outside
  // (for registerWindow / dispose wiring after the try/catch).
  let syncEventBridge: SyncEventBridgeHandle | null = null;

  try {
    const pipePath = resolveSyncPipePath({ dev: isDev });

    let nodeBinary: string | undefined;
    let servicePath: string | undefined;
    if (!isDev) {
      // `resolveServiceNodeBinary` can throw on unsupported arch/platform.
      // Keeping the call inside the try block so a bad packaged target
      // degrades the same as a supervisor failure — logged, skipped, and
      // bootstrap continues rather than leaving a blank BrowserWindow.
      nodeBinary = resolveServiceNodeBinary({
        isPackaged: true,
        appPath: app.getAppPath(),
      });
      // electron-builder copies services/fs-sync/dist → resources/fs-sync
      // (see node-binary-resolver.spike.md §4). fs-sync's entry is
      // dist/main/index.js per its package.json `main`, so the packaged
      // layout is resources/fs-sync/main/index.js. app.getAppPath() ends
      // in resources/app.asar (or resources/app), so `..` strips that
      // off and we land in resources/.
      servicePath = path.join(
        app.getAppPath(),
        "..",
        "fs-sync",
        "main",
        "index.js",
      );
    }

    // Decision 12: startSupervisor now returns SupervisorHandle.
    const syncHandle = await startSupervisor({
      mode: isDev ? "dev" : "prod",
      pipePath,
      ...(nodeBinary !== undefined ? { nodeBinary } : {}),
      ...(servicePath !== undefined ? { servicePath } : {}),
    });
    setSyncClient(syncHandle.getClient());
    syncHandle.on("reconnect", (newClient) => setSyncClient(newClient));

    // Task 7.9 — wire the sync event bridge. The bridge subscribes to the
    // supervisor handle's reconnect/disconnect events, issues the
    // subscribe+list-jobs handshake, and fans sync events to the renderer
    // over SYNC_CHANNELS.event. See design Decision 8: two bridges feed the
    // same renderer — the engine bus bridge for datasource events, and the
    // sync bridge for job lifecycle / upload-progress events.
    syncEventBridge = createSyncEventBridge(syncHandle);
  } catch (err) {
    console.error(
      "[desktop] fs-sync supervisor failed to start — sync IPC handlers will reject until the service is reachable.",
      err,
    );
  }

  // Register window against the sync bridge (Decision 12 — sync bridge is
  // created after supervisor). The renderer's datasource-facing events all
  // flow over `sync:event` now; the dead engine `datasources:event` bridge
  // was removed in migrate-engine-events-to-consumer (no production emitter
  // or consumer).
  syncEventBridge?.registerWindow(window);
  window.on("closed", () => {
    syncEventBridge?.dispose();
  });

  // OAuth consent broker — relocated to the fs-sync service per
  // implement-datasource-onboarding design Decision 1 + Decision 2.
  // The desktop main process retains only the side of the flow it
  // cannot delegate: `shell.openExternal` (in the sync event-bridge,
  // see Decision 6) and dialog rendering (in the renderer). All
  // engine.authenticate() execution, OAuth loopback HTTP listening,
  // OAuth app config consumption, and credential persistence are
  // service-side concerns now.

  // Register IPC handlers AFTER window creation so upload progress events can
  // be routed to the correct renderer via webContents.send.
  registerIpcHandlers(window);

  // add-engine-rename-download §18.9-§18.10 — fire the downloads:list-active
  // hydrate exactly once per app session. Fire-once-per-session is a
  // STRUCTURAL invariant: the call lives here at bootstrap (not inside
  // `startSupervisor` and NOT registered on `syncHandle.on("reconnect", ...)`),
  // so a mid-session pipe reconnect does NOT re-issue the query — the
  // renderer's live event subscriptions resume instead.
  //
  // Wait for `did-finish-load` so the renderer has subscribed to the
  // `files:hydrate-active-downloads` channel before the snapshot lands;
  // otherwise the one-shot event would be dropped.
  if (syncEventBridge !== null) {
    const fireHydrate = (): void => {
      // Closure reads via `getSyncClient()` so the always-current client
      // is used (matches the IPC handler pattern in sync-client-holder.ts).
      void hydrateActiveDownloadsOnce(
        { request: (cmd, params) => getSyncClient().request(cmd, params) },
        (channel, payload) => {
          if (window.isDestroyed()) return;
          window.webContents.send(channel, payload);
        },
      );
      // migrate-upload-orchestration-out-of-engine §13.3 — symmetric
      // upload hydrate. Fires once per app session on the same
      // `did-finish-load` tick as the download hydrate; reconnects
      // mid-session do NOT re-fire (Decision 4). Renderer subscribes
      // via `window.api.files.onActiveUploadsHydrate`.
      void hydrateActiveUploadsOnce(
        { request: (cmd, params) => getSyncClient().request(cmd, params) },
        (channel, payload) => {
          if (window.isDestroyed()) return;
          window.webContents.send(channel, payload);
        },
      );
    };
    if (window.webContents.isLoading()) {
      window.webContents.once("did-finish-load", fireHydrate);
    } else {
      fireHydrate();
    }
  }

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
