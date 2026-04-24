# Proposal: Drag-and-drop file upload into the file explorer

**Status**: Stub. Discovered during smoke-testing of `wire-file-explorer-to-service` on 2026-04-24.

## Why

Dragging files from the OS file manager into the file explorer window does nothing today. The expected behavior — drop files onto the explorer, watch them upload to the currently-viewed folder — is not wired. Codebase audit confirms:

- No `onDrop` / `DataTransfer` / `dragover` handlers anywhere in the renderer.
- The only upload entry point is the datasource card's `Upload` button (`actions.upload({ datasourceId })`), which calls `window.api.datasources.upload` with no file-list parameter — the main process must be opening a native picker.
- `sync:enqueue-upload` command already exists on the sync-service side (added in `add-fs-sync-service`).
- Drag-and-drop was never implemented; not a regression from `wire-file-explorer-to-service`.

Modern desktop file apps (Google Drive, Dropbox, OneDrive) all support drag-and-drop as the primary upload affordance. The click-to-pick Upload button is fine as a fallback but shouldn't be the only path.

## Out of scope

- Changing the existing `datasources.upload` → `sync:enqueue-upload` plumbing — the command and event surface are already correct; this change is purely renderer-side drag-drop plus a file-path→upload-request bridge.
- File-system picker UI changes.
- Progress UI — `datasources.onUploadProgress` event channel already exists; consume it unchanged.

## Open questions (resolve during `/opsx:propose`)

1. **Drop target scope.** The whole file-explorer pane, or only the entries area (leaving toolbar / breadcrumb / details pane as non-drop zones)? Recommend: whole pane with a visible overlay when dragover is active, so accidentally dropping on the toolbar still triggers an upload.
2. **Multi-file drop.** Chrome/Electron's `DataTransfer.files` is a `FileList`. Upload request shape: does `sync:enqueue-upload` accept N paths in one call, or does the renderer dispatch N separate calls? Audit the existing command surface.
3. **Engine-backed vs mock datasources.** The file explorer supports both. Engine-backed upload needs the engine's `uploadFile` path; mock-fs needs its in-memory write path. Is the main-process routing already in place, or does this change need to touch `apps/desktop/src/main/ipc/` too?
4. **Drag-drop FROM the explorer OUT (to OS).** Out of scope for this change; tracked separately if desired.
5. **Visual feedback.** Dragover overlay style — follow the visual direction approved for `wire-file-explorer-to-service` (amber/blue/neutral semantics, Lucide iconography, Pattern-A full-replace)? Or a lighter-weight dashed-border overlay that doesn't replace the entries?
6. **Folder drop.** Chromium exposes folders via `DataTransferItem.webkitGetAsEntry()`. Recursive folder upload is a substantial engineering undertaking — defer or include?
7. **Disable rules.** Disabled states today: `disconnected`, `auth-revoked`, `syncing` (before first list resolves). Should the drop target also be disabled in these states? Probably yes — dropping files on a disconnected datasource can't queue to the sync-service.
8. **Engine-backed datasource provider path.** Where does the file land? The explorer's `currentPath`? The datasource's default upload folder? Ambiguity resolution.

## Acceptance criteria (once promoted)

- Dragging a file from OS over the file explorer shows a visible drop overlay.
- Dropping a file triggers `window.api.datasources.upload` (or equivalent path-bearing command) for the currently-viewed datasource; progress surfaces via the existing `onUploadProgress` channel.
- Multi-file drop uploads each file in parallel respecting the sync-service's existing concurrency policy.
- Drop is disabled when the datasource is in `disconnected` / `auth-revoked` / `syncing` states (mirror the delete-affordance gating).
- Vitest composite covers: dragover overlay appears; drop dispatches upload; drop on disabled state is a no-op.

## Provenance

- Raised by user dev2@forti5.tech on 2026-04-24 during smoke-testing of `wire-file-explorer-to-service`.
- Not a regression from that change; a never-implemented feature surfaced by smoke exploration.
