# Proposal: Add an "Invalid Datasource" state to the file explorer

**Status**: Stub. Discovered during smoke-testing of `wire-file-explorer-to-service` on 2026-04-24.

## Why

The file explorer today has four Pattern-A full-replace states — `disconnected`, `auth-revoked`, `syncing`, `empty` — plus an inline "Failed to load" surface for `rate-limited` and `other` errors. A real-world failure mode the inline surface handles poorly is a **misconfigured / invalid datasource**: a record exists in the datasources store, the UI successfully mounts the explorer, but the sync-service rejects every `files:*` call because the credential is missing, the datasourceId is unknown to the service, or the credential shape is wrong for the declared `providerKind`. Today that surfaces as a terse "Failed to load" line with the raw engine message — the user can't tell whether to retry, reconnect, or delete-and-recreate.

A dedicated Pattern-A state would give those users a clear next step the same way `disconnected` and `auth-revoked` do today.

## Out of scope (tracked as separate changes)

- `add-drive-oauth-browser-consent` — interactive OAuth flow for adding a Drive datasource (currently falls back to a file-based credential).
- `fix-drive-listdirectory-scope-drift` — Drive listing returns only app-uploaded files on certain credential provenances.

## Open questions (resolve during `/opsx:propose`)

1. **Error tag surface.** The current `FilesErrorTag` union is `auth-revoked | disconnected | rate-limited | other`. Is `invalid-datasource` a fifth tag, or is it a refinement of `other` that the sync-service keys on a different field (e.g., a `reason` discriminator)? Prefer explicit tag for UX branching, but consider the 9→4 collapse in `normalizeFilesError` and whether adding a fifth breaks that shape.
2. **Action affordance.** Is the primary action "Reconnect" (same as auth-revoked), "Reconfigure datasource" (opens the edit form), or "Remove datasource" (destructive)? Probably depends on whether a fix is possible without losing sync history.
3. **Visual treatment.** Pattern A full-replace with an amber or red sentiment? The spec's WCAG rules already fix amber-600 on white; a red sentiment would need its own contrast verification.
4. **Trigger conditions.** Enumerate the exact service-side cases: (a) `datasourceId` unknown to service; (b) credential file absent; (c) credential present but shape wrong for `providerKind`; (d) provider descriptor says the credential was valid at issue time but the provider has revoked it beyond what `auth-revoked` covers. Each may warrant the same tag or different ones.
5. **Interaction with the datasources store.** If the store's own status for this datasource is already `error`, should the state defer to that text, or display its own copy? (Today the store's error flows through separately; the spec's engine-wins rule in `wire-file-explorer-to-service` means the file explorer would typically show its own state.)

## Acceptance criteria (once promoted)

- A user with a misconfigured datasource sees a Pattern-A full-replace treatment that names the failure and offers a single primary action.
- The state component meets WCAG AA contrast, carries `role="alert"`, and has keyboard-reachable action.
- A Vitest composite test covers at least two trigger conditions.
- The main-IPC surface does not need a new command — the state is a UX refinement of existing `files:list` rejections.

## Provenance

- Raised by user dev2@forti5.tech on 2026-04-24 during smoke-testing of `wire-file-explorer-to-service`.
- Recommendation to document as a future change came from the advisor during that same session.
