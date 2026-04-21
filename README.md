# ft5-cloude-sync

Electron desktop app that syncs a local Claude Code workspace to remote backends.

## Services

Two Node.js background services live under `services/`:

- **`services/fs-sync`** — per-user sync daemon. Owns manual upload and
  mirror-sync jobs: a named-pipe JSON IPC transport, SQLite-backed job
  queue + snapshot diff, global concurrency cap of 2, retry split
  (system-level network + rate-limit, user-level provider-error),
  ConfigFileCredentialStore plaintext JSON at `$HOME/ft5/sync_app/
  credentials.json` with `0600` / user-ACL enforcement, and per-OS
  install hooks (Windows Scheduled Task, macOS LaunchAgent, Linux
  `systemd --user`). See `services/fs-sync/README.md`.
- **`services/fs-monitor`** — future filesystem watcher that will feed
  auto-sync events into `services/fs-sync` via the `MonitorEventSource`
  port. Only scaffolded in this repo; no runtime behaviour yet.

Dev-mode for the sync service — run it in `--dev` mode (distinct pipe +
data dir) alongside any installed prod service:

```bash
pnpm dev:sync-service
```

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

### ABI flip between Node (tests) and Electron (dev)

`better-sqlite3` is shared between `apps/desktop` (runs under Electron,
NODE_MODULE_VERSION 145) and `services/fs-sync` (runs under Node,
NODE_MODULE_VERSION 137). Because pnpm's store keeps a single copy of each
version of a package, the compiled `.node` binary can only be one ABI at a
time. Running one side's test/build flips it; the other side then fails to
load until flipped back.

**Symptom (Electron side):**

```
Error: The module '...better_sqlite3.node' was compiled against a different
Node.js version using NODE_MODULE_VERSION 137. This version of Node.js
requires NODE_MODULE_VERSION 145.
```

Flip to **Electron ABI** (required before `pnpm --filter @ft5/desktop run dev`):

```bash
(cd apps/desktop && npx @electron/rebuild -f -w better-sqlite3)
```

The `-f` flag is required — without it the rebuild is a silent no-op.

**Symptom (Node side):**

When `pnpm -w test --run` or `pnpm --filter @ft5/fs-sync-service test` shows
`NODE_MODULE_VERSION 145. This version of Node.js requires NODE_MODULE_VERSION
137`, flip to **Node ABI**:

```bash
(cd node_modules/.pnpm/better-sqlite3@12.9.0/node_modules/better-sqlite3 && \
 npx prebuild-install --runtime=node --target=$(node -v) --force)
```

Running the fs-sync tests or Vitest against any service code sets Node ABI;
launching the desktop app requires Electron ABI. Switching between the two
takes ~5 seconds either way. A properly-wired `postinstall` on
`@ft5/fs-sync-service` that fetches the Node prebuild would make this a
choice of `pnpm --filter @ft5/fs-sync-service run postinstall` vs
`pnpm --filter @ft5/desktop run postinstall`; that's a follow-up rather than
a fix for this setup.

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
