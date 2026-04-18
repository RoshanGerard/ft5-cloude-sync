## 1. Allowlist native build scripts in root package.json

- [x] 1.1 Write a failing Vitest test `scripts/pnpm-built-deps.test.ts` that reads root `package.json`, parses it, and asserts `pkg.pnpm.onlyBuiltDependencies` equals the sorted set `["better-sqlite3", "electron", "electron-winstaller", "esbuild", "sharp", "unrs-resolver"]`. Confirm it fails (`pnpm -w test` red) because the `pnpm` block does not yet exist.
- [x] 1.2 Add the `pnpm` block with the `onlyBuiltDependencies` array to root `package.json`. Re-run `pnpm -w test` and confirm only the new test moves red → green with no other test regressions.

## 2. Verify the allowlist produces a working native toolchain

- [x] 2.1 From the repo root, delete the entire `node_modules/` tree (root and every workspace) plus `apps/desktop/node_modules/`, `packages/*/node_modules/`, `services/*/node_modules/` to force a cold install.
- [x] 2.2 Run `pnpm install` at the root. Confirm `pnpm` no longer prints the `Ignored build scripts: …` warning for any package in the allowlist. Record the tail of the install output (including the `apps/desktop postinstall` section) in the PR description.
- [x] 2.3 Run an Electron-hosted `require('better-sqlite3')` smoke test from `apps/desktop/` (so workspace resolution finds the dep): `pnpm exec electron ./check.cjs` where `check.cjs` does `const s=require('better-sqlite3'); new s(':memory:').prepare('SELECT 1 AS one').get()` and writes the result to a file. Confirm exit code 0 and "OK" in the file. Record the evidence in the PR description.
- [x] 2.4 Confirm `node_modules/.pnpm/electron@41.2.1/node_modules/electron/path.txt` exists and contains a non-empty path (e.g. `electron.exe` on Windows). Its absence was the upstream cause of `Error: Electron failed to install correctly`; its presence proves Electron's `install.js` ran under the new allowlist. Record the file contents in the PR description. (Note: `better_sqlite3.node` mtime is **not** a useful signal here — better-sqlite3 12.9.0 ships NAPI prebuilts that are stable across Node and Electron ABIs, so `electron-rebuild` intentionally no-ops for this package.)

## 3. Document the expectation in README

- [x] 3.1 Update `README.md`'s "Native module rebuild recovery" section to state that `pnpm install` is expected to produce a working Electron + `better-sqlite3` without any manual `pnpm approve-builds` step, and that the `pnpm.onlyBuiltDependencies` allowlist in root `package.json` is what makes that true. Keep the existing `pnpm rebuild` / `pnpm --filter @ft5/desktop run postinstall` instructions as the recovery path for ABI mismatches after an Electron or Node upgrade.

## 4. Verification before archive

- [x] 4.1 Run `pnpm -w typecheck && pnpm -w lint && pnpm -w test` — all green. (29/29 tests pass, including the new `scripts/pnpm-built-deps.test.ts`.)
- [x] 4.2 Confirm tasks 1–3 are all checked and the cold-install evidence from section 2 is pasted into the PR description. (See `PR-DESCRIPTION.md` in this change directory.)
- [x] 4.3 Sync the delta in `openspec/changes/allow-native-build-scripts/specs/app-shell/spec.md` into `openspec/specs/app-shell/spec.md` (adding the new "Native module dependencies ready after clean install" requirement) so the main specs reflect the new guarantee.
