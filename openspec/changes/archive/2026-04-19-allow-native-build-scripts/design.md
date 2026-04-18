## Context

The `setup-project` change (archived 2026-04-18) established the monorepo, pinned Electron 41.2.1 and `better-sqlite3` 12.9.0, and wired `apps/desktop`'s `postinstall` to `@electron/rebuild`. That was correct against pnpm 9's install-script semantics but collides head-on with pnpm 10's new security default: install/postinstall scripts are blocked unless the package is on an explicit allowlist.

Concretely, after a clean `pnpm install` today:

1. `node_modules/electron/install.js` never executes → no `path.txt` → `require('electron')` throws.
2. `node_modules/.pnpm/better-sqlite3@12.9.0/.../build/Release/better_sqlite3.node` is whatever prebuilt the pnpm content-addressed store hardlinked in (ABI for plain Node, not Electron).
3. `@electron/rebuild` (in `apps/desktop`'s postinstall) walks the dep tree, finds no Electron binary to target, and exits silently with `✔ Rebuild Complete`.

Evidence gathered while debugging:
- `pnpm install --force` printed `Ignored build scripts: better-sqlite3@12.9.0, electron-winstaller@5.4.0, electron@41.2.1, esbuild@0.25.12, esbuild@0.27.7, sharp@0.34.5, unrs-resolver@1.11.1.`
- `pnpm exec electron -e "..."` failed with `Error: Electron failed to install correctly`.
- `better_sqlite3.node` mtime was 7 days old (prebuilt), not fresh.

The fix is the allowlist pnpm itself documents: `pnpm.onlyBuiltDependencies` in root `package.json`.

## Goals / Non-Goals

**Goals:**
- A fresh clone + `pnpm install` yields a workspace where the packaged desktop app can `require('better-sqlite3')` under Electron with no manual `pnpm approve-builds` step.
- The allowlist is checked into source (not a per-user `~/.pnpmrc`) so it is reviewable, diffable, and identical across every developer and CI runner.
- A standing regression test guards the allowlist so future refactors can't silently regress to the broken state.

**Non-Goals:**
- Disabling pnpm 10's build-script security mechanism globally (`ignore-scripts=false` in `.npmrc`) — we want to keep the "blocked by default" posture for unknown future deps.
- Removing `@electron/rebuild` as a devDependency. It is still the correct recovery path for ABI mismatches after dependency upgrades and stays documented in the README.
- Switching `node-linker` from pnpm's default (symlinked virtual store) to `hoisted`. The symlink model is working; the problem is build-script policy, not the linker.
- Auditing every transitive dep's scripts proactively. pnpm surfaces new "Ignored build scripts" warnings on install; we'll extend the allowlist reactively when a legitimate dep appears there.

## Decisions

### Decision 1: Use `pnpm.onlyBuiltDependencies` in root `package.json`

**Chosen:** Add

```json
"pnpm": {
  "onlyBuiltDependencies": [
    "better-sqlite3",
    "electron",
    "esbuild",
    "sharp",
    "electron-winstaller",
    "unrs-resolver"
  ]
}
```

to root `package.json`.

**Rationale:** pnpm reads this field on every install in the workspace; the effect is identical to each contributor running `pnpm approve-builds <pkg>` interactively, without the manual step. Checked in → reviewable in PRs, present in git history, survives machine changes.

**Alternatives considered:**
- *Per-user `~/.pnpmrc` via `pnpm approve-builds` at first install.* Rejected: every new contributor and every CI runner hits the broken state first, then has to troubleshoot. Invisible to code review.
- *`ignore-scripts=false` in an `.npmrc` committed to the repo.* Rejected: disables the allowlist mechanism entirely, so a compromised transitive dep with a malicious `postinstall` runs silently. The whole point of pnpm 10's default is to prevent exactly that.
- *Invoke `electron-rebuild` explicitly in CI after install.* Rejected: papers over the symptom (better-sqlite3 rebuild) while leaving the root cause (Electron binary missing) untouched — `electron-rebuild` itself silently no-ops when Electron's binary isn't present, as we verified.

### Decision 2: Allowlist every package pnpm already flagged, not a minimal subset

**Chosen allowlist:** `better-sqlite3`, `electron`, `esbuild`, `sharp`, `electron-winstaller`, `unrs-resolver`.

**Rationale:** pnpm 10's "Ignored build scripts" warning at install time enumerated all six. Each serves a real purpose in our dep graph:
- `electron` → downloads the Electron binary (runtime prerequisite).
- `better-sqlite3` → compiles the native SQLite addon against Electron's ABI (runtime prerequisite in main process).
- `esbuild` → selects and extracts the prebuilt binary for the host platform (used transitively by Vitest and `electron-vite`; at least two version nodes appear because of pnpm's peer-dep resolution).
- `sharp` → native image-processing addon. Next.js 16 pulls it in even though our renderer sets `images.unoptimized: true`; excluding it causes `pnpm install` to print a noisy warning and any future Next.js image use to break.
- `electron-winstaller` → generates the Windows NSIS installer in `electron-builder`'s Windows target. Excluded → `package:win` produces `win-unpacked/` but no `.exe` installer artifact.
- `unrs-resolver` → native TypeScript-aware resolver used by `eslint-plugin-import-x`, which our ESLint config depends on. Excluded → lint becomes slow or falls back to JS resolver.

Each is part of our pinned toolchain. Excluding one to "stay minimal" risks silent downstream failures (failed Windows installer, slow lint, broken image pipeline) whose trigger is non-obvious months later. The allowlist is intentionally the full set pnpm itself surfaces.

**Trigger to revisit:** any time `pnpm install` prints a new "Ignored build scripts" warning for a package not in the list, audit whether that package is expected (add) or suspicious (investigate, do not add).

### Discovery: better-sqlite3 loads under Electron without a rebuild because its prebuilt is NAPI

When implementing this change the obvious expectation was that `better-sqlite3`'s native `.node` binary would have to be recompiled against Electron's ABI — that is the whole reason `@electron/rebuild` is wired as `apps/desktop`'s `postinstall` in the first place, and it is what the original "Native module rebuild recovery" README section assumes. In practice the cold-install run showed:

- `better-sqlite3`'s `install` script executed (`prebuild-install || node-gyp rebuild`) and `prebuild-install` succeeded — the `.node` file is a hardlink from pnpm's content-addressed store, with the store's mtime (not a fresh compile timestamp).
- `@electron/rebuild` ran immediately after and exited with `✔ Rebuild Complete` having rebuilt zero modules.
- `require('better-sqlite3')` under Electron 41.2.1 nevertheless succeeded and the module executed a real SQL query against an in-memory DB.

`better-sqlite3` 12.x ships **NAPI-based** prebuilt binaries. NAPI is a stable, runtime-agnostic ABI defined by Node.js and honoured by Electron, so the same `.node` file is valid under both Node and Electron as long as the host's NAPI version is at least the binary's required version. There is nothing to recompile when the prebuilt already matches.

Implication for this change: the acceptance criterion for task 2 is the behavioural one ("loads under Electron without ABI error"), **not** "the `.node` file has a fresh mtime". An earlier draft of `tasks.md` asserted mtime freshness; that assertion was removed because it would fail on a correctly-configured NAPI workflow. The `@electron/rebuild` invocation stays in `apps/desktop`'s `postinstall` because it is still needed for any future non-NAPI native dependency, but its silent no-op for `better-sqlite3` is now expected behaviour, not a bug.

### Decision 3: Static test, not an integration "install and run Electron" test

**Chosen:** One Vitest file (`scripts/pnpm-built-deps.test.ts`) that reads root `package.json`, asserts `pnpm.onlyBuiltDependencies` contains the expected set (as a sorted string-array assertion), and fails loudly if an entry is dropped or if the `pnpm` block is deleted.

**Rationale:** An integration test that runs `pnpm install` + launches Electron to `require('better-sqlite3')` would take 60–90s and download 200 MB, which is inappropriate for the standing test suite (it's already long enough). A static assertion over `package.json` catches the only realistic regression — someone deleting the block during a merge or refactor — in milliseconds. The manual integration check (delete `node_modules`, reinstall, run the Electron `require` smoke test) runs once during task verification and is recorded in the PR description, matching the pattern already set by `setup-project`'s task 11.1.

**Alternatives considered:**
- *Wire the integration check into CI.* Rejected for v0: CI already runs `pnpm install` on a fresh runner every job, so a broken allowlist would surface as `pnpm approve-builds` warnings or a downstream `pnpm --filter @ft5/desktop package:<os>` failure. That's sufficient end-to-end coverage without bolting on another step. Revisit if a future regression slips past.
