# Proposal: Add overwrite-confirm prompt for downloads to existing toPath

**Status**: Stub. Spawned during `add-download-resilience` §11.19 manual smoke on 2026-05-01 — surfaced when the user re-downloaded a file to the same `toPath` and the existing file was silently overwritten with no warning. Addresses Bug 5 from the §11.19 smoke (the other four bugs landed in iter-3 / iter-4 / iter-5 of `add-download-resilience`; this one was deferred as out of scope).

## Why

`files:download` currently calls `deps.fs.createWriteStream(params.toPath, { flags: "w", start: 0 })` on the first cycle, which truncates any existing file at `toPath` without asking. The user's rationale for the smoke catch (paraphrased): "I downloaded the file, looked at it, then re-downloaded the same file to test something else — and the original was just gone, no warning." For local sync workflows where the desktop folder is the canonical user store, a silent overwrite is destructive — there's no undo, no recycle-bin trip, just the new bytes overwriting the old.

The renderer's first-run download flow (`add-engine-rename-download` §22) prompts for a default folder + filename naming convention; the orchestrator calls a `RenameConflictDialog` for source-side conflicts (renaming over an existing remote file). Both surface the user's intent. The download path skipped this affordance — symmetric coverage closes the gap.

`add-engine-rename-download` shipped a `RenameConflictDialog` component that already encodes the "overwrite / rename / cancel" decision matrix; reusing it for the download case keeps UX consistent (`apps/desktop/src/renderer/src/features/file-explorer/RenameConflictDialog.tsx`). The handler boundary is well-defined: the renderer must answer the user's intent BEFORE the IPC `files:download` call lands, OR the handler must be capable of pausing mid-flight to surface the prompt.

## What this change does

- Extend the `files:download` IPC request shape with a `conflictPolicy: "fail" | "overwrite" | "keep-both"` field, defaulting to `"fail"`. Mirror the rename precedent verbatim (`add-engine-rename-download` Decision 7) — no new error tag, no new state machine.
- Service-side gate in `services/fs-sync/src/commands/files-download.ts`: after `validateToPath` (~line 524) and before the concurrency guard (~line 540), probe `fs.stat(toPath)`. On `"fail"` + existing file → return `{ tag: "conflict", existingPath, existingSize, existingModifiedAt }`. On `"overwrite"` → proceed (existing `flags: "w"` at line 1018 truncates, unchanged). On `"keep-both"` → compute next free `name (N).ext` via atomic `O_CREAT|O_EXCL` probe, mutate the effective `targetPath`, proceed.
- Resume-of-self carve-out: skip the gate when `DownloadRegistry` already holds an entry matching `(datasourceId, sourcePath, toPath)` with `bytesDownloaded > 0` — that pre-existing partial belongs to the registry's own aborted download, not a foreign collision. Forward-compatible with `migrate-download-registry-to-sqlite` (today's in-memory registry evaporates on restart, but the carve-out is the right shape once SQLite rehydration lands).
- Renderer: route the `tag: "conflict"` envelope through the reused dialog component (see Capabilities). Dialog renders `existingPath`, `existingSize` (formatted), and `existingModifiedAt` (relative time). User choice (`"overwrite"` / `"keep-both"`) re-dispatches `files:download` with the chosen policy; `"cancel"` aborts client-side without any service round-trip.
- Extend `FilesCommandError` (`packages/ipc-contracts/src/files.ts`) with optional `existingSize?: number` and `existingModifiedAt?: string` (ISO 8601). Additive — no breakage for rename callers that don't populate them.

## Out of scope

- **Whole-folder overwrite confirmation.** Bulk-download flows aren't yet wired (downloads are per-file today). When folder downloads land, the policy will need a "apply to all" option; that's a separate change.
- **Recycle-bin / trash routing of overwritten files.** Native OS trash is platform-specific (`shell.trashItem` on Electron) and worth its own scope.
- **Diff preview before overwrite.** "Show me what would change" is appealing but expensive for binary files. A future change might surface basic metadata (size + modifiedAt) in the dialog.
- **Per-datasource policy defaults.** "Always overwrite for Drive, always rename for S3" preferences would live in settings; deferred.
- **Conflict for in-flight concurrent downloads.** The handler's existing `findByKey` guard already rejects a second `files:download` for the same `(datasourceId, sourcePath)`; that's a separate failure mode (concurrent same-source) from this one (conflicting destination).

## Capabilities

### Modified Capabilities

- `file-explorer` — renderer state machine handles the `tag: "conflict"` envelope on download dispatch; the existing `rename-conflict-dialog.tsx` component is parameterized via `title` / `description` props so the rename and download flows share one dialog with distinct copy and an optional hint-metadata block.
- `fs-sync-service` — `files:download` handler accepts a `conflictPolicy` field, gates on existing destination, and emits the conflict envelope with size + modifiedAt hints; resume-of-self detection lets paused-then-resumed downloads through the gate untouched.

### New Capabilities

None. All work folds into existing capabilities.

## Resolved during proposal

The five open questions from the stub are resolved in `design.md` `## Decisions` 1–5:

1. **Architectural lock-in: service-side gate via shared rename `conflictPolicy` enum.** Rejected the renderer pre-check option (TOCTOU race + two paths to truncation). See Decision 1.
2. **Default focus: no destructive autofocus.** Match the existing rename dialog's keyboard behavior (Tab to choose, Escape to cancel). See Decision 5.
3. **Suffix convention: `name (N).ext` via atomic `O_CREAT|O_EXCL`.** Matches rename precedent; race-free server-side. See Decision 2.
4. **Hash-based byte-identical skip: rejected.** Local-file hashing is expensive on large media; always prompt is simpler and never wrong. See Decision 3.
5. **Hydration / app-restart: resume-of-self carve-out.** Today's in-memory registry evaporates on restart so the carve-out is reachable mid-session only; the shape is forward-compatible with the SQLite rehydration migration. See Decision 4.

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
