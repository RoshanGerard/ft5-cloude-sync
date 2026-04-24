# Proposal: Diagnose and fix Drive `listDirectory` returning only app-uploaded files

**Status**: Stub. Discovered during smoke-testing of `wire-file-explorer-to-service` on 2026-04-24.

## Why

A real Google Drive datasource configured in the dev environment shows **only files uploaded through the app** — files that already existed in the user's Drive before the app was connected are invisible. Static code review of `packages/fs-datasource-engine/src/strategies/googledrive-client.ts` shows no obvious bug:

- Query is `'<fileId>' in parents and trashed=false` — correct for listing a folder's children.
- `OAUTH_SCOPE` is `https://www.googleapis.com/auth/drive` (full) — not the narrower `drive.file`.
- `DRIVE_ROOT_FILE_ID = "root"` — canonical alias for the user's My Drive root.
- No `appProperties` or other app-author filter is applied.
- `DEFAULT_FILE_FIELDS` includes `id, name, mimeType, parents, size, modifiedTime, createdTime`.

So the *static* code looks correct. Candidate root causes that can't be verified without live access:

1. **Sticky OAuth scope.** The credential in `credentials.json` was issued under a narrower consent (`drive.file`). Changing the requested scope in source does not widen an already-issued refresh token. Fix requires re-consent — blocked on sibling change `add-drive-oauth-browser-consent`.
2. **Pagination.** `doListDirectoryImpl` does not follow `nextPageToken`. For a root folder with >1000 entries only the first page returns. Unlikely to produce "only uploaded files visible" unless the uploads happen to fill the early lexicographic ordering.
3. **Credential provenance.** The file-based credential at `$HOME/ft5/sync_app/dev/credentials.json` was generated out-of-band (see `add-drive-oauth-browser-consent`). If it's a service-account credential, the service account has its own empty Drive and cannot see the user's My Drive at all — files uploaded *by the service account* would appear; everything else would not.
4. **Shared drives.** `files.list` with `'root' in parents` ignores shared drives unless `supportsAllDrives: true` and `includeItemsFromAllDrives: true` are set.

## Out of scope

- Pagination support (`add-engine-listdirectory-pagination` already tracked in `wire-file-explorer-to-service` design.md as a follow-up).
- The OAuth browser flow itself (`add-drive-oauth-browser-consent`).

## Open questions (resolve during `/opsx:propose`)

1. **Is the dev credential a service account?** Inspect `credentials.json` contents (look for `type: "service_account"` or `private_key`) vs OAuth-issued (`refresh_token`). This determines whether #1 (sticky scope) or #3 (service-account Drive) is the actual cause.
2. **Can we reproduce with a cleanly re-consented OAuth token?** Blocked on `add-drive-oauth-browser-consent`. Until that lands, diagnosis is guesswork.
3. **If service-account:** document that the Drive provider under service-account credentials sees only files explicitly shared with the service-account email. Update onboarding copy. This is *not a bug* — it's the intended Drive API behavior.
4. **If OAuth with sticky scope:** add a "scope drift detector" that inspects the issued token's `scope` claim (from the `/tokeninfo` endpoint) and warns when it disagrees with `OAUTH_SCOPE`.
5. **Shared-drives behavior.** Should the engine's `listDirectory` set `includeItemsFromAllDrives: true`? Document tradeoff: broader visibility vs noisier listing.

## Acceptance criteria (once promoted)

- Root cause identified and documented (scope drift vs service-account vs pagination vs shared-drives).
- If scope drift: detector warns at connect time when the issued scope ≠ requested scope.
- If service-account: onboarding flow and UI copy call this out; folder-share docs linked.
- Regression test that asserts a freshly-consented OAuth token with full `drive` scope lists pre-existing My Drive files.

## Provenance

- Raised by user dev2@forti5.tech on 2026-04-24 during smoke-testing of `wire-file-explorer-to-service`.
- Advisor (same session) recommended deferring to a sibling change rather than blind-fixing inside `wire-file-explorer-to-service`.
