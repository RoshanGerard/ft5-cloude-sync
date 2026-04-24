# Proposal: Wire interactive OAuth browser consent for adding a Google Drive datasource

**Status**: Stub. Discovered during smoke-testing of `wire-file-explorer-to-service` on 2026-04-24.

## Why

When the user clicks **Add datasource → Google Drive** today, no browser window opens for OAuth consent. The app falls back to reading a pre-populated file at `$HOME/ft5/sync_app/dev/credentials.json`. That file was generated out-of-band at some earlier time with some scope, and the app has no visibility into its provenance. Consequences:

- A user adding a *new* Drive datasource cannot actually authenticate without manually provisioning the credential file.
- Re-consenting (e.g., after scope drift or revocation) requires deleting the file, re-running some external provisioning step, then restarting the app — not reachable from the UI.
- The dev flow silently masks the OAuth wiring gap during development.

The engine already exposes an OAuth intent via `getAuthIntent()` that returns an `authorizeUrl`. What's missing is the desktop app's piece: opening the URL in the system browser, hosting a loopback redirect, exchanging the authorization code for a refresh token, and persisting it via the existing credential store.

## Out of scope

- The token exchange flow already exists in the engine (`googledrive-client.ts`); this change is about the *desktop wiring* only.
- OneDrive and S3 onboarding flows (separate changes, but this proposal establishes the pattern).

## Open questions (resolve during `/opsx:propose`)

1. **Loopback vs custom scheme.** Google's desktop OAuth recommends a loopback HTTP listener on `127.0.0.1` with a dynamic port. Electron can also register a custom URI scheme (e.g., `ft5://oauth/callback`). Which is safer and less brittle across platforms?
2. **Host process.** Does the loopback listener live in the main process (`electron.app.whenReady` + `http.createServer`) or the fs-sync service? Main process has the advantage of being always-on during a consent window.
3. **State parameter.** Per RFC 6749 we need a CSRF-resistant `state` parameter. How is it generated, verified, and scoped to the specific datasource being added?
4. **Timeout and cancellation.** If the user closes the browser tab, the UI should reach a clear terminal state ("Consent cancelled") within a bounded window (say 5 min). How is that bounded?
5. **Re-consent entry point.** Where in the UI does the user click to re-trigger consent for an existing datasource — the datasource card, the `AuthRevoked` state's `Reconnect` button, both?
6. **Dev-mode override.** Preserve the file-based fallback behind a `FT5_DEV_CREDENTIALS` env var so engine tests that bypass browser consent still work.

## Acceptance criteria (once promoted)

- Clicking **Add Google Drive datasource** opens the system browser to Google's OAuth consent page with the full `auth/drive` scope requested.
- After consent, the loopback listener captures the authorization code, exchanges it for a refresh token, and persists via the existing `CredentialStore`.
- `credentials.json` on disk is written atomically (no half-file on crash).
- A cancelled consent leaves the datasource in a clear "setup pending" state with a `Retry` affordance.
- Smoke test: revoke the app in Google Account → Security → Third-party apps → re-trigger consent from the UI → confirm the new token has `auth/drive` scope.

## Provenance

- Raised by user dev2@forti5.tech on 2026-04-24 during smoke-testing of `wire-file-explorer-to-service`.
- Blocks diagnosis of the sibling change `fix-drive-listdirectory-scope-drift` (can't cleanly re-consent without this wired).
