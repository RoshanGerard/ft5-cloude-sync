# Proposal: Wire engine-backed `files:rename` and `files:download`

## Why

`wire-file-explorer-to-service` (archived 2026-04-24) migrated `files:list`,
`files:stat`, `files:search`, and `files:remove` from the mock backend to the
live engine, but kept `files:rename` and `files:download` on
`apps/desktop/src/main/ipc/files/mock-fs.ts`. The renderer disables both
affordances for engine-backed datasources via `isEngineBacked(providerKind)`
checks in `context-menu.tsx`, with tooltip "Rename / Download is coming in a
future release (see change add-engine-rename-download)". This change is
named in the user-facing UX copy. Promoting it closes the literal
string-match.

End-to-end correctness gaps the change resolves:

- Rename + Download unreachable on real datasources.
- The fs-sync service has no `files:rename` or `files:download` RPC at all
  (a comment in `services/fs-sync/src/commands/files-remove.ts` already
  names this change as the place that should add them).
- Long-running downloads have no plan for the access-token expiring
  mid-stream (token-lifetime ~1h; S3 raw-footage seeds are 400MB+).
- App-restart-while-download-in-flight has no UI continuity.

## What Changes

**Engine — `@ft5/fs-datasource-engine`:**

- `DatasourceClient<T>` gains two methods: `rename(target, newName, conflictPolicy)` and `downloadFile(target, options?: { rangeStart?, signal?, onProgress? })`. The interface carries no `kind` parameter — strategies determine file-vs-directory within their own provider context (Drive via `mimeType`, OneDrive via the `folder` facet, S3 via `HeadObject` + `ListObjectsV2` introspection). Deferred capabilities (S3 folder rename) surface as `DatasourceError { tag: "unsupported" }` from the strategy.
- `downloadFile` is a **stateless one-shot HTTP primitive**: each call issues exactly ONE provider GET wrapped in `withRefresh` (one-shot refresh-and-retry on the initial request only). Returns `{ stream, contentLength, contentRange? }`. No transaction-id, no internal tracker, no `cancelDownload` API. Mid-stream errors surface to the consumer; consumer (the fs-sync service handler) orchestrates retry via repeated calls with advancing `rangeStart`. The strategy forwards `options.signal` into the underlying SDK call so consumer-side cancel propagates naturally.
- The engine's role is strictly to **translate vendor APIs** — including emitting bus events for actions invoked through it. Retry policy, byte-tracking across stream lifetimes, transaction-id maps, and business-logic-decorated event emission to desktop live in the consumer (fs-sync) per the architectural principle. Parallel debt for upload (which still has the in-engine tracker pattern) is tracked in follow-up `migrate-upload-orchestration-out-of-engine`.
- New bus events: `entry-renamed { from: Target, to: DatasourceFileEntry<T> }` (the base normalizes provider differences — S3's internal copy+delete emits a single envelope, not file-created+deleted), plus the four download lifecycle events `downloading { datasourceId, path, loaded, total }`, `file-downloaded { datasourceId, path, savedPath, bytes }`, `download-failed { datasourceId, path, error }`, `download-cancelled { datasourceId, path, bytesDownloaded, bytesTotal }`. fs-sync subscribes to these raw vendor-derived events, applies business logic (downloadJobId minting, throttling, retry policy, integrity checks), and emits its OWN domain events to the desktop with different payload shapes (downloadJobId-keyed, business-decorated) — NOT a relay.
- New `DatasourceErrorTag.Conflict` member with payload `{ existingPath }` for rename collisions when `conflictPolicy === "fail"`.

**Service — `services/fs-sync`:**

- New RPC handlers: `services/fs-sync/src/commands/files-rename.ts` and
  `files-download.ts`.
- `files-rename.ts` resolves the engine client and forwards directly to
  `client.rename(target, newName, conflictPolicy)`. The handler does not
  inspect the entry's kind — the strategy resolves that within its own
  provider context.
- `files-download.ts` is the **orchestration layer** for downloads. It mints a service-level `downloadJobId`, creates an `AbortController`, and runs a retry loop calling `engine.downloadFile(target, { rangeStart, signal, onProgress })` against the local file's current size (`fs.stat(toPath).size`). On mid-stream auth-expired, the handler retries with the new `rangeStart`; the engine's `withRefresh` wrapper handles the credential refresh on the next call. The handler validates `contentRange.start === rangeStart` before resuming the local pipe (rejects range-not-honored 200 OK responses). On success, performs an integrity check against the provider's hash (Drive `md5Checksum`, OneDrive `quickXorHash`/`sha1Hash`, S3 `ETag` for non-multipart). Replies `{ savedPath, bytes }`. The `downloadJobId` is the canonical job key for cancel + progress correlation.
- New in-memory `DownloadRegistry` module (`services/fs-sync/src/downloads/registry.ts`)
  that holds `Map<downloadJobId, DownloadJob>` where `DownloadJob`
  carries `{ datasourceId, sourcePath, targetPath, bytesDownloaded,
  contentLength, startedAt }`. Updated on each `downloading` /
  `file-downloaded` / `download-failed` / `download-cancelled` event.
- New `downloads:list-active` RPC: returns the current registry snapshot.
  Used by the desktop main process on first connect to hydrate toasts.
- The `toPath` value on `files:download` requests SHALL be validated at
  the service boundary: it must be an absolute path, must not contain
  `..` segments after normalization, and must be writable. Fails with
  `tag: "other"` and a clear message if validation fails.

**Contracts — `packages/ipc-contracts`:**

- `FilesRenameRequest` gains `conflictPolicy: "fail" | "overwrite" |
  "keep-both"` (default `"fail"`). No `kind` field — the engine's
  strategy resolves kind within its own context.
- `FilesRenameResponse` envelope unchanged shape; error tag union gains
  `"conflict"` with `{ existingPath: string }`.
- `FilesDownloadRequest` already carries `toPath?: string`; this change
  makes it required (the service no longer has a "saved-to-mock-path"
  fallback).
- New commands `downloads:list-active` (request: empty; response: array
  of `DownloadJob`) and event `downloading` exposed to the renderer via
  `window.api.files.onDownloadProgress(downloadJobId, callback)`.

**Desktop main — `apps/desktop/src/main`:**

- `files/rename.ts` and `files/download.ts` rewritten to call
  `SyncClient.request("files:rename" | "files:download", req)` instead
  of `mock-fs.ts`. Matches the existing list/stat/search/remove pattern.
- `files/download.ts` integrates `dialog.showSaveDialog` per the user's
  preferences (default folder vs. always-ask vs. one-off Shift+Click
  force) — the renderer-supplied request carries a flag indicating which
  flow to take.
- New on-supervisor-connect handler queries `downloads:list-active` and
  forwards the snapshot to the renderer so toasts can hydrate.

**Renderer — `apps/desktop/src/renderer`:**

- `context-menu.tsx`: flip the `isEngineBacked` gate. Rename is enabled
  for files on every provider AND for directories on Drive/OneDrive; for
  S3 directories the item is disabled with tooltip "Folder rename isn't
  supported on S3". Download is enabled for all file entries on every
  provider.
- The existing inline-rename UX in `entry-name-cell.tsx` (F2 / context-menu
  → `editingId` flips → `EntryNameInput` renders → `store.rename(id, value)`
  with optimistic `pendingOp`) is reused as-is. The `store.rename` call
  now reaches the live engine via `window.api.files.rename`. On
  `tag: "conflict"`, the conflict-resolution dialog (already in use by
  upload) re-prompts the user and re-dispatches with the chosen policy.
- New download orchestrator (mirroring the upload orchestrator pattern):
  on click, resolves the toPath via the user's preferences (first-run
  modal, default folder, or showSaveDialog for "always ask" / Shift+Click),
  dispatches `window.api.files.download`, opens a Sonner toast bound to
  the returned `downloadJobId`, subscribes to the progress feed.
- Sonner success toast variant C: Open as primary CTA (filled blue
  button), "Show in folder" as secondary text link, auto-dismiss timer
  matching the upload toast's success duration.
- New first-run modal (`features/file-explorer/first-download-modal.tsx`):
  triggers on the user's very first download attempt. Blocks the download
  until the user picks a default folder. Single CTA "Use this folder",
  "Browse…" opens OS picker.
- New settings section (`features/settings/downloads-section.tsx`)
  inside the existing `SettingsDialog`. Two rows: (i) Default folder
  with Open / Change… buttons; (ii) "Always ask where to save" Switch.
- New `downloads-store.ts` (matches the existing `motion-store.ts`
  pattern) for renderer-side preferences in `localStorage`. Keys:
  `ft5.downloads.defaultFolder`, `ft5.downloads.alwaysAsk`. Renderer
  computes the per-download `toPath` from these preferences plus
  `Shift+Click` modifier and forwards to the IPC.
- On app-init effect, fetch active downloads via
  `window.api.files.listActiveDownloads()`, hydrate one Sonner toast per
  in-flight job, subscribe to each `downloadJobId`'s progress feed.

**Mock-fs cleanup:**

- `apps/desktop/src/main/ipc/files/mock-fs.ts` retains all seed-tree code
  + `list` / `stat` / `search` / `remove` functions (TDD fixtures still
  use them).
- The `rename` and `download` exports are deleted along with their unit
  tests `__tests__/mock-fs.test.ts` (the rename + download arms).

## Capabilities

### New Capabilities

None. All work folds into existing capabilities.

### Modified Capabilities

- `fs-datasource-engine` — `DatasourceClient<T>` gains `rename` and `downloadFile` (stateless one-shot primitives). New bus event for rename: `entry-renamed`. New `DatasourceErrorTag.Conflict`. The engine carries NO download-specific state, NO transaction-id map, NO `cancelDownload` API, NO mid-stream splice or retry — those are consumer concerns.
- `fs-sync-service` — gains `files:rename` and `files:download` RPC commands; gains in-memory `DownloadRegistry`; gains `downloads:list-active` command; gains the consumer-domain event taxonomy (`downloading`, `file-downloaded`, `download-cancelled`, `download-failed`); gains the retry loop + Content-Range validation + byte-count assertion + post-download integrity check; gains the `toPath` validation at the service boundary.
- `file-explorer` (renderer) — Rename + Download affordances flip from
  disabled to enabled (the existing "disabled for engine-backed" rule
  is REMOVED). Folder rename is provider-conditional. New first-run
  modal, settings section, downloads-store, download orchestrator,
  toast hydration on app-init.

## Impact

**Code:**

- Engine: `packages/fs-datasource-engine/src/base-client.ts` (3 new
  public methods, 2 new abstract primitives `doRenameImpl` +
  `doDownloadFileImpl`, new internal Readable wrapper); per-strategy
  implementations in the three `strategies/*-client.ts` files; new
  test files `*-rename.test.ts`, `*-download.test.ts`,
  `*-download-auth-resume.test.ts` per strategy plus contract tests
  in `__tests__/strategy-contract.ts`.
- Contracts: `packages/ipc-contracts/src/files.ts` (rename request gains
  `conflictPolicy`; download request `toPath` becomes required; new
  `tag: "conflict"` variant); new `downloads.ts` with
  `DownloadsListActiveRequest/Response` + `DownloadingEvent`.
- Service: `services/fs-sync/src/commands/files-rename.ts` (new),
  `files-download.ts` (new), `downloads-list-active.ts` (new);
  `services/fs-sync/src/downloads/registry.ts` (new); threading through
  `commands/handlers.ts`. Path-validation utility in `services/fs-sync/src/util/`.
- Desktop main: rewrites of `apps/desktop/src/main/ipc/files/rename.ts`
  and `download.ts`; new `apps/desktop/src/main/sync/on-connect-hydrate-downloads.ts`
  for the list-active query.
- Renderer: `context-menu.tsx` (gate flip + S3 folder-rename branch);
  `features/file-explorer/use-download-orchestrator.ts` (new, mirrors
  upload orchestrator); `features/file-explorer/download-job-toast.ts`
  (new, mirrors upload-job-toast); `features/file-explorer/first-download-modal.tsx`
  (new); `features/settings/downloads-section.tsx` (new);
  `features/settings/downloads-store.ts` (new); `features/settings/settings-dialog.tsx`
  (add Downloads section); plus tests for each.
- Mock-fs: delete `rename` + `download` exports from
  `apps/desktop/src/main/ipc/files/mock-fs.ts`; delete the corresponding
  arms in `__tests__/mock-fs.test.ts`.

**Dependencies:**

No new runtime deps. The engine's HTTP Range handling uses standard
`Range: bytes=N-` headers across all three providers (Drive, OneDrive's
`@microsoft/microsoft-graph-client` underlying fetch, S3's
`@aws-sdk/client-s3` `GetObjectCommand({ Range })`).

**Operational:**

No new operator-facing config. The "Downloads folder" preference is
renderer-localStorage; first download triggers the first-run modal that
collects it. The fs-sync service's existing data dir at
`~/ft5/sync_app/` is unchanged. Bundled with the existing service
restart cycle — no installer-level changes.

**Risks documented in `design.md`:**

- Token-expiry mid-stream auth-resume: the engine wrapper's
  splice-and-continue path is the trickiest piece of code in this
  change. Risk of losing the abort signal across the splice; mitigated
  by carrying the same `AbortController` through both stream lifetimes.
- `toPath` path-traversal at the service boundary: renderer-supplied
  string crosses IPC into a process that writes to disk. Validated at
  the service boundary (absolute path, no `..` after normalization,
  writable).
- Service-process death mid-download: out of scope this change (per
  the architectural boundary "service is the durable owner; reliability
  bugs live in the service"). Partial file orphaned; user retries.
  Tracked in follow-up `add-download-resilience`.
- Concurrent downloads on the same target path: detected by the existing
  conflict-policy round-trip on rename; for download, same target path
  is allowed (the second overwrites the first or we keep both via the
  preferences flow).

**Tests:**

- Engine: per-strategy rename + download contract tests; auth-resume
  fault-injection tests (synthetic 401-after-N-bytes, assert single
  refresh + Range request issued + content joined byte-exactly);
  `cancelDownload` parity with `cancelUpload`; `entry-renamed` event
  emission for Drive/OneDrive (single API call) and S3 (copy+delete
  hidden behind the wrapper).
- Service: registry state-machine tests; `files:rename` round-trip with
  each conflict policy; `files:download` pipe-to-disk including
  cancel mid-pipe; `toPath` validation rejection cases;
  `downloads:list-active` snapshot consistency under concurrent
  job lifecycle events.
- Desktop main: rename / download IPC handler swap; on-connect-hydrate
  query forwarding.
- Renderer: context-menu gate flip including S3 folder-rename branch;
  download-orchestrator dispatch + cancel + retry; toast hydration
  on app-init from list-active; first-run modal trigger conditions;
  settings downloads-section round-trip; downloads-store persistence;
  conflict-dialog re-prompt on rename `tag: "conflict"`.
- Smoke (manual, deferred per CLAUDE.md verification rules): exercise
  rename + download against real GCP / OneDrive / S3 datasources
  end-to-end once the change reaches a runnable build.

**Out of scope (deferred to follow-up `add-download-resilience`):**

- Network-disconnect / 5xx / rate-limit mid-stream resume.
- Disk-persisted download registry / service-crash recovery (boundary:
  service is the durable owner).

**Out of scope this change (other follow-ups):**

- Bulk rename / bulk download. v1 is single-entry only.
- S3 folder rename via iterate-and-rewrite-keys. Surfaces as
  `Unsupported` from the strategy until a separately-scoped change.
- Resumable downloads from network drops. Single-shot; user retries.
- Downloads tray panel UI. Toasts only for v1.
- Folder download (from any provider). Single-file only.

## Provenance

- Spawned by Non-Goals in `add-invalid-datasource-state` design.md on
  2026-04-25.
- Originally referenced as `add-engine-rename-download` in the archived
  `wire-file-explorer-to-service` (2026-04-24).
- Named by the renderer's `context-menu.tsx` tooltip copy ("see change
  add-engine-rename-download") — promoting this change closes a
  user-visible string match.
- Architectural framing — service-as-durable-owner, desktop-as-indicator —
  was the explicit user direction during `/opsx:explore`. The size of a
  bundled "with full stream-resilience" version was rejected in favor of
  the split into this change plus the follow-up `add-download-resilience`.
- Visual direction (Path C save flow + variant C success toast + variant A
  first-run modal + variant C settings section) was decided during the
  Visual Companion brainstorming pass; recorded in `design.md ## Visual
  direction`.
