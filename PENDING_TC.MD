# Pending Test Cases

Manual / E2E smoke scenarios that have NOT been visually confirmed but whose
underlying code paths are unit-test covered. Each entry documents the
scenario, why it was deferred, and the unit-test that proves the code path
is correct in isolation. Items here are NOT blockers for merging the change
they originated from — they are surfaced for a later environment-specific
verification pass.

---

## add-file-explorer-drag-drop-upload — §11.6 mid-batch network failure with Retry

**Scenario** (per `openspec/changes/add-file-explorer-drag-drop-upload/tasks.md` §11.6):
Upload 5 files from the dashboard card or toolbar Upload dialog, kill the
network mid-batch (turn WiFi off, unplug ethernet, or `kill` the
fs-sync-service process). Each in-flight upload should:

1. Have its toast flip from "Uploading X — Y%" to red "Upload failed: …"
   with a Retry action button, no auto-dismiss.
2. Clicking Retry on one toast should re-dispatch JUST that file's upload
   with the original `{datasourceId, sourcePath, targetPath, conflictPolicy}`
   (the orchestrator's closured `retry: () => dispatchOne(plan)`).
3. The old toast is dismissed and a NEW toast bound to the new jobId opens
   for the retried file. The other 4 toasts remain in their failed state
   until the user clicks their respective Retry buttons (or dismisses).

**Status:** PENDING — not visually confirmed in §11 manual smoke.

**Why deferred:** Required environment setup (5-file batch + mid-flight
network drop with consistent failure timing) is fiddly to reproduce
reliably. The component pieces have been verified independently:

- An invalid-credentials drag-drop produced a red "Upload failed" toast
  with Retry button — confirms the failure path's UI rendering and the
  red-styling per-toast `richColors: true`.
- Test (e) in `apps/desktop/src/renderer/src/features/file-explorer/__tests__/upload-job-toast.test.ts`
  covers: clicking Retry → calls `retry()` callback + dismisses old toast +
  unsubscribes old progress feed.
- Test (h) in the same file covers: after Retry fires, `onJobDispatched`
  with a NEW jobId opens a new toast bound to a fresh progress
  subscription. This is the round-trip §11.6 step (3) describes.
- Bug 1 fix commit `cc40fb1` ensures `job-failed` events translate to
  terminal `status: "failed"` upload-progress events (verified by 5 new
  tests in `event-bridge.upload-progress-translation.test.ts`).

**Re-verification command:** From the worktree root with the dev build up,
queue 5 files via the dashboard card or toolbar Upload dialog, then `kill`
the fs-sync-service process from another terminal. Observe each toast.

**Owner:** unassigned. To do during the next environment-loop pass for
this feature, or to be folded into the broader manual-QA suite.

---

## add-file-explorer-drag-drop-upload — §10 a11y + visual polish

**Scenario** (per `openspec/changes/add-file-explorer-drag-drop-upload/tasks.md` §10):

- §10.1 Manual a11y check in the dev build:
  - tab through the toolbar → Upload button receives focus with visible ring
  - tab into the Upload dialog → focus trapped; Escape closes
  - conflict dialog action buttons reachable by Tab; checkbox labeled
- §10.2 Manual contrast check:
  - amber-600 active overlay text on amber-600/8 tint → confirm WCAG AA
  - muted-foreground blocked overlay body on white → confirm WCAG AA
- §10.3 Visual regression: screenshot the active overlay, blocked overlay
  (each state), Upload dialog, and conflict dialog; add to
  `docs/screenshots/` (if that directory is the convention) or attach
  to the change's archive notes.

**Status:** PENDING — manual smoke confirmation deferred. The component
implementations have been verified through unit + composite tests:
- shadcn primitives (Dialog, Button, Checkbox) handle focus-trap +
  Escape-to-close out of the box.
- `aria-label` / `role="status"` / `aria-live="polite"` are present on
  drop-zone overlay (drop-overlay.tsx).
- Conflict dialog checkbox has `aria-label` matching the visible
  text (conflict-resolution-dialog.tsx).
- The design.md visual contract was followed throughout the
  implementation, with WCAG AA contrast asserted in design.md
  ("amber-600 on white at 15px/600 = 4.66:1 ✓; muted-foreground body
  on white passes ✓").

**Why deferred:** Visual regression screenshots and manual tab-through
require a running dev build with a human at the keyboard. Will be
captured in the next visual-QA pass alongside §11.4 / §11.6.

**Re-verification command:** Boot the dev build (`./dev.sh` from worktree
root). Tab through the toolbar, Upload dialog, and a forced conflict
dialog. Capture screenshots of the four overlay/dialog states.

**Owner:** unassigned. To do during the next environment-loop pass for
this feature.

---

## add-drive-oauth-browser-consent — §1 GCP OAuth client + Actions secrets + `.env.local` (HUMAN prerequisite)

**Scenario** (per the archived `openspec/changes/archive/2026-04-25-add-drive-oauth-browser-consent/tasks.md` §1.1–1.3):

- §1.1 Register a "Desktop app" OAuth 2.0 client in the org-owned GCP
  project (Google Cloud Console → APIs & Services → Credentials → Create
  Credentials → OAuth client ID → Desktop app). Enable the Google Drive
  API in the same project, configure the consent screen with `auth/drive`
  scope, and add internal dev accounts as test users. Capture the
  `client_id` + `client_secret`.
- §1.2 Add `FT5_GOOGLE_OAUTH_CLIENT_ID` and
  `FT5_GOOGLE_OAUTH_CLIENT_SECRET` to GitHub Actions secrets
  (Settings → Secrets and variables → Actions). Verify CI can read them
  by echoing their **lengths only** in a dry-run workflow step.
- §1.3 Create local `apps/desktop/.env.local` (gitignored — pattern
  added by this change) from the committed `apps/desktop/.env.example`
  template, populated with the two values from §1.1. Rebuild via
  `pnpm --filter @ft5/desktop build:all` so electron-vite's `loadEnv`
  picks them up at the `define` map.

**Status:** PENDING — operational, never automatable.

**Why deferred:** These are one-time human ops. The codebase wires
everything correctly (verified by `apps/desktop/src/main/__tests__/oauth-build-constants.test.ts`
and the `electron.vite.config.ts` non-dev fail-fast guard); they only
take effect once a real client + secret exist. The `FT5_DEV_CREDENTIALS=1`
override path is available as a smoke-test workaround that does not
need any of this (`README.md` Section 2).

**Re-verification command:** With §1 complete, run `pnpm --filter @ft5/desktop build:all`
and grep the resulting `apps/desktop/dist/main/index.js` for the client
ID — the build inlines it at the `__FT5_GOOGLE_OAUTH_CLIENT_ID__`
identifier. Length-only check (never echo the value).

**Owner:** unassigned (HUMAN). Required for §12.1–§12.4 below to be
runnable against real Google credentials.

---

## add-drive-oauth-browser-consent — §12.1 fresh add + real GCP client smoke

**Scenario** (per the archived tasks.md §12.1): Run `pnpm -F @ft5/desktop dev`
with `apps/desktop/.env.local` containing real credentials and
`FT5_DEV_CREDENTIALS` UNSET. Click Add Datasource → Google Drive →
Connect. The system browser opens to the Google consent page. Complete
consent. The dialog auto-closes. A new card appears in the dashboard.
Upload a small file. Confirm the file appears at the Drive root.

**Status:** BLOCKED on the follow-up change `implement-datasource-onboarding`.

**Why deferred:** This change ships the OAuth UI + main-process broker
correctly. After `completeWith(code)` succeeds, the engine's
`decorateIntent` calls `credentialStore.put(...)` — but
`apps/desktop/src/main/index.ts` wires `noopCredentialStore` per the
broader architecture's "Decision 1 — credential ownership lives on the
service" (wire-fs-sync-service). The fs-sync service's stubbed
`sync:authenticate-start` / `sync:authenticate-complete` handlers are
where credential persistence should land; until those are implemented
(by `implement-datasource-onboarding`), the registry row is created
but no credentials reach the service. Exploring the new card returns
`Failed to load: no credentials registered for datasourceId=…`. See
the archived `design.md` "Known gap — credential persistence" entry.

**Re-verification command:** After `implement-datasource-onboarding`
merges, repeat the §12.1 manual flow. The desktop broker should
forward the `AuthResult` to the service via
`client.authenticateComplete(...)`; the service's
`ConfigFileCredentialStore` writes to `~/ft5/sync_app/credentials.json`
or its `--dev` equivalent; exploring the card succeeds and shows the
Drive root.

**Owner:** unassigned. Pick up alongside `implement-datasource-onboarding`.

---

## add-drive-oauth-browser-consent — §12.2 revoke + reconnect smoke

**Scenario** (per the archived tasks.md §12.2): After §12.1, open
Google Account → Security → Third-party apps → revoke the OAuth grant.
Wait for the card to move to error state with the `auth-revoked`
banner. Click the "Reconnect" button on the banner. The browser
re-opens to the Google consent page. Complete consent. The card
returns to `connected`. A fresh sync succeeds.

**Status:** BLOCKED on `implement-datasource-onboarding`.

**Why deferred:** Same gap as §12.1 — the Reconnect path goes through
`startConsent({providerId, datasourceId: <existing>})` and ends in the
same `completeWith` → `noopCredentialStore.put(...)` no-op. Even if
the visual flow works (banner appears, Reconnect opens browser,
consent succeeds, banner clears), the credentials still don't reach
the fs-sync service. Sync will fail with the same "no credentials
registered" error.

The renderer's reconnect path is unit-tested in
`apps/desktop/src/renderer/src/features/datasources/__tests__/card-auth-error-banner.test.tsx`
(11 tests covering banner-on-auth-class-error, Reconnect → startConsent,
consent-completed → card flips to connected via store refresh).

**Re-verification command:** Same as §12.1 (post `implement-datasource-onboarding`),
plus the revoke step from the Google Account UI.

**Owner:** unassigned. Pick up alongside `implement-datasource-onboarding`.

---

## add-drive-oauth-browser-consent — §12.3 cancel mid-consent smoke

**Scenario** (per the archived tasks.md §12.3): With real GCP
credentials in `.env.local` (§1 done), run `pnpm -F @ft5/desktop dev`,
click Add Datasource → Google Drive → Connect. The browser opens to
Google. Without completing consent, close the dialog in the desktop app
(X / Escape / outside-click). The browser tab can be left open or
closed. The OAuthForm calls `cancelConsent({sessionId})` on unmount
(D7 invariant fix). No card materialises in the dashboard. If the user
later clicks Continue in the still-open browser tab, the broker's
loopback server has already torn down — no late `consent-completed`
event reaches the store.

**Status:** PENDING — testable today once §1 is complete.

**Why deferred:** Requires a running dev build with real OAuth
credentials. Unit-tested in
`apps/desktop/src/renderer/src/features/datasources/__tests__/oauth-form.test.tsx`
(3 unmount-cancel tests covering: post-Connect unmount fires
cancelConsent; no-Connect unmount does NOT fire cancelConsent;
post-terminal-state unmount still fires cancelConsent — broker is
idempotent). The broker's `cancel()` idempotency is covered in
`apps/desktop/src/main/oauth/__tests__/consent-broker.test.ts` task 4.4.

**Re-verification command:** With dev build up, click Connect, wait
for the browser, then close the desktop dialog. Confirm dashboard has
no new card. Open DevTools → `await window.api.datasources.list()` to
double-check.

**Owner:** unassigned. Easy bench test once §1 is done.

---

## add-drive-oauth-browser-consent — §12.4 5-min timeout smoke

**Scenario** (per the archived tasks.md §12.4): Click Connect to start
a consent session. Leave the browser tab idle for 5 minutes (don't
click Continue). The desktop dialog should surface "Consent timed out
— please try again" with a Retry button. Clicking Retry should reset
the session and start a fresh `startConsent` flow.

**Status:** PENDING — testable today once §1 is complete.

**Why deferred:** Real-wall-clock test — fiddly to wait through. The
broker's 5-minute timer is unit-tested with `vi.useFakeTimers()` in
`consent-broker.test.ts` task 4.5 ("Timer fires at 5 minutes": advance
300_001 ms, assert `consent-timeout` emitted, server closed, pending
session cleared) and task 4.6 ("Timer is cancelled on successful
completion": complete at t=60_000, advance past t=300_001, assert NO
`consent-timeout` event). The renderer's timeout-state copy + Retry
button path is tested in `oauth-form.test.tsx` task 8.3.

**Re-verification command:** With dev build up, click Connect, leave
the browser tab idle for 5 min 5 s, observe the dialog. Click Retry,
complete the second consent normally.

**Owner:** unassigned. Pair with §12.3 in a single bench session.
