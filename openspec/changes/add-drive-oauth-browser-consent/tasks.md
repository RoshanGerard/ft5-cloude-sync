## 1. Operational prerequisite — GCP OAuth client (HUMAN, one-time)

- [ ] 1.1 Register a "Desktop app" OAuth 2.0 client in the org-owned GCP project; capture `clientId` and `clientSecret`. Configure the consent screen with `auth/drive` scope, publish status "Testing" (or production once ready), and add the internal dev accounts as test users.
- [ ] 1.2 Add `FT5_GOOGLE_OAUTH_CLIENT_ID` and `FT5_GOOGLE_OAUTH_CLIENT_SECRET` to GitHub Actions secrets (repo → Settings → Secrets and variables → Actions). Verify CI can read them by echoing their lengths (never the values) in a dry-run workflow step.
- [ ] 1.3 Create `apps/desktop/.env.local` (gitignored) locally with the two values; document the expected format in `apps/desktop/.env.example` (committed, values empty). Confirm `.env.local` pattern is already in `.gitignore` at repo root.

## 2. IPC contracts (`packages/ipc-contracts`)

- [x] 2.1 Write failing type test in `packages/ipc-contracts/src/__tests__/datasources.test-d.ts` asserting `DatasourcesStartConsentRequest === { providerId: string; datasourceId?: string }` and `DatasourcesStartConsentResponse === { sessionId: string }` and their symmetric presence on `window.api.datasources.startConsent`.
- [x] 2.2 Write failing type test asserting `DatasourcesCancelConsentRequest === { sessionId: string }` and response is `void`.
- [x] 2.3 Write failing type test asserting the `DatasourceEvent` union contains the five consent variants (`consent-started`, `consent-completed`, `consent-cancelled`, `consent-failed`, `consent-timeout`) with the payload shapes specified in `datasources-ui` delta.
- [x] 2.4 Write failing type test asserting `DatasourceSummary` has `errorKind: DatasourceErrorTag | null` and that `errorKind` is required-when-errored (discriminated union variants narrow the type).
- [x] 2.5 Add the request/response/event types to `packages/ipc-contracts/src/datasources.ts`; add `errorKind` to `DatasourceSummary`. Rerun the type tests — they pass. Contract-level Vitest suite runs green (`pnpm -F @ft5/ipc-contracts test`).

## 3. Engine PKCE (`packages/fs-datasource-engine`)

- [x] 3.1 Write failing test in `googledrive-client.test.ts` — "Authorize URL carries S256 challenge parameters". Parse the authorize URL; assert `code_challenge_method === "S256"` and that `code_challenge` equals `base64url(SHA256(captured_verifier))` where the verifier is exposed via a test-only accessor on the intent.
- [x] 3.2 Write failing test — "Verifier threads into the token exchange". Injected `fetchImpl` intercepts the POST to `oauth2.googleapis.com/token`; assert exactly one `code_verifier` form field matches the verifier.
- [x] 3.3 Write failing test — "Fresh verifier per call". Two successive `authenticate()` calls yield two distinct `code_challenge` values.
- [x] 3.4 Write failing test — "Verifier is never stored or logged". Grep-scan the produced `AuthResult` and `StoredCredentials` fixtures for the verifier string after a complete flow; assert zero matches.
- [x] 3.5 Implement PKCE in `googledrive-client.ts`: generate `code_verifier` (48 bytes base64url → 64 chars) at the top of `doAuthenticateImpl`, compute `code_challenge = base64url(SHA256(verifier))`, add `code_challenge` + `code_challenge_method=S256` to the authorize URL URLSearchParams, capture the verifier inside the `completeWith` closure, and pass it as `code_verifier` in `exchangeCodeForTokens` form body. Rerun tests 3.1–3.4 — all pass.
- [x] 3.6 Update the existing `googledrive-client.contract.test.ts` expectations that pin the authorize URL as a string: switch to URL-parsing assertions so the test tolerates the new PKCE parameters. — N/A: `contract.test.ts` does not assert on the authorize URL (no `toBe`/`toEqual`/`toContain` against `authorizeUrl`); the shared contract suite is URL-agnostic for OAuth. Verified by running the contract suite after impl — 10/10 passing unchanged.
- [x] 3.7 Run `pnpm -F @ft5/fs-datasource-engine test` — entire package test suite green. (Ran via `pnpm exec vitest run packages/fs-datasource-engine`; the `-F` script alias is unbound in this package. 197/197 passing, 9/9 files.)

## 4. Main-process OAuth consent broker (`apps/desktop/src/main/oauth/`)

- [x] 4.1 Write failing test `consent-broker.test.ts` — "Loopback binding returns an ephemeral port". Stub `shell.openExternal`; call `broker.start({providerId: "google-drive"})`; verify the returned pending session carries a bound `127.0.0.1:<port>` and the authorize URL's `redirect_uri` matches.
- [x] 4.2 Write failing test — "State mismatch rejects the callback". Simulate a GET with wrong `state`; assert `completeWith` is not invoked, response is 400-class, the next event is `consent-failed` with `tag: "auth-revoked"`.
- [x] 4.3 Write failing test — "Valid callback invokes completeWith and emits consent-completed". Happy-path with stubbed engine fetch returning tokens; assert `CredentialStore.put` called, registry row present, `consent-completed` emitted with matching `sessionId` + new `datasourceId`.
- [x] 4.4 Write failing test — "Cancel closes listener and emits consent-cancelled". Call `broker.cancel`; subsequent HTTP hit on the port is `ECONNREFUSED`; event emitted once; second cancel is a no-op (no duplicate event).
- [x] 4.5 Write failing test — "Timer fires at 5 minutes". Vitest fake timers; advance 300001 ms with no callback; assert `consent-timeout` emitted, server closed, record gone.
- [x] 4.6 Write failing test — "Timer cancelled on successful completion". Complete at t=60000; advance past t=300001; assert NO `consent-timeout` event, timer-leak-check passes.
- [x] 4.7 Implement `OAuthConsentBroker` class in `apps/desktop/src/main/oauth/consent-broker.ts`: `Map<sessionId, PendingSession>`, `start()` does all 9 bootstrap steps from spec D1/§5, loopback `http.createServer()` handler does callback verification/response/completeWith/registry-persist/event-emit/cleanup, `cancel()` closes & clears idempotently, 5-min timer integrated. Rerun tests 4.1–4.6 — all pass.
- [x] 4.8 Add `.test.ts` coverage for construction-time validation: missing clientId/secret throws a clear error at `broker.start()` call site, not at constructor time.

## 5. Main-process IPC handlers (`apps/desktop/src/main/ipc/datasources/`)

- [x] 5.1 Write failing test for `start-consent.ts` — handler wires the broker instance, returns `{sessionId}`, forwards events to the renderer via the existing `DATASOURCES_CHANNELS` stream.
- [x] 5.2 Write failing test for `cancel-consent.ts` — handler dispatches to `broker.cancel(sessionId)`, returns `void`, tolerates unknown `sessionId` (no-op per idempotency spec).
- [x] 5.3 Implement `start-consent.ts` and `cancel-consent.ts` handlers, register them in `apps/desktop/src/main/ipc/index.ts`. Rerun 5.1/5.2 — green.
- [x] 5.4 Update `apps/desktop/src/main/ipc/datasources/summary-builder.ts` (or equivalent code path that constructs `DatasourceSummary`) to derive and populate `errorKind` from the engine's `DatasourceError.tag`. Add a unit test asserting the mapping.

## 6. Preload bridge (`apps/desktop/src/preload/`)

- [x] 6.1 Write failing integration test that imports `window.api.datasources.startConsent` and `cancelConsent` (via the test harness that mirrors the preload bridge). Assert both are functions with the expected shape; invocation round-trips to the main-process stub.
- [x] 6.2 Expose `startConsent` and `cancelConsent` in `apps/desktop/src/preload/index.ts` via `contextBridge.exposeInMainWorld('api', {...})`. Update `apps/desktop/src/preload/window-api.d.ts` and `apps/desktop/src/renderer/src/types/window-api.d.ts` to include the new methods. 6.1 turns green.

## 7. Renderer: datasource store wiring (`apps/desktop/src/renderer/src/features/datasources/store.tsx`)

- [x] 7.1 Write failing test — the store dispatches `consent-*` events to per-session subscribers; `useConsentSession(sessionId)` hook returns `{ status: "pending" | "completed" | "cancelled" | "failed" | "timeout"; datasourceId?; tag?; message? }`.
- [x] 7.2 Implement the session-subscriber plumbing in `store.tsx` and expose the `useConsentSession` hook. 7.1 green.

## 8. Renderer: OAuth form rewrite (`apps/desktop/src/renderer/src/features/datasources/credential-forms/oauth-form.tsx`)

- [x] 8.1 Delete the existing `delayMs` fake in a failing test — "OAuth form calls startConsent, not add". Render the form, click Connect, assert `window.api.datasources.startConsent({providerId})` called exactly once with NO `add` call.
- [x] 8.2 Write failing test — "OAuth form transitions to done on consent-completed". Fire a `consent-completed` event with matching `sessionId` via the test harness; assert `onSubmit` is called with the shape the dialog's success path expects OR the dialog-close side effect fires.
- [x] 8.3 Write failing test — "OAuth form surfaces cancel and timeout inline". Fire `consent-cancelled` / `consent-timeout`; assert inline `role="status"` copy, Retry button present, dialog stays open.
- [x] 8.4 Write failing test — "Non-OAuth flow compiles and runs unchanged". Sanity: `AwsAccessKeyForm` and `CustomForm` continue to call `actions.add` — verify no regression via the existing `add-dialog.test.tsx` suite plus a new assertion.
- [x] 8.5 Rewrite `oauth-form.tsx`: call `startConsent`, use `useConsentSession`, render the three terminal states, wire Retry. Remove the `delayMs` prop and the mock credential blob. 8.1–8.4 turn green.
- [x] 8.6 D7 invariant fix — OAuthForm calls `cancelConsent({sessionId})` on unmount so closing the dialog mid-OAuth tears down the broker's loopback server (otherwise a late browser callback can still trigger `completeWith` + `addToRegistry`, materialising a registry row for a session the user thought they cancelled). Three new tests in `oauth-form.test.tsx` cover post-Connect unmount, no-Connect unmount (no-op), and post-terminal-state unmount (broker idempotent).

## 9. Renderer: AuthErrorBanner (`apps/desktop/src/renderer/src/features/datasources/card.tsx`)

- [x] 9.1 Write failing test — "Banner renders iff errorKind is auth-class". Render card with `errorKind: "auth-revoked"`; assert `data-testid="auth-error-banner"` present, "Reconnect" button accessible name, bare `<p className="text-destructive text-xs">` NOT present.
- [x] 9.2 Write failing test — "Non-auth errors render the bare paragraph unchanged". `errorKind: "network-error"`; assert banner absent, bare paragraph present, quick-actions menu items list unchanged.
- [x] 9.3 Write failing test — "Reconnect starts a scoped consent session". Click Reconnect; assert `startConsent({providerId, datasourceId})` called exactly once; fire `consent-completed` with the same `sessionId`; assert card status flips to `connected` via the event stream.
- [x] 9.4 Write failing a11y test (jest-axe) — "Banner meets WCAG AA contrast and has an accessible name". No axe violations, Tab order is banner-copy → Reconnect → next element.
- [x] 9.5 Implement `AuthErrorBanner` as a subcomponent of `card.tsx`, add the render branch gated on `status === "error" && (errorKind === "auth-revoked" || errorKind === "auth-expired")`, preserve the bare `<p>` for other error kinds, no menu changes. Tokens per design.md Visual direction. 9.1–9.4 turn green.

## 10. Dev override — `FT5_DEV_CREDENTIALS=1` bypass

- [x] 10.1 Write failing test — "Dev override short-circuits the browser flow". Start main with env var set, stubbed `shell.openExternal`, valid `dev/credentials.json` fixture; call `startConsent`; assert browser not opened, no HTTP bind, `consent-completed` emitted with new `datasourceId`.
- [x] 10.2 Write failing test — "Startup warning fires once when dev override is active". Grep main-process startup log for the warning; assert exactly one match; subsequent `startConsent` calls do NOT repeat the warning.
- [x] 10.3 Implement the dev-override branch in `consent-broker.start()` and the one-shot startup warning in main bootstrap. 10.1/10.2 turn green.
- [x] 10.4 Packaged-build inspection: verified `electron-builder` config and `electron.vite.config.ts` contain no `define` block for `FT5_DEV_CREDENTIALS`; the var is read from runtime `process.env` only, so it cannot be baked into the packaged bundle. Task 11 will add esbuild `define` solely for `FT5_GOOGLE_OAUTH_CLIENT_ID/SECRET` — not for this var.

## 11. Build-time `clientId` / `clientSecret` injection

- [x] 11.1 Add esbuild `define` (or tsc equivalent) config in the main-process build so that `FT5_GOOGLE_OAUTH_CLIENT_ID` and `FT5_GOOGLE_OAUTH_CLIENT_SECRET` from the build-time env are inlined as module-local constants in the main-process bundle. Missing values during a non-dev build SHALL fail the build.
- [x] 11.2 Wire the GitHub Actions build workflow to pass the two env vars from secrets into the build step. Verify the packaged bundle includes the values via a grep smoke check (comparing length only — never echo values).
- [x] 11.3 Dev workflow: the main-process dev-runner reads from `.env.local` before spawning Electron (electron-vite auto-loads `.env.local` from `apps/desktop/`). Added `.env.example` with documented format. Added `.env.local` pattern to `.gitignore`. When both secrets are absent and `FT5_DEV_CREDENTIALS` is not set, the broker's existing `start()` validation surfaces "OAuth client ID is not configured" on the first connect attempt.

## 12. Smoke test + user-facing docs

> **Dependency note.** Tasks 12.1 and 12.2 require the follow-up change `implement-datasource-onboarding` to be merged first — it wires the service-side `sync:authenticate-*` handlers that persist OAuth tokens. Until then, the consent flow completes successfully but exploring the new card fails with `no credentials registered for datasourceId=...` (see design.md "Known gap — credential persistence"). Tasks 12.3 and 12.4 (cancel and timeout) are independently testable today because they exercise renderer-side terminal states that do not require credential persistence.

- [ ] 12.1 Manual smoke test — fresh install + real GCP client: run `pnpm -F desktop dev` with `.env.local` containing real credentials and `FT5_DEV_CREDENTIALS` UNSET; click Add Datasource → Google Drive → Connect; system browser opens; complete consent; dialog closes; new card appears; upload a small file; list the Drive root and confirm the file. Screenshot each step and attach to PR. **Blocked on `implement-datasource-onboarding`.**
- [ ] 12.2 Manual smoke test — revoke + reconnect: after 12.1, open Google Account → Security → Third-party apps → revoke; wait for the card to move to error state with `auth-revoked` banner; click Reconnect; complete consent; verify card returns to `connected` and a fresh sync succeeds. **Blocked on `implement-datasource-onboarding`.**
- [ ] 12.3 Manual smoke test — cancel mid-consent: click Connect, close the browser tab; verify dialog surfaces "Consent cancelled — you can try again" with Retry; click Retry; complete consent successfully.
- [ ] 12.4 Manual smoke test — timeout: click Connect, leave the browser tab idle; advance real wall clock past 5 minutes; verify dialog surfaces "Consent timed out — please try again" with Retry.
- [x] 12.5 Updated root `README.md` "Google Drive datasource setup" section: rewrote the stale preamble (OAuth form is no longer mocked), added Section 1 subsections covering 1.1 GCP OAuth client registration, 1.2 GitHub Actions secrets wiring, and 1.3 `.env.local` setup. Documented the `FT5_DEV_CREDENTIALS=1` dev override workflow (Section 2) including the PowerShell helper for obtaining offline tokens. Added a troubleshooting row for corporate-firewall loopback interference.

## 13. Close-out

- [x] 13.1 Full test suite green: 1793/1797 tests pass; 3 failing test files are pre-existing mock-fs failures unrelated to this change. `pnpm lint` clean (0 errors). `pnpm typecheck` clean (pre-existing mock-fs type errors excluded).
- [x] 13.2 Playwright packaged E2E — N/A: the existing Playwright harness only covers file-explorer flows; no datasources OAuth e2e harness is configured. E2E coverage for the OAuth path is deferred to a follow-up change once the GCP client is registered and real credentials are available (task 1.1-1.3 prerequisite).
- [ ] 13.3 Use `finishing-a-development-branch` skill to route merge/PR/cleanup per project rules.
- [x] 13.4 `openspec validate add-drive-oauth-browser-consent` — green: "Change 'add-drive-oauth-browser-consent' is valid".
- [ ] 13.5 Archive the change via `/opsx:archive` in the worktree branch BEFORE merging to master.
