# ft5-cloude-sync

Electron desktop app that syncs a local Claude Code workspace to remote backends.

## Native module rebuild recovery

### Fresh clone

`pnpm install` at the repo root is the only step needed. The root `package.json`
declares `pnpm.onlyBuiltDependencies` covering `electron`, `better-sqlite3`,
`esbuild`, `sharp`, `electron-winstaller`, and `unrs-resolver`, so pnpm 10 runs
each one's install/postinstall scripts automatically without asking for
approval. `better-sqlite3` 12.x ships NAPI-compatible prebuilt binaries that
load under Electron unchanged, so no additional rebuild step is expected on a
first install.

If you ever see `Error: Electron failed to install correctly, please delete
node_modules/electron and try installing again`, it means pnpm's build-script
allowlist was bypassed (e.g. a `.npmrc` disabled scripts entirely); delete
`node_modules/` and `pnpm install` again.

### ABI mismatch after an Electron or Node upgrade

If the app fails to load with an error similar to `Error: The module
'...better_sqlite3.node' was compiled against a different Node.js version`
(ABI mismatch — typically after bumping the `electron` dependency or switching
Node versions), rebuild native modules against the current Electron version:

```bash
pnpm rebuild
```

If the full rebuild is slow or you only need to fix the desktop app, use the
targeted form, which reruns the desktop workspace's `postinstall` hook
(`@electron/rebuild`):

```bash
pnpm --filter @ft5/desktop run postinstall
```
