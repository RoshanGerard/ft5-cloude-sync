# Proposal: Add pagination to engine `listDirectory`

**Status**: Stub. Spawned by Non-Goals in `add-invalid-datasource-state`'s
`design.md` on 2026-04-25; previously referenced by name in
`wire-file-explorer-to-service` design.md as a known limitation.

## Why

The engine's `listDirectory` returns at most one provider page per call
and does not expose a continuation token. Folders with more entries
than fit in one provider page (Drive: 1000, OneDrive: default,
S3: list limit) silently truncate. The renderer surfaces
`truncated: true` in `FilesListValue` but offers no way to fetch the
next page. Users with large folders see a partial listing with no
visible indication beyond a small status-row hint.

This change plumbs a continuation token through the engine and
exposes a "Load more" affordance in the file-explorer.

## Out of scope

- Infinite-scroll auto-loading. Manual "Load more" is the v1
  affordance; auto-load can land later if usability testing shows it
  is wanted.
- Server-side pagination of search results. `files:search` is a
  separate concern (see `add-engine-native-search`).
- Cursor-based persistence across sessions. The cursor is per-list-call
  and discarded on navigation away.

## Open questions (resolve during `/opsx:propose`)

1. **Cursor shape.** Each provider exposes its own continuation token
   (Drive: `nextPageToken`, OneDrive: `@odata.nextLink`,
   S3: `ContinuationToken`). Plumb each as an opaque string, or
   normalize to a structured cursor? Recommend opaque string passed
   through the engine without engine knowledge.
2. **Page size.** Currently each provider's default. Expose a
   page-size hint on the engine API or stay with provider defaults?
3. **`<Toolbar>` "Load more" placement.** Inline at the bottom of
   the entries list, or in the status row? Inline is the
   industry norm.
4. **Retry of a paginated load that fails mid-batch.** If page 2
   fetch errors, do we discard pages 1–1 already shown, keep them
   and surface an error, or re-fetch page 1+2 transactionally?
   Recommend keep-and-surface.
5. **Interaction with sort / search.** Re-sorting an already-paginated
   list either (a) re-fetches from page 1, or (b) sorts only what's
   loaded. Same question for search inside a paginated folder.

## Acceptance criteria (once promoted)

- Engine's `listDirectory` exposes `{ entries, nextCursor: string | null }`
  per call.
- Each provider strategy plumbs its native continuation token through
  the cursor field.
- Renderer file-explorer renders a "Load more" affordance below the
  entries list when `nextCursor !== null`.
- Composite test demonstrates a 3-page paginated folder listing all
  pages on demand.
- Status row's `truncated` indicator is replaced (or augmented) by
  the page count once pagination is wired.

## Provenance

- Spawned by `add-invalid-datasource-state` design.md Non-Goals on
  2026-04-25.
- Originally referenced as `add-engine-listdirectory-pagination`
  in `wire-file-explorer-to-service` (archived 2026-04-24).
- Documented as a known limitation in
  `openspec/specs/file-explorer/spec.md` and the FilesListValue
  type's `truncated: boolean` comment.
