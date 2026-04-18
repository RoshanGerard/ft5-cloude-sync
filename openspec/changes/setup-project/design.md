## Context

This is a greenfield repo: only `CLAUDE.md` and `openspec/` exist at the start of this change. `openspec/project.md` already declares the target stack (Node 24.14.1 LTS, Electron 41.2.1, TypeScript 6.0.3, React 19.2.5 via Next.js 16 static export, SQLite via Drizzle, Vitest, pnpm) and the non-negotiable architecture rules (four-layer IPC wiring, Drizzle confined to main, renderer with no Node built-ins, Electron security defaults). This change implements the scaffolding those rules describe and proves the wiring end-to-end with one trivial operation (`ping`), so every subsequent proposal can diff against a known-good skeleton rather than introduce skeleton + feature simultaneously.

## Goals / Non-Goals

**Goals:**
- Monorepo layout matching `openspec/project.md`: `apps/desktop/{main,preload,renderer}`, `services/fs-monitor/`, `packages/ipc-contracts/`.
- Single TypeScript version (6.0.3, strict), single Node version (24.14.1 LTS), single Electron version (41.2.1), pinned via lockfile + `.nvmrc` + `package.json#engines`.
- Walking skeleton: one `BrowserWindow`, one IPC op (`ping`) wired through all four layers, one Playwright test that asserts the round trip.
- Linting that fails the build on the two architecture violations most likely to slip in: renderer importing Node built-ins / main / preload, and Drizzle imports outside main.
- CI runs typecheck + lint + unit + e2e on macOS, Windows, Linux for every PR.
- Cross-platform packaging config (`electron-builder`) that produces unsigned artifacts in CI today, ready for signing-key wiring in a later change.

**Non-Goals:**
- Any real cloud-provider integration (Google Drive, OneDrive, S3).
- Any real filesystem watcher logic — `services/fs-monitor/` gets an entry point that compiles and exits; the watcher is a later change.
- Auto-update flow beyond declaring `electron-updater` as a dependency; no update server, no signing keys.
- Notarization / code-signing secret provisioning — deferred to a dedicated release-signing change.
- Database schema, migrations, or Drizzle models — this change only installs Drizzle so the lint rule has something to police.
- UI/UX beyond a minimal page that renders the ping response (styling, component library, design tokens are out of scope).
- Any form of state management, routing, or data-fetching library in the renderer beyond what Next.js 16 static export ships with.

## Decisions

### Decision 1: Build tooling — `electron-vite` for main + preload, `next build && next export` for renderer

**Chosen:** `electron-vite` handles bundling for the main and preload processes (HMR in dev, separate Rollup outputs for each target, correct `external` defaults for Electron). Renderer uses Next.js 16 with `output: 'export'` directly — no Next.js server in production, just static HTML/JS loaded via `app://`.

**Rationale:** `electron-vite` is the de-facto standard for Electron + Vite-style builds in 2026 and understands the preload sandbox constraints out of the box. Next.js 16 static export is already mandated by `openspec/project.md`, so we use Next's own export pipeline rather than swap it for a custom Vite renderer config.

**Alternatives considered:**
- *Raw `tsc` + manual bundling for main/preload.* Rejected: hand-rolling `external` lists for Electron's built-ins and keeping two separate tsconfig invocations in sync is exactly the kind of toil `electron-vite` removes.
- *Replace Next.js with a pure Vite renderer.* Rejected: `project.md` pins Next.js 16 static export; swapping it is a separate proposal.

### Decision 2: SQLite driver — `better-sqlite3`

**Chosen:** `better-sqlite3` as the underlying driver for Drizzle in `apps/desktop/src/main/`.

**Rationale:** Synchronous API fits the `ipcMain.handle` request/response model without manufactured promises; single-process, single-file DB matches our architecture (only main touches the DB); native module is well-supported on all three target platforms with prebuilt binaries, and `electron-rebuild` / `@electron/rebuild` handles the ABI mismatch automatically.

**Trigger to revisit:** switch to an async driver when any of: (a) a single DB op needs to stream or buffer >100MB and would block the main process for >50ms, (b) a feature requires remote/networked SQLite (e.g., libsql edge replication), (c) a second writer process appears (fs-monitor writing directly to the DB rather than via IPC), or (d) Drizzle drops the `better-sqlite3` dialect on an Electron/Node version we target.

**Alternatives considered:**
- *`@libsql/client` (local SQLite).* Rejected for v0: introduces an async API and a second process model (for libsql server) we don't need. Worth revisiting when/if we want edge-replicated sync.
- *`node:sqlite` (Node 22+ built-in).* Rejected: still marked experimental as of this writing and lacks the Drizzle dialect maturity `better-sqlite3` has.

### Decision 3: IPC contract format — plain TypeScript types in v0, not Zod schemas

**Chosen:** `packages/ipc-contracts/` exports pure TypeScript `type` declarations for request/response shapes. No runtime validation on the `ping` op.

**Rationale:** The renderer is the only caller and it's loaded from our own bundle over `app://` — inputs originate in our own code, not from an untrusted network. Adding Zod now would be premature and the refactor to Zod later is mechanical (every field already has a TS type).

**Trigger to revisit:** when the first IPC op accepts user-typed input that could be malformed (e.g., a file path the user pasted), or when any op is exposed over a channel an outside process can speak to (e.g., a deep-link protocol handler).

**Alternatives considered:**
- *Zod schemas everywhere from day one.* Rejected as overkill for a ping that takes no arguments.
- *tRPC or a generated IPC layer.* Rejected: adds a dependency whose value is only visible at 10+ IPC ops; we have 1.

### Decision 4: Enforcement of architecture rules — ESLint for renderer, dedicated CI grep for Drizzle

**Chosen:** Two enforcement mechanisms:
1. `eslint-plugin-import` with `no-restricted-imports` / `no-restricted-paths` fails the build if anything under `apps/desktop/src/renderer/` imports `fs`, `child_process`, `electron`, `node:*`, `apps/desktop/src/main/**`, or `apps/desktop/src/preload/**`.
2. A dedicated step in `.github/workflows/ci.yml` that runs `rg` for `drizzle-orm` outside `apps/desktop/src/main/` and fails the job on any hit. This is redundant with ESLint on purpose — the grep survives ESLint misconfiguration.

**Rationale:** The two rules most likely to be violated (renderer reaching for Node built-ins; Drizzle leaking outside main) are also the two whose violation has the worst blast radius. Defence in depth is cheap here.

**Alternatives considered:**
- *ESLint alone.* Rejected: if someone disables an ESLint rule file-locally (`/* eslint-disable */`) we lose the Drizzle guarantee silently.
- *TypeScript project-reference boundaries alone.* Rejected: TS references can catch cross-package imports but not `fs` or `electron`, which aren't in any package.

### Decision 5: Signing / notarization deferred

**Chosen:** `electron-builder.yml` declares the three target installers (dmg, nsis, AppImage + deb) with signing/notarization fields referencing env vars (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, Windows EV cert vars) but CI does not provide those secrets yet. PR-CI builds unsigned artifacts for smoke-testing; a follow-up change provisions the secrets and adds a release workflow.

**Rationale:** Signing is a logistics problem (acquiring certs, configuring notarization, rotating keys) more than a code problem. Blocking this change on it would block every downstream change behind a paperwork task that has no spec impact.

## Risks / Trade-offs

- **[Risk] Electron 41.2.1 specific issues (native module ABI, new renderer process model) surface late.** → Mitigation: the Playwright e2e test in CI on all three OSes catches launch / window / IPC regressions on every PR; if a target platform is broken by an Electron upgrade we see it immediately.
- **[Risk] Walking skeleton becomes a bottleneck if `ping` grows features.** → Mitigation: `ping` is explicitly documented (in the spec) as a wiring test, not a production op; later work adds new IPC ops rather than extending `ping`.
- **[Risk] `better-sqlite3` native rebuild breaks on a clean install for a contributor on an unusual OS/arch combo.** → Mitigation: `@electron/rebuild` runs as a postinstall; README documents `pnpm rebuild` as the recovery step; CI exercises install on macOS + Windows + Linux so regressions are caught fast.
- **[Risk] Next.js 16 static export + `app://` protocol interaction (asset paths, `basePath`, font loading) subtly breaks.** → Mitigation: the walking-skeleton Playwright test asserts the renderer mounts and the ping result renders, which exercises the full asset-loading path end-to-end.
- **[Trade-off] Choosing `better-sqlite3` now commits us to a synchronous driver model.** Migrating to an async driver later is a non-trivial refactor of every future IPC handler that does DB work. Accepted: sync is a better fit for the IPC request/response model and the perf ceiling is high enough that we are not likely to hit it.
- **[Trade-off] Two enforcement mechanisms (ESLint + CI grep) for Drizzle confinement is duplication.** Accepted: the cost is one `rg` invocation in CI; the safety is that the rule survives any single misconfiguration.

## Migration Plan

N/A — greenfield. Nothing to migrate from.

## Open Questions

- Should the renderer dev loop use `next dev` (served from localhost in dev only, with Electron configured to load `http://localhost:3000` in development and `app://` in production), or always run against a static export to keep dev/prod identical? *Proposed default:* `next dev` in development, static export in production, gated by `NODE_ENV`. Confirm during implementation if DX is acceptable.
- Should `packages/ipc-contracts/` be a pure TypeScript package (no build step, consumed via TS project references) or a compiled package (emits `.d.ts` + `.js`)? *Proposed default:* TS project references + no build step, so contract changes have zero build latency.
- Do we want a single root `tsconfig.base.json` that workspaces extend, or per-workspace `tsconfig.json` with no shared base? *Proposed default:* shared `tsconfig.base.json` with strict options; each workspace extends and adds `include`/`references` only.
