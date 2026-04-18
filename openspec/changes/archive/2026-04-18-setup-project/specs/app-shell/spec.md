## ADDED Requirements

### Requirement: Desktop app launches with a single main window

The desktop app SHALL, when launched on macOS, Windows, or Linux, open exactly one `BrowserWindow` that loads the renderer via a custom `app://` protocol handler registered in the main process. The app SHALL NOT expose a local HTTP dev server in production builds.

#### Scenario: Production launch on a supported platform

- **WHEN** a packaged build is started on macOS, Windows, or Linux
- **THEN** Electron registers the `app://` protocol, creates exactly one `BrowserWindow`, loads the renderer's `index.html` via `app://`, and the window becomes visible within 5 seconds

#### Scenario: Second instance prevented

- **WHEN** a second instance of the packaged app is launched while the first is running
- **THEN** the main process calls `app.requestSingleInstanceLock()`, the second instance exits, and the original window is focused

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
