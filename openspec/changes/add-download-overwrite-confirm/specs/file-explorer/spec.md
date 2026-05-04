## ADDED Requirements

### Requirement: Download conflict resolution prompts via reused dialog with hint metadata

When `window.api.files.download` rejects with `{ tag: "conflict", existingPath, existingSize?, existingModifiedAt? }`, the renderer SHALL surface a modal dialog presenting three actions — Overwrite, Keep both, Cancel — and re-dispatch (or abort) based on the user's choice. The dialog SHALL reuse the existing `RenameConflictDialog` component (`apps/desktop/src/renderer/src/features/file-explorer/rename-conflict-dialog.tsx`) with download-specific copy passed via the `title` and `description` props. When `existingSize` or `existingModifiedAt` is populated on the envelope, the dialog SHALL render a hint block above the existing-path block, formatted as `"<size> • modified <relative-time>"` (e.g., `"4.2 MB • modified 2 minutes ago"`); when both fields are absent, the hint block is omitted.

The renderer's download orchestrator SHALL:

- Initial dispatch: invoke `window.api.files.download(req)` with `req.conflictPolicy === "fail"` (the default; renderer SHALL NOT omit the field).
- On `tag: "conflict"` envelope: invoke the registered `DownloadConflictPrompt` port (parallel to the existing `RenameConflictPrompt`) with `existingPath`, `existingSize`, `existingModifiedAt`. The port resolves with the user's choice: `"overwrite" | "keep-both" | "cancel"`.
- `"overwrite"` → re-dispatch `window.api.files.download(req)` with `req.conflictPolicy = "overwrite"`. Same job key (`(datasourceId, sourcePath, toPath)`); the service truncates the existing destination and proceeds.
- `"keep-both"` → re-dispatch with `req.conflictPolicy = "keep-both"`. The service computes a new `effectiveTargetPath` server-side and the response's `savedPath` reflects the actual landing filename.
- `"cancel"` → abort the orchestrator's pending state immediately. No re-dispatch is made; no `download-failed` event is awaited; the registry never holds an entry for this attempt. Subsequent clicks on Cancel for an already-cancelled prompt are no-ops.
- For ANY non-conflict error envelope: route through the existing per-entry pending/error state (see "Rename, delete, and download are async operations" requirement), unchanged.

The dialog component SHALL accept `title` and `description` as `RenameConflictDialogProps` fields, defaulting to the rename copy already in use. The download flow passes:

- `title`: `"Download destination already exists"`
- `description`: `"A file already exists at the download destination. Choose how to proceed."`

The dialog component SHALL accept the new optional hint fields (`existingSize`, `existingModifiedAt`) and render them in a `text-muted-foreground text-xs` line above the existing-path block when at least one is present. Rename callers continue to render path-only as today.

The dialog SHALL NOT autofocus on any destructive action button. Tab-order is Overwrite → Keep both → Cancel; Escape and overlay-click route through Cancel; Enter does nothing without explicit focus on a button. WCAG AA contrast is preserved (amber-600 Overwrite, neutral Keep both, ghost Cancel).

#### Scenario: Initial download dispatch carries `conflictPolicy: "fail"` by default

- **WHEN** the renderer's download orchestrator initiates a download (e.g., user clicks Download in the context menu)
- **THEN** the orchestrator invokes `window.api.files.download({ datasourceId, path, toPath, conflictPolicy: "fail" })`; the renderer SHALL never omit `conflictPolicy` from the request literal

#### Scenario: Conflict envelope routes through the dialog with hint metadata

- **WHEN** `window.api.files.download` rejects with `{ ok: false, error: { tag: "conflict", existingPath: "/Users/alice/Downloads/welcome.pdf", existingSize: 4194304, existingModifiedAt: "2026-05-05T12:30:00.000Z" } }`
- **THEN** the renderer invokes the registered `DownloadConflictPrompt` with `(existingPath, existingSize, existingModifiedAt)`; the dialog renders title `"Download destination already exists"`, description `"A file already exists at the download destination. Choose how to proceed."`, a hint line reading `"4.0 MB • modified <relative-time>"` (formatted by the renderer's existing byte-formatter and time-formatter), and the existing-path block with `/Users/alice/Downloads/welcome.pdf`; three action buttons render in order Overwrite, Keep both, Cancel; no button is autofocused

#### Scenario: User chooses Overwrite — re-dispatch with policy "overwrite"

- **WHEN** the user clicks the Overwrite button (or selects it via Tab + Enter); the prompt resolves with `"overwrite"`
- **THEN** the renderer re-dispatches `window.api.files.download({ datasourceId, path, toPath, conflictPolicy: "overwrite" })` with the same `(datasourceId, path, toPath)` triple as the initial dispatch; on success the response carries `savedPath === toPath` (the existing file was truncated and replaced); the registry holds a single entry for the dispatch (no leak from the initial fail attempt)

#### Scenario: User chooses Keep both — re-dispatch with policy "keep-both" and observed savedPath

- **WHEN** the user clicks the Keep both button; the prompt resolves with `"keep-both"`
- **THEN** the renderer re-dispatches with `conflictPolicy: "keep-both"`; on success the response carries `savedPath` matching `<dir>/<basename> (1)<ext>` (or higher integer if `(1)` was also taken); the renderer's success toast / Open / Show-in-folder actions reference the `savedPath` from the response, NOT the original `toPath`

#### Scenario: User chooses Cancel — no re-dispatch, no registry entry, no toast

- **WHEN** the user clicks the Cancel button (or presses Escape, or clicks the overlay); the prompt resolves with `"cancel"`
- **THEN** the renderer aborts the orchestrator's pending state without making a second `window.api.files.download` call; no `download-failed` toast renders; no registry entry exists for this attempt; subsequent re-clicks on Cancel are no-ops

#### Scenario: Conflict envelope without hint fields renders path-only block

- **WHEN** `window.api.files.download` rejects with `{ ok: false, error: { tag: "conflict", existingPath: "/Users/alice/Downloads/welcome.pdf" } }` (no `existingSize`, no `existingModifiedAt`)
- **THEN** the dialog renders title and description per the download copy; the hint line is OMITTED; the existing-path block renders as today

#### Scenario: Rename caller continues to use path-only dialog with rename copy

- **WHEN** `window.api.files.rename` rejects with `{ ok: false, error: { tag: "conflict", existingPath: "/parent/bar.pdf" } }`
- **THEN** the dialog renders the existing rename copy (`title: "File already exists"`, `description: "A file at this path already exists. Choose what to do for this rename."`); the hint line is omitted; the rename flow's behavior is unchanged from before this change

#### Scenario: No autofocus on destructive button — Enter without focus is a no-op

- **WHEN** the dialog opens (in either rename or download mode); the user has not Tabbed to any specific button
- **THEN** focus rests on the dialog container; pressing Enter does NOT trigger any action; the user must Tab to a button (Overwrite, Keep both, or Cancel) and press Enter, OR click the button, to commit a choice

#### Scenario: Escape closes via Cancel path

- **WHEN** the dialog is open (in either rename or download mode); the user presses Escape
- **THEN** the dialog closes; the prompt resolves with `"cancel"`; the calling flow takes the cancel path
