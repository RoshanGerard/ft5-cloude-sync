# Proposal: Real datasource-onboarding flow rooted in the fs-sync service

## Why

`sync:authenticate-start` and `sync:authenticate-complete` ship as `not-implemented` stubs (see Decision 11 in the archived `wire-fs-sync-service` design). Today no end-to-end add-datasource flow lands credentials at `~/ft5/sync_app/credentials.json` — the desktop OAuth broker writes through `noopCredentialStore` and the non-OAuth `datasources:add` IPC explicitly ignores its `credentials` field. As a result every PENDING_TC entry tagged `add-drive-oauth-browser-consent §12.x` and `add-invalid-datasource-state §13.x` is blocked: a fresh-install user can complete browser consent, see a card materialise in the dashboard, and then hit `Failed to load: no credentials registered for datasourceId=…` the moment they explore it. This change replaces the stubs with a real flow whose backend lives entirely on the fs-sync service: the service runs `engine.authenticate()`, hosts the OAuth loopback HTTP listener, owns OAuth app config at `~/ft5/sync_app/config.json`, and persists per-user tokens via the existing `ConfigFileCredentialStore`. The desktop main process becomes a thin frontend over that backend.

## What Changes

**Engine — `@ft5/fs-datasource-engine`:**
- New `factory.createForAuth(providerId, oauthAppConfig)` factory method that constructs a strategy-specific client without real `StoredCredentials` — only OAuth app config (`clientId`, `clientSecret`, `redirectUri`) for OAuth providers, or no extra config for credentials-form providers. Exists for the explicit "I haven't authenticated yet" case rather than relying on the empty-token-blob hack the desktop broker uses today.
- Per-strategy adaption so each `doAuthenticateImpl` (Google Drive, OneDrive, S3) is reachable through `createForAuth` without the existing `readCredsFromStored` empty-field rejection.

**Service — `services/fs-sync`:**
- New `ServiceConfigStore` reads `~/ft5/sync_app/config.json` (per-provider OAuth app config). Fails with the new `service-config-missing` error tag when the file is absent or any consulted provider entry has empty `clientId`/`clientSecret`. No auto-seed, no installer template — a committed `services/fs-sync/config.example.json` is the human-copy source.
- New `OAuthLoopbackBroker` module — relocated from `apps/desktop/src/main/oauth/consent-broker.ts`. Hosts the per-session 127.0.0.1:0 loopback, owns CSRF state + 5-minute timer, runs `intent.completeWith(code)`. Lives in the service process because credential ownership lives there (Decision 1 of `wire-fs-sync-service`).
- Real `handleAuthenticateStart` and `handleAuthenticateComplete` replacing the `not-implemented` stubs — consume the existing `AuthCorrelationStore`, branch on `intent.kind` (`oauth` → start loopback + emit `oauth-open-url`; `credentials-form` → return form schema for the renderer to drive). On terminal success, the engine's `decorateIntent` writes credentials via the existing `ConfigFileCredentialStore`.
- New `sync:authenticate-cancel` wire command (parallel to the desktop broker's existing cancel idempotency).
- New `sync:get-config` and `sync:set-config` wire commands (minimal scope: just OAuth app config keys; future settings UI can reuse).
- New service-stream events: user-facing `auth-initiated`, `auth-completed`, `auth-cancelled`, `auth-failed`, `auth-timeout`; internal-to-the-bridge `oauth-open-url` (carries authorize URL) and `credential-persisted` (carries `DatasourceSummary`).
- **BREAKING (contract)**: removes the `not-implemented` variant from the `sync:authenticate-start` and `sync:authenticate-complete` command-error unions. Renderer / desktop callers no longer need to defensively handle that tag.

**Desktop main — `apps/desktop/src/main`:**
- Sync event-bridge gains two new subscriptions: `oauth-open-url` → `shell.openExternal(authorizeUrl)`; `credential-persisted` → `getEngine().registry.add(summary)`. The `registry.add` call becomes idempotent (insert-or-update on duplicate id) so duplicate event delivery cannot wedge the bridge.
- **REMOVED**: `apps/desktop/src/main/oauth/consent-broker.ts` and its tests — relocated to the service.
- **REMOVED**: the `noopCredentialStore` declaration in `apps/desktop/src/main/index.ts` and the engine wiring that fed it to the broker.
- `datasources:start-consent` and `datasources:cancel-consent` IPC handlers either delete or downgrade to thin proxies that call `sync.authenticateStart/Cancel` (final shape decided in design.md per the contract-evolution decision).

**Renderer — `apps/desktop/src/renderer`:**
- `oauth-form.tsx` switches its request/response surface from `window.api.datasources.startConsent` to `window.api.sync.authenticateStart` (and `authenticateComplete` for the in-dialog cancel path). Existing failure-state rendering surfaces the new `service-config-missing` tag with copy pointing at the file path + README §X (Layer 1 error notification only).
- `aws-access-key-form.tsx` and `custom-form.tsx` migrate from `actions.add` to `sync.authenticateStart` + `sync.authenticateComplete` with `kind: "credentials-form"` completion — same backend path, no new broker.
- `useConsentSession` hook → `useAuthSession`. Subscribes via `window.api.sync.onEvent` instead of `window.api.datasources.onEvent`. Existing `auth-*` event consumers in tests migrate.
- `add-dialog.tsx` adjusts the OAuth-completion sentinel and the registry-refresh path.

**Repo + docs:**
- New committed template `services/fs-sync/config.example.json`.
- `README.md` gains a new section: per-provider OAuth app registration (GCP for Google Drive, Azure for OneDrive) plus the "copy `config.example.json` to `~/ft5/sync_app/config.json` and edit" setup step. Mirrors the existing `add-drive-oauth-browser-consent` `.env.example` pattern.

## Capabilities

### New Capabilities

None. All work folds into existing capabilities.

### Modified Capabilities

- `fs-datasource-engine` — `factory` gains `createForAuth(providerId, oauthAppConfig)`; per-strategy `doAuthenticateImpl` reachable without real tokens.
- `fs-sync-service` — gains real authenticate handlers, OAuth loopback broker, `ServiceConfigStore` with `~/ft5/sync_app/config.json` source, `sync:authenticate-cancel` command, `sync:get-config` / `sync:set-config` commands, the new event taxonomy, and the `service-config-missing` error tag. Loses the `not-implemented` error-tag variant on `sync:authenticate-{start,complete}`.
- `datasources-ui` — `oauth-form` + `aws-access-key-form` + `custom-form` migrate to `window.api.sync.authenticate{Start,Complete}`; `useConsentSession` → `useAuthSession`; new error-state copy for `service-config-missing`. The `datasources:start-consent` / `cancel-consent` IPC surface either disappears or becomes a thin proxy (decided in design).

## Impact

**Code:**
- Engine: `packages/fs-datasource-engine/src/factory.ts`, the three strategy files (`googledrive-client.ts`, `onedrive-client.ts`, `s3-client.ts`), plus matching test files.
- Contracts: `packages/ipc-contracts/src/sync-service{,-desktop}/*.ts` — new commands (`authenticate-cancel`, `get-config`, `set-config`), new error tag `service-config-missing`, removed `not-implemented` variant, new event union members.
- Service: new `services/fs-sync/src/oauth/loopback-broker.ts`, `services/fs-sync/src/config/service-config-store.ts`; rewrites of `services/fs-sync/src/commands/authenticate-{start,complete}.ts`; new `authenticate-cancel.ts`, `get-config.ts`, `set-config.ts`; threading through `handlers.ts` and `bootstrap.ts`.
- Desktop main: `apps/desktop/src/main/sync/event-bridge.ts` (two new subscriptions); `apps/desktop/src/main/datasources/registry.ts` (idempotent `add`); deletions of `apps/desktop/src/main/oauth/consent-broker.ts` + tests + the noop-store declaration in `index.ts`.
- Renderer: `apps/desktop/src/renderer/src/features/datasources/credential-forms/oauth-form.tsx`, `aws-access-key-form.tsx`, `custom-form.tsx`, `add-dialog.tsx`, `store.tsx`, plus the affected test files (`oauth-form.test.tsx`, `store-consent.test.tsx`, `card-auth-error-banner.test.tsx`, `card-invalid-datasource-banner.test.tsx`, `add-dialog.test.tsx`, `add-dialog-extensibility.test.tsx`).

**Dependencies:**
- No new runtime deps. The service uses Node built-ins for the loopback HTTP server and `fs/promises` for the config file. Engine PKCE already lives in `add-drive-oauth-browser-consent`.

**Operational:**
- New first-run human step: copy `services/fs-sync/config.example.json` to `~/ft5/sync_app/config.json` and populate per-provider `clientId`/`clientSecret` from the GCP / Azure consoles. README documents this. The earlier `apps/desktop/.env.local` build-time inlining of `FT5_GOOGLE_OAUTH_CLIENT_ID` / `FT5_GOOGLE_OAUTH_CLIENT_SECRET` becomes obsolete for the running app — the service config supersedes it. Whether to keep the build-time inlining for a transition period is decided in design.md.

**Risks documented in design.md:**
- Orphan-credentials window during the temporary state where credentials live on the service but the registry row still lives on desktop. Mitigated by idempotent `registry.add` and a typed credential-store error event for a later janitor task. Closed structurally by the follow-up change `move-datasource-registry-to-service`.
- Plaintext OAuth secrets on disk at `~/ft5/sync_app/config.json`. Mirrors the `add-fs-sync-service` D4 plaintext-credentials deferred tradeoff.

**Tests:**
- Engine: `factory.createForAuth` shape + per-strategy reachability; existing strategy tests stay green.
- Service: `ServiceConfigStore` read/write, missing-file → typed error, partial-config → typed error; `OAuthLoopbackBroker` ports the existing broker tests; real `handleAuthenticate{Start,Complete}` cover oauth and credentials-form intents through the correlation store; `sync:authenticate-cancel` cancel + idempotency; `sync:get-config` / `sync:set-config` round-trip.
- Desktop main: bridge subscriptions for `oauth-open-url` / `credential-persisted`; idempotent `registry.add`.
- Renderer: existing `oauth-form.test.tsx` etc. migrated to the sync event channel; new `service-config-missing` rendering arm; non-OAuth forms wired to authenticate-complete.
- Smoke (manual, deferred to PENDING_TC): the §12.x and §13.x flows that are currently blocked unblock under this change.

**Out of scope (deferred to follow-up `move-datasource-registry-to-service`):**
- Datasource registry table migration from desktop's DB to `sync.db`.
- `datasources:list` / `datasources:add` / `datasources:remove` / `datasources:action` IPC migration to `sync:*`.
- Reduction or removal of the desktop `getEngine()` singleton.

**Out of scope (deferred to follow-up `migrate-credentials-to-sqlite`):**
- Migrating per-user credentials from `~/ft5/sync_app/credentials.json` to a `credentials` table in `sync.db`. The `ConfigFileCredentialStore` continues to back the credential read/write path in this change; `sync:delete-credentials` calls into it via the existing `CredentialStore` interface so the eventual SQLite swap requires no IPC contract change. Pairs naturally with the registry move so both stores end up in `sync.db` for transactional remove.

**Out of scope for this change (other follow-ups):**
- Layer 2 (toast) and Layer 3 (dashboard banner) error notification surfaces for config issues.
- A general settings UI that uses `sync:get-config` / `sync:set-config` to edit OAuth app config from inside the app.

## Provenance

- Decision 11 of the archived `wire-fs-sync-service` design (`openspec/changes/archive/2026-04-24-wire-fs-sync-service/design.md`) explicitly named this change as the chartered follow-up that replaces the `not-implemented` stubs.
- PENDING_TC entries `add-drive-oauth-browser-consent §12.1`, `§12.2`, and `add-invalid-datasource-state §13.1`, `§13.2`, `§13.3` all name this change as their unblock-on dependency.
- Architectural framing — service-as-backend, desktop-as-frontend, engine package shared — was the explicit user direction during `/opsx:explore`. The size of the bundled "registry on service too" version was rejected in favor of the split into this change plus the follow-up `move-datasource-registry-to-service`; that bundling-versus-split decision is intentional and recorded in design.md `## Goals / Non-Goals`.
