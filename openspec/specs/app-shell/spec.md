# app-shell

## Purpose

The `app-shell` capability covers the Electron desktop application's shell: the single main window, the secure `webPreferences` defaults, the `app://` protocol handler that serves the Next.js static export, the ping IPC round-trip that proves four-layer wiring (main / preload / ipc-contracts / renderer), and the renderer's import bans that keep the renderer isolated from OS and database access.

## Requirements

### Requirement: Desktop app launches with a single main window

The desktop app SHALL, when launched on macOS, Windows, or Linux, open exactly one `BrowserWindow` that loads the renderer via a custom `app://` protocol handler registered in the main process. The app SHALL NOT expose a local HTTP dev server in production builds. The window's initial route SHALL be `app://./`, which the renderer maps to the datasources dashboard; the ping-wiring probe is relocated to `app://./diagnostics` and is no longer the home view.

#### Scenario: Production launch on a supported platform

- **WHEN** a packaged build is started on macOS, Windows, or Linux
- **THEN** Electron registers the `app://` protocol, creates exactly one `BrowserWindow`, loads the renderer's `index.html` via `app://`, the window becomes visible within 5 seconds, and the visible view on first paint is the datasources dashboard (loading, empty, or populated state per the dashboard requirement), NOT a timestamp or diagnostics output

#### Scenario: Second instance prevented

- **WHEN** a second instance of the packaged app is launched while the first is running
- **THEN** the main process calls `app.requestSingleInstanceLock()`, the second instance exits, and the original window is focused

#### Scenario: Diagnostics route remains reachable for wiring verification

- **WHEN** the user navigates to `app://./diagnostics` (deep link) or triggers the developer shortcut `Ctrl/Cmd + Shift + D`
- **THEN** the renderer displays the ping probe's result, the existing `ping` IPC wiring is exercised unchanged, and the Playwright end-to-end test at `apps/desktop/e2e/ping.spec.ts` navigates to `/diagnostics` to assert the ping round-trip

### Requirement: Main window enforces hardened Electron defaults

Every `BrowserWindow` created by the main process SHALL be constructed with `webPreferences` that set `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `webSecurity: true`. The main process SHALL NOT call `webContents.executeJavaScript` with any input that originated outside the main process, and SHALL NOT open URLs outside the `app://` origin inside the main window (external URLs open in the OS browser via `shell.openExternal`).

#### Scenario: Security defaults applied

- **WHEN** the main process creates the main window
- **THEN** the window's `webPreferences` report `contextIsolation=true`, `nodeIntegration=false`, `sandbox=true`, and `webSecurity=true`

#### Scenario: External navigation is deflected

- **WHEN** the renderer attempts to navigate the main window to an origin other than `app://`
- **THEN** the main process intercepts via `will-navigate` / `setWindowOpenHandler`, cancels the navigation, and calls `shell.openExternal` for allow-listed `https://` URLs

### Requirement: Ping IPC round-trip proves four-layer wiring

The renderer SHALL be able to invoke `window.api.ping()` and receive an object `{ ok: true, ts: number }` where `ts` is a millisecond epoch produced in the main process. The operation SHALL be implemented as four coordinated pieces: (1) an `ipcMain.handle('ping', …)` handler under `apps/desktop/src/main/ipc/`, (2) a typed contract in `packages/ipc-contracts/` describing the request/response, (3) a `contextBridge.exposeInMainWorld('api', { ping })` binding in `apps/desktop/src/preload/`, (4) a typed call site in the renderer under `apps/desktop/src/renderer/`.

`ping` is defined as a wiring verification op, not a product feature: it SHALL accept zero arguments and return exactly the response shape `{ ok: true, ts: number }` with no additional properties. New capabilities MUST be added as new IPC channel names with their own contracts and handlers; extending `ping`'s request or response shape is disallowed and CI SHALL fail if the `PingRequest` or `PingResponse` type in `packages/ipc-contracts/` gains any field beyond those specified here.

#### Scenario: Successful ping from renderer

- **WHEN** the renderer mounts and calls `window.api.ping()`
- **THEN** the preload forwards the call through `ipcRenderer.invoke('ping')`, the main handler replies with `{ ok: true, ts: Date.now() }`, and the renderer receives that exact shape with `ts` within 2 seconds of the call

#### Scenario: Contract type is the single source of truth

- **WHEN** a developer changes the `ping` response shape in `packages/ipc-contracts/`
- **THEN** the TypeScript build fails in both `apps/desktop/src/main/` and `apps/desktop/src/renderer/` until both the main handler and renderer call site are updated to match

#### Scenario: Ping contract shape is frozen

- **WHEN** `PingRequest` becomes anything other than `void`, or `PingResponse` gains any field other than `ok: true` and `ts: number`
- **THEN** the contract type-assertion test in `packages/ipc-contracts/src/__tests__/ping.test-d.ts` fails and `pnpm -w test` exits non-zero

### Requirement: Renderer has no direct OS or DB access

The renderer bundle SHALL NOT import `fs`, `child_process`, `electron`, any path under `apps/desktop/src/main/`, any path under `apps/desktop/src/preload/`, or any Drizzle package. CI SHALL fail the build when any such import is detected.

#### Scenario: Lint rejects forbidden import

- **WHEN** a file under `apps/desktop/src/renderer/` contains `import … from 'fs'` (or any other forbidden specifier above)
- **THEN** ESLint reports an error and `pnpm lint` exits non-zero

#### Scenario: Drizzle confined to main

- **WHEN** any file outside `apps/desktop/src/main/` imports from `drizzle-orm` or a Drizzle dialect package
- **THEN** CI fails on a dedicated grep step in the workflow, independent of ESLint

### Requirement: Native module dependencies are ready after a clean install

After a fresh `pnpm install` on a clean clone — with no prior `pnpm approve-builds` step, no prior `pnpm rebuild`, and no prior `pnpm --filter @ft5/desktop run postinstall` — the workspace SHALL be in a state where:

1. The Electron binary is present and `require('electron')` from a Node process inside the workspace resolves to a real binary path (i.e. Electron's `install.js` script has executed and written `node_modules/.pnpm/electron@<version>/node_modules/electron/path.txt`).
2. Every native addon depended on by the main process (currently `better-sqlite3`) loads under Electron without an ABI-mismatch error (e.g. without `Error: The module '…better_sqlite3.node' was compiled against a different Node.js version`).

This SHALL be achieved by an explicit `pnpm.onlyBuiltDependencies` allowlist in the repository's root `package.json` — not by per-user configuration, not by a README instruction telling contributors to run `pnpm approve-builds` themselves, and not by disabling pnpm's build-script security default globally.

#### Scenario: Fresh clone can load better-sqlite3 under Electron without manual intervention

- **WHEN** a developer clones the repository, runs `pnpm install`, and then runs `pnpm --filter @ft5/desktop exec electron -e "require('better-sqlite3')"`
- **THEN** the Electron process exits with code 0 and prints no error on stderr, with no prior `pnpm approve-builds`, `pnpm rebuild`, or targeted postinstall run

#### Scenario: Allowlist is defined in source, not per-user pnpm configuration

- **WHEN** a reviewer reads `package.json` at the repo root
- **THEN** there is a `pnpm.onlyBuiltDependencies` array that includes, at minimum, every package pnpm 10 flags in its "Ignored build scripts" warning for the current dependency graph — currently `better-sqlite3`, `electron`, `electron-winstaller`, `esbuild`, `sharp`, and `unrs-resolver`

#### Scenario: Allowlist regression is caught by the test suite

- **WHEN** any commit removes the `pnpm` block from root `package.json`, or drops any of the required packages from the `onlyBuiltDependencies` array
- **THEN** `scripts/pnpm-built-deps.test.ts` fails and `pnpm -w test` exits non-zero
