# `@ft5/fs-sync-service`

Framework-agnostic per-user Node.js background daemon. Owns manual upload
and mirror-sync jobs: accepts IPC commands, executes them against
`@ft5/fs-datasource-engine`, persists state in a SQLite database owned
exclusively by the service, and keeps running after the Electron desktop
app closes.

No Electron, no `safeStorage`, no provider SDK imports. All provider
calls flow through the engine's `DatasourceClient<T>` obtained from
`ClientFactory.create`.

## Data directory

`$HOME/ft5/sync_app/` (dev: `$HOME/ft5/sync_app/dev/`), honouring
`FT5_SYNC_DATA_DIR` override. Created on first start with mode `0700`
on Unix / user-only ACL on Windows. Contents:

| File               | Role                                             |
|--------------------|--------------------------------------------------|
| `credentials.json` | `ConfigFileCredentialStore` plaintext JSON (v1). |
| `sync.db`          | SQLite DB (WAL), owned by the service only.      |
| `service.pid`      | PID file for the single-instance guard.          |
| `service.log`      | JSON-lines log, 5 MB × 5 rotation.               |
| `sync.sock`        | Unix socket (Unix only; Windows uses a named pipe). |

## IPC surface

Transport: newline-delimited JSON over a named pipe
(`\\.\pipe\ft5-sync` on Windows, `$HOME/ft5/sync_app/sync.sock` on
Unix; `-dev` suffix in dev mode). Each frame is `Request`,
`Response`, or `Event`. Contract types live in
`@ft5/ipc-contracts/sync-service`.

Commands (see `COMMAND_NAMES`):

- `sync:enqueue-upload` — enqueue a single-file upload
- `sync:enqueue-mirror` — enqueue a one-way mirror sync (dedup-guarded
  per `(datasourceId, sourcePath)`)
- `sync:list-jobs` / `sync:get-job` — read-only queries over the
  `jobs` table
- `sync:cancel-job` — cancel a queued or waiting-network job
- `sync:subscribe-events` / `sync:unsubscribe-events` — per-client
  event stream opt-in
- `sync:set-retry-policy` / `sync:get-retry-policy` — global or
  per-datasource retry policy
- `sync:authenticate` — authenticate a datasource via the engine
- `sync:get-status` — service version, uuid, and queue-depth summary

Auto-sync (`sync:enable-auto` / `sync:disable-auto`) is **not** in v1.

Events (per `EVENT_NAMES`): `job-enqueued`, `job-started`,
`job-progress`, `job-completed`, `job-failed`, `job-cancelled`,
`job-recovered`, `sync-completed`, `source-unavailable`,
`network-available`, `credential-store-permission-violation`.

## Dev mode

Run the service against a distinct pipe + data dir so it doesn't
collide with an installed production service:

```bash
pnpm dev:sync-service
```

Equivalent to `node --enable-source-maps services/fs-sync/dist/main/
index.js --dev`.

## Known limitations (v1)

- **Plaintext credentials on disk.** `ConfigFileCredentialStore` stores
  `StoredCredentials` as plaintext JSON at `credentials.json`, with
  `0600` / user-ACL enforcement and refusal-to-operate when the mode
  widens. Migration to an OS keyring (`keytar` / `wincred` / libsecret)
  is a deliberate follow-up; the `CredentialStore` port interface
  doesn't change.
- **Full re-upload on network retry.** Resumable-upload session APIs
  (S3 multipart continue, Drive resumable sessions, OneDrive upload
  sessions) aren't implemented. A partial upload that fails is
  re-started from byte 0 on retry. Follow-up tracked in the engine
  backlog.
- **Scheduler wiring of rate-limit + user-retry loops.** The retry
  classifier modules (`retry/system-retry.ts` + `retry/user-retry.ts`)
  and the `NetworkProbe` are fully implemented, but the scheduler's
  failure branch currently emits `waiting-network` for network-error
  and `failed` otherwise. Wiring the full retry-after-backoff loop
  into `Scheduler.applyOutcome` is a thin follow-up once product
  traffic exercises rate-limit paths.
- **Auto-sync via `MonitorEventSource`.** Port declared, no-op impl
  bound in v1; real implementation arrives with `services/fs-monitor`.
- **Installer execution coverage.** Per-OS install scripts ship with
  standing content tests; a full CI matrix exercising actual
  `schtasks` / `launchctl` / `systemctl --user` invocations is a
  phase-22 follow-up.

## Build and test

```bash
pnpm --filter @ft5/fs-sync-service build
pnpm --filter @ft5/fs-sync-service test
```

The service's tests run standalone via its own `vitest.config.ts` and
are also included in the root `pnpm -w test` glob.
