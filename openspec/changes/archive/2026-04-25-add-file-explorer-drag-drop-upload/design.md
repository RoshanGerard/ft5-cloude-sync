# Design: Drag-and-drop upload + in-app Upload dialog

## Context

Upload in the current tree is minimal and datasource-root-only. `window.api.datasources.upload({datasourceId})` → main opens a native OS picker → hard-codes `targetPath = "/" + path.basename(sourcePath)` → calls `syncClient.enqueueUpload` — the renderer never participates in picking the destination. There is no drag-drop handler anywhere in the renderer (verified: no `onDrop` / `DataTransfer` / `dragover` references under `apps/desktop/src/renderer/`).

The `sync:enqueue-upload` command already accepts an explicit `targetPath` and a `ConflictPolicy` of `"overwrite" | "duplicate" | "skip"` — the service side is capable; it's the renderer-to-service bridge that's uninformed. `DATASOURCES_CHANNELS.uploadProgress` is already wired through the event-bridge added in `wire-fs-sync-service`, so per-job progress surfaces without changes.

This change replaces the renderer side wholesale: renderer picks both the source files and the target path, then dispatches one `files.upload` IPC per file. Main-process becomes a thin proxy; no more hard-coded `targetPath`. The retired `datasources.upload` handler is a net removal.

## Goals / Non-Goals

**Goals:**
- Make drag-drop onto the file-explorer upload to the currently-viewed folder for every supported datasource (engine-backed and mock) with zero new service-side code.
- Replace the root-only Upload quick action with an in-app dialog that lets users pick a destination folder by browsing the datasource via `files.list`, and offers the same flow from a new Upload button in the file-explorer toolbar.
- Preflight-check conflicts via `files.stat` so users are asked Overwrite / Keep both / Skip *before* any job is enqueued, never surprised by a later failure.
- Match the established visual vocabulary from `wire-file-explorer-to-service` (Lucide, amber/blue/neutral semantics, shadcn primitives, Pattern-A full-replace).
- Keep every existing file-explorer test green; add composite tests for four-layer wiring of the new `files.upload` IPC.

**Non-Goals:**
- Folder-drop / recursive upload. Deferred to follow-up change `add-file-explorer-folder-drop-upload`.
- Dragging files OUT of the explorer to the OS. Deferred to follow-up change `add-file-explorer-drag-out`.
- Multi-file batching on the service side. `sync:enqueue-upload` stays single-file; renderer dispatches N calls.
- Extending the `ConflictPolicy` vocabulary. The existing three values (`overwrite`, `duplicate`, `skip`) cover Overwrite / Keep both / Skip.
- Keyboard-accessible drag-drop. Drag-drop is pointer-only by design; the Upload toolbar button is the keyboard-reachable equivalent and is documented as such in the spec.
- Progress aggregation / batch summary UIs. Each job gets its own Sonner toast; no combined "3 of 5 complete" summary in v1.

## Decisions

### Decision 1: Renderer-dispatched per-file `files.upload` calls; no service-side batch surface

**Choice:** Each file in a drop (or the dialog's Files list) becomes one `window.api.files.upload({datasourceId, sourcePath, targetPath, conflictPolicy})` call. Renderer dispatches them in parallel via `Promise.allSettled`. Each call enqueues one `sync:enqueue-upload` job.

**Alternatives considered:**
- **Extend `sync:enqueue-upload` to accept an array of sources.** Rejected: requires a service-side contract change, a new dispatch path, additional tests, and an aggregate-progress event shape — all to optimize a surface that is already cheap. Single-file semantics keep service invariants simple (one job, one row, one progress stream).
- **New `files:enqueue-batch-upload` command.** Rejected: same over-engineering. No evidence that N single calls is a problem at the scale users actually drop (expected: 1–50 files per batch).

**Why:** Service is already correct and complete for single-file uploads. Renderer fan-out is trivial; toast-per-file is the right UX granularity anyway (per Decision 4).

### Decision 2: Retire `datasources.upload` instead of keeping it as a compat shim

**Choice:** Remove the `datasources.upload` IPC contract, main handler, and preload binding entirely. Remove the one renderer call site (datasource card's quick-action handler) and replace it with "open the new Upload dialog". Delete associated tests.

**Alternatives considered:**
- **Keep `datasources.upload` as a back-compat alias that opens the same dialog.** Rejected: the renderer is the only consumer of this IPC; there are no external callers. An alias adds two code paths to maintain and a dead contract that future readers will have to investigate.
- **Keep `datasources.upload` as a fast-path for "upload to root".** Rejected: there is no user scenario that specifically wants root. The dialog's default destination behavior (root when opened from the dashboard, current folder from the explorer) covers both cases cleanly.

**Why:** Nothing downstream depends on this IPC. Removing it is pure subtraction; keeping it is pure complexity.

### Decision 3: Preflight conflict detection via `files.stat`, not post-enqueue error handling

**Choice:** Before dispatching `files.upload` for each file, the renderer calls `window.api.files.stat({datasourceId, path: targetPath})`. If the stat resolves successfully, the target exists → show conflict dialog. If it rejects with `not-found`, there's no conflict → proceed. If it rejects with `auth-revoked` / `disconnected` / `other`, abort the whole batch with a red Sonner toast — no partial uploads.

**Alternatives considered:**
- **Let `sync:enqueue-upload` fail with tag `conflict` and react in the renderer.** Rejected: the job becomes a failed job in history; the user sees a mid-stream failure toast rather than a proactive prompt; terminal state for the job is "failed" even though the user would have chosen "Overwrite" if asked. Preflight keeps history clean.
- **Call a dedicated "preflight-upload" service command.** Rejected: `files.stat` already does exactly this work. No new command needed.

**Why:** Preflight is cheap (one stat per file), matches user expectation ("ask me *before* you do anything"), and keeps the jobs table clean.

### Decision 4: One Sonner toast per enqueued job; no aggregate summary

**Choice:** Each successful `files.upload` dispatch returns a `jobId`. The renderer opens one Sonner toast per job, subscribes to `DATASOURCES_CHANNELS.uploadProgress` for that id, shows a progress bar, transitions to "✓ Uploaded" on complete (auto-dismiss 4s) or red + Retry on failure.

**Alternatives considered:**
- **Single aggregate toast "Uploading 5 files… (3/5)".** Rejected: the aggregate hides per-file state; when one of five fails, the user has to dig into a summary to find which one. Per-file toasts let each failure speak for itself.
- **Inline ghost rows in the explorer's entries list.** Rejected for v1. Requires coordinating with `files:list` and reconciling with the eventual engine-produced entry (handle vs path mismatch during the transient phase). Worth doing, but out of scope here. Tracked as `add-file-explorer-optimistic-upload-rows` follow-up.

**Why:** Toasts are the existing error surface in this app (delete failures, etc.); uploads fit the same pattern. Per-file granularity matches how the service issues jobs.

### Decision 5: Destination-tree driven by the same `files.list` IPC, directories-only

**Choice:** The Upload dialog's destination picker calls `window.api.files.list({datasourceId, path})` on navigation. The returned entries are filtered client-side to `kind === "directory"` for display. Interaction model matches OS "Save As" / folder-picker dialogs: the **currently-displayed folder is the destination** — there is no separate row-selection state. Single-click or Enter on a row navigates into that directory (destination path updates, list re-fetches, breadcrumb updates). The parent `..` row and breadcrumb segments navigate up. A `.. (parent)` row is synthesized at the top when `path !== "/"`. The destination footer (`→ /current/path`) and the primary button label (`Upload N files → /current/path`) both read live from the current path.

**Alternatives considered:**
- **New `files:list-directories-only` command.** Rejected: the filter is a one-line `.filter(e => e.kind === "directory")` on the client; no need to add a specialized service command.
- **Recursive tree with expand/collapse disclosure triangles.** Rejected: matches OS folder-picker convention but requires lazy-loading logic and visual polish. The breadcrumb + directory-list pattern is simpler and matches how the main file-explorer already works — users are already familiar with it.

**Why:** Reuse of an existing, battle-tested IPC. Zero new service surface.

### Decision 6: Drag-drop blocked states mirror delete/rename gating; no local queuing

**Choice:** When the datasource status is `disconnected`, `auth-revoked`, or `syncing` (initial sync), drag-drop is disabled. `drop-zone.tsx` reads the status from the datasources store. Dragover sets `isBlocked` instead of `isDragActive` and renders a grey-palette overlay ("Can't upload — datasource is disconnected" etc.). Drop is a no-op. No jobs are queued locally for later.

**Alternatives considered:**
- **Queue uploads locally and flush on reconnect.** Rejected: the sync service doesn't support renderer-initiated local queuing of user uploads (the job row requires an active datasource); implementing it adds a new state machine in a change scoped to a UI affordance. Out of scope.
- **Allow drop during `syncing`; only block on `disconnected` / `auth-revoked`.** Rejected in favor of strict parity with how Delete is gated today — mid-indexing is a transient state the engine is busy with; adding upload traffic competes with the very indexing pass that is trying to reconcile reality.

**Why:** Consistency with the existing delete/rename gating. Deferred local-queuing is honest about what the service currently supports.

### Decision 7: Drag-drop bypasses the conflict dialog? — No. Both paths converge at preflight.

**Choice:** Drag-drop and the Upload dialog submit the same orchestrator function (`useUploadOrchestrator`). Both do the preflight `files.stat` check, both open the conflict-resolution dialog on collision. A silent-overwrite drag-drop mode was considered and rejected.

**Alternatives considered:**
- **Drag-drop silently overwrites (skip the conflict dialog).** Rejected: drag-drop is often *more* accident-prone than the deliberate dialog flow (user didn't explicitly pick the destination). Surprising overwrites are worse in the drag-drop path, not better.
- **Configurable per-user preference.** Rejected: premature. If users ask for it, add later.

**Why:** A single orchestrator means one conflict-handling code path, one set of tests, one mental model.

### Decision 8: No-conflict files default to `conflictPolicy: "overwrite"`

**Choice:** Files that pass preflight (no existing target at that path) are dispatched with `conflictPolicy: "overwrite"`. This is effectively a no-op for those files since there's nothing to collide with — but we still have to pass some value to `enqueueUpload`.

**Alternatives considered:**
- **Pass `"skip"` for no-conflict files.** Semantically misleading — nothing is being skipped.
- **Make `conflictPolicy` optional in the contract.** Rejected: the current contract requires it; changing the contract to make it optional for this flow is churn for no real benefit.

**Why:** If a race happens (a file appears at the target path between preflight stat and enqueue dispatch), overwrite matches user expectation — they just said "upload this file here", they didn't ask to be re-prompted about a file that didn't exist 40ms ago.

### Decision 9: File picker for the Upload dialog stays OS-native

**Choice:** The dialog's "+ Add files…" button calls a new `window.api.datasources.pickFilesToUpload()` IPC that opens `dialog.showOpenDialog` in main with `properties: ["openFile", "multiSelections"]`. Returns `{filePaths: string[], canceled: boolean}`. No in-renderer `<input type="file">`.

**Alternatives considered:**
- **Use `<input type="file">` in the renderer.** Rejected by the existing `datasources-ui` spec rule — renderer must not render a file input for this flow. Carry-over from the security/architecture posture of the project: the renderer shouldn't exercise the Web File API when a native picker is available.

**Why:** Respects the established rule. Native picker gives the user filesystem context (recent locations, drive navigation) that `<input type="file">` does not.

## Visual direction

- **Aesthetic:** Quiet, utilitarian. shadcn-on-Tailwind, Lucide icons, no decorative gradients. Inherits directly from the vocabulary approved for `wire-file-explorer-to-service`.
- **Active drag-drop overlay:** Amber 2px dashed border at `border-amber-600` inset 4px from the pane edge. Translucent amber tint `bg-amber-600/8` over the entries area. Entries dim to `opacity-35` via a single class (no per-row re-render). Centered 40px Lucide `Upload` icon in `text-amber-600`; 15px/600 headline "Drop to upload here" in `text-amber-700`; 13px/400 subtext "→ /currentPath" in `text-amber-600`.
- **Blocked-state drop overlay:** Same layout, grey palette. Border `border-muted-foreground` dashed, no tint. Icon varies by state: `CloudOff` (disconnected), `KeyRound` (auth-revoked), `RefreshCw` with `animate-spin` (syncing). Headline "Can't upload right now" in `text-foreground`. Body "This datasource is <state-specific>" in `text-muted-foreground`. No action button.
- **Upload dialog:** shadcn `<Dialog>` at `max-w-xl`. Header: "Upload to <datasource name>". Two sections — "Files to upload" and "Destination folder" — each labeled with `text-xs font-semibold uppercase tracking-wide text-muted-foreground`. Both sections wrapped in `border rounded-md`. Footer: primary button "Upload N files → /dest/path" (default primary: black/white), secondary "Cancel".
- **Files section:** Native picker via the "+ Add files…" row (styled as a link-button at the bottom of the list). Each file row: Lucide icon from the existing `icons.ts` mimeFamily mapping + name + size + `X` to remove. Empty state: "No files selected. Click + Add files… to choose.".
- **Destination section:** Breadcrumb at top (same style as the main explorer's breadcrumb). List of directory rows below (max-height ~140px, scrollable). Each row: `Folder` icon + name. Synthesized `.. (parent)` row when `path !== "/"`. Interaction: single-click or Enter navigates INTO the clicked directory — there is no separate row-selection; the currently-displayed folder IS the destination. Footer reads "→ /current/dest" live.
- **Conflict dialog:** shadcn `<Dialog>` at `max-w-md`. Header: "File already exists". Conflict card uses `bg-amber-50 border-amber-200` (informational, not alerting). Per-conflict body: file name in bold, "<size> · modified <relative-time>". Three actions as shadcn buttons: "Overwrite" (amber-600 primary), "Keep both" (outline), "Skip this file" (outline). shadcn `<Checkbox>` "Apply this choice to the remaining N conflicts". Footer: "Cancel all" ghost button.
- **Upload button in the toolbar:** Lucide `Upload` icon + "Upload" label. Enabled when datasource status is `connected` or `paused`; `aria-disabled="true"` with tooltip in other states. Tabs in immediately after Delete in the toolbar's focus order.
- **Type:** Inherits project defaults (system / Tailwind via shadcn). Headlines 15px/600, body 13px/400, section labels 11px/600 uppercase.
- **Color palette (Tailwind semantic):**
  - `amber-600` — drop-active overlay, conflict warning accents, Overwrite primary.
  - `amber-50` / `amber-200` — conflict card surface.
  - `muted-foreground` — blocked-overlay, section labels, body copy.
  - App default primary (black in light theme) — dialog submit CTAs.
- **Iconography (Lucide only):** `Upload` (drop-active, toolbar button), `CloudOff` / `KeyRound` / `RefreshCw` (blocked overlay), `Folder` / `FolderOpen` (destination tree), `FileText` / `FileImage` / etc. via `icons.ts` mapping (selected files), `X` (remove file from batch, close dialog), `AlertTriangle` (conflict card accent — optional).
- **Spacing:** 14px padding in dialog body, 10px gap between section label and content, 8px between file rows, 6px between dest-tree rows. Matches `confirm-delete-dialog` and `properties-modal`.
- **Motion:** No custom motion. shadcn `<Dialog>` default open/close transition. Drag overlay appears/disappears on state flip with no transition (avoid jitter during rapid dragover/dragleave).
- **Accessibility:**
  - Drop overlay: `role="status"` + `aria-live="polite"` so screen readers announce activation. Icons `aria-hidden="true"`.
  - Upload dialog: shadcn focus trap, Escape-to-close, `aria-labelledby` on header.
  - Conflict dialog: same; action buttons keyboard-reachable; checkbox labeled.
  - Drag-drop has no keyboard equivalent by design; the Upload button in the toolbar is the keyboard-reachable alternative. Documented explicitly in the spec.
  - Every button has an accessible name; icons paired with text are `aria-hidden`.
  - WCAG AA: amber-600 on white at 15px/600 = 4.66:1 ✓; muted-foreground body on white passes ✓.
- **No WCAG deviations flagged.**

## Risks / Trade-offs

- **Preflight stat × N round-trips on a large drop.** → Acceptable: `files.stat` is cheap, and drops are typically small (1–10 files). If a pathological 100-file drop becomes common, batch the stats in one IPC call (trivial extension; not gated here).
- **Destination tree uses the same IPC as the main explorer — a stale cache risk across tabs.** → No client cache in v1; every navigation in the destination tree re-calls `files.list`. Minor over-fetching; honest about state.
- **Drag-drop and the dialog both run through `useUploadOrchestrator` — single bug surface can break both entry points.** → Upside: one set of tests covers both. Downside accepted.
- **`DataTransferItem.webkitGetAsEntry()` is a Chromium/Electron extension, not standard DOM.** → We're in Electron — this is fine. Documented in the design.
- **Folder drop produces a toast-per-drop, which could spam if the user drags multiple folders in quick succession.** → Detect any folder in the batch, show a single toast, reject the whole batch. Mitigation baked in.
- **Retiring `datasources.upload` is a breaking IPC change.** → The only consumer is the in-tree renderer, updated in the same change. No external API surface touched. The `DatasourcesUploadRequest` / `Response` types and `DATASOURCES_CHANNELS.uploadProgress` channel are in active use — the channel stays (progress still flows through it); only the command-style `upload()` IPC is removed.
- **New four-layer surface (`files.upload`) adds to the IPC contract test matrix.** → Extension, not new pattern. Mirrors the wiring of `files.list` / `remove` / etc.
- **Upload button placement in the toolbar competes with toolbar real estate.** → Current toolbar has Delete, Sort, Search, View, Details — 5 buttons. Adding Upload makes 6. Still fits at all reasonable window widths tested in the existing visual tests.

## Known limitations (follow-up tracked)

- **Folder drop** — recursive directory upload preserving structure. Tracked as `add-file-explorer-folder-drop-upload`. Requires recursive `webkitGetAsEntry()` walk + directory-creation logic on the target side + aggregate progress UI.
- **Drag out (from the explorer to the OS)** — tracked as `add-file-explorer-drag-out`. Requires coordinating with the engine's `downloadFile` to produce a `DataTransfer.setData("DownloadURL", ...)` payload.
- **Optimistic ghost rows during upload** — dropped/selected files appear in the entries list as pending entries before the engine produces the real entry. Tracked as `add-file-explorer-optimistic-upload-rows`.
- **Aggregate batch progress UI** — per-file Sonner toasts are the v1 surface; a combined "Uploading N files" strip is a potential follow-up if user feedback demands it.

## Migration Plan

- No data migration. Pure renderer + main-process code swap plus two new IPC contracts and one removed IPC contract.
- Roll-out order (per `/opsx:apply` phase sequence, each phase behind a failing test per `test-driven-development`):
  1. Contract extensions: add `FilesUploadRequest`/`Response` in `packages/ipc-contracts/src/files.ts`; add `DatasourcesPickFilesRequest`/`Response` in `packages/ipc-contracts/src/datasources.ts`; remove `DatasourcesUploadRequest`/`Response`.
  2. Main-process handlers: add `apps/desktop/src/main/ipc/files/upload.ts` (thin proxy over `syncClient.enqueueUpload`); add `apps/desktop/src/main/ipc/datasources/pick-files-to-upload.ts`; remove `apps/desktop/src/main/ipc/datasources/upload.ts` and its tests.
  3. Preload bindings: expose `window.api.files.upload` and `window.api.datasources.pickFilesToUpload`; remove `window.api.datasources.upload`.
  4. Renderer: `useUploadOrchestrator` hook (preflight stat → conflict dialog → N dispatches → toast per job).
  5. Renderer: `drop-zone.tsx` + `drop-overlay.tsx` wrapping `file-explorer.tsx`'s outer container.
  6. Renderer: `upload-dialog.tsx` with destination tree, `conflict-resolution-dialog.tsx`; rewire the dashboard card's Upload quick-action to open it.
  7. Renderer: Upload button in the file-explorer toolbar.
  8. Composite tests: four-layer wiring for `files.upload`, dashboard/explorer dialog-origin behaviors, blocked-state drop overlays.
  9. End-to-end smoke in the worktree against a real Google Drive datasource (see spec's smoke scenarios).
- **Rollback:** revert the commits. No schema changes, no persistent state written. Any in-flight upload job enqueued through the new IPC continues to completion on the service side unaffected.

## Open Questions

None at this time. All nine decision points flagged during brainstorming are resolved above.
