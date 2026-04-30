# Proposal: UI affordance to delete partial files left after a failed download

**Status**: Stub. Spawned during `add-download-resilience` brainstorming
on 2026-04-30.

## Why

`add-download-resilience` ships a partial-file disposition policy:

| Terminal cause | Disposition |
|---|---|
| Environmental budget exhausted | **Keep** |
| Wall-time ceiling reached | **Keep** |
| `auth-revoked` | **Keep** |
| User cancellation | **Keep** |
| Range-not-honored | Delete |
| Range-mismatch | Delete |
| Byte-count-mismatch | Delete |
| Integrity-failed | Delete |

The "keep" cases preserve the user's bandwidth investment so a future
attempt can resume from where the previous one stopped. The downside
is **orphan partial files accumulating** on the user's filesystem
when:

- Resume isn't attempted (user gives up after a transient failure).
- The user has no programmatic way to discover which files on disk
  are "partial downloads from a failed attempt" vs "intentional files."
- A 240MB file at `~/Downloads/seed.mp4` looks identical to a
  successful 240MB download — the toast disappears once dismissed,
  and there's no metadata trail.

Browser convention (Chrome's `.crdownload`, Firefox's `.part`) is to
suffix partial files so they're recognizable. We don't do that — the
file lives at the user-chosen `toPath` directly so the disposition is
"the file the user asked for, just incomplete."

This change adds two affordances that close the gap:

1. **A "Delete partial file" button** on the failure toast, next to
   "Retry." Clicking it unlinks `toPath` and dismisses the toast.
2. **Aggregate cleanup** of orphaned partials in the Downloads
   settings panel — surfaces a list of "kept partials from past
   failures" with bulk-delete + per-row delete, sourced from the
   download history (which lands in `migrate-download-registry-to-sqlite`,
   so this change has a sequencing dependency).

The first is implementable today with no infrastructure changes. The
second waits on durable history.

## Out of scope

- Auto-cleanup on app launch (sweeping orphans without user consent).
  Aggressive; risks deleting files the user wants to keep. Manual
  affordance only.
- Renaming partials to `.crdownload` or similar. Diverges from the
  current behavior where the partial lives at the chosen `toPath`,
  which is itself a deliberate choice in `add-engine-rename-download`
  (the user knows where their file went).
- Resuming a kept partial via "the next download attempt picks up
  where the last one left off automatically." Different change —
  would require the registry to outlive the toast and offer "Resume"
  semantics. Today, the user clicks Retry and the handler starts
  fresh.

## Open questions (resolve during `/opsx:propose`)

1. **Phase 1 scope vs full scope.** Phase 1 = just the toast button
   (no infra dependency). Phase 2 = the settings panel (depends on
   `migrate-download-registry-to-sqlite`). Recommend shipping Phase 1
   in this change; spawn a third stub for Phase 2 once the SQLite
   migration lands.

2. **Toast button placement.** Three layouts on the failure toast:
   - "Retry" + "Delete partial" + "Dismiss" (3 actions).
   - "Retry" + overflow menu containing "Delete partial" (compact).
   - Two separate toasts: one for the failure ("Retry"), one for
     the partial ("Delete file?"). Most intrusive.
   Recommend the first — explicit, discoverable, low cognitive load.
   The toast width accommodates 3 actions; existing `Sonner` API
   supports it.

3. **Confirmation prompt before delete.** Two-click vs one-click:
   - One-click: "Delete partial" deletes immediately, toast dismisses.
   - Two-click: "Delete partial" → secondary toast "Delete 240MB
     partial file? [Yes / Cancel]" → confirm to delete.
   Recommend one-click for partials < 1GB, two-click for ≥ 1GB.
   Threshold avoids the destruction-by-accident risk on big files
   while keeping common cases frictionless.

4. **What if the partial is already gone?** User manually deleted the
   file via Finder / Explorer between the toast appearing and the
   delete-button click. Handler's `unlink` rejects with ENOENT.
   Recommend treating ENOENT as success (the desired state is
   reached) — toast dismisses without an error message. Other
   failures (EACCES, EPERM) surface as a discreet "Could not delete:
   <reason>" inline in the toast.

5. **Telemetry.** Track click-through on "Delete partial" to confirm
   demand. If usage is < 1% of failed downloads, the affordance is
   removed in a follow-up. If usage is ≥ 10%, we know to invest in
   Phase 2's settings panel sooner. Recommend a single anonymous
   counter (no file paths / sizes) emitted to whatever telemetry
   pipeline the desktop app uses.

## Acceptance criteria (once promoted)

- The download failure toast (`apps/desktop/src/renderer/src/features/file-explorer/download-job-toast.ts`)
  renders a "Delete partial file" action alongside "Retry" when the
  failure's disposition is "kept" (per the matrix above). The action
  is hidden for "deleted" dispositions (no partial to delete).
- Clicking the action calls a new IPC command `files:delete-partial`
  with the `toPath`. The handler validates that the path is within
  the user's expected download directory (security guard reused from
  `validateToPath`), then `unlink`s.
- Per Q3, partials ≥ 1GB get a confirmation step.
- Per Q4, ENOENT is treated as success.
- Toast dismisses on success; reports inline error on failure.
- Phase 2 (settings panel for aggregate cleanup) is deferred to a
  follow-up stub spawned post-merge of `migrate-download-registry-to-sqlite`.
- Telemetry counter wired per Q5.

## Provenance

- Spawned during `add-download-resilience` brainstorming on 2026-04-30
  when the user approved the Q5 disposition policy. The "keep on
  failure" choice creates an orphan-partial problem that the proposal
  acknowledged ("a UI affordance 'Delete partial file' is wireable
  as a follow-up if telemetry shows users want it"). Rather than
  ship blind, this change makes the affordance a deliberate
  follow-up.
- Phase 2 (settings panel) depends on
  `migrate-download-registry-to-sqlite` for durable history. Phase 1
  (toast button) ships independently.
