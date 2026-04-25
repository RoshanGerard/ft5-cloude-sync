# Proposal: Drag-and-drop file upload + in-app Upload dialog for the file explorer

## Why

Dragging files from the OS file manager into the file-explorer window does nothing today — modern desktop file apps (Google Drive, Dropbox, OneDrive) all make drag-and-drop the primary upload affordance. The existing `Upload from local…` quick action on the datasource card is also minimal: it opens an OS-native picker and dumps every uploaded file at the datasource root (`/<basename>`), regardless of where the user is browsing. Users who navigate into `/projects/2026` and want to upload a file there have no way to do so from the UI.

This change adds two connected upload affordances:
1. **Drag-and-drop** onto the file-explorer — drop files anywhere in the pane, they upload to the currently-viewed folder.
2. **A reworked in-app Upload dialog** — reachable from the datasource card's quick-action menu AND from a new Upload button in the file-explorer toolbar — that lets the user pick files (native OS picker) AND browse the datasource's folder tree to pick a destination folder. Conflict-per-file prompting (Overwrite / Keep both / Skip) before dispatch.

Raised by dev2@forti5.tech on 2026-04-24 during smoke-testing of `wire-file-explorer-to-service`. Not a regression — a never-implemented feature surfaced by exploration.

## What Changes

- **NEW** — Drag-and-drop handler on the file-explorer pane (`drop-zone.tsx` + `drop-overlay.tsx`). Dragover shows amber full-pane overlay with "Drop to upload here → /currentPath"; drop dispatches N parallel `files.upload` calls for multi-file drops.
- **NEW** — Drop target rejects folder drops (toast: "Folder upload is coming soon — drop individual files for now"). Detected via `DataTransferItem.webkitGetAsEntry()`.
- **NEW** — Blocked-state drop overlay (grey, no action) when datasource is `disconnected` / `auth-revoked` / `syncing`. Drop is a no-op.
- **NEW** — In-app Upload dialog (`upload-dialog.tsx`) with (a) files-to-upload list fed by a native OS picker and (b) destination-folder tree driven by `window.api.files.list`. Submit dispatches N `files.upload` calls. Destination defaults: current folder when opened from the explorer, root when opened from the dashboard card.
- **NEW** — Conflict-resolution dialog (`conflict-resolution-dialog.tsx`) — preflight `files.stat` on each target path; any collisions trigger a serial per-file Overwrite / Keep both / Skip prompt with "Apply to remaining" checkbox.
- **NEW** — Upload button in the file-explorer toolbar (Lucide `Upload` icon). Keyboard-reachable; opens the same dialog as the dashboard card's Upload quick-action.
- **NEW** — `window.api.files.upload({datasourceId, sourcePath, targetPath, conflictPolicy})` IPC surface — single-file, thin proxy over `syncClient.enqueueUpload`. Full four-layer wiring (contract, main handler, preload, renderer call site).
- **NEW** — `window.api.datasources.pickFilesToUpload()` IPC surface — opens native OS dialog with `properties: ["openFile", "multiSelections"]`, returns `{filePaths, canceled}`. Pure picker, no enqueue.
- **NEW** — Sonner toast per enqueued upload job; subscribes to `DATASOURCES_CHANNELS.uploadProgress` for that jobId; shows progress, turns green on complete, red with Retry on failure.
- **BREAKING** — `window.api.datasources.upload({datasourceId})` IPC is **REMOVED**. The old path-unaware, root-only upload flow is retired. The quick-action menu item "Upload from local…" still exists; it now opens the new dialog instead.
- **BREAKING** — Main-process `datasources.upload` handler and its tests (`upload.ts`, `upload.test.ts`, `upload.existing-renderer-compat.test.ts`) are removed. Renderer's existing `actions.upload({datasourceId})` call site is rewired to open the new dialog.

## Capabilities

### New Capabilities
<!-- None — this change extends existing capabilities. -->

### Modified Capabilities
- `file-explorer`: adds drag-and-drop upload, Upload toolbar button, in-app Upload dialog, conflict-resolution dialog, and the `files.upload` IPC surface.
- `datasources-ui`: replaces the main-process-picker Upload flow with an in-app dialog opened by the "Upload from local…" quick action; removes `datasources.upload` IPC in favor of `datasources.pickFilesToUpload` + `files.upload`.

## Impact

**Code:**
- `apps/desktop/src/renderer/src/features/file-explorer/` — new `drop-zone.tsx`, `drop-overlay.tsx`, `upload-dialog.tsx`, `conflict-resolution-dialog.tsx`, `use-upload-orchestrator.ts`; modifications to `file-explorer.tsx` (wrap in drop-zone), `toolbar.tsx` (add Upload button).
- `apps/desktop/src/renderer/src/features/datasources/` — modify the Upload quick-action handler to open the new dialog instead of calling `datasources.upload`.
- `apps/desktop/src/main/ipc/files/` — new `upload.ts` (thin proxy over `syncClient.enqueueUpload`).
- `apps/desktop/src/main/ipc/datasources/` — remove `upload.ts`; add `pick-files-to-upload.ts`.
- `apps/desktop/src/preload/` — expose new `window.api.files.upload` and `window.api.datasources.pickFilesToUpload`; remove `window.api.datasources.upload`.
- `packages/ipc-contracts/src/files.ts` — new `FilesUploadRequest` / `FilesUploadResponse` types.
- `packages/ipc-contracts/src/datasources.ts` — new `DatasourcesPickFilesRequest` / `DatasourcesPickFilesResponse`; remove `DatasourcesUploadRequest` / `DatasourcesUploadResponse`.

**APIs:**
- Renderer-facing: `window.api.datasources.upload` REMOVED; `window.api.files.upload` and `window.api.datasources.pickFilesToUpload` ADDED.
- Sync service: no changes — reuses the existing `sync:enqueue-upload` command.

**Dependencies:** None added. Uses shadcn `<Dialog>`, `<Checkbox>`, `<Button>` already in the tree.

**Follow-ups not included here:**
- `add-file-explorer-folder-drop-upload` — recursive folder-drop with directory-structure preservation.
- `add-file-explorer-drag-out` — dragging from the explorer out to the OS.
