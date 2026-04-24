## Why

The three modules that make the application work — `@ft5/fs-datasource-engine` (shared engine), `apps/desktop` (Electron shell), and `services/fs-sync` (background daemon) — exist as completed islands but have never been composed into a running system. The service's entry point is a Phase-5 scaffold that opens a DB and exits; desktop has no sync client, no supervisor, and no `window.api.sync.*`; and every upload today runs in-process inside Electron and dies when the window closes. The application is not yet usable end-to-end. This change wires them together so a user can launch the desktop app, upload a file, close the window, and have the upload finish.

## What Changes

- **BREAKING** — Remove the in-process upload path in desktop main (`DATASOURCES_CHANNELS.upload` + `uploadProgress` handlers that call `engine.uploadFile` directly). All uploads now enqueue `sync:enqueue-upload` on the service and receive progress via relayed `job-progress` events.
- **BREAKING** — Delete `apps/desktop/src/main/datasources/sqlite-credential-store.ts` and the `0001_datasource_credentials` migration. Desktop no longer stores credentials. The service's `ConfigFileCredentialStore` becomes the single source of truth; all auth flows proxy through `sync:authenticate`.
- Compose `services/fs-sync/src/main/index.ts` from the existing (already-implemented) parts: `startup/recovery` → `scheduler` → `ipc/server` → `commands/handlers`, with signal-driven shutdown and pipe/socket bind. The service becomes a long-lived daemon, not a phase-5 stub that exits.
- Add a sync-service client to `apps/desktop/src/main/sync/`: newline-delimited JSON framing over the platform-appropriate transport (Windows named pipe / Unix domain socket), request/response correlation, event-stream subscription, typed against `@ft5/ipc-contracts/sync-service`.
- Add a supervisor in desktop main that implements Option 3: attempt to connect; if the PID guard is unheld, spawn the service detached; if a race produces `AlreadyRunningError` (exit 3), retry-connect to the surviving instance.
- Add desktop IPC handlers that proxy the renderer-facing `sync:*` surface to the service client, and extend the preload to expose `window.api.sync.*` with typed request/response + event subscription.
- Add the renderer-facing IPC contract under `@ft5/ipc-contracts` (distinct from the service's on-the-wire contract) covering: `listJobs`, `getJob`, `enqueueUpload`, `enqueueMirror`, `cancelJob`, `subscribeEvents`, `authenticate`, `getStatus`, `setRetryPolicy`, `getRetryPolicy`.
- On app open, fetch in-progress jobs (`sync:list-jobs` filtered to `running`, `queued`, `waiting-network`) and subscribe to the service event stream. Surface per-datasource: active-sync indicator on the card; active-upload progress bar on the card.
- Add a single `pnpm dev` entry that boots renderer + main + fs-sync-service (`--dev`) concurrently with coordinated shutdown so a developer can run the full app in one terminal.
- Remove the stale `// Phase 5 / three placeholder strategy stubs` comment at `packages/fs-datasource-engine/src/index.ts:52-53` — Phases 6–8 landed real S3, OneDrive, and Google Drive strategies (780 / 1054 / 1334 lines respectively, zero TODO markers).

## Capabilities

### New Capabilities

- `fs-sync-supervisor`: desktop main's role in connecting to (and, when absent, spawning) the fs-sync service; the sync-client transport; the renderer-facing `sync:*` IPC surface; app-open reconciliation of in-progress jobs; coordinated shutdown with the service (the supervisor does NOT kill a detached service on desktop quit — that is the whole point of the service outliving the window).

### Modified Capabilities

- `fs-sync-service`: the service's bootstrap requirement changes from "DB opened and migrated" (phase-5 scaffold) to "fully composed runtime with scheduler, IPC server, signal-driven shutdown, and recovery on startup." The `sync:authenticate` command is promoted to the canonical authentication entry point (previously one of several commands; now the only way credentials are written).
- `fs-datasource-engine`: remove the requirement "CredentialStore port + SqliteCredentialStore implementation." The port remains (framework-agnostic, unchanged); the SqliteCredentialStore obligation was desktop-specific and is being deleted. No other engine behavior changes.
- `datasources-ui`: the upload quick-action still invokes `window.api.datasources.upload({ datasourceId })` with a main-process file picker, but the handler now enqueues a service job and delivers progress via the service event stream, not the in-process `DatasourcesEventBus`. Cards gain two states driven by live service events: `syncing` when a mirror-sync job is active for that datasource, and a per-card upload progress bar when an upload job is active.

## Impact

- **Code removed:** `apps/desktop/src/main/datasources/sqlite-credential-store.ts`, the `0001_datasource_credentials` migration, the in-process upload implementation in `apps/desktop/src/main/ipc/datasources/`, and the preload's direct upload-progress wiring. Corresponding tests go with them.
- **Code added:** `apps/desktop/src/main/sync/` (client, supervisor, proxy handlers), service bootstrap composition in `services/fs-sync/src/main/index.ts`, renderer-facing sync IPC contract under `packages/ipc-contracts/src/sync-service-desktop/` (or similar), renderer surfacing of job state on datasource cards.
- **Spec files changed:** `openspec/specs/fs-sync-service/spec.md` (bootstrap requirement), `openspec/specs/fs-datasource-engine/spec.md` (credential-store requirement removed), `openspec/specs/datasources-ui/spec.md` (upload path + card states). New `openspec/specs/fs-sync-supervisor/spec.md`.
- **Dev workflow:** single `pnpm dev` orchestrates three processes. Developers no longer need a separate `pnpm dev:sync-service` terminal (the command remains for debugging the service in isolation).
- **Architecture rules preserved:** engine remains framework-agnostic (Option B credential resolution); Drizzle stays in `apps/desktop/src/main/` only; Electron security defaults untouched; the four-piece rule (contract + main handler + preload + renderer call) applies to every new `sync:*` channel.
- **Known gaps deliberately carried forward (out of scope):** auto-sync commands, `fs-monitor` service, retry-after-backoff scheduler loop, resumable uploads, installer end-to-end CI matrix, OS-keyring credential re-encryption.
