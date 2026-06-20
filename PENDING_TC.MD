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

---

## add-engine-rename-download — §27 manual smoke (deferred)

The eight §27 subtasks defined in this change's `tasks.md` are HUMAN-only
end-to-end smoke flows against real Google Drive / OneDrive / S3
datasources and the dev build. None can be exercised automatically; per
CLAUDE.md they are recorded here with a one-line pointer to the unit /
integration test that proves the equivalent code path is correct in
isolation. The implementation closed via 1175 desktop tests + 2432
full-repo tests passing on commit `c021fba`.

- **§27.1** Boot the dev build with a real Drive datasource; rename a
  file; download a file; confirm the file lands at the configured
  default folder; click Open and Show in folder. **Covered in isolation
  by:** `packages/fs-datasource-engine/src/strategies/googledrive-client.test.ts`
  (§7.1–§7.12) + `packages/fs-datasource-engine/src/strategies/googledrive-client.contract.test.ts`
  (§10.1) + `services/fs-sync/src/commands/files-rename.test.ts` (§12.1)
  + `services/fs-sync/src/commands/__tests__/files-download.test.ts` (§13)
  + `apps/desktop/src/renderer/src/features/file-explorer/__tests__/use-download-orchestrator.test.ts`
  (§23) and `download-job-toast.test.ts` (§24) for the Open / Show in
  folder Sonner CTAs.
- **§27.2** Same flow with a real OneDrive datasource. **Covered in
  isolation by:** `packages/fs-datasource-engine/src/strategies/onedrive-client.test.ts`
  + `packages/fs-datasource-engine/src/strategies/onedrive-client.contract.test.ts`
  (§8.x parity arms — rename via PATCH, download via `/content` GET with
  Range) + the same `files-rename.test.ts` / `files-download.test.ts`
  service handlers (provider-agnostic: they resolve via the engine factory).
- **§27.3** Same flow with a real S3 datasource (file rename uses
  copy+delete; folder rename surfaces the disabled tooltip). **Covered
  in isolation by:** `packages/fs-datasource-engine/src/strategies/s3-client.test.ts`
  + `packages/fs-datasource-engine/src/strategies/s3-client.contract.test.ts`
  (§9.x — file rename via `CopyObject` + `DeleteObject`, folder rename
  rejects with `tag:"unsupported"`); renderer-side disabled-tooltip arm
  in `apps/desktop/src/renderer/src/features/file-explorer/__tests__/context-menu.test.tsx`
  (§22 S3-folder-rename branch).
- **§27.4** Boot the dev build, start a download against a large
  fixture, close the app mid-download; reopen the app; verify the toast
  hydrates and the download completes. **Covered in isolation by:**
  `apps/desktop/src/renderer/src/features/file-explorer/__tests__/download-job-toast.test.ts`
  (§24.3 hydration test — `onJobHydrated` mounts toast bound to existing
  jobId + subscribes to in-flight progress feed) +
  `apps/desktop/src/main/sync/on-connect-hydrate-downloads.test.ts`
  (§18.9 — on-supervisor-connect queries `downloads:list-active` and
  forwards the snapshot to the renderer) + service-side
  `services/fs-sync/src/downloads/__tests__/registry.test.ts` (registry
  retains in-flight jobs across the IPC reconnect).
- **§27.5** Boot the dev build, start a download that will exceed
  1 hour (or simulate via a token-expiry mock); verify the auth-resume
  splice happens transparently and the download completes. **Covered in
  isolation by:** `googledrive-client.test.ts` mid-stream auth-expired
  arms (§7.11 — synthetic 401-after-N-bytes, assert single refresh +
  Range request issued + content joined byte-exactly) + the parallel
  `onedrive-client.test.ts` and `s3-client.test.ts` auth-resume arms +
  `services/fs-sync/src/commands/__tests__/files-download.test.ts`
  retry-loop (§13.5 — handler advances `rangeStart` from
  `fs.stat(toPath).size` and validates `contentRange.start === rangeStart`
  before resuming the local pipe).
- **§27.6** Boot the dev build, toggle "Always ask where to save";
  verify every Download click opens the save dialog. **Covered in
  isolation by:** `apps/desktop/src/renderer/src/features/settings/__tests__/downloads-store.test.ts`
  (§20 — `alwaysAsk` + `defaultFolder` localStorage round-trip) +
  `apps/desktop/src/renderer/src/features/file-explorer/__tests__/use-download-orchestrator.test.ts`
  (§23 — orchestrator routes through `dialog.showSaveDialog` when
  `alwaysAsk === true` OR Shift+Click modifier set, and through
  `defaultFolder` otherwise).
- **§27.7** Boot the dev build with
  `localStorage.removeItem("ft5.downloads.defaultFolder")`; click
  Download; verify the first-run modal appears and blocks dismiss.
  **Covered in isolation by:**
  `apps/desktop/src/renderer/src/features/file-explorer/__tests__/first-download-modal.test.tsx`
  (§21 — modal renders iff `defaultFolder == null`, blocks dismiss until
  user picks a folder, "Use this folder" sets store + closes modal,
  "Browse…" opens OS picker) +
  `apps/desktop/src/renderer/src/features/file-explorer/__tests__/use-download-orchestrator.test.ts`
  (§23.3 — orchestrator opens the modal before dispatching when no
  default folder exists).
- **§27.8** Trigger a rename conflict on Drive; verify
  `RenameConflictDialog` appears and re-dispatch with each policy works.
  **Covered in isolation by:**
  `apps/desktop/src/renderer/src/features/file-explorer/__tests__/rename-conflict-dialog.test.tsx`
  (dialog render + Overwrite/Keep both/Cancel CTA wiring) +
  `apps/desktop/src/renderer/src/features/file-explorer/__tests__/store.test.ts`
  rename re-prompt arms (§25 — initial dispatch with
  `conflictPolicy:"fail"`; on `tag:"conflict"`, prompt with
  `existingPath`; user choice drives a re-dispatch with the new policy
  and refreshes `pendingOp.startedAt`; Cancel clears `pendingOp`
  without surfacing an error) + the engine's per-strategy rename
  conflict tag arms (`googledrive-client.test.ts` / `onedrive-client.test.ts`
  / `s3-client.test.ts` rename-conflict cases).

**Status:** PENDING — eight HUMAN-only smoke flows. The codebase is
unit-test green; the deferred items only require the dev build with
real provider credentials to verify end-to-end. Items §27.4 and §27.5
are the trickiest to bench-reproduce (mid-flight close+reopen for
hydration; 1-hour wait or token-expiry mock for auth-resume).

**Re-verification command:** With a populated
`~/ft5/sync_app/config.json` (per `add-drive-oauth-browser-consent §1`)
and at least one real datasource registered, run
`pnpm -F @ft5/desktop dev` and walk each scenario.

**Owner:** unassigned. To do during the next environment-loop pass,
likely paired with the still-open §13.1 / §13.2 / §13.3 flows and
`implement-datasource-onboarding §33.x`.

---

## add-download-resilience — §9.4 manual wifi-drop smoke + §10.3 follow-up window

**Scenario** (per `openspec/changes/add-download-resilience/tasks.md` §9.4):
Cold-start the desktop app via `pnpm dev` from the worktree root, log
into a datasource (Drive / OneDrive / S3 — any with a 100MB+ file),
start a download. When the toast shows ~30–60% progress, disable wifi
for ~10 seconds, then re-enable. Watch the toast through the outage
and resume.

**Expected visual contract** (per design.md Decision 5):

1. Before outage — `Downloading welcome.pdf — 62%` (Sonner loading
   template, ONE spinner glyph, percentage in the message).
2. During outage — title `Downloading welcome.pdf`; subtext
   `Reconnecting… (1/5)` (or `(2/5)`, `(3/5)` depending on outage
   length and exponential backoff schedule); ONE spinner glyph
   replacing the percentage; progress bar pauses at the last byte
   position (does not rewind).
3. After resume — snaps back to `Downloading welcome.pdf — 63%` (or
   wherever the byte counter reaches); the loading-template chrome
   re-renders in place.
4. On completion — final downloaded file's hash matches the provider-
   advertised hash.

**Specific failure modes to watch for** (advisor checkpoint #2):

The retrying-state implementation in `download-job-toast.ts` reuses the
loading toast id when calling `toast.custom(buildRetryingRender, { id:
existing.toastId })`. Same-id reuse is REQUIRED by Decision 5's
"progress bar position remains unchanged" constraint — Sonner keeps
the slot when the id matches. However, the success-path post-archive
fix at lines 469-472 (commit `2762401`) demonstrated that on a
loading→custom transition, Sonner's loading-variant chrome can persist
alongside the custom render, OR the custom render can inherit a
dismiss-animation race. Either failure manifests as one of:

- **Two spinners visible simultaneously** during the Reconnecting phase
  (loading-template spinner-chrome leaking through the custom render).
- **Stale `62%` text** still showing alongside the Reconnecting subtext
  (loading-template message-text leaking).
- **Toast disappears prematurely** during the loading→custom or
  custom→loading swap (dismiss-animation race resurrecting).

If ANY of those reproduce, the fix is fresh-id pattern: dismiss the
loading id and spawn the custom render on a fresh id (e.g.
`<toastId>-retrying`) for the retrying state, then dismiss that id
and spawn the loading template on `<toastId>-resumed` on the next
`downloading` event. This is a code change, NOT a follow-up
PENDING_TC entry.

**Status:** PENDING — visually unconfirmed. Closes §9.4 (manual smoke)
and §10.3 (PENDING_TC entry IF §9.4 surfaces unexpected behavior — this
entry is the §10.3 placeholder; the moment §9.4 is run successfully,
both boxes can be flipped or, if a failure mode reproduces, the fix-
cycle dispatches and §10.3 lands a PENDING_TC entry pointing at the
fix commit).

**Why deferred:** Requires a running dev build with live network
manipulation. The component pieces are fully unit-tested:

- **Service handler retry-loop:** `services/fs-sync/src/commands/__tests__/files-download.test.ts`
  §6.4–§6.16 (13 deterministic integration tests using
  `vi.useFakeTimers()`) cover network-drop recovery, budget exhaustion,
  byte-progress reset, walltime ceiling, `retryAfterMs` honor, cancel-
  during-sleep, auth-revoked bypass, range-not-honored / range-mismatch
  / integrity-failed delete-before-emit, byte-count-mismatch keep,
  unlink-failure non-fatal, and auth-expired co-existence with
  environmental retry. 5 consecutive sync-service runs (§9.6) confirmed
  zero flake.
- **Renderer toast retrying state:** `apps/desktop/src/renderer/src/features/file-explorer/__tests__/download-job-toast.test.ts`
  §8.1–§8.8 plus §8.cov-1 / §8.cov-2 cover: subtext switch on
  download-retrying, snap-back to progress on next downloading,
  tooltip with engineCause + waitMs, auth-expired invisible to
  renderer, cancel during retrying state, hydration → retrying
  transition, hydration → downloading no-op, exhausted-retries tag
  rendered with verbatim message, retrying-as-first-event defensive
  path, retrying → failed transition with retry callback survival.
- **Wire shape coherence:** verified by the final cross-cutting
  reviewer (commit `9bccafd` predecessor) — `download-retrying`
  payload declared once in `packages/ipc-contracts`, emitted by the
  service handler, mirrored in the renderer's local DownloadEvent
  union; no field declared-but-unconsumed or consumed-but-undeclared.

The Sonner runtime swap behavior (which the chrome-leak failure modes
above turn on) is the only thing the unit tests cannot observe. The
`(c-postsmoke)` test at `download-job-toast.test.ts:224-292` documents
the success-path discovery; the retrying-state chrome behavior may or
may not reproduce the same bug — only manual visual verification can
tell.

**Re-verification command:**

```bash
cd <worktree-root>
pnpm dev
```

Then: log in to a datasource, queue a 100MB+ download, drop wifi ~10s
mid-flight, observe the toast through the three states above.

**Owner:** unassigned. Pair with any other manual-QA pass against the
dev build; the §9.4 smoke is independent of all other PENDING_TC
entries (does not require real GCP creds, does not gate on
`implement-datasource-onboarding`, etc.).

---

## migrate-upload-orchestration-out-of-engine — §17.3–§17.6 manual smoke

The four §17 smoke flows defined in this change's `tasks.md` exercise
the post-migration upload pipeline end-to-end against real provider
SDKs (Drive / OneDrive / S3). They were deferred to
`PENDING_TC.MD` per CLAUDE.md verification rules — unit + integration
coverage is in place for every code path; only the real-provider
visual / network behavior can confirm the migration in production.

### §17.3 — packaged-build happy-path upload to Drive / OneDrive / S3

**Scenario:** With the desktop app running against a real GCP / Azure
/ AWS datasource, drag a small file (~1 MB) into the file-explorer.
Expect:

1. Sonner toast opens "Uploading <basename>" with a 0% bar.
2. Bar animates to 100% as bytes flow.
3. Toast flips to "Uploaded <basename>" terminal state.
4. The remote datasource shows the new file at the target path
   (verify via the provider's web UI).

**Why deferred:** Requires real provider credentials and the
`~/ft5/sync_app/config.json` setup from
`add-drive-oauth-browser-consent §1`. Code paths verified via:

- `services/fs-sync/src/commands/__tests__/files-upload.test.ts`
  (12 tests including happy-path: validates request, mints
  uploadJobId, calls engine.uploadFile, emits one file-created on
  resolve, replies success).
- `apps/desktop/src/main/ipc/files/__tests__/upload.test.ts` (7
  tests asserting direct-RPC forwarding).
- `apps/desktop/src/renderer/src/features/file-explorer/__tests__/upload-job-toast.test.ts`
  (10 tests asserting the toast lifecycle).

**Re-verification command:**
```bash
cd <worktree-root>
pnpm -F @ft5/desktop dev
```
Drag a file onto the file-explorer for each provider; confirm the
toast lifecycle and the remote file's existence.

**Owner:** unassigned (HUMAN). Pair with the §1 HUMAN ops setup pass.

### §17.4 — mid-upload cancel + provider session cleanup

**Scenario:** Start a large upload (10+ MB to Drive / OneDrive
resumable session, or S3 multipart). Within 1-2s, click the toast's
Cancel action. Expect:

1. Toast flips to silent dismiss (`upload-cancelled` is silent per
   `upload-job-toast.ts (j)`).
2. Provider-side session is cleaned up:
   - **Drive**: `DELETE <sessionUrl>` issued via fresh
     AbortController + 5s timeout (per design.md Decision 3).
   - **OneDrive**: `DELETE <uploadUrl>` issued same way.
   - **S3**: `Upload.abort()` issues `AbortMultipartUploadCommand`
     internally.
3. No orphan file appears at the target path on the provider.

**Why deferred:** The fresh-AbortController cleanup behavior is
unit-tested at the strategy layer
(`packages/fs-datasource-engine/src/__tests__/strategy-contract.ts`
and per-strategy `*-client.test.ts`), but provider-side cleanup
requires inspecting the provider's pending-multipart / pending-
session list.

**Verification artifacts:**

- Drive: `/upload/drive/v3/files?uploadType=resumable` session URL
  should not appear in `gdrive list-resumable-uploads` (or
  equivalent debug API). Drive GCs after ~1 week regardless.
- OneDrive: Graph API `/me/drive/items/{item-id}/createUploadSession`
  list — clean within 5s of cancel.
- S3: `aws s3api list-multipart-uploads --bucket <name>` — should
  show no in-flight multipart for this `(bucket, key)`.

**Owner:** unassigned (HUMAN). Pair with §17.3.

### §17.5 — concurrent-target rejection (Decision 10)

**Scenario:** Start an upload to a target slot. Without waiting for
it to finish, attempt a SECOND upload to the same
`(datasourceId, targetPath)`. Expect:

1. Second upload's dispatch call rejects synchronously at the
   service boundary with `{ tag: "conflict", message: "An upload
   to this path is already in progress", existingUploadJobId,
   existingPath }`.
2. The renderer surfaces a Sonner error toast with the message; the
   IN-FLIGHT upload's toast is unaffected.
3. The first upload completes normally to the original target.

**Why deferred:** The conflict envelope and the renderer toast
binding are unit-tested
(`apps/desktop/src/renderer/src/features/file-explorer/__tests__/use-upload-orchestrator.test.ts`
"surfaces a tag: 'conflict'" + the concurrent-target-rejection cases
in `files-upload.test.ts`), but verifying the UX requires a real
multi-stage upload (the unit harness completes synchronously).

**Owner:** unassigned (HUMAN). Pair with §17.3.

### §17.6 — app-restart-while-uploading hydrate

**Scenario:** Start a large upload. While bytes are still flowing,
quit the app (force-quit if needed). Restart. Expect:

1. The hydrate channel `files:hydrate-active-uploads` fires on
   first supervisor connect.
2. If the service was killed alongside the renderer (typical), the
   `UploadRegistry` is empty post-restart and no toast hydrates —
   the in-flight upload state is lost (in-memory only per
   design.md Non-Goals; resumability is `add-upload-resilience`'s
   future scope).
3. If the service somehow survived (atypical for a force-quit),
   the in-flight `UploadJobEntry` SHOULD surface as a Sonner
   toast subscribed to the live `sync:event-stream`.

**Latent edge case from chunk F (advisor-flagged):** A user DB
created BEFORE this change's merge may carry `kind: 'upload'` rows
in `state: 'running'` from the legacy queue path. On first startup
post-migration, the scheduler's recovery path at
`services/fs-sync/src/scheduler/scheduler.ts:152-167` transitions
those rows to `failed` with `errorTag: "unsupported"` and
`errorMessage: "no executor registered for kind=upload"`. Graceful
— no hang or crash — but the user may see a "Sync failed" entry
on the dashboard for that historical row. Acceptable degradation;
worth observing during this smoke pass to confirm the recovery
path actually fires (vs being silent).

**Why deferred:** Force-quit + supervisor-survival timing is
fiddly. Unit-tested code paths:
`apps/desktop/src/main/sync/on-connect-hydrate-uploads.test.ts`
(4 tests, fire-once invariant + payload forwarding +
service-error fallback).

**Re-verification:** Start a deliberate slow upload (throttle the
network), force-quit (Task Manager / `kill -9`), reopen, observe
hydrate behavior. For the legacy-DB recovery edge: import a
pre-chunk-F user DB or manually `UPDATE jobs SET state = 'running'
WHERE kind = 'upload'` before launch.

**Owner:** unassigned (HUMAN). Pair with §17.3.

---

## migrate-upload-orchestration-out-of-engine — dead `onUploadProgress` mock harness lines

**Scenario:** ~25 renderer test files retain dead mock setup of the
form `onUploadProgress: vi.fn().mockReturnValue(() => {})` for a
preload binding (`window.api.datasources.onUploadProgress`) that
chunk E removed. Type-safe under the loose mock typing the test
harness uses, so they compile and don't affect behavior. Cleanup-
worthy per CLAUDE.md "If you are certain that something is unused,
you can delete it completely."

**Status:** PENDING — not blocking. Polish-only.

**Files affected** (full list in chunk-E commit message):
`page.test.tsx`, `a11y.test.tsx` (file-explorer + datasources),
`download-toaster-wiring.test.tsx`, `file-explorer-composite.test.tsx`,
`handle-download-wiring.test.tsx`, `rename-guard.test.tsx`,
`states-integration.test.tsx`, `search-ui.test.tsx`,
`upload-toaster-wiring.test.tsx`, plus ~10 `features/datasources/__tests__/*.tsx`.

**Re-verification:** Grep `onUploadProgress` in
`apps/desktop/src/renderer/src` — the only legitimate mentions
post-cleanup should be tombstone comments (zero callers).

**Owner:** unassigned. Suitable for a follow-up cleanup PR; safe to
do mechanically (the lines are dead code).

## add-download-overwrite-confirm — §8.5 manual smoke (deferred)

The §8.5 manual smoke is a HUMAN-only end-to-end flow against the dev build:
download a file, re-download the SAME file to an existing destination, and
exercise the conflict dialog's three outcomes. It can't run in the headless
worktree; per CLAUDE.md it's recorded here with pointers to the unit /
integration tests that prove each branch in isolation. The change's
automated surface is fully green (full suite 301 files / 2692 passed / 9
skipped on `feature/add-download-overwrite-confirm`).

- **§8.5a** Re-download a file to the same destination → conflict dialog
  appears with the size + "modified \<absolute-date\>" hint line. **Covered
  by:** `files-download.test.ts` §2.1 (fail-policy conflict envelope w/
  `existingSize`/`existingModifiedAt`) + `__integration__/download-conflict.test.ts`
  §7.1 (gate through `buildCommandHandlers` + real fs) +
  `rename-conflict-dialog.test.tsx` (download-mode hint render) +
  `use-download-orchestrator.test.ts` §5.1 (prompt invoked with hint metadata).
- **§8.5b** Choose Overwrite → existing file replaced. **Covered by:**
  `files-download.test.ts` §2.5 (overwrite truncates) +
  `use-download-orchestrator.test.ts` §5 (re-dispatch `conflictPolicy:"overwrite"`) +
  `ipc-round-trip.test.ts` §7.3 (overwrite re-dispatch succeeds).
- **§8.5c** Choose Keep both → `name (1).ext` lands alongside the original.
  **Covered by:** `keep-both-suffix.test.ts` + `files-download.test.ts`
  §3–§4 (suffix loop + suffixed `savedPath`) + `download-conflict.test.ts`
  §7.2 (real-fs `O_CREAT|O_EXCL` writes `welcome (1).pdf`, original untouched).
- **§8.5d** Choose Cancel → no toast, no file change, idempotent. **Covered
  by:** `use-download-orchestrator.test.ts` §5 (cancel → no re-dispatch,
  resolves null, no `download-failed` toast).

**Status:** PENDING — HUMAN smoke. Not blocking; automated coverage complete.
**Owner:** unassigned (the original Bug 5 was raised by dev2@forti5.tech during
the `add-download-resilience` §11.19 smoke).

## FOLLOW-UP (pre-existing bug, surfaced by add-download-overwrite-confirm) — per-card upload toaster → duplicate upload toasts on multi-card dashboards

**Not part of `add-download-overwrite-confirm`** — surfaced by this change's
`card-*` test fixes during the full-suite green-up, then confirmed by the
§9 code review. Recorded here so it isn't lost; suitable for promotion to its
own OpenSpec stub (spawn on `master` post-merge, NOT on the overwrite-confirm
branch — keep concerns unmixed).

**Symptom:** `DatasourceCard` instantiates its own upload-job toaster per
card (`card.tsx:150` — `useMemo(() => createUploadJobToaster(), [])`), and the
toaster subscribes to the GLOBAL `window.api.sync.onEvent` stream filtered
only by event **kind** (`uploading`/`file-created`/`upload-failed`/
`upload-cancelled`), NOT by `datasourceId` (`upload-job-toast.ts:258-266`). On
the first unseen `uploading` event it spawns `toast.loading(...)`
(`upload-job-toast.ts:~396`). So with N connected datasource cards mounted, a
single upload event fans out to all N toasters → potentially N user-visible
duplicate toasts. This is ALSO the production root cause behind why the
`card-*` tests' `toHaveBeenCalledTimes(1)` sync assertions broke (each card
adds a 2nd `sync.onEvent` listener).

**Lineage (pre-existing, NOT this change):** per-card toaster introduced in
`670a117`; the event source was rewired from the legacy
`datasources.onUploadProgress` channel onto `sync.onEvent` by
`migrate-upload-orchestration-out-of-engine` §13.4.

**OPEN QUESTION (resolve before sizing the fix):** does Sonner de-duplicate
by toast id? If the toaster keys each toast deterministically on
`uploadJobId`, the N spawns may COLLAPSE to a single toast (Sonner upserts on
matching id), which would downgrade this from "N duplicate toasts" to "N
redundant no-op upserts" — annoying but not user-visible duplication. NOT
investigated yet; check `upload-job-toast.ts` toast-id construction +
Sonner's id-upsert semantics before deciding severity.

**Likely fix (if confirmed user-visible):** a single app-level upload toaster
(mounted once at the dashboard/root, not per card), OR datasource-scoped
filtering in the per-card subscription.

**Status:** PENDING follow-up — NOT blocking the overwrite-confirm merge (this
branch does not touch the toaster/card production code, so the merge cannot
worsen it). **Owner:** unassigned.

## DEFERRED SMOKE (migrate-engine-retry-policy-to-consumer) — real provider token-lifecycle re-auth against a running system

**Not blocking archive/merge** — automated coverage is complete (engine 320 +
fs-sync 529 + full-repo 2711 pass; both independent code reviews clean).
Deferred per CLAUDE.md `## Workflow` step 8 ("feature exercised against a
running system"): this change moves auth-expired refresh ownership from the
engine (`withRefresh`, removed) to fs-sync (`withAuthRefresh` → the new public
single-flight `refreshCredentials()`). Every automated test drives
`auth-expired` through FAKE `DatasourceClient`s — NONE exercise an ACTUAL
provider access-token lifecycle.

**Verify against a live datasource (Drive / OneDrive / S3-STS):**
1. **Read/mutate ops across a real token expiry** — let the access token
   expire, then invoke list / stat / search / rename / remove / upload. Expect:
   fs-sync's `withAuthRefresh` calls `refreshCredentials()` once, the op
   succeeds transparently, and the desktop EventBridge relays `token-refreshed`
   to the renderer.
2. **Download across a mid-stream token expiry** — start a large download,
   force expiry mid-stream. Expect: ONE handler-driven `refreshCredentials()`
   + resume from bytes-on-disk (206 Partial Content), completes + integrity
   passes. Bound: at most ONE mid-stream re-auth per download — a SECOND expiry
   surfaces `auth-revoked` (pre-existing limit, design.md Risks "[One auth
   refresh per download cycle]").
3. **Dead refresh token → `auth-revoked`** — revoke the refresh token, invoke
   any op. Expect: `refreshCredentials()` (or the re-issued GET) fails and the
   op surfaces wire `tag: "auth-revoked"` (not a silent hang, not
   `auth-expired`); renderer prompts reconnect.
4. **Mirror-sync (background) across a token expiry** — a scheduled mirror job
   whose token expires mid-run refreshes via the executor's `withAuthRefresh`
   and completes; a dead token lands the job `failed` (scheduler terminal, no
   intercept).

**Owner:** unassigned. (Optional follow-up stub for genuinely unbounded
hour-spanning re-auth — design.md Risks — only if smoke #2's one-per-download
bound proves insufficient in practice.)

---

## add-engine-listdirectory-pagination — deferred packaged-build smokes (2026-06-07)

The pagination flow (engine opaque-cursor `listDirectory` → fs-sync `files:list`
4-attempt env-retry → renderer store `loadMore`/`retryLoadMore` → the shared
Load-more region + Settings page-size) is fully implemented and the FULL repo
suite (304 files / 2809 tests) is green. BUT it has NEVER run against a real
provider or a packaged build. Every automated test mocks `window.api.files.list`
(renderer) or the `syncClient` (main); nothing exercises the live preload IPC
bridge or a real provider page-token round-trip. The preload binding was VERIFIED
a generic typed passthrough (`list: (req: FilesListRequest) => invoke(channel,
req)`, `preload/index.ts:171`) that forwards `cursor`/`pageSize` unchanged — so
the preload read is the only end-to-end evidence the wire fields reach the
engine; the smokes below are the real confirmation.

1. **>1000-item Drive folder Load-more flow (15.6)** — packaged build, open a
   Drive folder of >1000 entries. Expect: the initial page (default 500) renders
   with the Load-more affordance; each click appends the next provider page and
   advances the cursor; the affordance hides when `nextCursor === null`; the
   status row tracks `N+ items · N loaded` → `N items`. Then change Settings →
   Explorer → "Items loaded per page" and confirm the NEXT list call uses the new
   size (the current view does NOT auto-refresh). Confirm the busy state is the
   motion-free "Loading…" label (NOT a spinner — motion budget).
2. **Constrained-network retry surfaces (15.7)** — open the same folder on a
   throttled / flaky connection. Expect: a transient Load-more failure triggers
   fs-sync's 4-attempt env-retry (2s/5s/7s) transparently; on exhaustion the V-2
   page-load-failed row renders ("Couldn't load more entries" + the humanized
   WIRE tag + Retry); clicking Retry re-issues the SAME cursor with a fresh
   budget; already-loaded entries stay visible.
3. **Per-provider cursor round-trip** — confirm the opaque cursor round-trips on
   each provider: Drive `pageToken`, OneDrive `@odata.nextLink` (prefix-validated
   before re-issue), S3 `ContinuationToken` (single page per call — the internal
   auto-loop was removed). A stale/malformed cursor surfaces wire `tag: "other"`
   (engine `provider-error`), not a hang.

**Owner:** unassigned. Blocked on a packaged build + real datasource credentials
(same gate as add-drive-oauth-browser-consent §1 setup). Until run, treat the
pagination flow as automated-green but NOT yet provider-verified.

---

## migrate-engine-events-to-consumer — deferred running-system download-progress smoke (2026-06-20)

The engine `EventBus` removal is fully implemented and the FULL repo suite (302
files / 2767 tests) is green. The one behavioral change — the download-progress
throttle relocated from the engine-bus coalescer into the fs-sync download
handler (`options.onProgress` → a handler-local 1s-OR-10% coalescer with
flush-before-terminal) — is covered by dedicated handler tests (throttle gate,
flush-on-terminal for success AND failure, within-cycle wire value on resume).
BUT it has NEVER been eyeballed in a REAL download against a live provider; every
test drives the fake `downloadFile`'s `onProgress`. CLAUDE.md step 8 ("feature
exercised against a running system") is therefore explicitly DEFERRED here, not
met by the automated suite.

1. **Real download progress + throttle (running system)** — dev or packaged
   build, download a multi-MB file from a real datasource. Expect: the download
   toast updates at the throttled cadence (≤ ~1/s on a fast download, plus on 10%
   crossings) — NOT flooded at chunk frequency; the final 100% lands as a
   `downloading` BEFORE the terminal `file-downloaded`, and no progress update
   appears after the terminal; the download completes and the file is byte-correct.
2. **Resume-cycle progress** — interrupt mid-download (kill network) to force a
   range-resume (`rangeStart > 0`). Expect: progress continues without a renderer
   crash; the wire `bytesLoaded` is the engine's within-cycle value (UNCHANGED by
   this migration — the pre-existing resume-progress rough edge is preserved, not
   fixed; see design.md Decision 2 / Non-Goals).
3. **No renderer-observable regression from the bus removal** — confirm the
   renderer still receives `auth-*` events via `window.api.sync.onEvent` on
   reconnect, and the file explorer still updates after rename/delete (via RPC
   responses + the optimistic store) — i.e. removing the engine bus + the dead
   `datasources:event` path lost no renderer-facing behavior.

**Owner:** unassigned. Blocked on a real datasource + a running fs-sync service
(same gate as add-drive-oauth-browser-consent §1). Risk is low — the change is a
removal plus one throttle relocation, both heavily unit-tested — but treat the
bus removal as automated-green and NOT yet exercised against a running system
until these run.

---

## unify-datasource-reconnect-view — deferred reconnect-view smoke + focus follow-up (2026-06-20)

The explorer's two reconnect states (`auth-revoked` + `invalid-datasource`) are
unified into ONE shared in-place reconnect view, and Reconnect now works for
every datasource type (OAuth opens the browser; S3/credentials providers reveal
the keys form inline, threaded with the existing `datasourceId`). Renderer-only;
no service/IPC change. The FULL repo suite (303 files / 2778 tests) is green and
the parallel code review found no critical issues. BUT these are UI flows that
have NEVER been exercised against a running Electron app (worktree, no live
provider). CLAUDE.md step 8 ("feature exercised against a running system") is
therefore explicitly DEFERRED here.

1. **Google Drive reconnect inline (was the "nothing happens" case)** — put a
   Drive datasource into an auth-revoked / insufficient-scope state, open it in
   the explorer. Expect: the shared reconnect view (AlertTriangle, "This
   datasource needs reconfiguring", Reconnect + Remove) — NOT the old amber
   "Sign in again" view, and NOT a bounce to the dashboard. Click Reconnect →
   the browser opens in-place; on completion the folder re-lists and the view
   disappears.
2. **OneDrive reconnect inline** — same as (1) for OneDrive; confirm the
   experience is now identical to Drive (the original inconsistency is gone).
3. **S3 reconnect inline keys form (was the silent no-op)** — put an S3
   datasource into invalid-datasource (missing/invalid creds), open it. Click
   Reconnect → the AwsAccessKeyForm appears INLINE below the icon + "Reconnect
   Amazon S3" heading (keep-header, form below), with a Back control. Submit
   valid keys → the EXISTING datasource is re-authed (no new datasource minted)
   and the folder re-lists. Back returns to the prompt.
4. **Failed reconnect feedback** — trigger an authenticateStart failure (e.g.
   `service-config-missing`) on a Drive/OneDrive Reconnect. Expect: an inline
   error line (Decision 5), and Reconnect remains usable — no silent re-enable.

**Owner:** unassigned. Blocked on a real datasource + a running fs-sync service
(same gate as add-drive-oauth-browser-consent §1). The flows are automated-green
but NOT yet provider-verified.

### Follow-up (non-blocking) — keyboard focus on the inline-form transitions

The code review's accessibility reviewer flagged a MINOR, deferrable nicety:
when the inline credentials form is revealed (Reconnect → form) and dismissed
(form Back → prompt), keyboard focus drops to `document.body` because the
triggering button unmounts. This is not a WCAG AA failure and not a regression
(no prior in-page form swap existed); the approved Visual direction is silent on
it. Follow-up: on reveal, move focus to the form's first field; on Back, return
focus to the Reconnect button. Low priority.
