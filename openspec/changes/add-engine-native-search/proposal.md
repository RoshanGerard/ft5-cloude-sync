# Proposal: Wire native provider search for Google Drive and OneDrive

**Status**: Stub. Spawned by Non-Goals in `add-invalid-datasource-state`'s
`design.md` on 2026-04-25.

## Why

`files:search` is wired through the engine to the per-strategy
`search(query, scope)` method, but the Drive and OneDrive strategies
currently REJECT every search call with the canonical message
`FILES_PROVIDER_SEARCH_DEFERRED_MESSAGE = "provider native search is
not wired yet; try a narrower path scope"`. The renderer's search
dispatcher matches on this exact string to surface a "search not
available for this provider" hint instead of a generic error.

The deferral was acceptable when the engine first shipped — search is
a frill compared to list / stat / upload — but real users now
encounter the message and ask for working search.

This change wires the native search APIs:
- Google Drive: `files.list` with `q="name contains 'foo' and trashed=false"`
- OneDrive: `/me/drive/root/search(q='foo')`
- S3 already has no search primitive; the existing path-scope
  filtering remains as a fallback.

## Out of scope

- Full-text content search. v1 is name-based only (matches the
  current renderer search input behavior).
- Indexing / caching of search results across sessions.
- Search filters (file type, size, date range). v1 is
  query-string only.
- Cross-datasource search. Each search is scoped to one datasource.
- S3 native search — S3 has no search primitive; the path-scope
  fallback stays.

## Open questions (resolve during `/opsx:propose`)

1. **Scope semantics.** When the user's `currentPath` is `/projects`,
   does search look:
   (a) Inside `/projects` only (exact-folder scope)
   (b) Inside `/projects` AND its descendants
   (c) Datasource-wide regardless of current path
   The renderer currently passes `scope = currentPath`; promote
   needs to reconcile this with each provider's native scope
   semantics (Drive's `parents` operator vs OneDrive's
   `folder` filter).
2. **Pagination of search results**. Each provider paginates search
   responses too. Reuse the `add-engine-listdirectory-pagination`
   cursor model, or treat search as a separate concern? Recommend
   reuse.
3. **Empty-result UX.** Renderer's existing `<SearchResults>`
   component already handles the empty case. Confirm no copy
   changes needed.
4. **Rate-limit handling.** Search shares the engine's
   per-datasource rate-limit budget with list / stat. Confirm
   the existing `tag: "rate-limited"` envelope flows through
   `files:search` correctly.
5. **Match highlighting**. Out of scope for v1 — confirm.

## Acceptance criteria (once promoted)

- Drive's `search` returns real provider results (no longer rejects
  with `FILES_PROVIDER_SEARCH_DEFERRED_MESSAGE`).
- OneDrive's `search` returns real provider results.
- S3's `search` continues to use the path-scope fallback (or a
  client-side filter) — explicitly NOT changed by this PR.
- Renderer's deferred-search hint disappears for Drive / OneDrive
  datasources.
- The constant `FILES_PROVIDER_SEARCH_DEFERRED_MESSAGE` is removed
  from `packages/ipc-contracts/src/files.ts` (or kept ONLY for the
  S3 case if path-scope fallback is removed in a later change).
- Composite test demonstrates a real search returning entries from
  a fixture for each provider.

## Provenance

- Spawned by `add-invalid-datasource-state` design.md Non-Goals on
  2026-04-25.
- Existing renderer behavior surfaces the deferral via
  `FILES_PROVIDER_SEARCH_DEFERRED_MESSAGE` (defined in
  `packages/ipc-contracts/src/files.ts:134`).
- The renderer's `<SearchResults>` component branches on
  `providerSearchDeferred` to render the hint UX today.
