# PR: setup-project (walking skeleton)

Implements the `setup-project` OpenSpec change on branch `feature/setup-project`.

## Summary

- pnpm monorepo (apps/desktop, packages/ipc-contracts, services/fs-monitor)
- Electron 41.2.1 main + preload + Next.js 16 static-export renderer
- Ping IPC round-trip wired end-to-end, covered by unit tests at each layer and by Playwright e2e against the packaged binary
- Strict TS 6.0.3, ESLint flat config (renderer-scoped forbidden imports), Prettier
- electron-builder config for mac/win/linux unsigned builds
- 3-OS GitHub Actions CI with pnpm-store cache keyed on lockfile + drizzle-orm boundary guard

## Verification (task 11.1)

All on `feature/setup-project` at commit `$(git rev-parse --short HEAD)` on Windows 11 (Node 24.14.1, pnpm 10.33.0):

| Gate | Command | Result |
|---|---|---|
| Typecheck | `pnpm -w typecheck` | exit 0 |
| Lint | `pnpm -w lint` | exit 0 |
| Format | `pnpm -w format:check` | exit 0 |
| Unit tests | `pnpm -w test` | 28/28 passed (11 test files) |
| Package | `pnpm --filter @ft5/desktop package:win` | `release/win-unpacked/FT5 Claude Sync.exe` produced; NSIS installer step requires Windows Developer Mode on this host and is deferred to CI |
| E2E | `pnpm --filter @ft5/desktop e2e` | 1/1 passed (launched packaged exe, asserted 13-digit ts in DOM, closed) |

## Spec-scenario → test map (task 11.2)

Spec file: `openspec/changes/setup-project/specs/app-shell/spec.md`.

### Requirement: Desktop app launches with a single main window

| Scenario | Coverage |
|---|---|
| Production launch on a supported platform | `apps/desktop/e2e/ping.spec.ts` — launches packaged exe, `firstWindow()`, waits for domcontentloaded, closes cleanly |
| Second instance prevented | `apps/desktop/src/main/__tests__/single-instance.test.ts` — asserts `enforceSingleInstance` returns `"acquired"` and does not call `exit` when the lock is obtained, and returns `"exited"` + calls `exit(0)` exactly once when a second instance is attempted. Policy extracted to `apps/desktop/src/main/single-instance.ts` |

### Requirement: Main window enforces hardened Electron defaults

| Scenario | Coverage |
|---|---|
| Security defaults applied | `apps/desktop/src/main/__tests__/window-options.test.ts` — asserts literal `contextIsolation`, `nodeIntegration`, `sandbox`, `webSecurity`, and `preload` values from `buildMainWindowOptions` |
| External navigation is deflected | `apps/desktop/src/main/__tests__/navigation-policy.test.ts` — 6 cases on the pure `willNavigatePolicy` / `windowOpenPolicy` helpers (`apps/desktop/src/main/navigation-policy.ts`): `https://` → `deny` + `openExternal`; `http://`, `file://`, `javascript:`, `app://`, and malformed URLs all → `deny` with no external hand-off |

### Requirement: Ping IPC round-trip proves four-layer wiring

| Scenario | Coverage |
|---|---|
| Successful ping from renderer | End-to-end via four tests: `apps/desktop/src/main/ipc/__tests__/ping.test.ts` (main handler shape + ts ±2s of `Date.now()`), `apps/desktop/src/preload/__tests__/exposed-api.test.ts` (preload exposes exactly `{ ping }` on `api`), `apps/desktop/src/renderer/src/app/__tests__/ping-page.test.tsx` (renderer calls `window.api.ping` and renders `ts`), `apps/desktop/e2e/ping.spec.ts` (packaged-app round-trip, 13-digit ts) |
| Contract type is the single source of truth | `packages/ipc-contracts/src/__tests__/ping.test-d.ts` + TS project references wire `packages/ipc-contracts` into `apps/desktop`; any shape change fails `pnpm -w typecheck` |
| Ping contract shape is frozen | `packages/ipc-contracts/src/__tests__/ping.test-d.ts` — `expectTypeOf<PingResponse>().toEqualTypeOf<{ ok: true; ts: number }>()` with literal `true` catches any new field or loosened type |

### Requirement: Renderer has no direct OS or DB access

| Scenario | Coverage |
|---|---|
| Lint rejects forbidden import | `scripts/lint-forbidden-import.test.ts` — standing regression test that writes a `__forbidden_lint_regression__/forbidden.ts` fixture with `import * as fs from "fs";`, invokes `pnpm exec eslint` on it, asserts non-zero exit and that the output matches `/no-restricted-imports/` and `/fs/`. Fixture is cleaned up in `afterEach` even on failure. Complements the RED-GREEN proof from Section 2.5 |
| Drizzle confined to main | `.github/workflows/ci.yml` — `drizzle-boundary` job greps for `drizzle-orm` imports outside `apps/desktop/src/main/**` and exits non-zero if any found. Proven RED-then-GREEN locally during Section 10 with a temp fixture |

**Summary: 8 scenarios, all 8 with standing automated test coverage.**

## Manual verification (task 11.3)

The Section 9 e2e test (`apps/desktop/e2e/ping.spec.ts`) performs the task-11.3 check programmatically: launches `release/win-unpacked/FT5 Claude Sync.exe`, observes the 13-digit `ts` render in the main window, and closes cleanly. Playwright's 1-pass result is the machine-checked equivalent of the human observation the task describes.

## Known follow-ups

1. NSIS installer regeneration requires Windows Developer Mode or elevated shell — the dev host lacks both. CI runners have neither constraint.
2. Native `better-sqlite3` rebuild runs via `@electron/rebuild` postinstall; on dev hosts without MSVC Build Tools, use `pnpm install --ignore-scripts` then rebuild once (documented in `README.md`).

## Commits on this branch

```
git log master..feature/setup-project --oneline
```
