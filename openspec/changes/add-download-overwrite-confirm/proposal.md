# Proposal: Add overwrite-confirm prompt for downloads to existing toPath

**Status**: Stub. Spawned during `add-download-resilience` §11.19 manual smoke on 2026-05-01 — surfaced when the user re-downloaded a file to the same `toPath` and the existing file was silently overwritten with no warning. Addresses Bug 5 from the §11.19 smoke (the other four bugs landed in iter-3 / iter-4 / iter-5 of `add-download-resilience`; this one was deferred as out of scope).

## Why

`files:download` currently calls `deps.fs.createWriteStream(params.toPath, { flags: "w", start: 0 })` on the first cycle, which truncates any existing file at `toPath` without asking. The user's rationale for the smoke catch (paraphrased): "I downloaded the file, looked at it, then re-downloaded the same file to test something else — and the original was just gone, no warning." For local sync workflows where the desktop folder is the canonical user store, a silent overwrite is destructive — there's no undo, no recycle-bin trip, just the new bytes overwriting the old.

The renderer's first-run download flow (`add-engine-rename-download` §22) prompts for a default folder + filename naming convention; the orchestrator calls a `RenameConflictDialog` for source-side conflicts (renaming over an existing remote file). Both surface the user's intent. The download path skipped this affordance — symmetric coverage closes the gap.

`add-engine-rename-download` shipped a `RenameConflictDialog` component that already encodes the "overwrite / rename / cancel" decision matrix; reusing it for the download case keeps UX consistent (`apps/desktop/src/renderer/src/features/file-explorer/RenameConflictDialog.tsx`). The handler boundary is well-defined: the renderer must answer the user's intent BEFORE the IPC `files:download` call lands, OR the handler must be capable of pausing mid-flight to surface the prompt.

## What this change does

- Detect existing file at `toPath` BEFORE issuing `engine.downloadFile`. Two natural insertion points:
  - **Renderer-side pre-check**: a new IPC `files:stat-local` command (or extension of an existing one) lets the orchestrator probe `toPath` synchronously before dispatching `files:download`, then surface the existing `RenameConflictDialog` if the file exists.
  - **Service-side gate**: `files:download` handler probes `toPath` after `validateToPath` and returns a new error tag (`tag: "destination-exists"`) the renderer recognises and routes through `RenameConflictDialog`. After user picks "overwrite", the renderer re-issues `files:download` with a new `force` / `policy` field.
- Add a "rename" path that auto-suffixes the filename per the existing source-side rename convention (`name (1).ext`, `name (2).ext`, ...) so users can keep both copies trivially.
- Add a "cancel" path that aborts the download before any bytes flow.
- Surface the choice via the existing `RenameConflictDialog` — same chrome, same a11y, same keyboard shortcuts.

## Out of scope

- **Whole-folder overwrite confirmation.** Bulk-download flows aren't yet wired (downloads are per-file today). When folder downloads land, the policy will need a "apply to all" option; that's a separate change.
- **Recycle-bin / trash routing of overwritten files.** Native OS trash is platform-specific (`shell.trashItem` on Electron) and worth its own scope.
- **Diff preview before overwrite.** "Show me what would change" is appealing but expensive for binary files. A future change might surface basic metadata (size + modifiedAt) in the dialog.
- **Per-datasource policy defaults.** "Always overwrite for Drive, always rename for S3" preferences would live in settings; deferred.
- **Conflict for in-flight concurrent downloads.** The handler's existing `findByKey` guard already rejects a second `files:download` for the same `(datasourceId, sourcePath)`; that's a separate failure mode (concurrent same-source) from this one (conflicting destination).

## Open questions (resolve during `/opsx:propose`)

1. **Where does the conflict gate live — renderer pre-check vs service-side response?** Pre-check is simpler (single IPC round-trip up front) but races the file system between the check and the actual download. Service-side gate is race-free (the handler holds the only window) but introduces a new error tag and renderer state machine. Pick based on race tolerance.
2. **Default action when the dialog opens.** "Cancel" is safest (no destructive default). "Rename" is friendliest (keeps both files). "Overwrite" is what the user usually wanted (matches today's silent behaviour). Pick one as keyboard-default; document the choice.
3. **Auto-rename suffix convention.** Match the existing rename-on-source pattern (`name (1).ext`) for consistency, or use a timestamp (`name 2026-05-02.ext`) to make collision detection trivial. The first matches `add-engine-rename-download`; the second avoids the iterative-probe cost.
4. **Skip the dialog when the existing file is byte-identical to the about-to-download file.** Hash-compare is cheap if the provider advertises one. Useful for "I downloaded this two minutes ago and clicked again by accident." Or always prompt — simpler, never wrong.
5. **Hydration / app-restart semantics.** If a download was in-flight and the app restarted before the conflict gate fired (rare — the gate fires before any bytes flow today), no special handling. Confirm during proposal.

## Acceptance criteria (once promoted)

- Re-downloading a file that already exists at `toPath` surfaces the `RenameConflictDialog` with three options (overwrite / rename / cancel).
- "Overwrite" proceeds with `flags: "w"` and the existing destructive behaviour — same as today, but now opt-in.
- "Rename" auto-generates a new filename with the agreed suffix convention, the download lands at the new path, both files coexist on disk.
- "Cancel" aborts the download before any bytes flow; no `download-failed` event, no partial file. Idempotent: clicking Cancel a second time has no effect.
- Test coverage: one test per option (overwrite / rename / cancel) at the orchestrator-and-handler boundary; one renderer test for the dialog wiring; one fs-sync integration test that the gate actually fires before `engine.downloadFile`.
- The handler's existing `findByKey` concurrent-rejection guard remains untouched — different failure mode.
- Spec delta in `file-explorer` and `fs-sync-service` capabilities.

## Provenance

- Spawned during `add-download-resilience` §11.19 user manual smoke on 2026-05-01 by user dev2@forti5.tech. User's exact phrasing (paraphrased): "I downloaded `<file>`, then re-downloaded the same file to test the cancel button — and the original was just overwritten without asking."
- iter-4 deferred this fix to its own change (the iter-4 scope was already wide — duplicate failure toasts, missing cancel button, no progress percentage, range-not-honored terminal). Iter-5 closed the other four bugs; this stub captures the deferred fifth.
- The pre-existing `RenameConflictDialog` component (`apps/desktop/src/renderer/src/features/file-explorer/RenameConflictDialog.tsx`) shipped in `add-engine-rename-download` and is reusable for this case — the dialog's three-option matrix matches verbatim. No new UI component needed.
- The architectural choice between renderer-side pre-check and service-side gate is genuinely open; advisor input + brainstorming during `/opsx:propose` will close it.
