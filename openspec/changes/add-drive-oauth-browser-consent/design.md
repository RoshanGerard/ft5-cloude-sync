# Design: Drive OAuth browser consent

## Context

The Google Drive datasource today is functional only because a pre-provisioned `$HOME/ft5/sync_app/dev/credentials.json` seeds tokens that `ConfigFileCredentialStore` reads. The "Add Google Drive" dialog in the renderer uses a mocked `OAuthForm` that waits 800 ms and submits a fake token blob. There is no production path to obtain tokens from Google, no path to re-consent after revocation or scope drift, and no test that exercises the real flow.

What the engine DOES have:
- `BaseDatasourceClient.authenticate()` returns an `AuthIntent`. For Drive, this is an `OAuthIntent { kind: "oauth", authorizeUrl, completeWith(code) → AuthResult }`. `GoogleDriveClient.doAuthenticateImpl` (googledrive-client.ts:642-663) builds the authorize URL from `meta.clientId`, `meta.redirectUri`, and a hardcoded `auth/drive` scope.
- `BaseDatasourceClient.decorateIntent` (base-client.ts:763-...) wraps `completeWith` so that on success the resulting `AuthResult` is persisted via the injected `CredentialStore` BEFORE the promise resolves. The main process does not re-implement persistence.
- `ConfigFileCredentialStore` (services/fs-sync/src/credential-store/config-file.ts) writes atomically (tmp + rename), chmod 0o600 on Unix, asserts mode widening on read.

What is missing:
- The main process does not open the authorize URL, does not listen for the redirect, does not exchange the code, does not verify `state`. PKCE is absent from the engine's authorize URL builder. The renderer has no path to trigger consent from the UI.

Architectural constraints (project.md):
- Renderer MUST NOT import `http`, `electron`, `child_process`, `fs`. All OS access flows through `window.api.*`.
- Every renderer-callable operation exists as four pieces: IPC contract → main handler → preload bridge → renderer call. Missing any is a proposal gap.
- shadcn primitives, `rounded-md` radii ceiling, tabular-nums for numerics, no backdrop-blur on cards.

## Goals / Non-Goals

**Goals:**
- Clicking "Add Google Drive" opens the system browser to Google's OAuth consent page with the full `auth/drive` scope, PKCE, and a unique CSRF `state`.
- The loopback listener captures the `code`, the engine exchanges it for a refresh token (threading the PKCE verifier), and `credentials.json` receives the tokens atomically.
- Re-consent for an existing datasource is reachable via a contextual banner on the errored card.
- Cancelled / timed-out / state-mismatch flows leave the system in a clean state: no half-created registry entry, no leaked listener, no stale pending session in memory.
- Dev workflow (engine unit tests, packaged E2E harness using pre-provisioned creds) continues to work via `FT5_DEV_CREDENTIALS=1`.

**Non-Goals:**
- OneDrive and S3 consent flows. (They have separate credential schemas; this change establishes the pattern but does not modify them.)
- Token rotation or periodic re-auth. Refresh via existing `refreshToken` stays unchanged.
- Keychain/OS-credential-store migration. `ConfigFileCredentialStore` with chmod 0o600 remains the backing store (documented v1 tradeoff).
- A "paste your own OAuth client" BYO flow. Rejected during brainstorming — premature.
- Moving the loopback listener into the `fs-sync` service. Rejected architecturally — a separate OS process would require round-trip IPC just to deliver the authorization code.

## Decisions

### D1 — Host process: Electron main (forced)

The loopback listener lives in the Electron main process. The renderer cannot bind sockets (project rule), and the `fs-sync` service is a separate OS process — hosting the listener there would mean the authorization code crosses two process boundaries instead of one, with no benefit. The main process is always running during the app lifetime, has `shell.openExternal`, and already holds every other OAuth-adjacent resource (IPC contract, preload bridge, engine instances).

**Alternative considered:** fs-sync service. Rejected: cross-process delivery of the code, duplicate session state, no upside.

### D2 — Loopback redirect transport

`http.createServer()` bound to `127.0.0.1:0` — OS picks the port. The redirect URI computed at session start is `http://127.0.0.1:<port>/callback`. Google's "Desktop app" OAuth client type officially supports loopback per RFC 8252 §7.3.

**Alternative considered:** Custom URI scheme `ft5://oauth/callback` via `app.setAsDefaultProtocolClient`. Rejected: Google does not officially support custom schemes for the Desktop client type; requires OS-level protocol registration that breaks on unsigned dev builds; different code paths on macOS (`open-url`) vs Windows/Linux (`second-instance`).

### D3 — PKCE with S256

Every consent attempt generates a 64-character URL-safe `code_verifier` (`crypto.randomBytes(48).toString('base64url')` → 64 chars). `code_challenge = base64url(SHA256(verifier))`, `code_challenge_method=S256`. The verifier is held in the pending session (main-process memory) until `completeWith(code)` fires; not persisted.

This touches the engine: `googledrive-client.ts` `doAuthenticateImpl` and `exchangeCodeForTokens` grow a verifier parameter. The engine is the correct owner (per-strategy OAuth flow detail), not the main-process broker.

**Alternative considered:** PKCE as a separate follow-up change. Rejected during Q1 brainstorming — shipping OAuth without PKCE would leave a security-posture gap that fails review and creates a forced migration once PKCE lands.

### D4 — CSRF state: 32 random bytes, in-memory

`state = crypto.randomBytes(32).toString('base64url')` per session, stored in the broker's pending-session Map keyed by `sessionId`. The loopback callback rejects (with a `consent-failed` event and `tag: "auth-revoked"` equivalent) when the query-string `state` does not match. No persistence — a main-process crash mid-consent abandons the session; user retries.

**Alternative considered:** HMAC-bound state tied to a long-lived app secret. Rejected: adds key management for zero meaningful gain on a desktop OAuth session.

### D5 — Consent timeout: 5 minutes

Timer starts when `startConsent` builds the authorize URL. On expiry, the listener closes, the pending session clears, and `consent-timeout` fires. Matches Google's ~10-minute `code` lifetime with safety margin; long enough for a slow SSO login, short enough that abandoned dialogs don't leave listening ports open.

### D6 — OAuth client credentials: app-bundled, injected at build time

`FT5_GOOGLE_OAUTH_CLIENT_ID` and `FT5_GOOGLE_OAUTH_CLIENT_SECRET` are build-time env vars consumed by the main-process bundler's `define` map. Dev reads from a gitignored `.env.local`; CI reads from GitHub Actions secrets. For the Google "Desktop app" OAuth client type with PKCE, the `client_secret` is explicitly non-confidential per Google's documentation — the security guarantee comes from the verifier, not the secret.

**Operational prerequisite (not code):** register the GCP project, OAuth client, and consent-screen metadata. Captured as a single task in tasks.md with a link from design.md.

**Alternative considered:** BYO (user pastes their own client). Rejected during Q2 brainstorming — punitive onboarding, no user has asked for it.

### D7 — No "setup pending" registry entry

The DatasourceRegistry row is created only after `completeWith(code)` succeeds. During consent, state lives in the broker's pending-session Map. Rationale: a half-baked row in the registry complicates list semantics (is it visible? can it be synced? what happens on app restart mid-consent?) for a session that, empirically, the user either completes in under a minute or abandons. This keeps DatasourceSummary invariants simple — every row is an already-authenticated datasource.

**Trade-off:** no UI indication that a consent session is in flight *on the dashboard* (it's in the dialog only). Accepted: the in-dialog status copy is sufficient; moving it to the dashboard adds noise.

### D8 — IPC surface: two new methods + five new events

New methods on `window.api.datasources`:
- `startConsent({providerId, datasourceId?}) → {sessionId}` — kicks off a new consent (fresh add) or re-consent (existing datasource).
- `cancelConsent({sessionId}) → void` — user-initiated cancel.

New events on the existing `onEvent` stream (all scoped by `sessionId`):
- `consent-started` — `{sessionId, datasourceId?}`
- `consent-completed` — `{sessionId, datasourceId}` (the datasource is live in the registry by the time this fires)
- `consent-cancelled` — `{sessionId}` (user-initiated)
- `consent-failed` — `{sessionId, tag, message}` (state mismatch, token-endpoint error, etc.)
- `consent-timeout` — `{sessionId}` (5-min timer fired)

`datasources.add` is unchanged for aws-access-key / custom-form providers (sync one-shot). The mocked sync-credentials path for OAuth is removed entirely — OAuth only goes through `startConsent` now.

**Alternative considered:** overloading `add` to return `{authorizeUrl}` early and fire events from there. Rejected: changes the request/response shape of an existing stable method; cleaner to add new methods and leave `add` alone for the non-OAuth providers.

### D9 — Renderer: `AuthErrorBanner` only, no menu item

`AuthErrorBanner` renders inside the `<Card>` in place of the existing bare `<p className="text-destructive text-xs">` when `summary.status === "error"` AND `summary.errorKind ∈ {auth-revoked, auth-expired}`. Other error reasons keep the bare paragraph (unchanged). The quick-actions menu is NOT touched — no "Reconnect" item on healthy cards.

Dispatched from the brainstorming visual companion selection (Option A). Rationale: contextual CTA matches the dense-quiet aesthetic (the app surfaces actions only when relevant); edge cases (scope drift on a healthy card, account switch) are rare enough to warrant the Remove + Add workaround.

### D10 — `errorKind` field on `DatasourceSummary`

A new `errorKind: DatasourceErrorTag | null` field on `DatasourceSummary` carries the engine's 8-tag taxonomy value (`auth-revoked`, `auth-expired`, `not-found`, `rate-limited`, `network-error`, `conflict`, `provider-error`, `cancelled`) when `status === "error"`, and `null` otherwise. The existing `errorReason` stays for display. Rationale: the renderer cannot string-match a human-rendered reason safely; the taxonomy is the stable contract.

### D11 — Dev override via env var

`FT5_DEV_CREDENTIALS=1` at main-process startup routes `startConsent` to read `$HOME/ft5/sync_app/dev/credentials.json` synchronously (via the existing `ConfigFileCredentialStore`-compatible shape), hand the blob to the engine factory, and skip the browser entirely. Logged once at startup with a banner warning: "⚠ FT5_DEV_CREDENTIALS active — consent flow bypassed." In packaged builds, the env var is never set; in dev builds, the developer sets it deliberately.

## Visual direction

Required by CLAUDE.md for any change with visible UI surface. Captures what the implementation phase consults — not the conversation history.

**Aesthetic tone:** Inherit the existing dashboard's dense-quiet / Linear-Vercel direction (established in the archived `ui-ux-design` change). No new visual territory.

**Typography:** Unchanged. Card header stays `text-sm font-semibold` for the title, `text-xs text-muted-foreground` for the provider line and meta row. Banner body is `text-xs`; button label is the Button component's default.

**Color:** The `AuthErrorBanner` reuses the existing `--destructive` token only. Background tint: `color-mix(in srgb, var(--destructive) 8%, transparent)`. Border: `color-mix(in srgb, var(--destructive) 30%, transparent)`. Button: `variant="destructive"`, `size="sm"`. No new palette entries. The existing `text-destructive` paragraph stays the fallback for non-auth error kinds.

**Spacing & radius:** `rounded-md` (radii-ceiling capped). `p-3` inner padding for the banner, inline with the card's `gap-3` stack. Button sits on the right, flex-end, with `gap-2` from the copy.

**Motion:** None added. The banner appears/disappears with whatever transition the existing error-state paragraph already uses (instant, no animation). The OAuth dialog's status messages use `aria-live="polite"`; no visual motion.

**Accessibility:**
- Banner: accessible name `"Access revoked — Reconnect"` (or per-`errorKind` variant); button has the same label text.
- Dialog status copy: `role="status"` with `aria-live="polite"` so AT announces state transitions ("Opening browser...", "Consent cancelled", "Reconnect to retry").
- Contrast: destructive-on-tinted-destructive must pass WCAG AA (≥4.5:1 for body text, ≥3:1 for the button). The destructive-foreground-on-destructive-background contrast is already validated by the shadcn default; the tinted variant we add is lighter, so contrast is strictly better — but the test suite will include a jest-axe assertion on the errored card.
- No color-only signal: the banner's copy communicates "access revoked" textually; the tint is reinforcement.

**Deviations from the current look:** None.

## Risks / Trade-offs

**Risk:** Port 0 binding returns an unpredictable ephemeral port. Some corporate firewalls or security products quarantine localhost listeners on non-standard ports, breaking the callback.
→ Mitigation: on loopback-bind failure or on 5-min timeout with zero callback hits, surface a `consent-failed` with a tag suggesting the user disable the interfering product or use the dev-override path. Document in troubleshooting.

**Risk:** User closes the browser tab without clicking Cancel. The listener stays open until the 5-min timer fires.
→ Mitigation: accepted — the timer bounds the leak. The renderer's in-dialog state shows "Waiting for you to complete consent in browser…" so the user can explicitly Cancel.

**Risk:** PKCE verifier transits the engine's `completeWith` closure as a captured local. A test-time fake that replaces the engine's fetch could surface the verifier in logs.
→ Mitigation: the verifier is not logged or serialized anywhere in the engine (grep guardrail in tests). Test fakes are contract-local.

**Risk:** `FT5_GOOGLE_OAUTH_CLIENT_SECRET` in a dev `.env.local` leaks via a commit.
→ Mitigation: `.env.local` is in `.gitignore` (verified). Add a pre-commit hook check for the literal value patterns of the bundled client (`GOCSPX-...` for Google web clients, though Desktop clients currently use different patterns) as a belt-and-braces guard.

**Risk:** Engine PKCE change is a source-compatible addition, but a test that pins the authorize URL by string equality will break.
→ Mitigation: update `googledrive-client.test.ts` assertions to parse the URL and check parameter presence, not exact-string match.

**Risk:** App-bundled `client_secret` can be extracted from the binary. Per Google's own documentation for Desktop-type clients, the secret is non-confidential and PKCE is the real security boundary — but a security reviewer unfamiliar with Desktop OAuth may flag this.
→ Mitigation: a short design note cites Google's [Desktop OAuth docs](https://developers.google.com/identity/protocols/oauth2/native-app) in the operational-setup task; the reviewer's concern is addressed by pointing at PKCE as the actual guarantee.

## Migration Plan

No runtime migration. The existing `dev/credentials.json` file keeps working when `FT5_DEV_CREDENTIALS=1` is set. Packaged builds never read it (env var unset at build time).

Rollback: revert the change. The `OAuthForm` mock returns, and Drive becomes unusable on fresh installs — same pre-change state.

## Open Questions

None — all seven identified during brainstorming are resolved and encoded in D1-D11.

## References

- RFC 8252 (OAuth 2.0 for Native Apps) — loopback + PKCE guidance.
- RFC 6749 §10.12 (CSRF on OAuth) — state parameter rationale.
- RFC 7636 (PKCE) — verifier/challenge construction.
- Google Desktop OAuth docs — confirms non-confidential client_secret for Desktop client type with PKCE.
- `packages/fs-datasource-engine/src/strategies/googledrive-client.ts:642-663` (current authorize URL builder — no PKCE).
- `packages/fs-datasource-engine/src/base-client.ts:763` (`decorateIntent` — auto-persists via CredentialStore).
- `services/fs-sync/src/credential-store/config-file.ts` (atomic file write, chmod 0o600).
- `apps/desktop/src/renderer/src/features/datasources/card.tsx:201-203` (current error-reason rendering — replaced by `AuthErrorBanner`).
