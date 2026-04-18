## Why

The repo is empty except for scaffolding docs. Before any product feature can land, we need a monorepo that (a) enforces the architecture rules in `openspec/project.md` — Drizzle only in main, no Node built-ins in the renderer, four-layer IPC wiring for every user-facing op — and (b) proves end-to-end that an Electron main/preload/renderer round trip actually works on all three target platforms. Building a feature against an unproven skeleton would be guess-and-check; building the skeleton first gives every later proposal a known-good foundation to diff against.

## What Changes

- Add a pnpm workspaces monorepo with the layout `apps/desktop/` (main, preload, renderer), `services/fs-monitor/`, and `packages/ipc-contracts/` as declared in `openspec/project.md`.
- Pin Node 24.14.1 LTS and Electron 41.2.1 (via `.nvmrc` and `package.json#engines` / `electron` dep); set TypeScript 6.0.3 with strict mode as the single TS version across all workspaces.
- Add per-workspace `tsconfig.json` files with project references; root `tsconfig.base.json` holds shared compiler options.
- Add Vitest (unit) config for main, preload, renderer (jsdom), and fs-monitor; add Playwright config for an end-to-end test that launches the packaged-ish app and exercises the IPC ping.
- Add ESLint + Prettier configured to fail on: renderer importing `fs` / `child_process` / `electron` / `main/**` / `preload/**`, Drizzle imports outside `apps/desktop/src/main/**`, and disabled Electron security defaults.
- Add `electron-builder` config targeting macOS (dmg), Windows (nsis), Linux (AppImage, deb) with signing/notarization wired through CI secrets (not committed).
- Add a walking-skeleton `app-shell` capability: main process creates one `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; preload exposes `window.api.ping()`; an `ipcMain` handler replies with `{ ok: true, ts }`; renderer calls it on mount and shows the result. Every one of the four layers (main/ipc, ipc-contracts, preload, renderer) is exercised.
- Add a GitHub Actions CI workflow running typecheck, lint, unit tests, and Playwright on macOS + Windows + Linux runners for every PR.

## Capabilities

### New Capabilities
- `app-shell`: the desktop app boots, opens a single main window with hardened Electron defaults, and exposes one end-to-end IPC operation (`ping`) that proves the four-layer wiring.

### Modified Capabilities
<!-- None — greenfield repo, no existing specs. -->

## Impact

- **Code**: creates `apps/desktop/{main,preload,renderer}/`, `services/fs-monitor/`, `packages/ipc-contracts/`, root tooling (`pnpm-workspace.yaml`, `tsconfig.base.json`, `.eslintrc.*`, `.prettierrc`, `vitest.*.config.ts`, `playwright.config.ts`, `electron-builder.yml`), `.github/workflows/ci.yml`.
- **Dependencies (production)**: `electron@41.2.1`, `react@19.2.5`, `react-dom@19.2.5`, `next@16.x`, `drizzle-orm`, `better-sqlite3` (or `@libsql/client` — decide in design.md), `electron-updater`.
- **Dependencies (dev)**: `typescript@6.0.3`, `vitest`, `@vitest/coverage-v8`, `jsdom`, `@playwright/test`, `electron-builder`, `eslint`, `@typescript-eslint/*`, `prettier`, `tsx` or `electron-vite` (decide in design.md).
- **CI**: adds macOS/Windows/Linux matrix; signing keys referenced as secrets but not exercised until a later release-signing change.
- **Security**: establishes the Electron hardening baseline (`contextIsolation`, `sandbox`, `nodeIntegration: false`, `webSecurity`) — subsequent changes must preserve it.
- **Out of scope** (deferred): auto-update wiring beyond declaring the dependency, real cloud-provider sync code (Google Drive / OneDrive / S3), the fs-monitor service's watcher logic beyond a compiling empty entry point, notarization key provisioning.
