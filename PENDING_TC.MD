# Pending Test Cases

Manual / E2E smoke scenarios that have NOT been visually confirmed but whose
underlying code paths are unit-test covered. Each entry documents the
scenario, why it was deferred, and the unit-test that proves the code path
is correct in isolation. Items here are NOT blockers for merging the change
they originated from — they are surfaced for a later environment-specific
verification pass.

---

## NOTE — `implement-datasource-onboarding` shipped (supersedes several blockers below)

The change `implement-datasource-onboarding` (merged on the feature branch
`feature/implement-datasource-onboarding`) closes the credential-persistence
gap that blocked the following entries below:

- **add-drive-oauth-browser-consent §12.1** ("fresh add + real GCP client smoke") — was BLOCKED on this change. **Now PENDING** — testable once the (renamed) `§1 HUMAN ops` entry is complete.
- **add-drive-oauth-browser-consent §12.2** ("revoke + reconnect smoke") — same.
- **add-invalid-datasource-state §13.1** ("missing credential → Reconnect → entries appear") — same.
- **add-invalid-datasource-state §13.2** ("corrupt credential → Remove → datasource gone") — same. The Remove path now also cleans up the per-user credential entry via the new `sync:delete-credentials` handler.
- **add-invalid-datasource-state §13.3** ("dashboard banner → Reconnect → banner unmounts") — same.

**Updated `§1 HUMAN ops` instructions** (originally `add-drive-oauth-browser-consent §1.1–1.3`):
The OAuth app config no longer lives at `apps/desktop/.env.local` (build-time inlined). It now lives at `~/ft5/sync_app/config.json` (service-owned, manual copy + edit).

Updated steps:
1. Register a "Desktop app" OAuth 2.0 client in the org-owned GCP project + the equivalent in Azure for OneDrive (full step-by-step in `README.md` § "Provider OAuth registration (one-time setup)").
2. `cp services/fs-sync/config.example.json ~/ft5/sync_app/config.json` (or PowerShell equivalent on Windows; full command in `README.md`).
3. Edit the file and populate `clientId` + `clientSecret` for each provider intended to be used.
4. The previous GitHub Actions secrets `FT5_GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` are obsolete (the build-time defines were removed in this change). Repo secrets stay provisioned-but-unused per design.md Decision 4 (deferred housekeeping).

**Re-verification commands** for §12.x / §13.x: with the new `~/ft5/sync_app/config.json` populated, run `pnpm -F @ft5/desktop dev` and follow each scenario's existing manual flow. The credentials persistence path is now real (service writes via `ConfigFileCredentialStore.put` on every successful authenticate) and the §13.5 "missing-credential surface" arms now reach `<InvalidDatasourceState>` end-to-end.

**Owner:** unassigned (HUMAN). To do during the next environment-loop pass.

---

## implement-datasource-onboarding — §33.1–§33.7 manual smoke (rollover from this change)

The seven §33 subtasks defined in this change's `tasks.md` are HUMAN-only manual smoke flows requiring real GCP/Azure credentials and browser interaction. Marked done in `tasks.md` with the rationale "deferred to PENDING_TC.MD" since per-scenario unit + integration coverage is in place. They overlap heavily with the §12.x and §13.x entries above (which they unblock); confirming any of those entries is sufficient to confirm the equivalent §33 subtask. The §33.7 cancel-mid-consent and 5-min-timeout flows match `add-drive-oauth-browser-consent §12.3` and `§12.4` (already PENDING-testable today entries).

**Owner:** unassigned (HUMAN). Pair with the `§1 HUMAN ops` setup pass.

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

---

## add-invalid-datasource-state — §13.1 missing credential → Reconnect → entries appear

**Scenario** (per `openspec/changes/add-invalid-datasource-state/tasks.md` §13.1):

With a connected real-GCP Google Drive datasource (id `ds-X`),
manually delete its credential from the fs-sync-service credential
file (`~/ft5/sync_app/credentials.json`, or the `--dev` equivalent).
Open the Explore page for `ds-X`. The file-explorer should render
`<InvalidDatasourceState>` (red `AlertTriangle` icon, headline "This
datasource needs reconfiguring", body "Its connection details are
missing or invalid…", neutral primary `Reconnect` button, ghost
destructive `Remove datasource` button). Click `Reconnect`. The
system browser opens to Google's consent page. Complete consent. The
state component should unmount and the file entries should appear
without a manual page refresh.

**Status:** PENDING — visually unconfirmed; gated on a real GCP
credential pipeline.

**Why deferred:** Requires the prerequisite `add-drive-oauth-browser-consent`
§1 (HUMAN ops: real GCP client + Actions secrets + `.env.local`) AND
the gap-closing change `implement-datasource-onboarding` (so
credential persistence actually reaches the fs-sync service). Without
the latter, even a successful Reconnect leaves the credentials in the
no-op store and the explorer would re-enter the same invalid-datasource
state on retry. The renderer + main + sync paths for THIS change are
unit-test covered:

- `apps/desktop/src/renderer/src/features/file-explorer/states/__tests__/invalid-datasource.test.tsx`
  — 10 tests: render structure, role/aria; pending/completed/failed
  /cancelled/timeout lifecycle; providerId guard; Remove button → callback.
- `apps/desktop/src/renderer/src/features/file-explorer/__tests__/file-explorer-composite.test.tsx`
  — composite arm: list rejects with `tag:"invalid-datasource"` →
  state renders → Reconnect → `startConsent` → mocked `consent-completed`
  → `store.retryLoad()` → entries render.
- `services/fs-sync/src/main/__tests__/resolve-client.test.ts` —
  proves missing-credential path throws `DatasourceError({tag:"invalid-datasource",retryable:false})`.
- `services/fs-sync/src/commands/files-error-mapping.test.ts` —
  proves engine `invalid-datasource` → envelope `invalid-datasource`.

**Re-verification command:** With `add-drive-oauth-browser-consent` §1 done
AND `implement-datasource-onboarding` merged, boot the dev build, add
a Google Drive datasource, manually delete `~/ft5/sync_app/credentials.json`
for that id (or its `--dev` equivalent), open the Explore page,
observe `data-testid="file-explorer-state-invalid-datasource"`,
click Reconnect, complete browser consent, observe entries.

**Owner:** unassigned. Pair with `implement-datasource-onboarding` env
loop.

---

## add-invalid-datasource-state — §13.2 corrupt credential → Remove → datasource gone

**Scenario** (per tasks.md §13.2):

With a connected real-GCP Google Drive datasource (id `ds-X`),
manually corrupt its credential JSON (e.g. overwrite `accessToken`
with the empty string in `~/ft5/sync_app/credentials.json`). Open the
Explore page for `ds-X`. The file-explorer should render
`<InvalidDatasourceState>` (the engine's `factory.create` rejects the
credential shape via the per-provider `validateCredentialShape` helper
introduced in §3.7). Click `Remove datasource`. The shared
`<ConfirmRemoveDatasourceDialog>` opens with the destructive Remove
button focused. Confirm. The route navigates back to the dashboard;
the card for `ds-X` is gone.

**Status:** PENDING — visually unconfirmed; gated on a real GCP
credential pipeline.

**Why deferred:** Same prereqs as §13.1 — real GCP credentials and
`implement-datasource-onboarding` for the onboarding side, though the
remove path itself does not depend on the onboarding fix. Without
real credentials, the `factory.create` shape-validator is exercised
via unit tests but not against the live JSON-on-disk path.

Unit coverage for the Remove path:
- `apps/desktop/src/renderer/src/features/datasources/__tests__/confirm-remove-dialog.test.tsx`
  — 10 tests: visibility, copy, destructive Remove focus on open,
  Escape cancels, click Cancel/Remove → onCancel/onConfirm.
- `apps/desktop/src/renderer/src/features/file-explorer/__tests__/file-explorer-composite.test.tsx`
  — composite arm: Remove button click opens dialog; confirm dialog
  dispatches `actions.remove({datasourceId})`.
- Wrong-shape credential rejection in `packages/fs-datasource-engine/src/__tests__/factory-invalid-datasource.test.ts`
  — proves S3-shape credentials passed to a `google-drive` providerId
  surface as `tag:"invalid-datasource"` from `factory.create`.

**Re-verification command:** Boot dev build, add a Drive datasource,
edit the credential JSON to break it (truncate the token, set it to
""), open Explore, click Remove datasource, confirm the dialog,
observe dashboard card removal.

**Owner:** unassigned. Pair with `implement-datasource-onboarding` env
loop.

---

## add-invalid-datasource-state — §13.3 dashboard banner → Reconnect → banner unmounts

**Scenario** (per tasks.md §13.3):

With a misconfigured real-GCP datasource (registry row exists but
credentials missing — same setup as §13.1), open the dashboard
WITHOUT navigating into the file-explorer. The `DatasourceCard`
should render the new `<InvalidDatasourceBanner>` inline below the
meta row: copy "Datasource needs reconfiguring — credentials are
missing or invalid.", `Reconnect` (variant=outline) + `Remove`
(variant=outline, destructive-tinted). The bare error paragraph
should NOT render. Click `Reconnect`. The browser opens to Google's
consent page. Complete consent. As `summary.status` flips back to
`connected` via the dashboard's existing event-stream refresh, the
banner unmounts naturally.

**Status:** PENDING — visually unconfirmed; gated on a real GCP
credential pipeline.

**Why deferred:** Same `implement-datasource-onboarding` dependency
as §13.1. The banner's render-and-unmount path is unit-tested:

- `apps/desktop/src/renderer/src/features/datasources/__tests__/card-invalid-datasource-banner.test.tsx`
  — 11 tests: banner renders iff `errorKind === "invalid-datasource"`;
  Reconnect → `startConsent({providerId, datasourceId})` once;
  Remove → confirm dialog opens; confirm → `remove({datasourceId})`
  once; consent-completed → banner unmounts via `DatasourcesDashboard`
  summary refresh; non-invalid `errorKind` does NOT render the banner;
  structural a11y assertions (aria-label, accessible names, tab
  order). `jest-axe` / `vitest-axe` is not a dev-dep on this package
  per the `features/datasources/__tests__/a11y.test.tsx` convention;
  structural assertions stand in for the axe sweep.

**Re-verification command:** Boot dev build, induce the
invalid-datasource state (delete credential), open the dashboard,
observe `data-testid="invalid-datasource-banner"` on the card without
opening Explore, click Reconnect, complete consent, observe banner
unmount as the card flips to `connected`.

**Owner:** unassigned. Pair with `implement-datasource-onboarding` env
loop.

---

## add-invalid-datasource-state — §13.4 dependency note

§13.1 and §13.2 both require **`add-drive-oauth-browser-consent` §1**
(HUMAN ops: real GCP OAuth client, Actions secrets,
`apps/desktop/.env.local` populated) per the existing PENDING_TC entry
above titled "add-drive-oauth-browser-consent — §1 GCP OAuth client
+ Actions secrets + `.env.local` (HUMAN prerequisite)". Both also
benefit from `implement-datasource-onboarding` to close the
credential-persistence gap referenced in the §12.1 / §12.2 entries
above; without that follow-up, even a successful Reconnect lands the
credentials in `noopCredentialStore` and the next list call re-enters
the invalid-datasource state. §13.3's dashboard-banner flow inherits
the same dependencies because it shares the consent path with §13.1.
