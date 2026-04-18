## 1. Repo baseline

- [x] 1.1 Add `.nvmrc` pinning Node 24.14.1 and `package.json` at repo root with `packageManager: pnpm@<latest>`, `engines.node: "24.14.1"`, and `private: true`.
- [x] 1.2 Add `pnpm-workspace.yaml` declaring `apps/*`, `services/*`, and `packages/*`.
- [x] 1.3 Add `.editorconfig`, `.gitattributes` (enforce LF in repo), and a `.gitignore` covering `node_modules/`, `dist/`, `out/`, `.next/`, `release/`, `coverage/`, `*.log`, OS cruft.
- [x] 1.4 Write a failing `scripts/verify-repo-layout.test.ts` (Vitest, runnable with `pnpm -w vitest run scripts/`) that asserts the presence of each mandated directory (`apps/desktop/src/{main,preload,renderer}`, `services/fs-monitor/src`, `packages/ipc-contracts`); make it pass by creating the empty directories with `.gitkeep`.
- [x] 1.5 Add a root `README.md` with a "Native module rebuild recovery" section documenting `pnpm rebuild` (and `pnpm --filter @ft5/desktop run postinstall` as a targeted fallback) as the recovery path when `better-sqlite3` fails to load due to an Electron/Node ABI mismatch after a dependency upgrade or switch of machine.

## 2. TypeScript + shared tooling

- [x] 2.1 Add `tsconfig.base.json` at repo root with `strict: true`, `target: ES2023`, `module: NodeNext`, `moduleResolution: NodeNext`, `verbatimModuleSyntax: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and `skipLibCheck: false`.
- [x] 2.2 Install `typescript@6.0.3` at the root as a dev dep and wire `pnpm -w typecheck` to run `tsc -b` across project references.
- [x] 2.3 Add root ESLint config (`eslint.config.js`, flat config) with `@typescript-eslint`, `eslint-plugin-import`, and the `no-restricted-paths` rule scoped to `apps/desktop/src/renderer/**` forbidding imports from `fs`, `child_process`, `electron`, any `node:*` specifier, `apps/desktop/src/main/**`, and `apps/desktop/src/preload/**`.
- [x] 2.4 Add Prettier config (`.prettierrc`) and `pnpm -w format` / `pnpm -w format:check` scripts.
- [x] 2.5 Write a failing ESLint-rule unit test (fixture file under `apps/desktop/src/renderer/__forbidden__/fs-import.ts` that imports `fs`) and assert `pnpm lint` exits non-zero; satisfy by confirming the ESLint rule fires; then delete the fixture.

## 3. IPC contract package

- [x] 3.1 Create `packages/ipc-contracts/package.json` (name `@ft5/ipc-contracts`, `main`/`types` pointing at `src/index.ts`, no build step) and `tsconfig.json` extending the base, marked as composite.
- [x] 3.2 Write a failing Vitest test in `packages/ipc-contracts/src/__tests__/ping.test-d.ts` that type-asserts `PingRequest` is `void` and `PingResponse` is `{ ok: true; ts: number }`; make it pass by exporting those types from `src/index.ts`.

## 4. Main process (Electron)

- [x] 4.1 Create `apps/desktop/package.json` declaring `electron@41.2.1`, `better-sqlite3`, `drizzle-orm`, `electron-updater`, `electron-builder` (dev), `electron-vite` (dev), `@electron/rebuild` (dev); wire `postinstall` to run `@electron/rebuild`.
- [x] 4.2 Add `apps/desktop/electron.vite.config.ts` with separate main, preload, and renderer configs; renderer config delegates to Next.js static export output rather than bundling through Vite.
- [x] 4.3 Write a failing Vitest unit test `apps/desktop/src/main/__tests__/window-options.test.ts` that imports a `buildMainWindowOptions()` helper and asserts `webPreferences.contextIsolation === true`, `nodeIntegration === false`, `sandbox === true`, `webSecurity === true`; implement `buildMainWindowOptions` in `apps/desktop/src/main/window-options.ts` to make it pass.
- [x] 4.4 Write a failing Vitest test `apps/desktop/src/main/ipc/__tests__/ping.test.ts` that calls the exported `handlePing` directly and asserts the result shape `{ ok: true, ts: <number> }` with `ts` within ±2s of `Date.now()`; implement `apps/desktop/src/main/ipc/ping.ts` exporting `handlePing` and registering it via `ipcMain.handle('ping', handlePing)` in `apps/desktop/src/main/ipc/index.ts`.
- [x] 4.5 Implement `apps/desktop/src/main/index.ts`: `app.requestSingleInstanceLock()` (exit if not acquired), register the `app://` protocol with `protocol.registerFileProtocol` pointing at the renderer's exported static directory, register all IPC handlers from `ipc/index.ts`, create one `BrowserWindow` using `buildMainWindowOptions()`, wire `will-navigate` and `setWindowOpenHandler` to deflect non-`app://` origins through `shell.openExternal` (only for `https://`).

## 5. Preload script

- [x] 5.1 Write a failing Vitest test `apps/desktop/src/preload/__tests__/exposed-api.test.ts` that loads the preload module with a mocked `contextBridge` and asserts exactly one call to `exposeInMainWorld('api', <obj>)` where the exposed object has a `ping: () => Promise<PingResponse>` property and nothing else.
- [x] 5.2 Implement `apps/desktop/src/preload/index.ts` calling `contextBridge.exposeInMainWorld('api', { ping: () => ipcRenderer.invoke('ping') })`; add the matching `Window` type declaration in a preload-local `.d.ts` that re-exports `PingResponse` from `@ft5/ipc-contracts`.

## 6. Renderer (Next.js 16 static export)

- [x] 6.1 Create `apps/desktop/src/renderer/package.json` and `next.config.mjs` with `output: 'export'`, `images: { unoptimized: true }`, and an empty `basePath`; add `tsconfig.json` extending the base with `jsx: preserve` and DOM libs only.
- [x] 6.2 Write a failing Vitest + jsdom test `apps/desktop/src/renderer/src/app/__tests__/ping-page.test.tsx` that renders the root page with `window.api.ping` stubbed to return `{ ok: true, ts: 1712345678901 }` and asserts the rendered DOM contains the string `1712345678901`; implement the page under `apps/desktop/src/renderer/src/app/page.tsx` to call `window.api.ping()` on mount and render the `ts` value.
- [x] 6.3 Add the `window.api` ambient declaration under `apps/desktop/src/renderer/src/types/window-api.d.ts`, typed against `@ft5/ipc-contracts`.

## 7. fs-monitor service stub

- [x] 7.1 Create `services/fs-monitor/package.json` and `tsconfig.json` extending the base (Node target, no DOM libs).
- [x] 7.2 Write a failing Vitest test `services/fs-monitor/src/__tests__/entry.test.ts` that imports the entry module and asserts it exports a `start()` function whose call is a no-op returning `{ started: true }`; implement `services/fs-monitor/src/index.ts` accordingly.

## 8. Packaging (electron-builder)

- [x] 8.1 Add `apps/desktop/electron-builder.yml` targeting macOS (dmg), Windows (nsis), Linux (AppImage + deb); reference signing env vars but do not require them to be present.
- [x] 8.2 Add `pnpm --filter @ft5/desktop package:mac`, `package:win`, `package:linux` scripts wrapping `electron-builder --mac` / `--win` / `--linux`; verify locally on the current platform that an unsigned artifact builds. (Win: `release/win-unpacked/FT5 Claude Sync.exe` produced; NSIS installer step requires Windows Developer Mode or elevation for winCodeSign symlinks — deferred to signing-capable CI host.)

## 9. End-to-end test (Playwright)

- [ ] 9.1 Add `apps/desktop/playwright.config.ts` using Playwright's Electron launcher, pointing at the packaged build output of the current platform.
- [ ] 9.2 Write a failing e2e test `apps/desktop/e2e/ping.spec.ts` that launches the packaged app, waits for the main window, asserts the DOM contains a 13-digit `ts` value, and closes the app; make it pass end-to-end on the dev machine.

## 10. Continuous integration

- [x] 10.1 Add `.github/workflows/ci.yml` with a 3-OS matrix (macOS-latest, windows-latest, ubuntu-latest), running: install, typecheck, lint, unit tests, package, and Playwright e2e. Each job caches the pnpm store keyed on the lockfile hash.
- [x] 10.2 Add a dedicated CI step (shell, not ESLint) that fails the job if `drizzle-orm` appears anywhere outside `apps/desktop/src/main/**`. Seed a temporary fixture to confirm the step fails, then remove it.

## 11. Verification before archive

- [ ] 11.1 Run `pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm --filter @ft5/desktop package:<current-os> && pnpm --filter @ft5/desktop e2e` locally; all green.
- [ ] 11.2 Confirm every spec scenario in `specs/app-shell/spec.md` is covered by at least one passing test (unit or e2e) — map each scenario to its test file in the PR description before merge.
- [ ] 11.3 Open the packaged app on the dev machine, watch a 13-digit timestamp render in the window, close cleanly. Record that manual step in the PR description.
