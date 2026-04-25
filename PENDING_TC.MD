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
