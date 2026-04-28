# Proposal: Add Google Drive Docs Editors export support

**Status**: Stub. Spawned during `add-engine-rename-download` post-archive smoke on 2026-04-28 — surfaced when the user attempted to download a Google Doc and the strategy correctly refused (per binary-only contract) but the underlying Export API IS available and would close the gap.

## Why

Drive's `files.get?alt=media` only works for files with binary content. Google Docs / Sheets / Slides / Drawings / Forms / Apps Script files have no binary content; attempting to download them returns a 403 with reason `fileNotDownloadable` and the prose `"Use Export with Docs Editors files"`. `add-engine-rename-download` shipped binary-only download per its original scope, so the user-visible result was a raw provider-error toast.

The post-archive fix on `add-engine-rename-download` made the failure user-friendly: the Drive strategy detects `application/vnd.google-apps.*` mimes upstream and refuses with a clean `tag: "unsupported"` message naming the file and pointing at this follow-up. That closes the immediate UX gap but leaves a real capability hole — Drive **does** support exporting these files via `files.export({ fileId, mimeType: <export-mime> })` with a `responseType: "stream"` override that mirrors the alt=media path. Users can already export from Drive's web UI ("File → Download → choose format"); the desktop app should match.

This change wires `files.export` into the Drive strategy with sensible default formats per Apps type so a single click from the file explorer downloads the document in the format users expect (Word for Docs, Excel for Sheets, etc.).

## What this change does

- Detect `application/vnd.google-apps.<subtype>` in `doDownloadFileImpl` (already done in the post-archive fix on `add-engine-rename-download`); promote that branch from "refuse" to "route through `files.export`".
- Call `drive().files.export({ fileId, mimeType: <export-format> }, { responseType: "stream" })` instead of `files.get?alt=media`. The response shape matches the alt=media path closely (stream + headers), so the byte-counting Transform wrapper from §7.7 is reusable.
- Default export formats per Apps subtype:
  - `document` → `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (DOCX)
  - `spreadsheet` → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (XLSX)
  - `presentation` → `application/vnd.openxmlformats-officedocument.presentationml.presentation` (PPTX)
  - `drawing` → `image/png` (PNG)
  - `form` → `application/zip` (ZIP — Forms export the response set as CSV inside a ZIP)
  - `script` → `application/vnd.google-apps.script+json` (JSON)
- Rename the saved file with the matching extension (`.docx`, `.xlsx`, `.pptx`, `.png`, `.zip`, `.json`) appended to the original Google Apps title — the title itself has no extension because Drive's native files don't carry one.
- (Optional UX, decide during `/opsx:propose`) surface a "Download as..." submenu in the renderer's context menu for Google Apps files so users can pick a non-default format inline. Default-only is acceptable for v1.
- Test coverage across all six Apps subtypes (one per default-format mapping) and one mixed-folder case verifying that binary files in the same folder still go through alt=media unchanged.

## Out of scope

- **Microsoft 365 files** (Word / Excel / PowerPoint hosted on OneDrive). These already have binary content downloadable via OneDrive's standard download endpoint; no export equivalent is needed.
- **Drive export quotas.** Drive imposes a maximum file size for exports (currently ~10 MB for documents). The first version surfaces the provider's quota-exceeded error verbatim; a follow-up may add a quota-aware pre-check.
- **User-customisable default format per Apps subtype** (e.g. "always export Sheets as CSV instead of XLSX"). Defaults are wired in code; per-user overrides would live in the settings store and are deferred.
- **Mid-export resume.** `files.export` doesn't support `Range:` headers the way `files.get?alt=media` does; resume on partial export is a separate problem and is not in scope.

## Open questions (resolve during `/opsx:propose`)

1. **Silent default vs always-prompt.** Should the renderer always use the default format silently, or always prompt with a "Download as..." dialog the user dismisses? Defaults reduce clicks; prompts surface choice. A middle path — default + a Shift-click override — mirrors the existing Save-as bypass.
2. **Filename extension policy.** Drive's Google Apps files have no extension in the title. After export, the saved file is `<title>.<ext>` (e.g. `My Doc.docx`). What if the title already ends in something extension-shaped (e.g. user named it `Notes.txt`)? Append regardless (`Notes.txt.docx`) or strip-and-replace? Strip-and-replace is friendlier; appending is honest.
3. **Where does the format choice live.** Three options: (a) settings page (per-user, per-subtype default), (b) per-download (prompt every time), (c) both (settings provides default, prompt with Shift-click). (c) parallels existing patterns (default folder + Always-ask + Shift-click in the download orchestrator).
4. **Apps Script default.** Apps Script has only a JSON export — should we even surface it in the file explorer? Niche; consider hiding Apps Script files from the UI entirely (they're authored in script.google.com, not consumed as files).

## Acceptance criteria (once promoted)

- Clicking Download on a Google Doc fetches via `files.export({ fileId, mimeType: <DOCX> })`, saves the file as `<title>.docx`, emits the standard `downloading` / `file-downloaded` event sequence, and the success toast shows.
- Clicking Download on each of the other five Apps subtypes (Sheet / Slide / Drawing / Form / Script) succeeds with the matching default format + extension.
- Binary Drive files (`text/plain`, `application/pdf`, etc.) continue to flow through `files.get?alt=media` with no behaviour change — verified by a regression test that downloads a `.txt` file end-to-end.
- The engine's Google Apps refusal path from `add-engine-rename-download` (post-archive smoke fix) is REMOVED — the new export path replaces it. Removal is captured as a `## REMOVED Requirements` block in the spec delta during `/opsx:propose`.
- Test coverage: one happy-path test per Apps subtype (six total), plus the binary-regression test, plus one quota-exceeded test surfacing the friendly error pattern from the existing files-error-mapping helper.

## Provenance

- Spawned during `add-engine-rename-download` post-archive manual smoke on 2026-04-28 by user dev2@forti5.tech. The strategy correctly threw `tag: "unsupported"` per the binary-only spec, but the user noted the export endpoint exists and the limitation is artificial.
- The post-archive fix landed clean refusal copy + a parked-stub pointer (this proposal). The actual capability work happens here.
