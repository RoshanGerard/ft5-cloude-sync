# Proposal: Add an "Invalid Datasource" state

## Why

The file explorer's current rate-limited / other error path collapses
misconfigured-datasource failures (registry drift, missing credential file,
wrong credential shape) into a terse `Failed to load: <raw engine message>`
inline surface. Users cannot tell whether to retry, reconnect, or
remove-and-recreate. The dashboard card shows the same opaque
`errorReason` text. This change introduces a dedicated `invalid-datasource`
error tag carried end-to-end (engine → sync-service → renderer) so both
surfaces can render an actionable Pattern-A state with **Reconnect** +
**Remove** affordances.

## What Changes

- **Engine**: refactor `DatasourceErrorTag` from a string-literal union to
  an `as const` object with derived type (matching the existing
  `FILES_CHANNELS` / `DATASOURCES_CHANNELS` convention), and add a new
  `InvalidDatasource: "invalid-datasource"` member. Existing literal call
  sites continue to type-check and are NOT mechanically migrated by this
  change.
- **Engine**: `factory.create(...)` throws
  `DatasourceError({ tag: "invalid-datasource" })` instead of generic
  `Error` when the providerId is unknown or the supplied credential's
  shape does not match the provider's expected schema.
- **Sync-service**: `resolveClient` (in `bootstrap.ts`) replaces its raw
  `throw new Error("no credentials registered…")` with the typed
  `DatasourceError({ tag: "invalid-datasource" })`. Per-command handlers
  (`files-list.ts`, `files-stat.ts`, `files-search.ts`, `files-remove.ts`)
  stay thin — the existing `try/catch → normalizeFilesError` flow is
  unchanged.
- **Sync-service**: same const-object refactor for `FilesErrorTag` (4 → 5
  members, derived type), plus a 1:1 mapping in `normalizeFilesError`
  (`engine "invalid-datasource"` → envelope `"invalid-datasource"`).
- **Renderer (file explorer)**: new `<InvalidDatasourceState>` Pattern-A
  full-replace component (`AlertTriangle` icon, red sentiment via icon,
  neutral primary `Reconnect` button, ghost-destructive `Remove` button).
  Branched in `file-explorer.tsx` when `state.errorTag === FilesErrorTag.InvalidDatasource`.
  Reconnect calls `startConsent` in-place (no dashboard redirect), shows a
  spinner while pending, and triggers `store.retryLoad()` on
  `consent-completed` so the entries appear without a manual refresh.
- **Renderer (dashboard card)**: new `<InvalidDatasourceBanner>` (sibling
  of the existing `AuthErrorBanner`) rendered when
  `summary.status === "error" && summary.errorKind === "invalid-datasource"`.
  Same Reconnect + Remove behavior as the explorer state.
- **Renderer (shared)**: new `<ConfirmRemoveDatasourceDialog>` used by
  both the explorer state's Remove button AND the dashboard banner's
  Remove button so destructive removal goes through one confirm flow.
- Executors (upload, mirror-sync) get free coverage of the new tag via
  the same `resolveClient` port — no executor code changes required.

No BREAKING changes. The const-object refactor is non-breaking because
the derived type is the same string union; existing literal references
continue to compile.

## Capabilities

### New Capabilities

None. All work modifies existing capabilities.

### Modified Capabilities

- `fs-datasource-engine`: `DatasourceErrorTag` gains an
  `InvalidDatasource` member; `factory.create` throws with the new tag
  for unknown providerId or wrong-shape credential.
- `fs-sync-service`: `FilesErrorTag` gains an `InvalidDatasource`
  member; `resolveClient` throws the typed error;
  `normalizeFilesError` maps the engine tag 1:1 to the envelope tag.
- `file-explorer`: new `<InvalidDatasourceState>` rendered when the
  files envelope returns `errorTag === "invalid-datasource"`; Reconnect
  flow runs in-place via `startConsent` and refreshes via
  `store.retryLoad()`; Remove goes through the shared confirm dialog.
- `datasources-ui`: dashboard card renders an
  `<InvalidDatasourceBanner>` mirroring the existing `AuthErrorBanner`
  pattern when `errorKind === "invalid-datasource"`.

## Impact

- **Affected code**: `packages/ipc-contracts/src/{files,fs-datasource-engine,datasources}.ts`,
  `packages/ipc-contracts/src/sync-service/errors.ts`,
  `packages/fs-datasource-engine/src/factory.ts` (or equivalent),
  `services/fs-sync/src/main/bootstrap.ts:189`,
  `services/fs-sync/src/commands/files-error-mapping.ts`,
  `apps/desktop/src/renderer/src/features/file-explorer/states/invalid-datasource.tsx` (new),
  `apps/desktop/src/renderer/src/features/file-explorer/file-explorer.tsx`,
  `apps/desktop/src/renderer/src/features/datasources/card.tsx`,
  `apps/desktop/src/renderer/src/features/datasources/confirm-remove-dialog.tsx` (new shared component).
- **APIs**: extends the existing `DatasourceErrorTag` and `FilesErrorTag`
  unions; no new IPC channels; no new RPC commands. Reuses the existing
  `datasources:start-consent` and `datasources:remove` surfaces.
- **Dependencies**: none added. Uses existing shadcn primitives
  (`Dialog`, `Button`), Lucide `AlertTriangle`, the existing
  `useConsentSession` hook, and the existing `useDatasourceActions`
  hook.
- **Tests**: extends `files-error-mapping.test.ts`,
  `card-auth-error-banner.test.tsx` pattern (for the new banner
  sibling), `file-explorer-composite.test.tsx`,
  `states-integration.test.tsx`, plus new dedicated tests for the
  state component, banner, and confirm dialog.
- **Migration**: none. No data schema changes, no persistent state
  written.
