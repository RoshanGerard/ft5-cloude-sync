# Tasks: add-file-explorer-drag-drop-upload

Follow `test-driven-development` (write the failing test first) and `subagent-driven-development` (one subagent per numbered task with two-stage review) per CLAUDE.md. Each task completes with its own green test(s); commits are scoped to the task.

## 1. Contract extensions (@ft5/ipc-contracts)

- [x] 1.1 Add `FilesUploadRequest` / `FilesUploadResponse` to `packages/ipc-contracts/src/files.ts` with the discriminated envelope shape (`{ ok: true; value: { jobId: string } } | { ok: false; error: { tag, message, retryable } }`). Export via the package barrel.
- [x] 1.2 Add `DatasourcesPickFilesRequest` (empty object) / `DatasourcesPickFilesResponse` (`{ filePaths: readonly string[]; canceled: boolean }`) to `packages/ipc-contracts/src/datasources.ts`. Export via the package barrel.
- [x] 1.3 Remove `DatasourcesUploadRequest` / `DatasourcesUploadResponse` types and any re-exports. Update the `.test-d.ts` surface assertions.
- [x] 1.4 Add a test in `packages/ipc-contracts/src/__tests__/files.test-d.ts` that asserts `FilesUploadRequest` and `FilesUploadResponse` match the spec shape exactly (use `expectTypeOf`).
- [x] 1.5 Update `packages/ipc-contracts/src/__tests__/datasources.test-d.ts` to assert `upload` is NOT a member of the datasources surface and `pickFilesToUpload` IS, with the correct request/response shapes.

## 2. Main-process IPC handlers (apps/desktop/src/main/ipc)

- [x] 2.1 Write a failing test `files/__tests__/upload.test.ts` asserting `handleFilesUpload` is a thin proxy over `syncClient.enqueueUpload` — forwards `datasourceId`, `sourcePath`, `targetPath`, `conflictPolicy` verbatim and returns the envelope.
- [x] 2.2 Implement `apps/desktop/src/main/ipc/files/upload.ts` exporting `handleFilesUpload(req, deps)` that calls `deps.syncClient.enqueueUpload(req)` and wraps the result/error in the envelope.
- [x] 2.3 Write a failing test `datasources/__tests__/pick-files-to-upload.test.ts` asserting `handlePickFilesToUpload` invokes `dialog.showOpenDialog` with `properties: ["openFile", "multiSelections"]` and returns `{ filePaths, canceled }`.
- [x] 2.4 Implement `apps/desktop/src/main/ipc/datasources/pick-files-to-upload.ts`.
- [x] 2.5 Wire both new handlers into the IPC registry in `apps/desktop/src/main/ipc/index.ts`. Remove the `datasources.upload` registration.
- [x] 2.6 Delete `apps/desktop/src/main/ipc/datasources/upload.ts` and its test files (`upload.test.ts`, `upload.existing-renderer-compat.test.ts`). Confirm no references remain via grep.
- [x] 2.7 Add a grep-based composite test that fails if any source under `apps/desktop/src/main/ipc/files/` imports a provider SDK or calls `engine.uploadFile` directly.

## 3. Preload bindings (apps/desktop/src/preload)

- [x] 3.1 Write a failing test asserting `window.api.files.upload` is a function with the correct signature.
- [x] 3.2 Add `files.upload` to the preload's `contextBridge.exposeInMainWorld` surface.
- [x] 3.3 Write a failing test asserting `window.api.datasources.pickFilesToUpload` is a function with the correct signature AND `window.api.datasources.upload` is `undefined`.
- [x] 3.4 Add `datasources.pickFilesToUpload` and remove `datasources.upload` from the preload bridge.

## 4. Renderer upload orchestrator hook

- [x] 4.1 Write failing tests in `apps/desktop/src/renderer/src/features/file-explorer/__tests__/use-upload-orchestrator.test.ts`: (a) no conflicts → N dispatches in parallel; (b) single conflict → conflict dialog opens → user picks Overwrite → that file dispatches with `conflictPolicy: "overwrite"`; (c) preflight stat rejects with `auth-revoked` → zero dispatches, one red toast; (d) user clicks "Cancel all" → zero dispatches, orchestrator state resets.
- [x] 4.2 Implement `apps/desktop/src/renderer/src/features/file-explorer/use-upload-orchestrator.ts` — exported hook that accepts `{datasourceId, targetDir, files}`, returns `{ start(): Promise<void> }`, drives preflight stat → conflict prompts → dispatch → toast-per-job.
- [x] 4.3 Add a helper `resolveConflicts` that walks conflicts serially and honors "Apply to remaining". Test it in isolation.

## 5. Renderer — drag-drop zone + overlay

- [x] 5.1 Write failing tests in `drop-zone.test.tsx`: (a) dragover with `dataTransfer.types` including `"Files"` activates overlay; (b) dragover without `"Files"` does not activate; (c) drop dispatches the orchestrator with `targetDir = currentPath`; (d) drop of a folder shows the toast and dispatches zero uploads; (e) mixed file+folder drop dispatches only the files; (f) drop while datasource is `disconnected` renders blocked overlay, drop is no-op.
- [x] 5.2 Implement `apps/desktop/src/renderer/src/features/file-explorer/drop-zone.tsx` — wrapper component with drag event handlers, reads datasource status from the store to compute `isBlocked`.
- [x] 5.3 Implement `apps/desktop/src/renderer/src/features/file-explorer/drop-overlay.tsx` — renders active (amber) and blocked (neutral) variants per design § Visual direction. Icons from Lucide via the existing `icons.ts`. Uses `role="status"` + `aria-live="polite"`.
- [x] 5.4 Wrap the outermost container of `file-explorer.tsx` with `<DropZone>`. Ensure existing file-explorer tests still pass (no layout regression).

## 6. Renderer — Upload dialog

- [ ] 6.1 Write failing tests in `upload-dialog.test.tsx`: (a) opens with destination = `currentPath` when opened from explorer; (b) opens with destination = `/` when opened from card; (c) "+ Add files…" calls `pickFilesToUpload`, appends to list; (d) directory tree shows only `kind === "directory"` entries from `files.list`; (e) single-click on a directory row navigates into it and updates the destination path + breadcrumb + footer + primary button label; (f) click on the `..` parent row navigates up; (g) click on a breadcrumb segment jumps to that segment; (h) primary button disabled when Files list empty; (i) submit dispatches orchestrator with correct `targetDir` (= the current displayed folder) and closes dialog.
- [ ] 6.2 Implement `apps/desktop/src/renderer/src/features/file-explorer/upload-dialog.tsx` using shadcn `<Dialog>`, `<Button>`, `<ScrollArea>`. Call `files.list` on destination navigation.
- [ ] 6.3 Rewire the datasource card's "Upload from local…" quick-action handler to open the dialog with `initialDestination: "/"` instead of calling `window.api.datasources.upload`.
- [ ] 6.4 Add an "Upload" button to the file-explorer `toolbar.tsx` (Lucide `Upload` icon + label, placed first in the toolbar). Opens the dialog with `initialDestination: currentPath`. Disabled with tooltip when datasource is non-browsable.
- [ ] 6.5 Update existing `toolbar.test.tsx` expectations to include the Upload button in the toolbar-controls assertion list.

## 7. Renderer — conflict resolution dialog

- [ ] 7.1 Write failing tests in `conflict-resolution-dialog.test.tsx`: (a) serial walk through N conflicts, default checkbox unchecked; (b) "Apply to remaining" checkbox short-circuits further prompts with the last-chosen policy; (c) "Cancel all" resolves the promise with `{ aborted: true }`; (d) "Keep both" resolves with `conflictPolicy: "duplicate"`.
- [ ] 7.2 Implement `apps/desktop/src/renderer/src/features/file-explorer/conflict-resolution-dialog.tsx` — controlled shadcn `<Dialog>` that walks a queue of conflicts and returns per-file decisions to `useUploadOrchestrator`.

## 8. Composite / four-layer wiring tests

- [ ] 8.1 Add `packages/ipc-contracts/src/__tests__/files-upload-four-layer.test.ts` asserting `files.upload` has: a contract type in `files.ts`, a main-process handler file at `apps/desktop/src/main/ipc/files/upload.ts`, a preload binding on `window.api.files.upload`, AND at least one renderer call site (grep for `window.api.files.upload` or `api.files.upload` under `apps/desktop/src/renderer/`).
- [ ] 8.2 Add an analogous test for `datasources.pickFilesToUpload`.
- [ ] 8.3 Add a grep-based negative test asserting `datasources.upload` is nowhere in the codebase (contract, handler, preload, renderer). Allow the string only in spec / design / tasks documents under `openspec/`.

## 9. Sonner toast integration

- [ ] 9.1 Write a failing test for a `upload-job-toast.ts` helper that subscribes to `DATASOURCES_CHANNELS.uploadProgress` for a given `jobId`, updates a Sonner toast per progress event, flips to success on terminal success (auto-dismiss 4s), flips to red with Retry on terminal failure.
- [ ] 9.2 Implement the helper. Wire it from `useUploadOrchestrator` so each dispatched job spawns exactly one toast.
- [ ] 9.3 Retry re-dispatches `files.upload` with the original `{datasourceId, sourcePath, targetPath, conflictPolicy}` and replaces the toast with one bound to the new `jobId`.

## 10. Accessibility + visual polish

- [ ] 10.1 Manual a11y check in the dev build: tab through the toolbar → Upload button receives focus with visible ring; tab into the Upload dialog → focus trapped; Escape closes; conflict dialog action buttons reachable by Tab; checkbox labeled.
- [ ] 10.2 Manual contrast check: amber-600 active overlay text on amber-600/8 tint → confirm WCAG AA; muted-foreground blocked overlay body on white → confirm WCAG AA.
- [ ] 10.3 Visual regression: screenshot the active overlay, blocked overlay (each state), Upload dialog, and conflict dialog; add to `docs/screenshots/` (if that directory is the convention) or attach to the change's archive notes.

## 11. End-to-end smoke (manual, in the worktree)

- [ ] 11.1 Drag 3 files from OS onto a connected Google Drive datasource's explorer while inside `/docs` → confirm files appear in the folder on Drive, 3 toasts complete.
- [ ] 11.2 Click Upload on the dashboard card → dialog opens defaulted to root; pick 2 files, one colliding with an existing name; resolve conflict with Overwrite; confirm both succeed.
- [ ] 11.3 Click Upload on the file-explorer toolbar while inside `/projects/2026` → dialog opens defaulted to `/projects/2026`; pick 1 file; navigate destination tree into `/projects/2026/drafts`; submit; confirm file lands in `/projects/2026/drafts`.
- [ ] 11.4 Drag a file onto a `disconnected` datasource's explorer → neutral overlay; drop does nothing.
- [ ] 11.5 Drag a folder → rejection toast, zero jobs dispatched.
- [ ] 11.6 Upload 5 files, kill the network mid-upload → each toast turns red with Retry; click Retry on one → re-dispatches just that file and a fresh toast appears.

## 12. Verification + close-out

- [ ] 12.1 `pnpm typecheck` green across the monorepo.
- [ ] 12.2 `pnpm lint` green.
- [ ] 12.3 `pnpm test` green — full suite, not just new tests.
- [ ] 12.4 Full regression pass of every existing file-explorer test and dashboard test (no changes expected to regress).
- [ ] 12.5 `openspec validate --strict` green.
- [ ] 12.6 Create PR with summary + screenshots.
- [ ] 12.7 Merge once reviewed.
- [ ] 12.8 `/opsx:archive add-file-explorer-drag-drop-upload` in the worktree branch BEFORE merging to master (per CLAUDE.md).
- [ ] 12.9 Merge the archive commit into master.
