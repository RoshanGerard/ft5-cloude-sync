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

## Build and package

### Local development build

For iterative work, use electron-vite's dev server. The command builds the
Next.js renderer once via a `predev` hook, then launches Electron with file
watchers on the main and preload processes:

```bash
pnpm --filter @ft5/desktop run dev
```

- **Main / preload changes** reload automatically on save.
- **Renderer changes** require restarting `dev` (the renderer ships as a
  static export under `apps/desktop/src/renderer/out/` that `electron-vite dev`
  does not watch). Live-reload for the renderer is a known-limitation
  follow-up — it needs the Next dev server running in parallel plus an
  `ELECTRON_RENDERER_URL` branch in the main process.

For a one-shot production build (without packaging), run:

```bash
pnpm --filter @ft5/desktop run build:all
```

This produces the compiled main and preload bundles under
`apps/desktop/dist/` (e.g. `dist/main/index.js`, `dist/preload/index.js`) and
the static Next.js renderer export under `apps/desktop/src/renderer/out/`.
End-to-end on the dev host this finishes in ~5 seconds.

### Packaging for the current OS

The root wrapper is:

```bash
pnpm package:current-os
```

It's currently hard-wired to the Windows target (the repo is developed on a
Windows host). For an explicit target, use the per-platform form from the
desktop workspace:

```bash
pnpm --filter @ft5/desktop package:win
pnpm --filter @ft5/desktop package:mac
pnpm --filter @ft5/desktop package:linux
```

Each command runs `build:all` internally and then `electron-builder --<os>`.
Outputs land under `apps/desktop/release/`:

- `win`: `release/win-unpacked/FT5 Cloude Sync.exe` (directly runnable
  unpackaged app) and, on a host that can finish the NSIS step,
  `release/FT5 Cloude Sync Setup.exe` (the installer).
- `mac`: `release/*.dmg`.
- `linux`: `release/*.AppImage` and `release/*.deb`.

### Windows caveat: NSIS installer needs Developer Mode

On Windows hosts **without Developer Mode enabled**, `package:win` always
produces the unpackaged exe — you'll find a ~220 MB
`apps/desktop/release/win-unpacked/FT5 Cloude Sync.exe` that launches and runs
identically to the installed app. That's sufficient for local smoke-testing.

The NSIS step that would produce the `Setup.exe` installer fails with:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the
client. : C:\Users\<you>\AppData\Local\electron-builder\Cache\winCodeSign
\<hash>\darwin\10.12\lib\libcrypto.dylib
ERROR: Cannot create symbolic link : A required privilege is not held by the
client. : C:\Users\<you>\AppData\Local\electron-builder\Cache\winCodeSign
\<hash>\darwin\10.12\lib\libssl.dylib

⨯ cannot execute  cause=exit status 2
```

`winCodeSign`'s macOS codesigning tarball contains symlinks (`libcrypto.dylib`
and `libssl.dylib` under `darwin/10.12/lib/`). Creating them on NTFS requires
a privilege the default Windows user account doesn't hold. Three recovery
paths, any one of which fixes it:

1. **Enable Windows Developer Mode** — Settings → System → For developers →
   "Developer Mode" on. One-time setting, grants `SeCreateSymbolicLinkPrivilege`
   to the current user. The command re-run from a normal shell then succeeds.
2. **Run the command from an elevated (Administrator) shell** — works without
   toggling Developer Mode, but every future `package:win` also needs to be
   run elevated.
3. **Leave it to CI** — GitHub Actions Windows runners have the privilege
   already, so pushing a commit that should produce an installer and letting
   the existing workflow build it is the friction-free path. This is what the
   archived `setup-project` change recommends for day-to-day development.
