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

## Provider OAuth registration (one-time setup)

OAuth-class datasources (Google Drive, OneDrive) require a per-provider
"app" registration in the vendor's developer console. The resulting
`clientId` / `clientSecret` pair identifies *this application* to the
vendor and is consumed by the fs-sync service at authenticate-time.
Configuration lives at `~/ft5/sync_app/config.json` (Unix) or
`%USERPROFILE%\ft5\sync_app\config.json` (Windows) — service-owned,
manually copied from the committed template. The service surfaces a
`service-config-missing` error in the Add-Datasource dialog when a
provider entry is missing or empty.

S3 is access-key auth, not OAuth, so no app registration is required —
S3 users supply credentials directly through the credentials-form path
in the dialog.

### Google Drive

1. Open [Google Cloud Console](https://console.cloud.google.com/) →
   **APIs & Services → Credentials → Create Credentials → OAuth client
   ID**.
2. **Application type: Desktop application** (not Web application —
   only Desktop clients accept the loopback redirect this app uses).
   Name it (e.g. "FT5 Sync Dev").
3. **APIs & Services → OAuth consent screen** — configure with the
   `auth/drive` scope, add the dev email accounts that will sign in
   during testing as **Test users** (without app verification, only
   listed test users can complete consent).
4. **APIs & Services → Library** → search "Drive" → **Enable Google
   Drive API** in the same project. Without this, every authenticated
   call fails with `provider-error: Google Drive API has not been used
   in project …`.
5. Capture the resulting `client_id` (looks like
   `1234567890-abc….apps.googleusercontent.com`) and `client_secret`
   (looks like `GOCSPX-…`). These go into `config.json` below.

Per Google's [Desktop OAuth docs](https://developers.google.com/identity/protocols/oauth2/native-app),
the `client_secret` for Desktop clients is **non-confidential** — PKCE
is the real security boundary. Treat it as embedded in the binary, not
as a key requiring secret-grade rotation.

### OneDrive

1. Open [Azure Portal](https://portal.azure.com/) → **App registrations
   → New registration**.
2. **Supported account types:** "Accounts in any organizational
   directory and personal Microsoft accounts" (the multi-tenant
   `common` authority — single-tenant deployments are out of scope; the
   strategy defaults `tenantId` to `"common"`).
3. **Authentication → Add a platform → Mobile and desktop
   applications.** Add `http://localhost` as a redirect URI placeholder
   — the actual loopback port is dynamic per session.
4. **API permissions → Microsoft Graph → Delegated** → add
   `Files.ReadWrite` (and `User.Read` if your tenant requires sign-in
   metadata). Grant admin consent if your tenant requires it.
5. **Certificates & secrets → New client secret** — capture the
   Application (client) ID and the secret value. These go into
   `config.json` below.

### Configure the service

Copy the committed template to your home directory and edit the
per-provider entries you intend to use. Leave a provider's entries
empty if you don't intend to use it — the service surfaces a clear
`service-config-missing` error only when that specific provider is
exercised.

Linux / macOS:

```bash
mkdir -p ~/ft5/sync_app
cp services/fs-sync/config.example.json ~/ft5/sync_app/config.json
chmod 0600 ~/ft5/sync_app/config.json
$EDITOR ~/ft5/sync_app/config.json
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\ft5\sync_app" | Out-Null
Copy-Item services\fs-sync\config.example.json "$env:USERPROFILE\ft5\sync_app\config.json"
notepad "$env:USERPROFILE\ft5\sync_app\config.json"
```

The file shape (after editing):

```json
{
  "schemaVersion": 1,
  "providers": {
    "google-drive": {
      "clientId":     "1234567890-abc….apps.googleusercontent.com",
      "clientSecret": "GOCSPX-…"
    },
    "onedrive": {
      "clientId":     "<Azure Application (client) ID>",
      "clientSecret": "<Azure client secret value>"
    }
  }
}
```

Edits are picked up on the next `sync:authenticate-start` request — no
service restart required.

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
Google's consent screen, captures the redirect on a loopback port
hosted by the fs-sync service, exchanges the code with PKCE, persists
tokens at `~/ft5/sync_app/credentials.json`, and adds the connected
datasource to the dashboard.

The one-time prerequisite is the **Provider OAuth registration**
section above — register a Google Cloud OAuth Desktop client, then copy
`services/fs-sync/config.example.json` to `~/ft5/sync_app/config.json`
and populate the `google-drive` entry. After that, no further setup is
needed for the in-app flow.

> **Migration note.** Previous releases inlined
> `FT5_GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` into the desktop bundle at
> build time via `apps/desktop/.env.local` and the matching GitHub
> Actions secrets. That path was removed in
> `implement-datasource-onboarding` (see `electron.vite.config.ts` —
> the `define` map no longer references those env vars). OAuth app
> config now lives at `~/ft5/sync_app/config.json` and is read by the
> service at authenticate-time. Existing `.env.local` files become
> inert; the `apps/desktop/.env.example` entries are marked deprecated.

#### Dev override (`FT5_DEV_CREDENTIALS=1`)

If you want to skip the browser flow entirely (CI smoke tests, offline
development), set the env var when launching the **fs-sync service**
(not the desktop):

```bash
FT5_DEV_CREDENTIALS=1 pnpm dev:sync-service
```

The service-side broker checks the var on every authenticate-start
call. When set, it short-circuits the loopback flow: no browser opens,
no HTTP server binds, and `auth-completed` fires immediately using
credentials read from `~/ft5/sync_app/dev/dev-credentials.json` (dev
data dir; production reads from `~/ft5/sync_app/dev-credentials.json`).
The service logs a one-shot warning at the first invocation:

```
[ft5] ⚠  FT5_DEV_CREDENTIALS=1 is active — the OAuth browser flow is bypassed.
NEVER set this in a production build.
```

You provide the `dev-credentials.json` yourself. To obtain valid
tokens, run this PowerShell helper once (lives outside the repo;
don't commit it):

```powershell
# get-gdrive-tokens.ps1
$clientId     = "<from Provider OAuth registration → Google Drive>"
$clientSecret = "<from Provider OAuth registration → Google Drive>"
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

Then write the dev-credentials file at the service's data dir:

- **Dev service** (`pnpm dev:sync-service` — uses dev data dir):
  `~/ft5/sync_app/dev/dev-credentials.json` (Windows:
  `%USERPROFILE%\ft5\sync_app\dev\dev-credentials.json`).
- **Prod service** (installed background service):
  `~/ft5/sync_app/dev-credentials.json` (Windows:
  `%USERPROFILE%\ft5\sync_app\dev-credentials.json`).

```json
{
  "providerId": "google-drive",
  "authResult": {
    "accessToken": "<from helper>",
    "refreshToken": "<from helper>",
    "meta": {
      "clientId":     "<from Provider OAuth registration → Google Drive>",
      "clientSecret": "<from Provider OAuth registration → Google Drive>",
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

For end-to-end upload testing against an existing registry row, the
fs-sync service also needs a matching entry in its credentials store
keyed by the registry's datasource id. Open the desktop's DevTools
(`Ctrl+Shift+I`) → Console:

```js
await window.api.datasources.list()
```

…copy the `id` of the Google Drive row, then save it to the service's
`credentials.json` (dev: `~/ft5/sync_app/dev/credentials.json`; prod:
`~/ft5/sync_app/credentials.json`):

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
| Add-Datasource dialog shows "Service configuration missing. Add OAuth credentials to `<path>`." | `~/ft5/sync_app/config.json` is absent, or the requested provider's `clientId` / `clientSecret` is empty. See **Provider OAuth registration → Configure the service** above. |
| Connect opens browser, you authorize, browser shows "you can close this tab", but desktop dialog hangs | Token-exchange failure — most often `redirect_uri_mismatch` (you registered a "Web application" client instead of a "Desktop app" client; only Desktop clients accept loopback redirects) or `invalid_client` (clientSecret mismatch in `config.json`). Inspect the fs-sync service log for the `auth-failed` message. |
| Browser never opens after Connect                            | Corporate firewall / endpoint-protection product is quarantining the loopback listener on `127.0.0.1:<ephemeral-port>`. Disable the interfering product temporarily, or use the dev override path. |
| `auth-revoked: Google Drive credentials must include meta.*` | `meta` block missing or a field isn't a string in `dev-credentials.json` / `credentials.json`. Re-check the JSON schema above. |
| `provider-error: Google Drive API has not been used…`        | Drive API not enabled in your GCP project. See **Provider OAuth registration → Google Drive** step 4. |
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
