# Tasks: implement-datasource-onboarding

Each task lands behind a failing test first per the Superpowers
`test-driven-development` skill. Long-running commands (test suites,
builds) MUST be dispatched via subagent with `run_in_background: true`
per CLAUDE.md. Subagent dispatch per task per CLAUDE.md
`subagent-driven-development`.

## 1. Pre-flight & worktree

- [x] 1.1 Confirm with user where to put the worktree: in-place vs sibling (per CLAUDE.md `using-git-worktrees`); default to `.worktrees/implement-datasource-onboarding/` if no answer (user picked sibling at `.worktrees/implement-datasource-onboarding/`)
- [x] 1.2 Create the worktree + branch via the `using-git-worktrees` skill (worktree at `.worktrees/implement-datasource-onboarding/`, branch `feature/implement-datasource-onboarding` off master `ec538a5`; pnpm install completed in 1m4s)
- [x] 1.3 Verify a clean baseline: run `pnpm typecheck` and the full vitest suite once in the worktree to confirm green-before-changes; capture any pre-existing flaky/failing test as a known-baseline (e.g., the `scripts/preload-bundle.test.ts` flake noted in `add-invalid-datasource-state` §1.3 may still apply) — Result: typecheck green; vitest **1955 pass / 1 fail / 7 skip across 248 files**. The single failure is the same documented `scripts/preload-bundle.test.ts` flake — `tsc -b` from typecheck overwrites the Vite-bundled `apps/desktop/dist/preload/index.js` with the tsc-compiled output that includes runtime `require()` for `@ft5/ipc-contracts` workspace dep; vitest's preload-bundle guardrail then flags it. Structural fragility, unrelated to this change. Treated as the known-baseline flake.

## 2. Engine — `OAuthAppConfig` type + `PreAuthConfig` strategy slot

- [x] 2.1 Write a typed test (`packages/fs-datasource-engine/src/__tests__/oauth-app-config.test-d.ts`) asserting `OAuthAppConfig = { clientId, clientSecret, redirectUri }` is exported from the engine package's public surface; test fails because the type does not yet exist
- [x] 2.2 Add `OAuthAppConfig` type to `packages/fs-datasource-engine/src/index.ts` (or a sibling `auth-types.ts`); rerun the typed test → green
- [ ] 2.3 Write a unit test for `GoogleDriveClient` accepting a `preAuth?: PreAuthConfig` constructor parameter and reading `clientId`/`clientSecret`/`redirectUri` from it at `doAuthenticateImpl` time when present (`packages/fs-datasource-engine/src/strategies/__tests__/googledrive-preauth.test.ts`); current test reads from `creds.authResult.meta` so the new test fails
- [ ] 2.4 Adapt `GoogleDriveClient` to accept and consult the new `preAuth` slot; existing `meta`-reading code path stays for backward compatibility during the transition (deletion of the `meta` path covered later by §22.x)
- [ ] 2.5 Repeat 2.3/2.4 for `OneDriveClient` (`onedrive-preauth.test.ts` + adaptation in `onedrive-client.ts`)
- [ ] 2.6 Write a unit test for `S3Client` accepting `preAuth: null` constructor param without errors; existing credentials-form intent path stays unchanged
- [ ] 2.7 Adapt `S3Client` to accept `preAuth` (no-op for credentials-form providers); rerun test → green

## 3. Engine — `factory.createForAuth(providerId, oauthAppConfig, ctx)`

- [ ] 3.1 Write a unit test for `ClientFactory.createForAuth("google-drive", oauthAppConfig, ctx)` returning a `GoogleDriveClient` whose `authenticate()` produces an OAuthIntent with the expected authorize URL parameters (`packages/fs-datasource-engine/src/__tests__/factory-create-for-auth.test.ts`); test fails because `createForAuth` does not yet exist
- [ ] 3.2 Write the same shape for `createForAuth("amazon-s3", null, ctx)` returning an `S3Client` whose `authenticate()` produces a `CredentialsFormIntent`
- [ ] 3.3 Write rejection tests: OAuth provider with `null` config → throws `DatasourceError(invalid-datasource)`; credentials-form provider with non-null config → throws same; unknown providerId → throws same
- [ ] 3.4 Implement `createForAuth` in `packages/fs-datasource-engine/src/factory.ts`; dispatch on `providerId` via the existing `ProviderRegistry`; thread `oauthAppConfig` into the strategy constructor's new `preAuth` slot
- [ ] 3.5 Extend the registry entry shape so each entry declares whether it is OAuth-class or credentials-form-class; `createForAuth` validates the `oauthAppConfig` argument against the declaration
- [ ] 3.6 Rerun the engine package's full vitest suite → all green; ensure existing `factory.create` tests still pass unchanged

## 4. Contracts — new wire commands

- [ ] 4.1 Write a typed test asserting `SyncAuthenticateStartRequest`, `SyncAuthenticateStartResponse` are present in `@ft5/ipc-contracts/sync-service`; the response is the discriminated union `{ ok: true, result: { correlationId, kind: "oauth" } | { correlationId, kind: "credentials-form", formSchema } } | { ok: false, error: SyncAuthenticateStartError }` per design.md Decision 9; test fails until the union shape is in
- [ ] 4.2 Update the contract types in `packages/ipc-contracts/src/sync-service/commands.ts` to match; rerun typed test → green
- [ ] 4.3 Repeat 4.1/4.2 for `SyncAuthenticateCompleteRequest/Response` (`{ correlationId, completion: { kind: "credentials-form", values } }` shape only — OAuth completion runs inside the service)
- [ ] 4.4 Write/extend the typed test for `SyncAuthenticateCancelRequest/Response` (`{ correlationId }` → `{ ok: true, result: { cancelled: boolean } } | { ok: false, error }`); add the contract types and the `COMMAND_NAMES` enum entry; rerun → green
- [ ] 4.5 Write/extend typed tests for `SyncGetConfigRequest/Response` and `SyncSetConfigRequest/Response`; add to contract types + `COMMAND_NAMES`; rerun → green
- [ ] 4.6 Write/extend typed tests for `SyncDeleteCredentialsRequest/Response`; add to contract types + `COMMAND_NAMES`; rerun → green
- [ ] 4.7 Verify `COMMAND_NAMES` exhaustive test (`packages/ipc-contracts/src/__tests__/...`) catches the new entries; assert old `sync:authenticate` is absent (per Modified Requirement "IPC command surface")

## 5. Contracts — new event taxonomy + remove `consent-*` variants

- [ ] 5.1 Write a typed test asserting `SyncEvent` (the service event union) contains `auth-initiated`, `auth-completed`, `auth-cancelled`, `auth-failed`, `auth-timeout`, `oauth-open-url`, `credential-persisted` variants with their payload shapes per design.md Decision 7; test fails until shapes are in
- [ ] 5.2 Add the variants to `packages/ipc-contracts/src/sync-service/events.ts` (or wherever the existing `SyncEvent` union lives); rerun typed test → green
- [ ] 5.3 Write a typed test asserting `DatasourceEvent` does NOT contain `consent-*` variants; test fails because the variants are still there
- [ ] 5.4 Remove the `consent-*` variants from `DatasourceEvent` in `packages/ipc-contracts/src/datasources.ts`; remove the `DatasourcesStartConsentRequest/Response`, `DatasourcesCancelConsentRequest/Response` types; remove the `startConsent` and `cancelConsent` keys from `DATASOURCES_CHANNELS`; rerun → green
- [ ] 5.5 Write a typed test asserting `SyncAuthenticateStartError` includes `service-config-missing` variant with `path`/`providerId` fields; add to the union if missing; rerun → green
- [ ] 5.6 Write a typed test asserting the `not-implemented` variant is absent from `SyncAuthenticateStartError` AND `SyncAuthenticateCompleteError`; remove the variant from both unions; rerun → green
- [ ] 5.7 Run the full ipc-contracts package test suite; verify no regressions

## 6. Service — `ServiceConfigStore`

- [ ] 6.1 Write unit tests for `ServiceConfigStore` (`services/fs-sync/src/config/__tests__/service-config-store.test.ts`): `getOAuthAppConfig` happy path, missing-file error, missing-provider-entry error, empty-clientId error, empty-clientSecret error, `getRaw`/`setRaw` round-trip, atomic write (mode 0o600 on Unix)
- [ ] 6.2 Implement `services/fs-sync/src/config/service-config-store.ts` to pass the tests; reuse the atomic-write pattern from `ConfigFileCredentialStore` (write-to-tmp + rename + chmod 0o600)
- [ ] 6.3 Define `ServiceConfigMissingError` class with `path` and `providerId` fields
- [ ] 6.4 Wire `ServiceConfigStore` into `services/fs-sync/src/main/bootstrap.ts` (new bootstrap stage between `construct-credential-store` and `construct-provider-registry`); update the `BootstrapStage` union; existing `bootstrap.test.ts` order assertion gets a new entry
- [ ] 6.5 Add a path-resolver function `resolveServiceConfigPath` parallel to the existing `resolveCredentialsPath` in `services/fs-sync/src/env/paths.ts`; tests confirm the path is `<dataDir>/config.json`

## 7. Service — committed `config.example.json` template

- [ ] 7.1 Write a test that reads `services/fs-sync/config.example.json` from the repo and asserts it is valid JSON with `schemaVersion: 1` and a `providers` object containing `google-drive` and `onedrive` keys (both with empty-string `clientId`/`clientSecret`)
- [ ] 7.2 Create `services/fs-sync/config.example.json` matching the schema; commit
- [ ] 7.3 Confirm `.gitignore` does NOT exclude the example file (only the user-managed `~/ft5/sync_app/config.json` should be untracked, and that path is outside the repo)

## 8. Service — `OAuthLoopbackBroker` (port from desktop)

- [ ] 8.1 Copy `apps/desktop/src/main/oauth/__tests__/consent-broker.test.ts` to `services/fs-sync/src/oauth/__tests__/loopback-broker.test.ts`; rename `OAuthConsentBroker` → `OAuthLoopbackBroker`, `sessionId` → `correlationId`, `consent-*` event names → `auth-*` / `oauth-open-url` / `credential-persisted` per design.md Decision 7. Run the suite — every test fails (file does not exist yet)
- [ ] 8.2 Repeat for `consent-broker-dev-override.test.ts` → `loopback-broker-dev-override.test.ts`
- [ ] 8.3 Implement `services/fs-sync/src/oauth/loopback-broker.ts` to pass the ported tests. Surface differences from the desktop original:
  - keys on `correlationId` (not `sessionId`)
  - emits service events (`oauth-open-url`, `auth-completed`, `credential-persisted`, `auth-cancelled`, `auth-failed`, `auth-timeout`) via the engine bus
  - consults the engine's existing `ConfigFileCredentialStore` directly (no `noopCredentialStore`)
  - reads `clientId`/`clientSecret` from a `ServiceConfigStore` injection (no build-time constants)
  - dev-override reads `<dataDir>/dev-credentials.json` (service path, not Electron userData)
- [ ] 8.4 Implement `OAuthLoopbackBroker.dispose()` to close every active session's HTTP server + clear every timer (used by SIGINT shutdown per fs-sync-service Modified Requirement "Service bootstrap composes the full runtime")
- [ ] 8.5 Run the broker test file standalone; all green

## 9. Service — real `handleAuthenticateStart`

- [ ] 9.1 Replace the stub at `services/fs-sync/src/commands/authenticate-start.ts` — first write the real implementation's failing tests in `authenticate-start.test.ts` (currently mostly stub-shape assertions). Cover: OAuth-class happy path (returns `kind: "oauth"`, emits `auth-initiated` + `oauth-open-url`); credentials-form happy path (returns `kind: "credentials-form"` with form schema, emits `auth-initiated` only); `service-config-missing` propagation; correlation store population; retry path (re-auth for an existing datasourceId)
- [ ] 9.2 Implement the real handler. Wire it through `buildCommandHandlers` deps: add `correlationStore: AuthCorrelationStore`, `configStore: ServiceConfigStore`, `factory: ClientFactory`, `engineBus: EngineEventBus`, `loopbackBroker: OAuthLoopbackBroker`. For OAuth providers, calls `factory.createForAuth(providerId, configStore.getOAuthAppConfig(providerId), { bus: engineBus, credentialStore })` then `client.authenticate()` then `correlationStore.create(intent)` then `loopbackBroker.start({correlationId, providerId, datasourceId, intent})`. For credentials-form, calls `factory.createForAuth(providerId, null, ...)` and returns the form schema.
- [ ] 9.3 Update `bootstrap.ts` to thread the new deps into `buildCommandHandlers`
- [ ] 9.4 Run the test file → all green

## 10. Service — real `handleAuthenticateComplete`

- [ ] 10.1 Replace the stub. Write failing tests covering: credentials-form happy path (consumes correlation, runs `intent.submit(values)`, emits `credential-persisted` + `auth-completed`); `correlation-expired` returns the typed error; `intent-kind-mismatch` returns the typed error (e.g., a credentials-form completion arrives for an oauth-kind intent); engine `submit` rejection emits `auth-failed`
- [ ] 10.2 Implement the real handler. Note this handler is invoked ONLY for credentials-form completions — OAuth completions arrive via the loopback HTTP callback inside the broker, not via this command
- [ ] 10.3 Run the test file → all green

## 11. Service — `handleAuthenticateCancel`

- [ ] 11.1 Write failing tests in a new `authenticate-cancel.test.ts`: cancel during OAuth pending (consumes correlation, calls `broker.cancel`, emits `auth-cancelled`); cancel during credentials-form pending (consumes correlation, no broker call, emits `auth-cancelled`); idempotent cancel (second call is a no-op, emits no event); cancel of unknown correlationId (returns `{ok: true, result: { cancelled: false }}`, no event)
- [ ] 11.2 Implement `services/fs-sync/src/commands/authenticate-cancel.ts`
- [ ] 11.3 Wire into `buildCommandHandlers`; rerun test → green

## 12. Service — `handleGetConfig` / `handleSetConfig`

- [ ] 12.1 Write failing tests in `get-config.test.ts` / `set-config.test.ts`: get-config when file is absent returns the empty default shape; round-trip set-config + get-config; set-config writes 0o600 on Unix
- [ ] 12.2 Implement the two handlers in `services/fs-sync/src/commands/get-config.ts` and `set-config.ts`
- [ ] 12.3 Wire into `buildCommandHandlers`; rerun → green

## 13. Service — `handleDeleteCredentials`

- [ ] 13.1 Write failing tests in `delete-credentials.test.ts`: delete-when-present (returns `deleted: true`, calls `credentialStore.delete`); delete-when-absent (returns `deleted: false`, no error); delete throws → handler logs structured warning, returns `{ok: true, deleted: false}`
- [ ] 13.2 Implement `services/fs-sync/src/commands/delete-credentials.ts`
- [ ] 13.3 Wire into `buildCommandHandlers`; rerun → green

## 14. Service — bootstrap composition update + integration test

- [ ] 14.1 Extend `services/fs-sync/src/main/__tests__/bootstrap.test.ts` order assertion to include the two new stages (`construct-service-config-store` and `construct-loopback-broker`)
- [ ] 14.2 Run the order-assertion test → green
- [ ] 14.3 Add an integration test (`services/fs-sync/src/__tests__/authenticate-flow.integration.test.ts`) that boots a full service runtime against scratch dirs, sends `sync:authenticate-start { providerId: "google-drive" }` through a real IPC client, asserts the response carries a correlationId + `kind: "oauth"`, asserts the bus emits `oauth-open-url` + `auth-initiated`, then calls `sync:authenticate-cancel { correlationId }` and asserts `auth-cancelled` fires
- [ ] 14.4 Same integration test, separate arm: credentials-form flow for `amazon-s3` → start → complete with valid stub values → assert `credential-persisted` + `auth-completed`; assert `credentials.json` contains a new entry for the minted datasourceId

## 15. Service — SIGINT shutdown cancels active OAuth sessions

- [ ] 15.1 Extend `signals.test.ts` to cover: service has one active OAuth session; SIGINT fires; broker.dispose runs before process exit; loopback HTTP server is no longer listening
- [ ] 15.2 Update `services/fs-sync/src/main/signals.ts` to call `broker.dispose()` during shutdown
- [ ] 15.3 Rerun the test → green

## 16. Desktop main — bridge subscriptions for `oauth-open-url` + `credential-persisted`

- [ ] 16.1 Write failing tests in `apps/desktop/src/main/sync/event-bridge.auth.test.ts`: bridge subscribes to `oauth-open-url`; on event fire, calls injected `shell.openExternal(authorizeUrl)` exactly once; renderer-window subscriber is NOT called for the bridge-only event
- [ ] 16.2 Same shape for `credential-persisted`: bridge calls injected `registry.add(summary)` exactly once; renderer-window subscriber is NOT called
- [ ] 16.3 Same shape for forwarded events: `auth-completed` event reaches the renderer-window subscriber unchanged; bridge does NOT separately call `registry.add` (the paired `credential-persisted` event handles that)
- [ ] 16.4 Implement the new subscriptions in `apps/desktop/src/main/sync/event-bridge.ts`. Inject `shell.openExternal` at construction time so tests can stub. Filter `oauth-open-url` and `credential-persisted` out of the renderer-bound forward
- [ ] 16.5 Rerun → all green

## 17. Desktop main — idempotent `registry.add`

- [ ] 17.1 Write failing tests in `apps/desktop/src/main/datasources/__tests__/registry-idempotent.test.ts`: calling `registry.add` twice with the same `id` does NOT throw; the second call updates `display_name` / `status` / `error_kind` if they differ; `created_at` is preserved (only `updated_at` advances)
- [ ] 17.2 Modify `apps/desktop/src/main/datasources/registry.ts` `insertStmt` to use `INSERT INTO datasources ... ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, status=excluded.status, error_reason=excluded.error_reason, error_kind=excluded.error_kind, updated_at=?`
- [ ] 17.3 Rerun → green; rerun the existing `registry.test.ts` to confirm no regressions on first-insert semantics

## 18. Desktop main — delete `consent-broker.ts` + tests

- [ ] 18.1 Delete `apps/desktop/src/main/oauth/consent-broker.ts`
- [ ] 18.2 Delete `apps/desktop/src/main/oauth/__tests__/consent-broker.test.ts`, `consent-broker-dev-override.test.ts`, and any other consent-broker-* test files
- [ ] 18.3 Delete the `noopCredentialStore` declaration in `apps/desktop/src/main/index.ts` (lines 280-284 today) and the `createOAuthConsentBroker(...)` block (lines 288-319) and the `broker.dispose()` cleanup wiring (line 320)
- [ ] 18.4 Delete the broker-related imports from `apps/desktop/src/main/index.ts` (`createOAuthConsentBroker`, `randomBytes`, `readFileSync`, `path` if otherwise unused, `__FT5_GOOGLE_OAUTH_CLIENT_ID__` / `_SECRET__` references)
- [ ] 18.5 Update `electron.vite.config.ts` to drop the `__FT5_GOOGLE_OAUTH_CLIENT_ID__` / `_SECRET__` `define` entries
- [ ] 18.6 Run the full desktop main test suite — typecheck + vitest. Anything that imported from `oauth/consent-broker` must now be deleted or migrated; expect compile errors that mark the next deletion targets

## 19. Desktop main — delete `datasources:start-consent` / `cancel-consent` IPC handlers

- [ ] 19.1 Delete `apps/desktop/src/main/ipc/datasources/start-consent.ts` and `cancel-consent.ts`
- [ ] 19.2 Delete the corresponding test files
- [ ] 19.3 Update `apps/desktop/src/main/ipc/index.ts` to remove the `ipcMain.handle` registrations for these channels and remove the `broker` constructor argument from `registerIpcHandlers`
- [ ] 19.4 Update `apps/desktop/src/preload/index.ts` to remove the `startConsent` and `cancelConsent` `contextBridge` exposures
- [ ] 19.5 Update `apps/desktop/src/renderer/src/lib/api.d.ts` (or wherever the `window.api.datasources` type lives) to remove the methods
- [ ] 19.6 Run typecheck → expect compile errors at every renderer call site of `window.api.datasources.startConsent` / `cancelConsent`; collect the list (will be addressed in Phase 22+)

## 20. Desktop main — `datasources:remove` calls `sync:delete-credentials`

- [ ] 20.1 Write failing tests in `apps/desktop/src/main/ipc/datasources/__tests__/remove.test.ts`: when `datasources:remove` is invoked, the desktop calls `syncClient.deleteCredentials({datasourceId})` exactly once after `registry.remove` succeeds; `deleteCredentials` rejection logs a structured warning but does NOT block the local remove from succeeding (best-effort cleanup per spec)
- [ ] 20.2 Modify `apps/desktop/src/main/ipc/datasources/remove.ts` to call `getSyncClient().deleteCredentials({datasourceId})` after `registry.remove`
- [ ] 20.3 Add `deleteCredentials` method to `apps/desktop/src/main/sync/client.ts` (parallel to existing `authenticateStart`/`authenticateComplete`)
- [ ] 20.4 Rerun → green

## 21. Renderer — `useAuthSession` hook (replaces `useConsentSession`)

- [ ] 21.1 Write failing tests in `apps/desktop/src/renderer/src/features/datasources/__tests__/use-auth-session.test.tsx`: hook returns `{status: "pending"}` initially; transitions to `completed` on matching `auth-completed` event delivered via `window.api.sync.onEvent`; ignores events for other correlationIds; transitions to `cancelled` / `failed` / `timeout` on the corresponding events; status carries `tag` and `message` for `failed` (including `service-config-missing`)
- [ ] 21.2 Implement `useAuthSession(correlationId)` hook in `apps/desktop/src/renderer/src/features/datasources/store.tsx` (or a sibling `use-auth-session.ts`); subscribe via `window.api.sync.onEvent` exactly once per correlation; filter by `event.correlationId === correlationId`
- [ ] 21.3 Rerun → green
- [ ] 21.4 Update the store's existing reducer/state slice if needed to track `auth-*` events; remove the `consent-*` event slice
- [ ] 21.5 Delete `useConsentSession` export and any internal consent-session state once no consumer remains (Phase 22+ deletes the consumers)

## 22. Renderer — `oauth-form.tsx` migration

- [ ] 22.1 Write failing tests in `apps/desktop/src/renderer/src/features/datasources/__tests__/oauth-form.test.tsx` (rewrite the existing file): form mount calls nothing; clicking Connect calls `window.api.sync.authenticateStart({providerId})` exactly once; the returned `correlationId` is recorded; subscription via `useAuthSession(correlationId)` reflects `auth-completed` → form calls `onSubmit({_authCompleted: "completed", datasourceId})` (or rename the sentinel); `auth-cancelled` / `auth-failed` / `auth-timeout` show inline copy with Retry; dialog unmount calls `window.api.sync.authenticateCancel({correlationId})` exactly once
- [ ] 22.2 Add the `service-config-missing` arm: when `auth-failed { tag: "service-config-missing", path }` arrives, the form renders the inline copy with `<code>{path}</code>` and the README pointer
- [ ] 22.3 Rewrite `apps/desktop/src/renderer/src/features/datasources/credential-forms/oauth-form.tsx` to use `useAuthSession`, call `window.api.sync.authenticateStart`, etc.
- [ ] 22.4 Rerun → green

## 23. Renderer — `aws-access-key-form.tsx` + `custom-form.tsx` migration

- [ ] 23.1 Write failing tests in `apps/desktop/src/renderer/src/features/datasources/__tests__/aws-access-key-form.test.tsx` (new file): form mount calls nothing; clicking Connect with valid values calls `window.api.sync.authenticateStart({providerId: "amazon-s3"})` exactly once; the response's `formSchema` populates the field set; submit calls `window.api.sync.authenticateComplete({correlationId, completion: {kind: "credentials-form", values}})` exactly once; on `ok: true` the form's `onSubmit` fires; on `ok: false` an inline error renders
- [ ] 23.2 Rewrite `aws-access-key-form.tsx` to use the two-step authenticate flow; remove `actions.add` calls
- [ ] 23.3 Repeat 23.1/23.2 for `custom-form.tsx`
- [ ] 23.4 Rerun → all green

## 24. Renderer — `add-dialog.tsx` adjustments

- [ ] 24.1 Update `apps/desktop/src/renderer/src/features/datasources/__tests__/add-dialog.test.tsx`: the OAuth-completion sentinel handling in `handleCredentialsSubmit` now consumes `_authCompleted` (renamed from `_oauthConsent`); successful authenticate calls `actions.refresh()` and closes the dialog; non-OAuth path no longer goes through `actions.add` — the form itself drives `sync.authenticateComplete` and signals via the same sentinel
- [ ] 24.2 Update `add-dialog.tsx` accordingly
- [ ] 24.3 Update `add-dialog-extensibility.test.tsx` if its provider-id-branch grep expectations change
- [ ] 24.4 Rerun → green

## 25. Renderer — `<AuthErrorBanner>` Reconnect path migration

- [ ] 25.1 Update `apps/desktop/src/renderer/src/features/datasources/__tests__/card-auth-error-banner.test.tsx`: Reconnect button click calls `window.api.sync.authenticateStart({providerId, datasourceId})` (NOT `datasources.startConsent`); `useAuthSession(correlationId)` drives the disabled / "Connecting…" state and the eventual unmount
- [ ] 25.2 Update `apps/desktop/src/renderer/src/features/datasources/card.tsx` (the `<AuthErrorBanner>` component definition) accordingly
- [ ] 25.3 Rerun → green

## 26. Renderer — `<InvalidDatasourceBanner>` Reconnect path migration

- [ ] 26.1 Update `apps/desktop/src/renderer/src/features/datasources/__tests__/card-invalid-datasource-banner.test.tsx`: Reconnect calls `sync.authenticateStart`; Remove confirmation triggers `datasources:remove` AND the desktop main now also calls `sync:delete-credentials` (assertion lives at the main-process layer, see Phase 20)
- [ ] 26.2 Update `apps/desktop/src/renderer/src/features/datasources/card.tsx` and `confirm-remove-dialog.tsx` if any path branches on the now-removed `consent-*` events
- [ ] 26.3 Rerun → green

## 27. Renderer — `<InvalidDatasourceState>` (file-explorer) Reconnect path

- [ ] 27.1 Update `apps/desktop/src/renderer/src/features/file-explorer/states/__tests__/invalid-datasource.test.tsx`: Reconnect calls `sync.authenticateStart`; `useAuthSession` drives the lifecycle; on `auth-completed` the state's `onReconnectSucceeded` fires which triggers `store.retryLoad()`
- [ ] 27.2 Update `apps/desktop/src/renderer/src/features/file-explorer/states/invalid-datasource.tsx` accordingly
- [ ] 27.3 Update the composite test at `apps/desktop/src/renderer/src/features/file-explorer/__tests__/file-explorer-composite.test.tsx` for the equivalent Reconnect arm
- [ ] 27.4 Rerun → green

## 28. Renderer — store-consent → store-auth migration

- [ ] 28.1 Rename `store-consent.test.tsx` → `store-auth.test.tsx`; update test assertions to use `auth-*` event names and `sync.onEvent` mocks instead of `consent-*` and `datasources.onEvent`
- [ ] 28.2 Update the corresponding store slice in `apps/desktop/src/renderer/src/features/datasources/store.tsx` to consume from sync stream
- [ ] 28.3 Rerun → green

## 29. Renderer — verify `consent-` is unreferenced in production code

- [ ] 29.1 Add a Vitest grep test (`apps/desktop/src/renderer/src/__tests__/no-consent-references.test.ts`) that scans all `.ts` / `.tsx` under `apps/desktop/src/renderer/src/` and asserts no non-test file contains the literal `consent-`, `useConsentSession`, or `datasources.startConsent`
- [ ] 29.2 Fix any leftover references the test surfaces; rerun → green

## 30. Repo + docs — `README.md` per-provider OAuth registration section

- [ ] 30.1 Add a new top-level section to `README.md` titled "Provider OAuth registration (one-time setup)"
- [ ] 30.2 Subsection "Google Drive": step-by-step for GCP Console → APIs & Services → Credentials → Create OAuth client ID → Desktop application; enable Google Drive API; configure consent screen; record `client_id` and `client_secret`
- [ ] 30.3 Subsection "OneDrive": step-by-step for Azure Portal → App registrations → New registration → Mobile and desktop application platform; configure Microsoft Graph permissions for Files.ReadWrite; record `client_id` and `client_secret`
- [ ] 30.4 Subsection "Configure the service": `cp services/fs-sync/config.example.json ~/ft5/sync_app/config.json` (Linux/macOS) or equivalent on Windows; edit the file to populate `clientId`/`clientSecret` for each provider intended to be used
- [ ] 30.5 Cross-link from the existing `README.md` "Google Drive datasource setup (dev only)" section so users on the legacy `.env.local` path know where the workflow has moved

## 31. Repo + docs — supersede `.env.local` build-time inlining

- [ ] 31.1 Edit the existing `apps/desktop/.env.example` to mark `FT5_GOOGLE_OAUTH_CLIENT_ID` and `FT5_GOOGLE_OAUTH_CLIENT_SECRET` as deprecated/unused. Either delete them with a comment line referencing the new service config path, or leave them with a `# DEPRECATED — see services/fs-sync/config.example.json` note
- [ ] 31.2 If GitHub Actions still references the secrets in any workflow YAML, update / remove those references; if no other consumer exists, the secrets become unused and the README OAuth-registration steps point to the new config file

## 32. Verification — typecheck + lint + full test suite

- [ ] 32.1 Subagent dispatch (background): `pnpm -w typecheck` from worktree root; collect output
- [ ] 32.2 Subagent dispatch (background): `pnpm -w lint`; collect output
- [ ] 32.3 Subagent dispatch (background): `pnpm -w test` (full vitest suite); collect output. Use the long-running override per CLAUDE.md if the runaway-system-reminder bug surfaces
- [ ] 32.4 Triage every failure; fix in worktree; rerun until all three green
- [ ] 32.5 Run `openspec validate implement-datasource-onboarding` from worktree → must be green before declaring complete

## 33. Verification — manual smoke (PENDING_TC unblocks)

- [ ] 33.1 With `services/fs-sync/config.example.json` copied to `~/ft5/sync_app/config.json` and populated with real GCP credentials (per `add-drive-oauth-browser-consent §1` HUMAN ops), run `pnpm -F @ft5/desktop dev`. Click Add Datasource → Google Drive → Connect. Browser opens to Google consent. Complete consent. Dialog auto-closes. Card materialises in the dashboard
- [ ] 33.2 With the card present, click Explore. The file-explorer renders the Drive root entries (no "Failed to load: no credentials registered…" — the §12.1 PENDING_TC entry is unblocked)
- [ ] 33.3 In Google Account → Security → Third-party apps, revoke the OAuth grant. Wait for the card to flip to error state with the `auth-revoked` banner. Click Reconnect. Browser opens. Complete consent. Card returns to `connected` (§12.2 PENDING_TC unblocked)
- [ ] 33.4 Manually delete the card's credential entry from `~/ft5/sync_app/credentials.json`. Open Explore for that card. The `<InvalidDatasourceState>` renders. Click Reconnect → consent → entries appear (§13.1 PENDING_TC unblocked)
- [ ] 33.5 Add a card, manually corrupt its credential JSON (set `accessToken: ""`). Open Explore. The state renders. Click Remove → confirm → card unmounts AND `~/ft5/sync_app/credentials.json` no longer contains an entry for that id (§13.2 PENDING_TC unblocked, also verifies the new `sync:delete-credentials` cleanup path)
- [ ] 33.6 Add a misconfigured card (delete credentials). Open the dashboard WITHOUT entering Explore. The `<InvalidDatasourceBanner>` renders. Click Reconnect → consent → banner unmounts (§13.3 PENDING_TC unblocked)
- [ ] 33.7 Repeat the §12.3 cancel-mid-consent and §12.4 5-min-timeout PENDING_TC entries (these were testable already once `add-drive-oauth-browser-consent §1` was done — confirm the new event names don't regress them)

## 34. Pre-archive

- [ ] 34.1 Confirm every checkbox above is checked
- [ ] 34.2 Confirm `openspec validate implement-datasource-onboarding` is green
- [ ] 34.3 Confirm full test suite + typecheck + lint are green (re-run if any task in §29-§33 surfaced regressions)
- [ ] 34.4 Run advisor checkpoint per CLAUDE.md "Coding discipline" — make deliverable durable (push the worktree branch) BEFORE the call
- [ ] 34.5 Use the `superpowers:finishing-a-development-branch` skill to wrap up
- [ ] 34.6 Run `/opsx:archive implement-datasource-onboarding` in the worktree branch BEFORE merging to master
- [ ] 34.7 Update `MEMORY.md` (auto-memory) with the change-state entry following the existing convention

## Deferred follow-up — NOT in this change

The following work is intentionally out of scope for this change and will land in
the follow-up `move-datasource-registry-to-service`:

- Migrate the `datasources` SQLite table from the desktop DB to `sync.db`
- Migrate `datasources:list` / `datasources:add` / `datasources:remove` / `datasources:action` IPC commands to the `sync:*` namespace
- Reduce or remove the desktop `getEngine()` singleton
- Switch the renderer's datasource-list subscription source from `datasources:event` to `sync:event`
- Close the orphan-credentials window structurally — once the desktop fetches the registry fresh from the service on every startup, the transitional window per Risks §1 in design.md disappears. No replay buffer is built in this change.

The following work is intentionally out of scope and will land in the follow-up
`migrate-credentials-to-sqlite`:

- Replace `ConfigFileCredentialStore` (`~/ft5/sync_app/credentials.json` plaintext JSON) with `SqliteCredentialStore` (a `credentials` table in `sync.db`)
- New schema migration in `sync.db` for the `credentials` table
- Spec rework on `fs-sync-service` capability: REMOVE the existing `ConfigFileCredentialStore` requirement + the credential-file permission-widening requirement; ADD the equivalent `SqliteCredentialStore` requirement
- Decision on the `FT5_DEV_CREDENTIALS=1` dev-override path under SQLite (read from `dev/credentials.json` and seed the SQLite table on boot, or drop the override entirely)

This split keeps the `sync:delete-credentials` handler interface store-agnostic in
this change — the IPC contract and handler shape stay identical when the store
implementation flips in the follow-up.

The following work is intentionally out of scope for other separate follow-ups:

- Layer 2 (toast) and Layer 3 (dashboard banner) error notification surfaces for service-config-missing
- An in-app settings UI consuming `sync:get-config` / `sync:set-config` to edit OAuth app config from inside the app
- Encrypted-at-rest storage for OAuth app config or per-user credentials (`SqliteCredentialStore` + SQLCipher would be the natural successor once the SQLite migration ships)
