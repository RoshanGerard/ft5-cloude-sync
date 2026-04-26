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
- [x] 2.3 Write a unit test for `GoogleDriveClient` accepting a `preAuth?: PreAuthConfig` constructor parameter and reading `clientId`/`clientSecret`/`redirectUri` from it at `doAuthenticateImpl` time when present (`packages/fs-datasource-engine/src/strategies/__tests__/googledrive-preauth.test.ts`); current test reads from `creds.authResult.meta` so the new test fails
- [x] 2.4 Adapt `GoogleDriveClient` to accept and consult the new `preAuth` slot; existing `meta`-reading code path stays for backward compatibility during the transition (deletion of the `meta` path covered later by §22.x)
- [x] 2.5 Repeat 2.3/2.4 for `OneDriveClient` (`onedrive-preauth.test.ts` + adaptation in `onedrive-client.ts`)
- [x] 2.6 Write a unit test for `S3Client` accepting `preAuth: null` constructor param without errors; existing credentials-form intent path stays unchanged
- [x] 2.7 Adapt `S3Client` to accept `preAuth` (no-op for credentials-form providers); rerun test → green

## 3. Engine — `factory.createForAuth(providerId, oauthAppConfig, ctx)`

- [x] 3.1 Write a unit test for `ClientFactory.createForAuth("google-drive", oauthAppConfig, ctx)` returning a `GoogleDriveClient` whose `authenticate()` produces an OAuthIntent with the expected authorize URL parameters (`packages/fs-datasource-engine/src/__tests__/factory-create-for-auth.test.ts`); test fails because `createForAuth` does not yet exist
- [x] 3.2 Write the same shape for `createForAuth("amazon-s3", null, ctx)` returning an `S3Client` whose `authenticate()` produces a `CredentialsFormIntent`
- [x] 3.3 Write rejection tests: OAuth provider with `null` config → throws `DatasourceError(invalid-datasource)`; credentials-form provider with non-null config → throws same; unknown providerId → throws same
- [x] 3.4 Implement `createForAuth` in `packages/fs-datasource-engine/src/factory.ts`; dispatch on `providerId` via the existing `ProviderRegistry`; thread `oauthAppConfig` into the strategy constructor's new `preAuth` slot
- [x] 3.5 Extend the registry entry shape so each entry declares whether it is OAuth-class or credentials-form-class; `createForAuth` validates the `oauthAppConfig` argument against the declaration
- [x] 3.6 Rerun the engine package's full vitest suite → all green (240 tests, 16 files); existing `factory.create` tests pass unchanged. Final factory signature: `createForAuth(providerId, oauthAppConfig, ctx, datasourceId?)` — optional `datasourceId` mints a `pre-auth-${randomUUID()}` when omitted; reconnect flows pass through their existing id. Registry entry gained `createForAuth: PreAuthFactoryFn<P>` + `authKind: "oauth" | "credentials-form"`. S3 placeholder creds: AWS SDK validates `region` at construction so the placeholder uses `"us-east-1"` (unused — `submit()` builds its own AWS client from user-typed values).

## 4. Contracts — new wire commands

- [x] 4.1 Write a typed test asserting `SyncAuthenticateStartRequest`, `SyncAuthenticateStartResponse` are present in `@ft5/ipc-contracts/sync-service`; the response is the discriminated union `{ ok: true, result: { correlationId, kind: "oauth" } | { correlationId, kind: "credentials-form", formSchema } } | { ok: false, error: SyncAuthenticateStartError }` per design.md Decision 9; test fails until the union shape is in (added `authenticate-onboarding.test-d.ts`; tsc errored on missing `ServiceConfig`/`SyncAuthenticate*Error` exports + missing CommandMap entries)
- [x] 4.2 Update the contract types in `packages/ipc-contracts/src/sync-service/commands.ts` to match; rerun typed test → green (`SyncAuthenticateStartError` union: `service-config-missing` + `unknown-provider` + `engine-error`; `not-implemented` removed; old single-shot `sync:authenticate` retired entirely from CommandMap and COMMAND_NAMES)
- [x] 4.3 Repeat 4.1/4.2 for `SyncAuthenticateCompleteRequest/Response` (`{ correlationId, completion: { kind: "credentials-form", values } }` shape only — OAuth completion runs inside the service) (`SyncAuthenticateCompleteError`: `correlation-expired`, `intent-kind-mismatch`, `engine-error`; result is `{ datasourceId, summary }`; old `correlation-kind-mismatch` tag renamed to `intent-kind-mismatch` per spec)
- [x] 4.4 Write/extend the typed test for `SyncAuthenticateCancelRequest/Response` (`{ correlationId }` → `{ ok: true, result: { cancelled: boolean } } | { ok: false, error }`); add the contract types and the `COMMAND_NAMES` enum entry; rerun → green (`SyncAuthenticateCancelError`: `correlation-not-found` only; cancel is otherwise idempotent)
- [x] 4.5 Write/extend typed tests for `SyncGetConfigRequest/Response` and `SyncSetConfigRequest/Response`; add to contract types + `COMMAND_NAMES`; rerun → green (`ServiceConfig = { schemaVersion: 1, providers: Partial<Record<ProviderId, { clientId, clientSecret }>> }`)
- [x] 4.6 Write/extend typed tests for `SyncDeleteCredentialsRequest/Response`; add to contract types + `COMMAND_NAMES`; rerun → green
- [x] 4.7 Verify `COMMAND_NAMES` exhaustive test (`packages/ipc-contracts/src/__tests__/...`) catches the new entries; assert old `sync:authenticate` is absent (per Modified Requirement "IPC command surface") (updated existing `commands.test-d.ts` Expected union; added explicit absence-assertion in `authenticate-onboarding.test-d.ts`)

## 5. Contracts — new event taxonomy + remove `consent-*` variants

- [x] 5.1 Write a typed test asserting `SyncEvent` (the service event union) contains `auth-initiated`, `auth-completed`, `auth-cancelled`, `auth-failed`, `auth-timeout`, `oauth-open-url`, `credential-persisted` variants with their payload shapes per design.md Decision 7; test fails until shapes are in (added `auth-events.test-d.ts` — tsc errored on missing payload-type exports + missing `EventPayloadMap` keys)
- [x] 5.2 Add the variants to `packages/ipc-contracts/src/sync-service/events.ts` (or wherever the existing `SyncEvent` union lives); rerun typed test → green (added `AuthInitiated/Completed/Cancelled/Failed/Timeout/OAuthOpenUrl/CredentialPersistedPayload` types + `AuthFailedTag` union; the wire `ServiceEvent` is keyed by `name` per existing convention; existing `events.test-d.ts` exhaustive Expected union updated)
- [x] 5.3 Write a typed test asserting `DatasourceEvent` does NOT contain `consent-*` variants; test fails because the variants are still there (added `consent-removed.test-d.ts` asserting `DATASOURCES_CHANNELS` excludes `startConsent`/`cancelConsent` at type + runtime level; the spec wording mentioned `DatasourceEvent` but the actual consent-* variants were on a separate `ConsentEvent` union — this test asserts both paths are gone)
- [x] 5.4 Remove the `consent-*` variants from `DatasourceEvent` in `packages/ipc-contracts/src/datasources.ts`; remove the `DatasourcesStartConsentRequest/Response`, `DatasourcesCancelConsentRequest/Response` types; remove the `startConsent` and `cancelConsent` keys from `DATASOURCES_CHANNELS`; rerun → green (also removed re-exports from top-level `index.ts`; updated existing `datasources.test-d.ts` channel-list assertions; pruned the consent-event describe blocks)
- [x] 5.5 Write a typed test asserting `SyncAuthenticateStartError` includes `service-config-missing` variant with `path`/`providerId` fields; add to the union if missing; rerun → green (covered by `authenticate-onboarding.test-d.ts` "error union exposes service-config-missing" — already in from §4.2)
- [x] 5.6 Write a typed test asserting the `not-implemented` variant is absent from `SyncAuthenticateStartError` AND `SyncAuthenticateCompleteError`; remove the variant from both unions; rerun → green (covered by `authenticate-onboarding.test-d.ts` "error union does NOT contain the retired not-implemented variant" assertions for both unions — already in from §4.2 + §4.3)
- [x] 5.7 Run the full ipc-contracts package test suite; verify no regressions (40 test files, 397 tests green; 11 unhandled errors are downstream consumers in `apps/desktop/src/preload/` that import the deleted types — to be fixed in §19/§22 per scope)

## 6. Service — `ServiceConfigStore`

- [x] 6.1 Write unit tests for `ServiceConfigStore` (`services/fs-sync/src/config/__tests__/service-config-store.test.ts`): `getOAuthAppConfig` happy path, missing-file error, missing-provider-entry error, empty-clientId error, empty-clientSecret error, `getRaw`/`setRaw` round-trip, atomic write (mode 0o600 on Unix) — 10 tests; added unparseable-file scenario + `getRaw` empty-default-when-absent scenario per advisor guidance for §12 forward-compat
- [x] 6.2 Implement `services/fs-sync/src/config/service-config-store.ts` to pass the tests; reuse the atomic-write pattern from `ConfigFileCredentialStore` (write-to-tmp + rename + chmod 0o600). Permission-widening read check intentionally omitted — OAuth app secrets are documented v1 plaintext (Risks §2) and the operator-edit workflow makes widened-mode reads expected
- [x] 6.3 Define `ServiceConfigMissingError` class with `path` (absolute) and `providerId` fields; constructor takes a third `reason` argument that disambiguates the four failure modes for service-side diagnostics (file absent, file unparseable, provider entry absent, provider entry has empty fields). Only `path` and `providerId` cross the wire per the contract
- [x] 6.4 Wire `ServiceConfigStore` into `services/fs-sync/src/main/bootstrap.ts` (new bootstrap stage `construct-service-config-store` between `construct-credential-store` and `construct-provider-registry`); `BootstrapStage` union and order-assertion test updated; `BootstrapOptions.configPath?` added so tests can scope to a scratch dir; `Runtime.serviceConfigStore` added so §9 authenticate-start handler can reach the same instance bootstrap composed
- [x] 6.5 Add a path-resolver function `resolveServiceConfigPath` parallel to the existing `resolveCredentialsPath` in `services/fs-sync/src/env/paths.ts`; tests confirm the path is `<dataDir>/config.json` for both prod and dev (the dataDir override differentiates the two)

## 7. Service — committed `config.example.json` template

- [x] 7.1 Write a test that reads `services/fs-sync/config.example.json` from the repo and asserts it is valid JSON with `schemaVersion: 1` and a `providers` object containing `google-drive` and `onedrive` keys (both with empty-string `clientId`/`clientSecret`) (test at `services/fs-sync/src/__tests__/config-example-template.test.ts` — 4 cases including amazon-s3-absent assertion)
- [x] 7.2 Create `services/fs-sync/config.example.json` matching the schema; commit (clientId + clientSecret only for google-drive + onedrive; amazon-s3 intentionally absent — access-key auth, no OAuth registration)
- [x] 7.3 Confirm `.gitignore` does NOT exclude the example file (verified — `git check-ignore` exit 1 = not ignored)

## 8. Service — `OAuthLoopbackBroker` (port from desktop)

- [x] 8.1 Copy `apps/desktop/src/main/oauth/__tests__/consent-broker.test.ts` to `services/fs-sync/src/oauth/__tests__/loopback-broker.test.ts`; rename `OAuthConsentBroker` → `OAuthLoopbackBroker`, `sessionId` → `correlationId`, `consent-*` event names → `auth-*` / `oauth-open-url` / `credential-persisted` per design.md Decision 7. Run the suite — every test fails (file does not exist yet)
- [x] 8.2 Repeat for `consent-broker-dev-override.test.ts` → `loopback-broker-dev-override.test.ts`
- [x] 8.3 Implement `services/fs-sync/src/oauth/loopback-broker.ts` to pass the ported tests. Surface differences from the desktop original:
  - keys on `correlationId` (not `sessionId`)
  - emits service events (`oauth-open-url`, `auth-completed`, `credential-persisted`, `auth-cancelled`, `auth-failed`, `auth-timeout`) via the engine bus
  - consults the engine's existing `ConfigFileCredentialStore` directly (no `noopCredentialStore`)
  - reads `clientId`/`clientSecret` from a `ServiceConfigStore` injection (no build-time constants)
  - dev-override reads `<dataDir>/dev-credentials.json` (service path, not Electron userData)
- [x] 8.4 Implement `OAuthLoopbackBroker.dispose()` to close every active session's HTTP server + clear every timer (used by SIGINT shutdown per fs-sync-service Modified Requirement "Service bootstrap composes the full runtime")
- [x] 8.5 Run the broker test file standalone; all green

## 9. Service — real `handleAuthenticateStart`

- [x] 9.1 Replace the stub at `services/fs-sync/src/commands/authenticate-start.ts` — first write the real implementation's failing tests in `authenticate-start.test.ts`. Covered: OAuth-class happy path (returns `kind: "oauth"`, broker dispatch); credentials-form happy path (returns `kind: "credentials-form"` with form schema, emits `auth-initiated`); `service-config-missing` propagation; reconnect-via-datasourceId path; unknown-provider mapping; engine-error mapping
- [x] 9.2 Implement the real handler at `services/fs-sync/src/commands/authenticate-start.ts` (factory function `makeAuthenticateStartHandler`). Deps: `bus`, `correlationStore`, `factory`, `configStore`, `loopbackBroker`, `engineContext`. OAuth branch delegates the whole flow to the broker (broker resolves config, binds loopback, emits `auth-initiated` + `oauth-open-url` post-config-validation per design.md Decision 7 addendum). Credentials-form branch: `factory.createForAuth(providerId, null, ctx, datasourceId)` → `client.authenticate()` → `correlationStore.createWith(correlationId, intent)` → handler-side emit of `auth-initiated`
- [x] 9.3 Update `bootstrap.ts` to thread the new deps into `buildCommandHandlers` (done in handlers.ts + bootstrap.ts wiring commit)
- [x] 9.4 Run the test file → 7 new green; loopback-broker tests updated and 10 green; auth-correlation-store tests 14 green

## 10. Service — real `handleAuthenticateComplete`

- [x] 10.1 Replace the stub. Failing tests in `authenticate-complete.test.ts`: credentials-form happy path; correlation-expired; intent-kind-mismatch (oauth intent + credentials-form completion); engine submit rejection (auth-failed emitted, no credential-persisted)
- [x] 10.2 Implement at `services/fs-sync/src/commands/authenticate-complete.ts` (factory `makeAuthenticateCompleteHandler`). Reads `(datasourceId, providerId)` metadata from `correlationStore.consumeEntry(...)` (added to AuthCorrelationStore in this commit). Builds `DatasourceSummary` from providerId metadata. Engine's `decorateIntent` writes credentials via the strategy's injected store on `intent.submit(values)` resolution
- [x] 10.3 Run the test file → 4 new green; 42 total green across §9/§10 + broker + correlation-store

## 11. Service — `handleAuthenticateCancel`

- [x] 11.1 Failing tests in `authenticate-cancel.test.ts`: OAuth pending (broker.cancel called, broker emits auth-cancelled); credentials-form pending (handler emits auth-cancelled); idempotent (second cancel = `{cancelled: false}`, no event); unknown correlationId = `{cancelled: false}`, no event
- [x] 11.2 Implement at `services/fs-sync/src/commands/authenticate-cancel.ts` (factory `makeAuthenticateCancelHandler`). Handler is branch-agnostic: subscribes to `auth-cancelled` BEFORE calling `broker.cancel(...)` so it can detect whether the broker emitted (OAuth path) vs no-op (id unknown to broker), then tries `correlationStore.consume(...)` for the credentials-form path. Emits `auth-cancelled` only when the broker did not (mutual exclusion in production)
- [x] 11.3 Wire into `buildCommandHandlers` (done in handlers.ts + bootstrap.ts wiring commit)

## 12. Service — `handleGetConfig` / `handleSetConfig`

- [x] 12.1 Failing tests at `services/fs-sync/src/commands/{get-config,set-config}.test.ts`: get-config absent-file → empty default; round-trip set + get; set-config 0o600 on Unix; io-error propagation for both handlers
- [x] 12.2 Implement at `services/fs-sync/src/commands/{get-config,set-config}.ts` (factories `makeGetConfigHandler`, `makeSetConfigHandler`). Thin wrappers around `ServiceConfigStore.getRaw()` / `setRaw(...)`. Throws map to `{tag: "io-error", message}`
- [x] 12.3 Wire into `buildCommandHandlers` (done in handlers.ts + bootstrap.ts wiring commit)

## 13. Service — `handleDeleteCredentials`

- [x] 13.1 Failing tests at `services/fs-sync/src/commands/delete-credentials.test.ts`: delete-when-present → `{deleted: true}`; delete-when-absent → `{deleted: false}` and `delete` not called; delete-throws → structured warning `bridge-credential-delete-failed` + `{deleted: false}` (best-effort)
- [x] 13.2 Implement at `services/fs-sync/src/commands/delete-credentials.ts` (factory `makeDeleteCredentialsHandler`). Pre-checks via `credentialStore.get(...)` to distinguish deleted-vs-absent (engine `CredentialStore.delete` is `Promise<void>` per the port contract — kept that way to preserve the engine port's idempotent semantics)
- [x] 13.3 Wire into `buildCommandHandlers` (done in handlers.ts + bootstrap.ts wiring commit)

## 14. Service — bootstrap composition update + integration test

- [x] 14.1 Extend `services/fs-sync/src/main/bootstrap.test.ts` order assertion to include the two new stages (`construct-service-config-store` was added in §6.4; `construct-loopback-broker` added in this commit between `construct-network-probe` and `recover-running-jobs`). Test description updated from "11 bootstrap stages" → "13 bootstrap stages"
- [x] 14.2 Run the order-assertion test → green (covered by §14.1's bootstrap.test.ts update; 13-stage assertion already in place)
- [x] 14.3 Add an integration test (`services/fs-sync/src/__tests__/authenticate-flow.integration.test.ts`) that boots a full service runtime against scratch dirs, sends `sync:authenticate-start { providerId: "google-drive" }` through a real IPC client, asserts the response carries a correlationId + `kind: "oauth"`, asserts the bus emits `oauth-open-url` + `auth-initiated`, then calls `sync:authenticate-cancel { correlationId }` and asserts `auth-cancelled` fires (also covers the service-config-missing-no-event arm)
- [x] 14.4 Same integration test, separate arm: credentials-form flow for `amazon-s3` → start → complete with valid stub values → assert `credential-persisted` + `auth-completed`; assert `credentials.json` contains a new entry for the minted datasourceId. Required `vi.mock("@aws-sdk/client-s3", …)` so the `HeadBucket` verification at `intent.submit(values)` resolves locally; service package took a test-only devDep on `@aws-sdk/client-s3` (`^3.1032.0`, pinned to engine) so vitest's pnpm-strict module resolution finds the same path as the engine's import — without that, the mock silently no-ops. Test infrastructure note added to `design.md`.

## 15. Service — SIGINT shutdown cancels active OAuth sessions

- [x] 15.1 Extend `signals.test.ts` to cover: service has one active OAuth session; SIGINT fires; broker.dispose runs before process exit; loopback HTTP server is no longer listening (asserts (A) shutdown ≤5s, (B) `_getPendingSessionForTests` returns undefined post-dispose, (C) TCP connect to the formerly-bound port refused, (D) PID file removed)
- [x] 15.2 Update `services/fs-sync/src/main/signals.ts` to call `broker.dispose()` during shutdown (already wired: `signals.ts` calls `runtime.stop()` which disposes the broker FIRST per `bootstrap.ts:380`; no signals.ts edit needed)
- [x] 15.3 Rerun the test → green (full fs-sync-service suite: 322 pass / 0 fail / 9 skip / 0 type errors)

## 16. Desktop main — bridge subscriptions for `oauth-open-url` + `credential-persisted`

- [x] 16.1 Write failing tests in `apps/desktop/src/main/sync/event-bridge.auth.test.ts`: bridge subscribes to `oauth-open-url`; on event fire, calls injected `shell.openExternal(authorizeUrl)` exactly once; renderer-window subscriber is NOT called for the bridge-only event
- [x] 16.2 Same shape for `credential-persisted`: bridge calls injected `registry.add(summary)` exactly once; renderer-window subscriber is NOT called
- [x] 16.3 Same shape for forwarded events: `auth-completed` event reaches the renderer-window subscriber unchanged; bridge does NOT separately call `registry.add` (the paired `credential-persisted` event handles that)
- [x] 16.4 Implement the new subscriptions in `apps/desktop/src/main/sync/event-bridge.ts`. Inject `shell.openExternal` at construction time so tests can stub. Filter `oauth-open-url` and `credential-persisted` out of the renderer-bound forward (extended `BridgeRegistry` with `add(summary)`; extended `SyncEventBridgeDeps` with `openExternal?` injection seam; production defaults to Electron `shell.openExternal`. Both bridge-only events return early before the renderer broadcast; structured warning logged on `bridge-registry-add-failed` per Risks §1)
- [x] 16.5 Rerun → all green (3 new + 25 pre-existing event-bridge tests = 28 green)

## 17. Desktop main — idempotent `registry.add`

- [x] 17.1 Write failing tests in `apps/desktop/src/main/datasources/registry-idempotent.test.ts` (file lives as a sibling of `registry.test.ts` per local convention, not under a `__tests__/` subdir): calling `registry.add` twice with the same `id` does NOT throw; the second call updates `display_name` / `status` / `error_reason` / `error_kind` if they differ; `created_at` is preserved (only `updated_at` advances). All three failing on `UNIQUE constraint failed: datasources.id` as expected
- [x] 17.2 Modified `apps/desktop/src/main/datasources/registry.ts` `insertStmt` to `INSERT ... VALUES (...) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, status = excluded.status, error_reason = excluded.error_reason, error_kind = excluded.error_kind, updated_at = excluded.updated_at`. Columns deliberately NOT updated on conflict: `created_at` (audit stable), `paused` (user-set flag must survive re-emit), `item_count` / `last_sync_at` (real sync history must not regress to first-add defaults)
- [x] 17.3 Rerun → green: 3 new idempotent tests + 15 existing registry tests = 18 green

## 18. Desktop main — delete `consent-broker.ts` + tests

- [x] 18.1 Deleted `apps/desktop/src/main/oauth/consent-broker.ts`
- [x] 18.2 Deleted `apps/desktop/src/main/oauth/__tests__/consent-broker.test.ts` + `consent-broker-dev-override.test.ts`. Empty `__tests__/` and `oauth/` directories also removed
- [x] 18.3 Deleted from `apps/desktop/src/main/index.ts`: the `noopCredentialStore` declaration, the `createOAuthConsentBroker(...)` block, the `dev-credentials` path resolution + `isDevOverride` env-var check, and the second `window.on("closed", () => broker.dispose())` cleanup wiring (the existing first `closed` handler that disposes `eventBridge` + `syncEventBridge` is left untouched). Also dropped the `broker` argument from `registerIpcHandlers(window)`
- [x] 18.4 Deleted the broker-related imports from `apps/desktop/src/main/index.ts`: `createOAuthConsentBroker`, `randomBytes` (unused after removal), `readFileSync` (unused after removal), `CredentialStore` type-only import, and the two `__FT5_GOOGLE_OAUTH_CLIENT_ID__` / `_SECRET__` ambient declarations. `path` is retained — still used by renderer asset resolution + db path + service path
- [x] 18.5 Updated `apps/desktop/electron.vite.config.ts`: replaced the `loadEnv()` + clientId/clientSecret + non-development fail-fast block + `define: { __FT5_GOOGLE_OAUTH_*__ }` entries with a plain `defineConfig({...})` shell. Comment block at top now references `implement-datasource-onboarding §18.5` and points to the service-side config file (`~/ft5/sync_app/config.json`) per design.md Decision 4
- [x] 18.6 Ran main-process tests post-deletion: 58 tests green across event-bridge.* (28), datasources/registry* (18), datasources/remove (8), engine (4) suites. Renderer + preload + remaining ipc/datasources `consent` files DO still reference removed types — that's the §19 destruction and §21+ renderer migration scope

## 19. Desktop main — delete `datasources:start-consent` / `cancel-consent` IPC handlers

- [ ] 19.1 Delete `apps/desktop/src/main/ipc/datasources/start-consent.ts` and `cancel-consent.ts`
- [ ] 19.2 Delete the corresponding test files
- [ ] 19.3 Update `apps/desktop/src/main/ipc/index.ts` to remove the `ipcMain.handle` registrations for these channels and remove the `broker` constructor argument from `registerIpcHandlers`
- [ ] 19.4 Update `apps/desktop/src/preload/index.ts` to remove the `startConsent` and `cancelConsent` `contextBridge` exposures
- [ ] 19.5 Update `apps/desktop/src/renderer/src/lib/api.d.ts` (or wherever the `window.api.datasources` type lives) to remove the methods
- [ ] 19.6 Run typecheck → expect compile errors at every renderer call site of `window.api.datasources.startConsent` / `cancelConsent`; collect the list (will be addressed in Phase 22+)

## 20. Desktop main — `datasources:remove` calls `sync:delete-credentials`

- [x] 20.1 Extended `apps/desktop/src/main/ipc/datasources/__tests__/remove.test.ts` with 4 new TDD-red cases: (a) `deleteCredentials` called exactly once with `{datasourceId}`; (b) call ordering — `registry.remove` runs BEFORE `deleteCredentials`; (c) rejection logs a structured warning AND remove still resolves successfully (`{ok: true}`); (d) when registry.remove throws, deleteCredentials is NOT called
- [x] 20.2 Modified `apps/desktop/src/main/ipc/datasources/remove.ts` to call `client.deleteCredentials({datasourceId})` after `registry.remove`. The whole credential-cleanup branch (including `getSyncClient()` resolution) is wrapped in try/catch so a missing supervisor / disconnected client / IPC rejection never blocks the user-facing remove; structured warning logs the datasourceId + errorMessage. The handler signature accepts an optional `client` parameter (parallel to `handleSyncAuthenticateStart`) so tests inject without mocking the supervisor holder
- [x] 20.3 Added `deleteCredentials` method to `apps/desktop/src/main/sync/client.ts` mirroring the existing `authenticateStart`/`authenticateComplete` patterns. Documents the best-effort contract per design Decision 12 + Risks §1
- [x] 20.4 Rerun → green: 8 tests pass (4 pre-existing + 4 new) in remove.test.ts; 10 tests pass in client.typed-methods.test.ts (no regressions on the typed-method surface)

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
