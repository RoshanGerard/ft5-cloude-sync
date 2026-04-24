# Proposal: Wire interactive OAuth browser consent for adding a Google Drive datasource

## Why

Clicking **Add datasource → Google Drive** today runs a mock: the renderer's `OAuthForm` waits 800 ms and submits a fake token blob. The only way real Drive credentials reach the app is a pre-provisioned `$HOME/ft5/sync_app/dev/credentials.json` generated out-of-band. A fresh-install user cannot authenticate at all; re-consent after scope drift or revocation is unreachable from the UI; and the dev fallback silently masks a missing wiring. The engine already exposes an OAuth intent (`client.authenticate()` → `OAuthIntent { authorizeUrl, completeWith }`) that persists tokens via `CredentialStore` on success — what is missing is the main-process side: opening the URL in the system browser, hosting a loopback redirect, verifying the `state` parameter, exchanging the code for tokens with PKCE, and surfacing clean terminal states (completed / cancelled / timed-out) to the UI.

## What Changes

**Engine (PKCE):**
- Modify `GoogleDriveClient.doAuthenticateImpl` (and `exchangeCodeForTokens`) to generate a 64-character `code_verifier`, include `code_challenge = SHA256(verifier)` + `code_challenge_method=S256` on the authorize URL, and pass the verifier as `code_verifier` on the token exchange. The verifier is per-session state, not stored.

**Main process (consent broker):**
- New module `apps/desktop/src/main/oauth/consent-broker.ts` owns pending consent sessions (Map keyed by `sessionId`), loopback `http.createServer()` bound to `127.0.0.1:0`, 5-minute timeout timer, CSRF `state` (32 random bytes base64url), and PKCE verifier. Opens the authorize URL via `shell.openExternal`.
- New IPC handlers under `apps/desktop/src/main/ipc/datasources/`: `startConsent`, `cancelConsent`.
- When `FT5_DEV_CREDENTIALS=1` is set in the process env at startup, the broker is bypassed — the handler reads `$HOME/ft5/sync_app/dev/credentials.json` and hands the blob to the engine. Logged on startup with a warning; never set in packaged production builds.

**IPC contract (`packages/ipc-contracts`):**
- Add `DatasourcesStartConsentRequest` / `…Response`, `DatasourcesCancelConsentRequest` / `…Response`.
- Add consent events to the existing `DatasourceEvent` union: `consent-started`, `consent-completed`, `consent-cancelled`, `consent-failed`, `consent-timeout`. Each carries a `sessionId`.
- Add an `errorKind` field to `DatasourceSummary` carrying the engine's 8-tag taxonomy string (`auth-revoked`, `auth-expired`, etc.). The existing `errorReason` (human string) stays for display.

**Renderer:**
- Rewrite `credential-forms/oauth-form.tsx`: replace the 800 ms mock with a call to `window.api.datasources.startConsent({providerId})`, subscribe to consent events, render in-dialog status copy ("Opening browser… Complete consent and return here") and terminal states (completed → dialog closes; cancelled/timeout → inline message + Retry).
- New `AuthErrorBanner` subcomponent in `card.tsx`: when `summary.status === "error"` AND `summary.errorKind` is `auth-revoked` or `auth-expired`, replace the bare `<p className="text-destructive text-xs">` with a tinted panel (`color-mix(destructive 8%)` background, `destructive 30%` border, `rounded-md`) containing the error copy plus a `destructive` variant Reconnect button. The button calls `startConsent({datasourceId})`. Quick-actions menu is unchanged.

**Build-time config:**
- `apps/desktop/package.json` and the electron-builder config grow a build-time env hook: `FT5_GOOGLE_OAUTH_CLIENT_ID` (inline-safe) and `FT5_GOOGLE_OAUTH_CLIENT_SECRET` (injected via esbuild/tsc `define` into the main-process bundle). `.env.local` (gitignored) for dev; CI reads from GitHub Actions secrets.
- Operational prerequisite (captured as a task, not solved by code): register a GCP "Desktop app" OAuth client in an org-owned project; record the values.

## Capabilities

### New Capabilities
None. All additions fold into existing capabilities.

### Modified Capabilities
- `fs-datasource-engine`: Google Drive's `authenticate()` flow adds PKCE (S256 challenge on the authorize URL, verifier on the token exchange).
- `datasources-ui`: adds the consent IPC surface (`startConsent`, `cancelConsent`, consent events), the `errorKind` field on `DatasourceSummary`, the real `OAuthForm` behavior, and the `AuthErrorBanner` rendering rule for auth-class error states.

## Impact

**Code:**
- `packages/fs-datasource-engine/src/strategies/googledrive-client.ts` (PKCE), plus matching test files (`googledrive-client.test.ts`, `.contract.test.ts`).
- `packages/ipc-contracts/src/datasources.ts` (new request/response types, consent events, `errorKind`), plus `__tests__/datasources.test-d.ts` and any type-decl files the preload rehydrates.
- `apps/desktop/src/main/oauth/consent-broker.ts` (new file).
- `apps/desktop/src/main/ipc/datasources/start-consent.ts`, `cancel-consent.ts` (new), plus index rewire.
- `apps/desktop/src/preload/index.ts` (expose the two new methods; the event bridge already exists).
- `apps/desktop/src/renderer/src/features/datasources/credential-forms/oauth-form.tsx` (rewrite).
- `apps/desktop/src/renderer/src/features/datasources/card.tsx` (`AuthErrorBanner`).
- `apps/desktop/src/renderer/src/features/datasources/store.tsx` (threads consent events into state; surfaces the banner decision).

**Dependencies:**
- No new runtime deps. PKCE uses Node's `crypto` module (already available in the Electron main process).

**Operational:**
- GCP project registration (one-time). Values flow into CI secrets + `.env.local` for dev; neither is committed to the repo.

**Tests:**
- Engine: PKCE verifier format + challenge math, token exchange threads the verifier.
- Main: loopback bound to `127.0.0.1:0`, state verification rejects mismatch, timeout fires at 5 min, cancel closes listener, dev-env override bypasses browser.
- IPC: four-layer wiring (contract ↔ main handler ↔ preload bridge ↔ renderer call site) for `startConsent` / `cancelConsent`.
- Renderer: `OAuthForm` reaches each terminal state deterministically via mocked event stream; `AuthErrorBanner` renders iff `status === "error" && errorKind ∈ {auth-revoked, auth-expired}`.
- Smoke: revoke in Google Account Security → Reconnect from card banner → confirm new token carries `auth/drive` scope.

**Blocks:**
- `fix-drive-listdirectory-scope-drift` — cannot be cleanly diagnosed without reachable re-consent.

## Provenance

- Promoted from the 2026-04-24 stub that surfaced during smoke-testing of `wire-file-explorer-to-service`.
- Scope expanded during `/opsx:propose` to include engine PKCE changes after verifying `doAuthenticateImpl` at `packages/fs-datasource-engine/src/strategies/googledrive-client.ts:642-663` has no PKCE wiring. The original stub framed this as "desktop wiring only" — that was incomplete.
