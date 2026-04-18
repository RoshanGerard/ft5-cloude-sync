## Why

pnpm 10 ships with a security default that blocks `install` and `postinstall` scripts for every dependency unless the dependency is on an explicit allowlist. The `setup-project` scaffolding did not add such an allowlist, so on a fresh clone today the following silently breaks:

- Electron's `install.js` never runs, so `node_modules/electron/` has no binary path — `require('electron')` throws `Error: Electron failed to install correctly, please delete node_modules/electron and try installing again`.
- `better-sqlite3`'s `install` script never runs, so the native addon is a stale prebuilt from pnpm's global store rather than one built against Electron's ABI.
- `@electron/rebuild` (wired in `apps/desktop`'s `postinstall`) can't find Electron's binary to target, so it exits with `✔ Rebuild Complete` having rebuilt zero modules.

The user-visible symptom is `pnpm --filter @ft5/desktop run postinstall` "doing nothing" — but the real failure is upstream: the scripts that would make Electron and better-sqlite3 functional never ran. A new contributor cloning the repo cannot launch the app without manually running `pnpm approve-builds`.

## What Changes

- Add a `pnpm.onlyBuiltDependencies` allowlist to the root `package.json` covering every package that pnpm 10 flagged at install time: `better-sqlite3`, `electron`, `esbuild`, `sharp`, `electron-winstaller`, `unrs-resolver`.
- Add a Vitest guard under `scripts/` that reads root `package.json` and asserts the allowlist contains that exact set, so an accidental removal fails `pnpm -w test`.
- Verify by nuking `node_modules/`, running `pnpm install`, and asserting `pnpm --filter @ft5/desktop exec electron -e "require('better-sqlite3')"` exits 0 — i.e. the Electron binary is present and the native binding loads under Electron's ABI.
- Note the allowlist in the existing `README.md` "Native module rebuild recovery" section so the expectation (clean install = working Electron) is documented alongside the manual rebuild recovery path.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `app-shell`: adds a requirement that native-module dependencies (Electron binary, `better-sqlite3` addon) are usable after `pnpm install` with no manual approval step.

## Impact

- **Code**: root `package.json` gains a `pnpm.onlyBuiltDependencies` array (6 entries); one new Vitest file at `scripts/pnpm-built-deps.test.ts`; a README note.
- **Dependencies**: no new production or dev deps. Pre-existing packages are moved from "scripts blocked by default" to "scripts allowed by explicit allowlist".
- **CI**: existing `pnpm install` step in `.github/workflows/ci.yml` starts running the allowed install scripts. The time cost is the Electron binary download (~200 MB, cached via the lockfile-keyed pnpm store cache already configured) plus the `electron-rebuild` of `better-sqlite3` (~10s on Windows, faster on Linux/macOS). On a warm CI cache the delta is seconds.
- **Security**: narrows the "blocked by default" surface for future transitive deps. Any new package that wants to run install scripts will still be blocked and surface in pnpm's "Ignored build scripts" warning — the allowlist is a positive opt-in, not a global `ignore-scripts=false`.
- **Out of scope**: `@electron/rebuild` stays in `devDependencies` as the documented recovery path for ABI mismatches after Electron or Node upgrades. Trimming other transitive scripts or switching to `node-linker=hoisted` is deferred.
