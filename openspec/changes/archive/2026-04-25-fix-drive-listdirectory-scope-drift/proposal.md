# Proposal: Detect and surface Drive OAuth scope drift at connect time

## Why

A real Google Drive datasource configured in dev shows **only files uploaded through the app** — files that already existed in the user's Drive before the app was connected are invisible. Static review of `packages/fs-datasource-engine/src/strategies/googledrive-client.ts` shows the engine code is correct: query is `'<fileId>' in parents and trashed=false`, the requested `OAUTH_SCOPE` is the full `https://www.googleapis.com/auth/drive`, and the `ya29.`-prefixed access token in `$HOME/ft5/sync_app/dev/credentials.json` is OAuth-issued (not a service account JWT, no `private_key` / `type: "service_account"` field).

The remaining root cause is **sticky OAuth scope**: the *issued* refresh token in `credentials.json` was generated under a narrower consent (almost certainly `drive.file`, which restricts the app to files it created). Changing the requested scope in source code does **not** widen an already-issued refresh token — that requires re-consent. Today the engine has no way to detect that the issued scope is narrower than what `OAUTH_SCOPE` requests, so a Drive datasource in this state silently appears "connected" while listing only app-created files. The user has no signal that anything is wrong.

This change adds an **engine-side scope-drift detector** that runs at connect time (status / test-connection / refresh), captures the issued scope from the OAuth token endpoint, persists it on the credential, and fails fast with a tailored `auth-revoked` error when the issued scope is insufficient. The actual re-consent UX (opening the system browser to widen the grant) lives in the sibling change `add-drive-oauth-browser-consent` and is **out of scope here** — this change provides the *signal* that the consent flow will respond to.

## What Changes

- **Capture issued scope from token responses.** `parseTokenResponse` (token exchange and refresh) reads the `scope` field from Google's OAuth token endpoint response and stores it on the credential as `meta.scope`. New token exchanges and refreshes always carry the issued scope; legacy credentials (no `meta.scope`) get a one-time backfill.
- **Backfill via `tokeninfo` for legacy credentials.** First time a credential without `meta.scope` reaches `doStatusImpl`, the engine calls `https://oauth2.googleapis.com/tokeninfo?access_token=<token>` once, persists the returned scope, and reuses it thereafter. Persisted scope is never re-fetched.
- **Sufficiency check on every status / test-connection.** Before the existing `about.get` probe, the engine compares the stored scope against the required scope `https://www.googleapis.com/auth/drive`. The check is **exact-grant**: the issued scope set must include the full `drive` scope. `drive.file`, `drive.readonly`, `drive.metadata.readonly`, and `drive.appdata` alone are insufficient because the engine performs mutations (`createFile`, `uploadFile`, `deleteFile`).
- **Tailored `auth-revoked` error on insufficient scope.** When the check fails, the engine throws `DatasourceError` with `tag: "auth-revoked"`, `retryable: false`, and a structured `raw` payload `{ kind: "scope-insufficient", requiredScope, actualScope }`. The error `message` reads "Drive permissions are too narrow — reconnect with full access to see your existing files." This routes through the existing event-bus path (`authentication-failed` → renderer) without new IPC surface.
- **No UI work in this change.** The renderer's existing `AuthRevokedState` component already handles `auth-revoked` with a generic "Sign in again to view files" message and a `Reconnect` button. Tailoring that copy to scope drift is paired with the consent flow in `add-drive-oauth-browser-consent` (the Reconnect button doesn't actually re-consent yet, so a more specific message would point at a remedy that doesn't exist). Documented as a follow-up.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `fs-datasource-engine`: adds two requirements — issued OAuth scope is captured and persisted on the credential, and Drive's status/test-connection probe SHALL fail with `auth-revoked` when the issued scope is insufficient for the engine's mutating operations.

## Impact

- **Code**: `packages/fs-datasource-engine/src/strategies/googledrive-client.ts` (new constants, `parseTokenResponse` writes `meta.scope`, `doStatusImpl` / `doTestConnectionImpl` gain a sufficiency check, new `tokeninfo` probe helper).
- **Tests**: `packages/fs-datasource-engine/src/strategies/googledrive-client.test.ts` (new unit suite covering scope capture, backfill, sufficiency matrix, error mapping). The `googledrive-client.contract.test.ts` suite is unaffected — it provides a stub credential that includes `meta.scope`.
- **No IPC contract changes.** `meta.scope` is a free-form `Record<string, unknown>` field on `AuthResult.meta` and does not require a `@ft5/ipc-contracts` update.
- **No renderer changes.** Existing `AuthRevokedState` already handles `auth-revoked`. Renderer-side message tailoring is deferred (see "What Changes").
- **Documentation**: a short entry in operator/onboarding docs explaining what scope drift looks like and how the user re-consents (forward-pointer to `add-drive-oauth-browser-consent`).
- **Out of scope** (deferred to their own changes):
  - The OAuth browser consent flow itself — `add-drive-oauth-browser-consent`.
  - `listDirectory` pagination — already tracked as `add-engine-listdirectory-pagination` follow-up.
  - Shared-drives visibility (`includeItemsFromAllDrives: true`) — orthogonal to scope drift; should be its own change.
  - Service-account credential support — confirmed not in play here (the dev credential is OAuth-issued).
  - Renderer message tailoring for the scope-insufficient sub-case — paired with the consent flow.

## Provenance

- Raised by user dev2@forti5.tech on 2026-04-24 during smoke-testing of `wire-file-explorer-to-service`.
- Diagnosis confirmed during `/opsx:propose` on 2026-04-25: the dev `credentials.json` is OAuth-issued (token has the `ya29.` prefix; no service-account JSON fields), and the source code requests full `drive` scope, leaving sticky scope as the only remaining candidate.
