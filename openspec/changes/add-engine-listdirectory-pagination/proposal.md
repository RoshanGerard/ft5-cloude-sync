# Proposal: Add pagination to engine `listDirectory`

**Status:** Drafted; **blocked-on** the engine `migrate-*` chain (see
Risks/Trade-offs in `design.md`). **Do NOT `/opsx:apply`** until the
prerequisites listed in `tasks.md` `## 0. Prerequisites` are merged
to `master` — pagination's auto-retry policy and event semantics
must coordinate with the migrated retry/event surface, and the
cursor-handling code lives in the same wrapper layer those changes
restructure.

## Why

Folders larger than one provider page render incorrectly today:

- **Google Drive** caps `doListDirectoryImpl` at `pageSize: 1000` and
  ignores `nextPageToken` — folders of >1000 entries silently truncate.
- **OneDrive** uses Graph's default `~200` per page and ignores
  `@odata.nextLink` — folders of >200 entries silently truncate.
- **S3** auto-loops every page internally, which fixes the visibility
  problem but blows IPC payload size and first-paint latency on
  buckets of tens of thousands of keys.

The wire-level `truncated` flag in `FilesListValue` is currently
hard-coded to `false` in both `services/fs-sync/src/commands/files-list.ts`
and `files-search.ts`, so the renderer never even sees the existing
indicator. Users with large folders see a partial listing with no UI
recourse.

This change introduces explicit cursor pagination on the engine's
`listDirectory`, wires it through the sync-service `files:list`
command and the renderer-facing IPC contract, and adds an inline
"Load more" affordance plus a configurable page-size setting in the
file-explorer.

## What Changes

- **BREAKING** — `DatasourceClient<T>.listDirectory(target)` becomes
  `listDirectory(target, options?: { cursor?: string; pageSize?: number }):
  Promise<{ entries: DatasourceFileEntry<T>[]; nextCursor: string | null }>`.
  The flat-array return type is replaced. Every concrete strategy
  (`GoogleDriveClient`, `OneDriveClient`, `S3Client`) and every direct
  consumer of the engine's read surface MUST migrate.
- **BREAKING** — `FilesListRequest` (`@ft5/ipc-contracts/files`) gains
  optional `cursor?: string` and `pageSize?: number` fields.
  `FilesListValue` regains `nextCursor: string | null` (the field
  comment historically explaining its removal will be reversed).
  `truncated: boolean` stays for now to avoid double-renames; it
  becomes derived (`truncated === nextCursor !== null`).
- **BREAKING** — sync-service `files:list` request envelope plumbs
  `cursor` and `pageSize` through to the engine and surfaces
  `nextCursor` in the response. Existing renderer call sites that
  pass `{ datasourceId, path }` continue to type-check (new fields
  are optional).
- Each provider strategy's `doListDirectoryImpl` receives the opaque
  cursor and forwards it as the provider-native continuation token
  (Drive `pageToken`, OneDrive `@odata.nextLink`, S3
  `ContinuationToken`). S3 stops auto-looping internally — it returns
  one provider page per call like the others.
- OneDrive's `@odata.nextLink` is validated against
  `https://graph.microsoft.com/v1.0/` before re-issue.
- `fs-sync` ships an auto-retry wrapper around `client.listDirectory`
  for paginated calls (initial + 3 retries at 2s/5s/7s back-off, total
  4 attempts, ~14s budget) before surfacing the failure to the
  renderer with the cursor as a manual-retry handle.
- The file-explorer renders an inline **"Load more"** affordance below
  the entries list when `nextCursor !== null`, available in all six
  view modes (List, Details, Small/Medium/Large Icons, Tiles).
- The status row's `truncated` indicator is replaced with a count
  ("Showing N entries — more available" when `nextCursor !== null`).
- The Settings dialog gains an **EXPLORER** section with a "Page size"
  dropdown (choices: 100 / 500 / 1000 / 5000 / 10000; default **500**).
- A **page-load-failed** inline retry row renders inside the entries
  list with `tag` + `message` + a Retry button that re-issues with
  the same cursor. Auto-retry is exhausted before this row is shown.
- Establish **`docs/design_limitations.md`** as a new project-level
  doc for vendor-quirk notes that aren't requirements (e.g., S3 has
  no native `orderBy`; Drive/OneDrive sort server-side; OneDrive's
  `@odata.nextLink` is a fully-qualified URL, not a token).
- The proposal-level acceptance criteria (3-page paginated folder
  composite test) becomes a `tasks.md` deliverable.

## Capabilities

### New Capabilities

(none — no new capability folder is added)

### Modified Capabilities

- `fs-datasource-engine`: `listDirectory` signature changes (BREAKING
  Strategy interface change); add a new pagination requirement.
- `fs-sync-service`: `files:list` command plumbs `cursor` /
  `pageSize` / `nextCursor` end-to-end; add a new requirement.
- `file-explorer`: Load-more affordance, status-row count, page-size
  Settings entry, page-load-failed retry row.

## Impact

**Code:**
- `packages/fs-datasource-engine/src/base-client.ts` — `DatasourceClient<T>`
  interface, `BaseDatasourceClient.listDirectory`, `runReadOp` plumbing.
- `packages/fs-datasource-engine/src/strategies/{googledrive,onedrive,s3}-client.ts`
  — `doListDirectoryImpl` signature + paged provider calls.
- `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` —
  contract test asserts the new return shape.
- `services/fs-sync/src/commands/files-list.ts` — plumbs request
  fields through; auto-retry wrapper.
- `packages/ipc-contracts/src/files.ts` + `sync-service/commands.ts`
  — request/response shape changes.
- `apps/desktop/src/main/ipc/files/list.ts` — passes new fields
  through; mock-fs branch likewise.
- `apps/desktop/src/renderer/src/features/file-explorer/store.ts` —
  cursor / nextCursor state, page-size pref read, `loadMore` action,
  page-load-failed state.
- `apps/desktop/src/renderer/src/features/file-explorer/{toolbar,status-row,view-modes/*}.tsx`
  — "Load more" affordance integration, status-row count, retry row.
- `apps/desktop/src/renderer/src/features/settings/settings-dialog.tsx`
  — new EXPLORER section + page-size dropdown.
- `apps/desktop/src/preload/...` — settings exposure for page-size
  pref (mirrors existing `ft5.downloads.*` localStorage pattern; no
  new preload binding strictly required).

**APIs / Contracts:**
- `DatasourceClient<T>.listDirectory` (engine) — BREAKING.
- `files:list` request/response (sync-service + ipc-contracts) —
  BREAKING shape additions.
- `window.api.files.list` (renderer surface) — additive, no break.

**Dependencies:** none new. The auto-retry wrapper is hand-rolled with
`AbortController` + `setTimeout`; no `p-retry` or similar — design.md
records the rationale.

**Sequencing / blocking:**
- `migrate-engine-retry-policy-to-consumer` — blocking. Pagination's
  auto-retry must agree with whichever side ends up owning retry.
- `migrate-engine-events-to-consumer` — soft-blocking. listDirectory
  emits no events today; if the migration redefines read-op
  emissions, pagination should follow suit.
- `migrate-engine-cache-invalidation` — soft-blocking. Drive's
  path-cache is touched on each page; the migration may change cache
  ownership.
- `migrate-error-tag-literals-to-const-refs` — informational.
  Pagination introduces no new error tags (cursor invalidation
  surfaces as `tag: "other"` carrying provider message; design.md
  records the decision).

## Provenance

- Spawned by `add-invalid-datasource-state` design.md Non-Goals on
  2026-04-25.
- Originally referenced as `add-engine-listdirectory-pagination` in
  `wire-file-explorer-to-service` (archived 2026-04-24).
- Documented as a known limitation in
  `openspec/specs/file-explorer/spec.md` and the `FilesListValue`
  type's `truncated: boolean` comment.
- Architectural questions resolved during the 2026-05-05 explore
  session — see design.md `## Decisions` for the locked-in choices.
