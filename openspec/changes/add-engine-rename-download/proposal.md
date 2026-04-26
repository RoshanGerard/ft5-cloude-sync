# Proposal: Wire engine-backed `files:rename` and `files:download`

**Status**: Stub. Spawned by Non-Goals in `add-invalid-datasource-state`'s
`design.md` on 2026-04-25; previously referenced by name in
`wire-file-explorer-to-service` design.md as the prerequisite for
re-enabling renderer affordances.

## Why

`wire-file-explorer-to-service` migrated `files:list`, `files:stat`,
`files:search`, and `files:remove` from the mock backend to the live
engine, but kept `files:rename` and `files:download` on the mock
backend (`apps/desktop/src/main/ipc/files/mock-fs.ts`). The renderer
disables both affordances for non-mock datasources via
`isEngineBacked(providerKind)` checks with tooltip
"Rename is coming in a future release (see change
add-engine-rename-download)" — i.e., this change is named in the UX
copy.

To deliver the affordances, this change must:

1. Add `renameFile` / `renameDirectory` and `downloadFile` methods to
   the engine's `DatasourceClient<T>` interface (or refine the
   existing `getMetadata` + `uploadFile` pair if rename can be modeled
   as fetch-and-rewrite).
2. Implement per-provider strategies for Drive / OneDrive / S3 — each
   has different rename + download semantics (Drive uses
   `files.update` with `name`; OneDrive uses PATCH; S3 has no rename
   primitive — either copy + delete or refuse).
3. Migrate the main-process IPC handlers off `mock-fs.ts`.
4. Re-enable the renderer's Rename + Download affordances; update the
   `isEngineBacked` check or remove it entirely.
5. Delete `mock-fs.ts` once nothing references it.

## Out of scope

- Bulk rename / bulk download. v1 is single-entry only, matching the
  current renderer affordances.
- In-place rename of folders on S3 (S3 has no folder primitive — a
  folder rename means iterate-and-rewrite every key, which is a
  separate scoped feature).
- Resumable downloads. Single-shot download to a user-picked path; if
  the network drops mid-download the user re-tries.
- The `<ConfirmRenameDialog>` UX (currently inline rename via
  `EntryNameCell` is sufficient).

## Open questions (resolve during `/opsx:propose`)

1. **S3 rename strategy.** S3 has no rename primitive. Options:
   (a) Implement as `CopyObject` + `DeleteObject` and emit
       `file-created` + `deleted` events accordingly.
   (b) Refuse with `tag: "unsupported"` for S3.
   Recommend (a) — closer to user expectation; (b) hides a real
   limitation behind a confusing error.
2. **Download destination.** Use Electron's `dialog.showSaveDialog`
   to pick the path, or stream to a default
   `~/Downloads/<basename>` and surface a path-not-customizable
   warning? Recommend `dialog.showSaveDialog`.
3. **Conflict handling on rename.** If the target name already exists
   in the same folder, do we (a) reject with `tag: "conflict"`,
   (b) auto-suffix, or (c) prompt the user? Existing upload flow
   uses (c); rename SHOULD match. Reuse the
   `<ConflictResolutionDialog>` component.
4. **Folder rename**: Drive supports it directly; OneDrive supports
   it; S3 requires copy-and-delete-keys. Defer S3 folder rename
   to a follow-up if needed.
5. **Renderer re-enablement order.** Land rename first (less risky),
   then download (file I/O on the main process). Or both
   together? Per-PR is safer.

## Acceptance criteria (once promoted)

- Engine's `DatasourceClient<T>` exposes `renameFile`,
  `renameDirectory`, and `downloadFile` (signatures TBD by
  promotion).
- All three strategies implement them; contract tests pass for each.
- Main-process IPC handlers for `files:rename` and `files:download`
  delegate to the engine; `mock-fs.ts` is deleted.
- Renderer's `isEngineBacked` check is removed; Rename + Download
  affordances are enabled for all providers (with provider-specific
  caveats surfaced via tooltip if any).
- Existing renderer tests pass with the affordances enabled (the
  current `aria-disabled="true"` assertions are flipped or
  removed).
- New composite test exercises rename and download against a real
  fixture for each provider.

## Provenance

- Spawned by `add-invalid-datasource-state` design.md Non-Goals on
  2026-04-25.
- Originally referenced as `add-engine-rename-download` in
  `wire-file-explorer-to-service` (archived 2026-04-24).
- Named by the renderer's tooltip copy ("see change
  add-engine-rename-download") — promoting this change closes a
  user-visible string match.
