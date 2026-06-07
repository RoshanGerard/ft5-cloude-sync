# Tasks: `add-engine-listdirectory-pagination`

## 0. Prerequisites — assessed; `/opsx:apply` is UNBLOCKED (2026-06-07)

The BLOCKING prerequisite is merged. The two SOFT prerequisites were
assessed non-blocking for pagination (rationale inline) — they relocate
sites pagination merely *uses*, so they adapt to pagination later, not
the reverse.

- [x] 0.1 `migrate-engine-retry-policy-to-consumer` (BLOCKING — auto-retry coordinates with retry ownership) — **MERGED** 2026-06-07 (`d26f26d`). fs-sync owns auth-expired refresh via `withAuthRefresh`; `files-list.ts` is already wrapped, and pagination's env-retry composes as the outer ring around it.
- [x] 0.2 `migrate-engine-events-to-consumer` (SOFT — per-page event emission) — **ASSESSED NON-BLOCKING** (not merged). `listDirectory` emits no success event today (`runReadOp` in `base-client.ts` emits only on failure: `rate-limited` / `status-changed`), and pagination adds none. No read-op emission exists for the events migration to coordinate with; if it later adds a `directory-listed` event, first-page-only emission is its concern. No double-rewrite.
- [x] 0.3 `migrate-engine-cache-invalidation` (SOFT — Drive per-page cache-write site) — **ASSESSED NON-BLOCKING** (not merged). Drive's `doListDirectoryImpl` populates the path cache at the existing call site; pagination keeps that site (populating incrementally per page — task 2.5 verifies). The cache migration relocates invalidation *ownership*, which pagination does not touch. No double-rewrite.
- [x] 0.4 ~~Re-run `superpowers:brainstorming` Visual Companion to fill `design.md` `## Visual direction` TODOs~~ — Resolved 2026-05-05 in Visual Companion session (mockups archived in `.superpowers/brainstorm/2462-1777928142/content/`); decisions V-1 through V-4 locked into `design.md` `## Visual direction` and `specs/file-explorer/spec.md` scenarios
- [x] 0.5 Confirm `design.md` Decision 4 auto-retry interpretation — **CONFIRMED 4 attempts** (initial + 3 retries at 2s/5s/7s) per the user's "proceed" on the design's recommended reading. The count is a single constant, adjustable if support feedback warrants.
- [x] 0.6 Re-run pre-apply staleness check per CLAUDE.md `## Workflow` step 6 — **DONE** 2026-06-07. Verified `runReadOp` / `listDirectory` wrapper / `doListDirectoryImpl` shapes against current `base-client.ts`; corrected 3 stale `withRefresh` refs in `design.md` (Decision 4, Decision 7 item 5, Risks Migrate-chain) to the as-merged `withAuthRefresh` model. Flagged tasks-vs-design conflict at 12.2 (shadcn `Select` vs `DropdownMenu`) to resolve at apply.

## 1. Engine port + base wrapper

- [ ] 1.1 Update `DatasourceClient<T>.listDirectory` signature in `packages/fs-datasource-engine/src/base-client.ts` from `(target) => Promise<DatasourceFileEntry<T>[]>` to `(target, options?: { cursor?: string; pageSize?: number }) => Promise<{ entries: DatasourceFileEntry<T>[]; nextCursor: string | null }>`
- [ ] 1.2 Update `BaseDatasourceClient.listDirectory` wrapper to accept and forward the new options parameter; preserve `runReadOp` wrap unchanged
- [ ] 1.3 Update `protected abstract doListDirectoryImpl` signature to receive `(target, options: { cursor?: string; pageSize?: number })` and return the new shape
- [ ] 1.4 Add unit tests for the base wrapper covering: options passthrough, default options when omitted, nextCursor surfaced in return, error envelope unchanged on rejection
- [ ] 1.5 Update `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` to assert the new return shape on every concrete strategy

## 2. Strategy: Google Drive

- [ ] 2.1 Update `GoogleDriveClient.doListDirectoryImpl` to accept the options parameter
- [ ] 2.2 Forward `options.cursor` to the SDK as `pageToken`; clamp `options.pageSize` to `[1, 1000]`; default to 1000 when omitted
- [ ] 2.3 Read `nextPageToken` from the response; populate `nextCursor` on the returned shape
- [ ] 2.4 Update `googledrive-client.test.ts` to cover: first-page call (no cursor), next-page call with cursor, pageSize clamp at 5000 → 1000, pageSize default of 1000
- [ ] 2.5 Verify `cachePathHandle` continues to populate the path cache for every entry across pages

## 3. Strategy: OneDrive

- [ ] 3.1 Update `OneDriveClient.doListDirectoryImpl` to accept the options parameter
- [ ] 3.2 First-page call: forward `options.pageSize` as `$top` (clamp `[1, 999]`); when omitted, use Graph default
- [ ] 3.3 Next-page call: validate `options.cursor` starts with `https://graph.microsoft.com/v1.0/`; on mismatch throw `DatasourceError { tag: "provider-error" }` with NO network call. (Reconciled 2026-06-07: the engine has no `"other"` tag — that is wire-level only; fs-sync's `normalizeFilesError` collapses engine `provider-error` → wire `"other"`, preserving Decision 8's intent.)
- [ ] 3.4 Next-page call: pass the validated URL directly to `graph.api(cursor).get()`; do not re-attach `$top` on a `@odata.nextLink` (it is already in the URL)
- [ ] 3.5 Read `@odata.nextLink` from the response; populate `nextCursor`
- [ ] 3.6 Update `onedrive-client.test.ts` to cover: first-page with default, first-page with `pageSize`, next-page with valid `@odata.nextLink`, next-page with invalid URL prefix → engine `tag: "provider-error"` (collapses to wire `"other"`)

## 4. Strategy: S3

- [ ] 4.1 Update `S3Client.doListDirectoryImpl` to accept the options parameter
- [ ] 4.2 Replace the existing `do/while` auto-loop with a single `ListObjectsV2` call
- [ ] 4.3 Forward `options.cursor` as `ContinuationToken`; clamp `options.pageSize` to `[1, 1000]` and forward as `MaxKeys`; default to 1000 when omitted
- [ ] 4.4 Read `IsTruncated` and `NextContinuationToken`; populate `nextCursor` (null when not truncated)
- [ ] 4.5 Update `s3-client.test.ts` to cover: first-page with no cursor, next-page with continuation token, pageSize clamp, the auto-loop behavior is REMOVED
- [ ] 4.6 NOTE: `doSearchImpl` retains its own internal `do/while` (search is full-subtree enumeration; pagination of search is out of scope per proposal)

## 5. IPC contracts

- [ ] 5.1 Update `packages/ipc-contracts/src/files.ts`: add optional `cursor?: string` and `pageSize?: number` to `FilesListRequest`; add `nextCursor: string | null` to `FilesListValue`; reverse the comment block at L105-108 explaining the field's history
- [ ] 5.2 Update `packages/ipc-contracts/src/sync-service/commands.ts`: same additions to the `files:list` command's request and response types
- [ ] 5.3 Update `packages/ipc-contracts/src/__tests__/files.test-d.ts` to assert the new shape (test-d only — type assertions, no runtime tests needed here)
- [ ] 5.4 Update `packages/ipc-contracts/src/sync-service/__tests__/files-commands.test-d.ts` similarly

## 6. fs-sync command + auto-retry

- [ ] 6.1 Update `services/fs-sync/src/commands/files-list.ts` to forward `cursor` and `pageSize` to `client.listDirectory`
- [ ] 6.2 Wrap the `listDirectory` call in a back-off retry loop: 4 attempts total with 2s / 5s / 7s waits between (NOT before attempt 1)
- [ ] 6.3 Honor `retryAfterMs` on `tag: "rate-limited"` rejections via `max(retryAfterMs, scheduledBackoff)`
- [ ] 6.4 Limit retry to `tag` ∈ `{ "network-error", "rate-limited", "provider-error" }` AND `err.retryable === true`; pass other tags — and any non-retryable error (e.g. OneDrive's deterministic malformed-cursor `provider-error { retryable: false }`, §3.3) — through immediately so the loop never burns its ~14s budget on a guaranteed-to-fail re-attempt (reconciled 2026-06-07 from engine-slice review)
- [ ] 6.5 Surface `nextCursor` on the response envelope; derive `truncated` as `nextCursor !== null`
- [ ] 6.6 Update `files-list.test.ts`: cover first-page no-cursor, next-page with-cursor, retry-then-success on attempt 4, retry-exhaustion → last error returned, retryAfterMs override, non-retryable tag returns immediately
- [ ] 6.7 Verify `files-search.ts` is NOT touched (search pagination is out of scope)

## 7. Main-process handler (desktop)

- [ ] 7.1 Update `apps/desktop/src/main/ipc/files/list.ts` to forward `cursor` and `pageSize` from the IPC request to the sync-service `files:list` command
- [ ] 7.2 Pass `nextCursor` through the response unchanged
- [ ] 7.3 Mock-fs handler (`apps/desktop/src/main/ipc/files/mock-fs.ts`): if mock-fs is still wired for `files:list` post-add-engine-rename-download (it should not be — verify), make it return `nextCursor: null` unconditionally; if no longer wired, no change
- [ ] 7.4 Update `apps/desktop/src/main/ipc/files/__tests__/list.test.ts`

## 8. Renderer store

- [ ] 8.1 Update `apps/desktop/src/renderer/src/features/file-explorer/store.ts` to track `nextCursor: string | null` per current path
- [ ] 8.2 Add `loadMore` action that re-issues `window.api.files.list` with the stored `nextCursor` and current `pageSize`
- [ ] 8.3 On success: append entries, update `nextCursor`
- [ ] 8.4 On failure (after fs-sync retry exhaustion): record the error envelope; the cursor remains untouched so manual Retry can re-issue with it
- [ ] 8.5 Add a manual `retryLoadMore` action that re-issues with the same cursor + pageSize; clears the failed-state on success
- [ ] 8.6 On navigation away from the current path: clear `nextCursor` and any failed-state (cursors are per-path)
- [ ] 8.7 Read `pageSize` from localStorage `ft5.explorer.pageSize` (default 500) on every list call origination
- [ ] 8.8 Update `store.test.ts` covering: load-more success, load-more failure-then-retry-success, navigation discards cursor, pageSize read

## 9. Renderer UI: Load-more affordance

- [ ] 9.1 Implement Load-more affordance component (place under `apps/desktop/src/renderer/src/features/file-explorer/load-more.tsx`)
- [ ] 9.2 Place the affordance in its OWN shared region between the scrollable entries area and the status row (Visual direction V-1) — NOT inside any view-mode scroll container — so it renders below all six view modes at full width, always visible at the bottom regardless of scroll. (Supersedes the pre-Visual-Companion per-view-mode "last row"/"footer below the grid" wording; V-1 locked a single shared placement.)
- [ ] 9.3 Verify the single shared placement renders + behaves correctly under each of the six view modes (List, Details, Small/Medium/Large Icons, Tiles) — same full-width component, not duplicated per mode.
- [ ] 9.4 Implement busy state (`aria-busy="true"` + spinner + disabled)
- [ ] 9.5 Add unit tests for each view mode's integration

## 10. Renderer UI: Page-load-failed inline retry row

- [ ] 10.1 Implement page-load-failed row component
- [ ] 10.2 Render in place of the Load-more affordance when the explorer store records a load-more failure
- [ ] 10.3 Show humanized `tag` + `message` and a Retry button; `aria-live="assertive"`
- [ ] 10.4 Wire Retry to `store.retryLoadMore`; on success, swap back to Load-more or hide if `nextCursor === null`
- [ ] 10.5 Verify focus does not steal from the entries area on appearance

## 11. Renderer UI: Status row

- [ ] 11.1 Update `apps/desktop/src/renderer/src/features/file-explorer/status-row.tsx` to the three-state count of Visual direction V-3 (supersedes the earlier "Showing N entries — more available" wording): `nextCursor !== null` → `<N>+ items · <N> loaded`; most-recent load-more failed (`loadMoreError !== null`) → `<N> items · couldn't load more`; `nextCursor === null` → `<N> items` (existing no-suffix behavior). Keep digits in `tabular-nums` and `aria-live="polite"`.
- [ ] 11.2 Preserve the existing "· N selected" suffix when a selection exists
- [ ] 11.3 Update `status-row.test.tsx` to cover both cases

## 12. Renderer UI: Settings dialog Explorer section

- [ ] 12.1 Add an EXPLORER section to `apps/desktop/src/renderer/src/features/settings/settings-dialog.tsx` as a sibling of the existing DOWNLOADS section
- [ ] 12.2 Implement the Page-size row using shadcn `Select` bound to `ft5.explorer.pageSize`
- [ ] 12.3 Default to 500 on first read; persist on change
- [ ] 12.4 Verify keyboard reachability + focus ring + accessible label
- [ ] 12.5 Update settings-dialog tests covering default, persistence, all five options

## 13. Composite test

- [ ] 13.1 Add a renderer composite test demonstrating a 3-page paginated folder: first page renders 500 entries with Load-more visible, click Load-more renders 500 more, click Load-more renders the final 200 with Load-more hidden
- [ ] 13.2 Add an integration test demonstrating the auto-retry path: `client.listDirectory` rejects 3 times then resolves on attempt 4; renderer surfaces 4 attempts' worth of cumulative wait via fake timers
- [ ] 13.3 Add an integration test demonstrating the manual Retry path: auto-retry exhausts, page-load-failed row renders, Retry click re-issues with the same cursor

## 14. `docs/design_limitations.md`

- [ ] 14.1 Create `docs/design_limitations.md` (new file; `docs/` directory will be created)
- [ ] 14.2 Add the five initial entries listed in `design.md` Decision 7
- [ ] 14.3 Reference the file from `proposal.md` and from the README's Documentation section if one exists

## 15. Validation + close-out

- [ ] 15.1 `pnpm test` (full suite) green
- [ ] 15.2 `pnpm typecheck` green
- [ ] 15.3 `pnpm lint` green
- [ ] 15.4 `openspec validate add-engine-listdirectory-pagination --strict` green
- [ ] 15.5 Advisor checkpoint #2 (before declaring done) per CLAUDE.md
- [ ] 15.6 Smoke test in packaged build: open a Drive folder of >1000 items, confirm initial 500 + Load-more flow renders all entries
- [ ] 15.7 Smoke test: open the same folder on a constrained network and confirm auto-retry / manual-retry / both surface as expected
- [ ] 15.8 Archive the change via `openspec archive add-engine-listdirectory-pagination`
