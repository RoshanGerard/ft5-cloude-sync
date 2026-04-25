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
