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

Two helper scripts under `bin/` (also exposed as pnpm scripts) automate the
flip. Each takes ~5 seconds and is idempotent:

```bash
pnpm abi:electron   # before: pnpm --filter @ft5/desktop run dev (or package:*)
pnpm abi:node       # before: pnpm -w test --run, fs-sync tests, or dev:sync-service
```

**Symptom (Electron side)** — launching the desktop app produces:

```
Error: The module '...better_sqlite3.node' was compiled against a different
Node.js version using NODE_MODULE_VERSION 137. This version of Node.js
requires NODE_MODULE_VERSION 145.
```

Run `pnpm abi:electron`, then retry `pnpm --filter @ft5/desktop run dev`.

**Symptom (Node side)** — `pnpm -w test --run` or
`pnpm --filter @ft5/fs-sync-service test` shows
`NODE_MODULE_VERSION 145. This version of Node.js requires NODE_MODULE_VERSION
137`. Run `pnpm abi:node`.

Under the hood, `abi:electron` runs `@electron/rebuild -f -w better-sqlite3`
from `apps/desktop` (the `-f` is required — without it the rebuild is a
silent no-op), and `abi:node` runs `prebuild-install --runtime=node
--target=$(node -v) --force` inside the pnpm-store copy of `better-sqlite3`.
See `bin/README.md` for details.

A properly-wired `postinstall` on `@ft5/fs-sync-service` that fetches the
Node prebuild would turn the Node-side flip into a standard
`pnpm --filter @ft5/fs-sync-service run postinstall`; that's a follow-up
rather than a fix for this setup.

## Build and package

### Local development

**Recommended — one command starts both processes:**

```bash
./bin/dev.sh start    # build + ABI flip + launch service and desktop
./bin/dev.sh status   # are they running?
./bin/dev.sh logs     # tail -F both log files (Ctrl+C to detach)
./bin/dev.sh stop     # kill both process trees
./bin/dev.sh restart  # stop + start
```

The script lives in the repo, runs under Git Bash on Windows (or any POSIX
shell), and handles the ABI dance for you — see "How `dev.sh` works" below
for the details. PIDs and logs go under `node_modules/.cache/ft5-dev/` so
they're auto-gitignored.

**Hard constraint while dev is running:** do not run any `pnpm` command
against this repo while `dev.sh` is up. pnpm's `verify-deps-before-run`
re-runs the `better-sqlite3` install script and silently flips the binary
back to the Node ABI, which breaks the service on its next restart.
`./bin/dev.sh stop` first if you need to install, test, or build. To
disable the auto-verify behaviour permanently, add
`verify-deps-before-run=false` to `.npmrc`.

### How `dev.sh` works

The fs-sync service runs on Node (ABI 137 by default), the desktop runs
under Electron (ABI 145), and pnpm keeps one compiled copy of
`better-sqlite3` per version — so only one ABI can be satisfied on disk at
a time (see "ABI flip" below). Two options to reconcile:

1. **Run both with the same ABI** by launching the service under Electron's
   bundled Node via `ELECTRON_RUN_AS_NODE=1`. Both sides want 145. One
   rebuild. What `dev.sh` does.
2. **Run each with its own ABI** by flipping the binary between sides. This
   works on Linux/macOS (dlopen + unlink doesn't block), but on Windows the
   loaded `.node` is file-locked so you can't re-rebuild while anything has
   it open.

`dev.sh` uses approach 1. Its sequence:

1. `pnpm --filter @ft5/fs-sync-service build` — builds the service (may flip
   the on-disk binary; that's fine, step 2 un-flips it).
2. `pnpm abi:electron` — rebuilds `better-sqlite3` for ABI 145. Must be the
   last command that touches the binary before launch.
3. Finds `node_modules/.pnpm/electron@*/node_modules/electron/dist/electron.exe`
   and starts the service with `ELECTRON_RUN_AS_NODE=1`, pointing it at
   `services/fs-sync/dist/main/index.js --dev`. Service now runs under
   Electron's Node (ABI 145) and happily loads the just-rebuilt binary.
4. Waits 3s for the named pipe (`\\.\pipe\ft5-sync-dev`) to bind, then
   launches the desktop via `pnpm --filter @ft5/desktop run dev`.
5. Writes both PIDs to `node_modules/.cache/ft5-dev/` so `stop` can kill
   the whole process tree (`taskkill //F //T //PID <pid>` on Windows —
   plain `kill` doesn't walk Electron's renderer/GPU/utility children).

### Manual / granular commands

If you need to run one side without the other, or `dev.sh` isn't an option
on your host:

- `pnpm dev:sync-service` — runs the fs-sync service standalone under plain
  Node (`node --enable-source-maps services/fs-sync/dist/main/index.js --dev`).
  Uses a dev-only pipe (`\\.\pipe\ft5-sync-dev` on Windows) and data dir
  (`$HOME/ft5/sync_app/dev/`) so it doesn't collide with an installed prod
  service. Requires the Node ABI (`pnpm abi:node`).
- `pnpm --filter @ft5/desktop run dev` — runs the desktop under
  electron-vite. Requires the Electron ABI (`pnpm abi:electron`). In dev
  mode the desktop process does **not** spawn the service — it expects one
  to be already running on the dev pipe. If you start the desktop alone and
  click Upload you will get `sync client not initialized — IPC handler
  invoked before supervisor started` from
  `apps/desktop/src/main/sync/sync-client-holder.ts`.
- `pnpm dev` (root) — runs both in parallel via `pnpm -r --parallel`. Works
  only if the single on-disk `better-sqlite3` binary happens to satisfy both
  sides, which by default it does not. Prefer `./bin/dev.sh start`.

### Google Drive datasource setup

The desktop app ships a real in-app OAuth consent flow: clicking
**Add Datasource → Google Drive → Connect** opens the system browser to
Google's consent screen, captures the redirect on a loopback port,
exchanges the code with PKCE, and adds the connected datasource to the
dashboard. This is the path covered by the `add-drive-oauth-browser-consent`
change (see `openspec/changes/add-drive-oauth-browser-consent/`).

> **Credential-persistence caveat (until `implement-datasource-onboarding`
> lands).** The OAuth flow currently completes successfully and creates the
> registry row, but the obtained tokens are **not** routed to the fs-sync
> service yet — clicking the new card to explore returns
> `Failed to load: no credentials registered for datasourceId=…`. The
> follow-up change `implement-datasource-onboarding` wires the service-side
> `sync:authenticate-*` handlers (currently stubbed). Until then, end-to-end
> upload testing requires the dev override path described later in this
> section.

#### Section 1 — One-time OAuth client + secrets setup

These steps are a prerequisite for the in-app consent flow. They are
operational (humans only — no code) and only need to be done once per
GCP project.

##### 1.1 Register the Google Cloud OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/), create or
   select a project.
2. **APIs & Services → Library → Google Drive API → Enable.** Without
   this, every upload fails with `provider-error: Google Drive API has not
   been used in project …`.
3. **APIs & Services → OAuth consent screen → External.** Fill in the
   required fields. Under "Test users" add the dev email accounts that
   will sign in during testing — without app verification, only listed
   test users can complete consent.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID
   → Desktop app.** Download the JSON. You need two values from it:
   - `client_id` (looks like `1234567890-abc….apps.googleusercontent.com`)
   - `client_secret` (looks like `GOCSPX-…`)

   Per Google's [Desktop OAuth docs](https://developers.google.com/identity/protocols/oauth2/native-app),
   the `client_secret` for Desktop clients is **non-confidential** —
   PKCE is the real security boundary. Treat it as embedded in the binary,
   not as a key requiring secret-grade rotation.

##### 1.2 Add the secrets to GitHub Actions

CI builds inline the `client_id` and `client_secret` into the main-process
bundle at build time via electron-vite's `define` map (see
`apps/desktop/electron.vite.config.ts`). The workflow pulls them from
repository secrets:

1. **Repo Settings → Secrets and variables → Actions → New repository
   secret.**
2. Add both:
   - `FT5_GOOGLE_OAUTH_CLIENT_ID` = the value from step 1.1
   - `FT5_GOOGLE_OAUTH_CLIENT_SECRET` = the value from step 1.1
3. The build / package / Playwright workflow steps in
   `.github/workflows/ci.yml` already reference them under their `env:`
   maps, so a fresh run will pick them up.

To verify CI can read the secrets without exposing the values, run a
dry-run workflow that echoes only their **lengths** (e.g.
`echo client-id length: ${#FT5_GOOGLE_OAUTH_CLIENT_ID}`) — never echo the
values themselves.

##### 1.3 Create your local `.env.local`

`pnpm -F @ft5/desktop dev` and `pnpm -F @ft5/desktop build:all` both call
`loadEnv()` from electron-vite, which reads `apps/desktop/.env.local` (and
`apps/desktop/.env`) before evaluating the config. `.env.local` is in
`.gitignore` — it is the right place for local dev credentials.

1. Copy the template:
   ```bash
   cp apps/desktop/.env.example apps/desktop/.env.local
   ```
2. Fill in the two values from step 1.1:
   ```dotenv
   FT5_GOOGLE_OAUTH_CLIENT_ID=<from step 1.1>
   FT5_GOOGLE_OAUTH_CLIENT_SECRET=<from step 1.1>
   ```
3. **Rebuild** (the values are inlined at build time, not read at runtime):
   ```bash
   pnpm -F @ft5/desktop build:all
   ```

If you ever see `OAuth client ID is not configured — set
FT5_GOOGLE_OAUTH_CLIENT_ID at build time` when clicking Connect, it
means the rebuild didn't pick up `.env.local`. Confirm the file exists at
`apps/desktop/.env.local` (not the worktree root) and rerun `build:all`.

#### Section 2 — Dev override (`FT5_DEV_CREDENTIALS=1`)

If you want to skip the browser flow entirely (CI smoke tests, offline
development, or while `implement-datasource-onboarding` is still pending),
set the env var before launching:

```bash
FT5_DEV_CREDENTIALS=1 pnpm -F @ft5/desktop dev
```

The broker checks the var on every `startConsent` call. When set, it
short-circuits the loopback flow: no browser opens, no HTTP server binds,
and `consent-completed` fires immediately using credentials read from
`<userData>/dev-credentials.json`. The desktop logs a one-shot warning
at the first invocation:

```
[ft5] ⚠  FT5_DEV_CREDENTIALS=1 is active — the OAuth browser flow is bypassed.
NEVER set this in a production build.
```

You provide the `dev-credentials.json` yourself. To obtain valid tokens,
run this PowerShell helper once (lives outside the repo; don't commit it):

```powershell
# get-gdrive-tokens.ps1
$clientId     = "<from Section 1.1>"
$clientSecret = "<from Section 1.1>"
$scope        = "https://www.googleapis.com/auth/drive.file"
$port         = 8765
$redirectUri  = "http://localhost:$port/"

$qs = @(
  "client_id=$([uri]::EscapeDataString($clientId))"
  "redirect_uri=$([uri]::EscapeDataString($redirectUri))"
  "response_type=code"
  "scope=$([uri]::EscapeDataString($scope))"
  "access_type=offline"
  "prompt=consent"
) -join "&"

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($redirectUri); $listener.Start()
Start-Process "https://accounts.google.com/o/oauth2/v2/auth?$qs"
$ctx  = $listener.GetContext()
$code = $ctx.Request.QueryString["code"]
$bytes = [Text.Encoding]::UTF8.GetBytes("Done. Close this tab.")
$ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length); $ctx.Response.Close(); $listener.Stop()

$tokens = Invoke-RestMethod -Method Post -Uri "https://oauth2.googleapis.com/token" -Body @{
  code          = $code
  client_id     = $clientId
  client_secret = $clientSecret
  redirect_uri  = $redirectUri
  grant_type    = "authorization_code"
}
Write-Host "accessToken:  $($tokens.access_token)"
Write-Host "refreshToken: $($tokens.refresh_token)"
```

`access_type=offline` + `prompt=consent` guarantees Google returns a fresh
`refresh_token` on every run.

Then write `<userData>/dev-credentials.json` — on Windows this is
`%APPDATA%\ft5-cloude-sync\dev-credentials.json`:

```json
{
  "providerId": "google-drive",
  "authResult": {
    "accessToken": "<from helper>",
    "refreshToken": "<from helper>",
    "meta": {
      "clientId":     "<from Section 1.1>",
      "clientSecret": "<from Section 1.1>",
      "redirectUri":  "http://localhost:8765/"
    }
  },
  "createdAt": 1714000000000,
  "updatedAt": 1714000000000
}
```

**Critical:** the `redirectUri` must exactly match the one used by the
helper (including the trailing slash) or Google rejects the refresh flow
with `redirect_uri_mismatch`.

For end-to-end upload testing the fs-sync service also needs a
matching entry — write
`$HOME\ft5\sync_app\dev\credentials.json` (Unix:
`$HOME/ft5/sync_app/dev/credentials.json`) keyed by the registry's
datasource id. Open the desktop's DevTools (`Ctrl+Shift+I`) → Console:

```js
await window.api.datasources.list()
```

…copy the `id` of the Google Drive row, then save:

```json
{
  "schemaVersion": 1,
  "credentials": {
    "<paste-datasource-id-from-devtools>": {
      "providerId": "google-drive",
      "authResult": { "...": "as above" },
      "createdAt": 1714000000000,
      "updatedAt": 1714000000000
    }
  }
}
```

The credential store reads this file fresh on every lookup — no service
restart required.

#### Troubleshooting

| Error / symptom                                              | Cause                                                                                                                         |
|---                                                           |---                                                                                                                            |
| `OAuth client ID is not configured — set FT5_GOOGLE_OAUTH_CLIENT_ID at build time` | `apps/desktop/.env.local` is missing or `build:all` ran before the file was created. See Section 1.3.                          |
| Connect opens browser, you authorize, browser shows "you can close this tab", but desktop dialog hangs | Token-exchange failure — most often `redirect_uri_mismatch` (you registered a "Web application" client instead of a "Desktop app" client; only Desktop clients accept loopback redirects) or `invalid_client` (clientSecret mismatch). Inspect the main-process terminal for the `consent-failed` message. |
| Connect opens browser, consent succeeds, dialog auto-closes, card appears, but exploring fails with `Failed to load: no credentials registered for datasourceId=…` | Expected gap — credential persistence is in the `implement-datasource-onboarding` follow-up. Use the dev override path (Section 2) for end-to-end testing today. |
| Browser never opens after Connect                            | Corporate firewall / endpoint-protection product is quarantining the loopback listener on `127.0.0.1:<ephemeral-port>`. Disable the interfering product temporarily, or use the dev override path (Section 2). |
| `auth-revoked: Google Drive credentials must include meta.*` | `meta` block missing or a field isn't a string in `dev-credentials.json` / `credentials.json`. Re-check the JSON schema above. |
| `provider-error: Google Drive API has not been used…`        | Drive API not enabled in your GCP project. See Section 1.1 step 2.                                                            |
| `no credentials registered for datasourceId=…`               | The datasource id in `credentials.json` doesn't match the one in the desktop registry. Re-fetch via DevTools.                |

### Hot-reload behaviour (desktop)

- **Main / preload changes** reload automatically on save.
- **Renderer changes** require restarting `dev` (the renderer ships as a
  static export under `apps/desktop/src/renderer/out/` that `electron-vite dev`
  does not watch). Live-reload for the renderer is a known-limitation
  follow-up — it needs the Next dev server running in parallel plus an
  `ELECTRON_RENDERER_URL` branch in the main process.

### Production build without packaging

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
