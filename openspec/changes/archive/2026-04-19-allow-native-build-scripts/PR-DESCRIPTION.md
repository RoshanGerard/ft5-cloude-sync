# allow-native-build-scripts

## Summary

Adds `pnpm.onlyBuiltDependencies` to root `package.json` so pnpm 10 runs the install/postinstall scripts for Electron, better-sqlite3, esbuild, sharp, electron-winstaller, and unrs-resolver automatically on `pnpm install`. Without this, pnpm 10's security default blocks those scripts — Electron's binary never downloads (`Error: Electron failed to install correctly`), native addons don't initialize, and the app is unusable on any fresh clone.

## Changes

- `package.json` — added `pnpm.onlyBuiltDependencies` array with the six packages pnpm surfaces in its "Ignored build scripts" warning
- `scripts/pnpm-built-deps.test.ts` — new Vitest standing regression that reads root `package.json` and asserts the allowlist contains exactly that set
- `README.md` — rewrote "Native module rebuild recovery" section; added a "Fresh clone" sub-section explaining the allowlist, kept the ABI-mismatch recovery path
- `openspec/specs/app-shell/spec.md` — added requirement "Native module dependencies are ready after a clean install" with three scenarios (load under Electron, allowlist in source, regression test)

## Verification evidence (task 2, cold install)

Start time: `2026-04-19T00:34:03+05:30`
End time:   `2026-04-19T00:34:38+05:30`
Duration:   34.6s

### Cold `pnpm install` tail (task 2.2)

```
.../node_modules/unrs-resolver postinstall$ napi-postinstall unrs-resolver 1.11.1 check
.../node_modules/electron postinstall$ node install.js
.../node_modules/electron-winstaller install$ node ./script/select-7z-arch.js
.../esbuild@0.25.12/node_modules/esbuild postinstall$ node install.js
.../esbuild@0.27.7/node_modules/esbuild postinstall$ node install.js
.../node_modules/electron-winstaller install: Selecting 7-Zip for arch x64
.../node_modules/electron-winstaller install: Done
.../node_modules/unrs-resolver postinstall: Done
.../node_modules/better-sqlite3 install$ prebuild-install || node-gyp rebuild --release
.../esbuild@0.27.7/node_modules/esbuild postinstall: Done
.../sharp@0.34.5/node_modules/sharp install$ node install/check.js || npm run build
.../esbuild@0.25.12/node_modules/esbuild postinstall: Done
.../sharp@0.34.5/node_modules/sharp install: Done
.../node_modules/better-sqlite3 install: Done
.../node_modules/electron postinstall: Done

apps/desktop postinstall$ electron-rebuild
apps/desktop postinstall: - Searching dependency tree
apps/desktop postinstall: ✔ Rebuild Complete
apps/desktop postinstall: Done
Done in 34.6s using pnpm v10.33.0
```

No `Ignored build scripts: …` warning. All six allowlisted packages executed their install/postinstall scripts.

### Electron-hosted `require('better-sqlite3')` (task 2.3)

Script (`apps/desktop/check-better-sqlite3.cjs`, removed after verification):

```js
const fs = require("node:fs");
try {
  const s = require("better-sqlite3");
  const db = new s(":memory:");
  const row = db.prepare("SELECT 1 AS one").get();
  fs.writeFileSync(".check-result.txt", "OK " + JSON.stringify(row) + "\n");
  process.exit(0);
} catch (e) {
  fs.writeFileSync(".check-result.txt", "FAIL " + e.message + "\n");
  process.exit(1);
}
```

Command: `pnpm exec electron ./check-better-sqlite3.cjs` (from `apps/desktop`).

Result: exit `0`, `.check-result.txt` contains `OK {"one":1}`. Electron loaded, better-sqlite3 loaded, SQLite executed a real query.

### Electron binary presence (task 2.4)

```
$ ls node_modules/.pnpm/electron@41.2.1/node_modules/electron/ | grep path.txt
path.txt

$ cat node_modules/.pnpm/electron@41.2.1/node_modules/electron/path.txt
electron.exe
```

`path.txt` is the artifact Electron's `install.js` writes after downloading the binary. Its absence on the prior install was the upstream cause of `Error: Electron failed to install correctly`.

Note on `better_sqlite3.node` mtime: the `.node` file in pnpm's virtual store retains the content-addressed-store hardlink timestamp, not a "freshly rebuilt" timestamp. This is correct — better-sqlite3 12.x ships NAPI prebuilts that are ABI-stable across Node and Electron, so no recompile is required when the prebuilt already matches. See `design.md § Discovery` for the full reasoning.

## Test-suite delta (task 4.1)

```
pnpm -w typecheck  → exit 0
pnpm -w lint       → exit 0
pnpm -w test       → 29 passed (was 28 before this change; +1 = scripts/pnpm-built-deps.test.ts)
```

## Spec-scenario → test map

| Scenario | Coverage |
|---|---|
| Fresh clone can load better-sqlite3 under Electron without manual intervention | Manual (task 2.3 evidence above); covered end-to-end in CI's existing `pnpm install` + packaging steps |
| Allowlist is defined in source, not per-user pnpm configuration | `scripts/pnpm-built-deps.test.ts` asserts the array via static `package.json` read |
| Allowlist regression is caught by the test suite | Same test; removing the block or dropping any required package flips the test red |
