# Project Context

Cloud file sync desktop app to manager local file sync to multiple datasources such as google drive, one-drive, s3.
Users can swtich between different datasources and manager file sync, auto sync, sheduled sync, manual sync.

## Stack
- Runtime: Node.js 24.14.1 LTS, Electron v41.2.1
- Language: TypeScript 6.0.3 (strict mode)
- Framework: React 19.2.5 (rendered by Next.js 16 static export — see renderer section)
- Database: SQLite via Drizzle ORM
- Test runner: Vitest
- Package manager: pnpm

## Component

### Desktop app — `apps/desktop/`

#### Main process — `apps/desktop/src/main/`
- Runtime: **Electron** (pin the major version in `package.json`; the embedded Node.js and Chromium versions come from the Electron release and are not independently selectable)
- Language: TypeScript 6.0.3 (strict mode)
- DB client: Drizzle ORM against SQLite (the ONLY place Drizzle may be imported)
- IPC: `ipcMain` handlers in `src/main/ipc/*`, one handler per renderer-facing operation
- Test runner: Vitest (unit) + Playwright (end-to-end across processes)

#### Preload script — `apps/desktop/src/preload/`
- Language: TypeScript 6.0.3 (strict mode)
- Purpose: expose a typed API via `contextBridge.exposeInMainWorld('api', …)`
- Must not import application code. Must not import Drizzle, `fs`, `child_process`, or any Node built-in beyond what the exposed API surface strictly requires.

#### Renderer — `apps/desktop/src/renderer/`
- Runtime: **Electron renderer** (sandboxed Chromium; version is determined by the Electron major above, not pinned independently)
- Language: TypeScript 6.0.3 (strict mode)
- Framework: Next.js 16 with `output: 'export'` (static HTML loaded via custom `app://` protocol). NOT a running Next.js server.
- UI data access: ONLY through `window.api.*` exposed by the preload script
- Test runner: Vitest with jsdom

### File Monitor service - `services/fs-monitor`

#### Main process — `services/fs-monitor/src/main/`
- Runtime: **Node.js**
- DB client: Drizzle ORM against SQLite (the ONLY place Drizzle may be imported)
- Test runner: Vitest (unit)
- Purpose: Runs as a background service to monitor auto sync files, directories for changes and sync to user configured cloud storage source destination, Only FileSystem to Cloud Sync Supported.

## Shared
- Database: SQLite, file lives under Electron's `userData` path. **Only the main process connects to it.** Renderer must not install or import a DB client.
- IPC contract: TypeScript types in `packages/ipc-contracts/` shared between main and renderer. Contract changes require updating both sides and the preload exposure.
- Packager: electron-builder. Installer targets: macOS (dmg, signed + notarized), Windows (nsis, signed), Linux (AppImage, deb).
- Electron security defaults: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`. These are not to be disabled.

## Architecture rules (non-negotiable)
- Renderer MUST NOT import from `main/`, `preload/`, `fs`, `child_process`, `electron`, or any Node built-in. All OS/DB/file access goes through `window.api.*`.
- Preload MUST NOT import application logic. Only `contextBridge` wiring and type re-exports from `packages/ipc-contracts/`.
- Every renderer-callable operation exists as four coordinated pieces: (1) a handler in `main/ipc/`, (2) a typed contract in `packages/ipc-contracts/`, (3) a `contextBridge` exposure in `preload/`, (4) a typed call site in the renderer. A proposal missing any of the four is incomplete.
- Drizzle imports are allowed only under `apps/desktop/src/main/`. CI greps for violations.
- Disabling any of the Electron security defaults listed in `## Shared` requires explicit justification in `design.md` and sign-off. Treat it like adding a production dependency.
- Never call `webContents.executeJavaScript` with user-controlled input. Never open `BrowserWindow` instances with `nodeIntegration: true`.
- Auto-update via `electron-updater`. Release signing keys live in CI secrets, never in the repo.

## Conventions
- Naming: `kebab-case` files, PascalCase components (renderer) and classes (main).
- Commit style: Conventional Commits with scope: `feat(main):`, `fix(renderer):`, `chore(ipc):`.
- Branches: `feature/<change-id>`, `fix/<short-desc>`.

## Out of scope (don't propose these unless asked)
- Disabling context isolation or the sandbox.
- Adding DB clients or filesystem access to the renderer.
- Running Next.js as a server inside Electron (use static export).
- Shipping an unsigned or un-notarized installer.