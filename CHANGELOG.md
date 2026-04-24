# Changelog

All notable user-visible and developer-visible changes to this repository
land here, organised per release. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/) once the first release is
cut. Pre-release entries live under `## [Unreleased]`.

## [Unreleased]

### Added

- **Single `pnpm dev` orchestration.** A new top-level `pnpm dev` script
  spawns the desktop app and the `fs-sync` service in parallel via
  `pnpm -r --parallel`, replacing the prior two-terminal workflow. The
  existing `pnpm dev:sync-service` alias still runs the service alone.
  See `services/fs-sync/README.md` "Dev mode" for the full picture.
- **Cross-platform dev-orchestration smoke.** `scripts/smoke/
  dev-orchestration.mjs` drives the full spawn → connect → `sync:get-
  status` → SIGINT teardown loop and is the acceptance criterion for
  the dev wiring. Verified on Windows; Mac/Linux runtime smoke is a
  documented gap.
- **Live job state on the datasource card.** The datasource card now
  reflects in-flight sync state from the service: a syncing badge with
  pulse animation while a sync job is running, an upload-progress bar
  driven by `job-progress` events, a multi-upload tiebreak that tracks
  the newer upload first, and a `waiting-network` variant with a
  `wifi-off` icon, zinc dot, humanised "Waiting for network" label, and
  `aria-live="polite"` on the badge for AT announcement.
- **Desktop ↔ service IPC.** Desktop main process now talks to the
  fs-sync service over a Unix socket / Windows named pipe via a typed
  `SyncClient`. A `Supervisor` connects to a running service or spawns
  one detached in production; in dev it connects only. An event bridge
  fans the service's job-lifecycle events out to every `BrowserWindow`
  and seeds the renderer with in-flight jobs at app open.
- **Two-step authenticate flow.** `sync:authenticate-start` +
  `sync:authenticate-complete` replace the single-shot `sync:
  authenticate` to keep callbacks/closures on the service side and the
  desktop transport JSON-clean. Service-side handlers ship as stubs in
  this change; the real implementation lands in the follow-up
  `implement-datasource-onboarding` change.

### Changed

- **Upload jobs are persisted by the service.** Manual uploads from the
  desktop now flow through `syncClient.enqueueUpload` rather than the
  legacy in-process executor. Job state is written to the service's
  SQLite database and survives desktop restarts; the renderer's
  `transactionId` contract is unchanged (now an opaque jobId).

### Removed

- **`SqliteCredentialStore` (desktop-side credential store).** The
  desktop no longer stores datasource credentials. The fs-sync service
  is the sole owner of credentials going forward (see
  `services/fs-sync/src/credentials/` and the
  `ConfigFileCredentialStore` plaintext-with-mode-enforcement design).
  The 0001 `datasource_credentials` Drizzle migration is dropped by a
  new 0003 migration; existing dev databases will lose any previously
  stored credentials and the user must re-authenticate.

### Breaking changes — developer-facing

These are not in-the-wild user impacts (no shipped releases yet) but
matter for anyone running this branch's earlier commits:

1. **Existing dev databases lose stored datasource credentials.**
   The 0003 migration drops the `datasource_credentials` table. Re-add
   any datasources after upgrading.
2. **The desktop app now requires the fs-sync service binary to be
   resolvable.** In dev: `pnpm dev` (or `pnpm dev:sync-service` in a
   second terminal). In production: the installer-registered service
   from a future change keeps the service running while the desktop
   isn't. Until that lands, the desktop's supervisor spawns a detached
   service instance the first time it can't connect.
3. **Upload jobs persist across app restarts.** Closing the desktop
   mid-upload no longer cancels the job — the service continues until
   completion or explicit cancel. The renderer's progress bar resumes
   on next app open via the seed handshake.
4. **Mac/Linux dev IPC socket relocation.** The dev socket now lives
   at `$HOME/ft5/sync_app/dev/sync-dev.sock` (matching the spec's
   data-dir layout), not the prior `$HOME/ft5/sync_app/sync-dev.sock`.
   Any stale socket file at the old path from this branch's earlier
   commits can be deleted; no action needed for users who haven't run
   `pnpm dev` on Unix yet. Latent on Windows because named pipes
   (`\\.\pipe\ft5-sync[-dev]`) bypass the data dir.
