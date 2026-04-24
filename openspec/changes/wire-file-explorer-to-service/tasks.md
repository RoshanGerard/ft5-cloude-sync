## 1. Contracts — `files:*` commands and response envelopes

- [x] 1.1 Write failing type-test fixtures under `packages/ipc-contracts/src/sync-service/__tests__/files-commands.test-d.ts` asserting that `CommandMap` contains `files:list`, `files:stat`, `files:search`, `files:remove` with the exact param and result shapes from `design.md` Decision 1 / Decision 2 (tagged envelope, per-path remove results).
- [x] 1.2 Extend `CommandMap` and `COMMAND_NAMES` in `packages/ipc-contracts/src/sync-service/commands.ts` with the four `files:*` commands and their param/result/error shapes; green the type-tests.
- [x] 1.3 Widen `FilesListResponse`, `FilesStatResponse`, `FilesSearchResponse`, `FilesRemoveResponse` in `packages/ipc-contracts/src/files.ts` to carry the discriminated error envelope (`{ ok: true, value } | { ok: false, error: { tag, message, retryable, retryAfterMs? } }`); update tests in `packages/ipc-contracts/src/__tests__/` that pinned the old shapes.
- [x] 1.4 Run `pnpm -r build` and fix any type errors surfaced in consumers.

## 2. Service — `files:*` command handlers in `fs-sync`

- [x] 2.1 Write failing unit tests for `files:list` under `services/fs-sync/src/commands/files-list.test.ts` covering: happy path returns `{ ok: true, value: { entries, truncated: false } }`; `auth-revoked` engine error returns `{ ok: false, error: { tag: "auth-revoked", retryable: false } }`; unknown `datasourceId` returns `{ ok: false, error: { tag: "other" } }`.
- [x] 2.2 Implement `files:list` handler in `services/fs-sync/src/commands/files-list.ts` delegating to `client.listDirectory({ kind: "path", path })` via the service's `ClientFactory`; wire into the command dispatcher.
- [x] 2.3 Repeat TDD loop for `files:stat` (delegates to `client.getMetadata`).
- [x] 2.4 Repeat TDD loop for `files:search` (delegates to `client.search(query, { kind: "path", path })`; `truncated` flag derives from the engine's envelope).
- [x] 2.5 Write failing tests for `files:remove` covering: single-path success; single-path failure (engine throws `rate-limited`); multi-path partial failure using `Promise.allSettled`; directory entry dispatches to `deleteDirectory` (resolved by `getMetadata` before delete). Implement handler in `services/fs-sync/src/commands/files-remove.ts`.
- [x] 2.6 Add a command-dispatcher integration test that exercises all four commands end-to-end against an in-memory fake engine fixture.

## 3. Main process — IPC handler rewire

- [ ] 3.1 Write failing tests for `apps/desktop/src/main/ipc/files/list.test.ts` asserting the handler issues `SyncClient.request("files:list", { datasourceId, path })` and maps the tagged envelope into the main-IPC response unchanged; no `mock-fs` import.
- [ ] 3.2 Rewrite `apps/desktop/src/main/ipc/files/list.ts` against a `SyncClient` holder; remove the `mock-fs` import from this file only.
- [ ] 3.3 Repeat TDD loop for `stat.ts`, `search.ts`, `remove.ts`. Keep `rename.ts` and `download.ts` on `mock-fs`.
- [ ] 3.4 Update `apps/desktop/src/main/ipc/__tests__/no-provider-sdk-imports.test.ts` expectations if scope changed; confirm main-process code still imports zero provider SDKs.

## 4. Renderer — state components and skeleton

- [ ] 4.1 Write failing `__tests__/disconnected.test.tsx` asserting: renders `CloudOff` icon, headline "Can't reach this datasource", body text, amber `Retry` button; `Retry` click dispatches the passed `onRetry` callback; `role="alert"` and `aria-live="polite"` present.
- [ ] 4.2 Implement `apps/desktop/src/renderer/src/features/file-explorer/states/disconnected.tsx`.
- [ ] 4.3 Repeat TDD for `states/auth-revoked.tsx` (icon `KeyRound`, button `Reconnect` → `onReconnect` callback).
- [ ] 4.4 Repeat TDD for `states/syncing.tsx` (icon `RefreshCw` with `animate-spin`, progress label via prop, `role="status"`, no action button).
- [ ] 4.5 Repeat TDD for `states/empty.tsx` (icon `FolderOpen`, neutral color, no button).
- [ ] 4.6 Repeat TDD for `states/skeleton.tsx` — parameterized by active view mode; exports `<Skeleton mode="list" />` / `"details"` / `"small-icons"` / `"tiles"` / `"medium-icons"` / `"large-icons"` and renders 6 rows matching the silhouette per mode; `data-testid="file-explorer-skeleton"`.

## 5. Renderer — wiring states into the explorer

- [ ] 5.1 Write a failing composite test `file-explorer.states-integration.test.tsx`: mount the explorer against a mock `window.api.files.list` that rejects with `{ error: { tag: "auth-revoked" } }`; assert the `AuthRevoked` state renders; assert no file rows; assert `Reconnect` routes to the reconnect action.
- [ ] 5.2 Modify `use-explorer-data.ts` to route rejection envelopes into store state (`errorTag: "auth-revoked" | "disconnected" | "rate-limited" | "other" | null` plus keep existing `error: string | null` for display); preserve the `requestIdRef` stale-response guard verbatim.
- [ ] 5.3 Modify `file-explorer.tsx` branching so: `state.loading && !state.entries.length` → `<Skeleton mode={viewMode} />`; `state.errorTag === "disconnected"` → `<Disconnected onRetry={…} />`; `state.errorTag === "auth-revoked"` → `<AuthRevoked onReconnect={…} />`; datasource-store status `"syncing"` with no prior list resolved → `<Syncing progressLabel={…} />`; resolved with empty entries → `<Empty />`; else ViewModeSwitcher. Remove the old plaintext `Loading…` and `Failed to load` branches.
- [ ] 5.4 Add composite tests for each of the five state transitions (5 new tests, one per state), using the canonical mocked `window.api.files.list` fixtures.
- [ ] 5.5 Add a test asserting **engine response wins over store**: mount with store status `"connected"` but list rejecting with `auth-revoked`; expect `AuthRevoked` rendered, not file rows.

## 6. Renderer — disable Rename / Download for engine-backed datasources

- [ ] 6.1 Write failing test `toolbar.engine-backed-disable.test.tsx`: render toolbar with `providerKind="google-drive"`; expect Download button to carry `aria-disabled="true"` and the tooltip text from the spec.
- [ ] 6.2 Write failing test `context-menu.engine-backed-disable.test.tsx`: open context menu on a file entry with `providerKind="google-drive"`; expect Rename and Download items to carry `aria-disabled="true"` and the spec tooltip copy; activating them is a no-op (no IPC, no state change).
- [ ] 6.3 Write failing test asserting mock datasources (`providerKind="mock"`) retain enabled Rename and Download.
- [ ] 6.4 Thread `providerKind` through the toolbar and context-menu props (already present on `<SearchResults>` — extend to the rest of the chrome). Implement the `aria-disabled` + tooltip behavior; green the tests.
- [ ] 6.5 Assert in a guardrail test that on any engine-backed entry, `store.startEdit(entryId)` SHALL NOT be called from keyboard (F2), context menu, or inline rename cell.

## 7. Spec cleanup — existing tests that assumed mocks

- [ ] 7.1 Remove the Vitest test that enforces the 300-entry mock-fs ceiling; delete it and any fixture it gates; verify no other test depends on the fixture.
- [ ] 7.2 Update `store.test.ts` scenarios that expected the old `{ removed, failed }` bulk-delete shape to the new per-path `results` envelope.
- [ ] 7.3 Update `search-ui.test.tsx` scenarios that asserted the Drive/OneDrive "Native search not available" message to expect engine-backed results (or the tagged error).
- [ ] 7.4 Run `pnpm -r test --silent` and `pnpm -r typecheck` from the repo root; zero failures before moving on.

## 8. Smoke in worktree (real providers)

- [ ] 8.1 Start the desktop app via `./bin/dev.sh start` against the user's real Google Drive datasource; navigate into the connected datasource; observe the initial render shows either skeleton → entries (fast) or the syncing state (first-connect) → entries.
- [ ] 8.2 Kill the network (airplane mode or `Disable-NetAdapter`); re-navigate; assert the `Disconnected` state renders with `Retry`. Click `Retry` after restoring network; assert entries render.
- [ ] 8.3 Revoke the Drive OAuth token (Google → Security → Third-party apps → Revoke for the app); re-navigate; assert the `AuthRevoked` state renders with `Reconnect`; click `Reconnect` and confirm routing (the reconnect flow itself is out of scope — just verify routing).
- [ ] 8.4 Navigate into a known-empty folder; assert `Empty` state renders.
- [ ] 8.5 Select 5 files (mix of success-bound and a lock-expected one if feasible); Delete; confirm the aggregate toast matches "Deleted N of 5; M failed" and per-path error tooltips surface.
- [ ] 8.6 Right-click a file; assert Rename and Download menu items are disabled with the spec tooltip copy; press Enter on each; confirm no IPC call is issued (check sync-service logs).
- [ ] 8.7 Capture screenshots of each state (skeleton, disconnected, auth-revoked, syncing, empty, engine-backed-disabled context menu); save under `openspec/changes/wire-file-explorer-to-service/screenshots/`.

## 9. Verification and finish

- [ ] 9.1 Full test suite green: `pnpm -r test --silent`.
- [ ] 9.2 Full typecheck green: `pnpm -r typecheck`.
- [ ] 9.3 Full lint green: `pnpm -r lint`.
- [ ] 9.4 Request code review on the worktree branch via `requesting-code-review` skill; resolve critical issues.
- [ ] 9.5 Sync delta specs to base specs (`openspec/specs/file-explorer/spec.md` and `openspec/specs/fs-sync-service/spec.md`) during `/opsx:archive`.
- [ ] 9.6 Archive the change in the worktree branch via `/opsx:archive wire-file-explorer-to-service` before merging.
- [ ] 9.7 Merge worktree → master locally using `finishing-a-development-branch`; push to `origin/master`.
