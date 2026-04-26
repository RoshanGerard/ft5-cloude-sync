# Tasks: add-invalid-datasource-state

Each task lands behind a failing test first per the Superpowers
`test-driven-development` skill. Long-running commands (test suites,
builds) MUST be dispatched via subagent with `run_in_background: true`
per CLAUDE.md.

## 1. Pre-flight & worktree

- [x] 1.1 Confirm with user where to put the worktree: in-place vs sibling (per CLAUDE.md `using-git-worktrees`); default to `.worktrees/add-invalid-datasource-state/` if no answer
- [x] 1.2 Create the worktree + branch via the `using-git-worktrees` skill
- [x] 1.3 Verify a clean baseline: run `pnpm typecheck` and the full vitest suite once in the worktree to confirm green-before-changes (1 pre-existing failure in `scripts/preload-bundle.test.ts` — `tsc -b` overwrites the Vite preload bundle at `dist/preload/index.js`; structural test fragility, unrelated to this change)

## 2. Engine: const-object refactor for `DatasourceErrorTag`

- [x] 2.1 Write a typed test (`packages/ipc-contracts/src/__tests__/datasource-error-tag.test-d.ts`) asserting the new `as const` object shape AND that all 9 existing literal call sites still type-check (use `satisfies` / type-equality fixtures)
- [x] 2.2 Run the failing test to confirm it fails for the right reason (current type is a string-literal union, not a const object)
- [x] 2.3 Convert `DatasourceErrorTag` in `packages/ipc-contracts/src/fs-datasource-engine.ts` from string-literal union to `as const` object + derived type per design.md Decision 1
- [x] 2.4 Run the typed test to confirm pass; run the full ipc-contracts package test suite to confirm no regressions
- [x] 2.5 Run `pnpm typecheck` across the workspace to confirm all 143+ existing literal call sites still compile (no migration in this change)

## 3. Engine: add `InvalidDatasource` member + factory throw

- [x] 3.1 Add `InvalidDatasource: "invalid-datasource"` to the const object; widen the `DatasourceError` constructor's expected tag union via the derived type
- [x] 3.2 Write a unit test for `factory.create` throwing `InvalidDatasource` for unknown providerId (`packages/fs-datasource-engine/src/__tests__/factory-invalid-datasource.test.ts`); MODIFIES the existing "Unknown provider id throws Unsupported" test fixture per spec MODIFIED requirement
- [x] 3.3 Run the failing test to confirm
- [x] 3.4 Update `factory.create` to throw `DatasourceError({ tag: DatasourceErrorTag.InvalidDatasource, ... })` instead of `tag: "unsupported"` for unknown providerId
- [x] 3.5 Write a unit test for wrong-shape credential rejection (S3-shape passed for google-drive providerId) — same test file as 3.2
- [x] 3.6 Run the failing test to confirm
- [x] 3.7 Add per-provider `validateCredentialShape(creds)` helper to each registry entry; wire `factory.create` to invoke it before constructing the strategy; throw `InvalidDatasource` on shape failure (also restructured `ProviderRegistry` to `{ create, validateCredentialShape }` entries; updated `createDefaultProviderRegistry` to wire each strategy's validator export)
- [x] 3.8 Run the engine package's full vitest suite to confirm no regressions

## 4. Sync-service: const-object refactor for `FilesErrorTag` + add `InvalidDatasource`

- [x] 4.1 Write a typed test (`packages/ipc-contracts/src/__tests__/files-error-tag.test-d.ts`) asserting the new `as const` object shape with 5 members AND that existing literal call sites still type-check
- [x] 4.2 Run the failing test
- [x] 4.3 Convert `FilesErrorTag` in `packages/ipc-contracts/src/files.ts` to const object + derived type, including `InvalidDatasource: "invalid-datasource"`
- [x] 4.4 Run typed test to confirm pass; run ipc-contracts suite

## 5. Sync-service: `resolveClient` typed-error throw

- [x] 5.1 Write a unit test (`services/fs-sync/src/main/__tests__/resolve-client.test.ts` — new file) that stubs `credentialStore.get(id)` to return `null` and asserts `resolveClient(id)` rejects with `DatasourceError instanceof` AND `tag === "invalid-datasource"`
- [x] 5.2 Run the failing test to confirm (current path throws plain `Error`)
- [x] 5.3 Modify `services/fs-sync/src/main/bootstrap.ts:189-204` — replace `throw new Error("no credentials registered for datasourceId=…")` with the typed `DatasourceError({ tag: DatasourceErrorTag.InvalidDatasource, datasourceId, retryable: false, message: "Credentials are missing — reconnect this datasource" })` (also extracted `resolveClient` to its own `services/fs-sync/src/main/resolve-client.ts` module so the throw path is directly unit-testable)
- [x] 5.4 Run the test to confirm pass
- [x] 5.5 Run `services/fs-sync` full test suite — no per-command handler should need changes; the existing `try/catch → normalizeFilesError` flow propagates the new tag automatically

## 6. Sync-service: `normalizeFilesError` mapping update

- [x] 6.1 Extend `services/fs-sync/src/commands/files-error-mapping.test.ts` with two new cases: `DatasourceError({ tag: "invalid-datasource" })` → envelope `{ tag: "invalid-datasource", retryable: false }`; non-DatasourceError thrown value continues to map to `Other`
- [x] 6.2 Run the failing tests to confirm
- [x] 6.3 Update `normalizeFilesError` in `services/fs-sync/src/commands/files-error-mapping.ts` to add the explicit `"invalid-datasource"` mapping branch
- [x] 6.4 Write a unit test for `files:list` end-to-end through the new path: stub `resolveClient` to throw the typed error, dispatch the handler, assert response envelope is `{ ok: false, error: { tag: "invalid-datasource", ... } }`
- [x] 6.5 Run the test; confirm pass

## 7. Renderer: `<InvalidDatasourceState>` component

- [x] 7.1 Write component tests (`apps/desktop/src/renderer/src/features/file-explorer/states/__tests__/invalid-datasource.test.tsx`, modeled on `auth-revoked.test.tsx`) covering: render structure (icon, headline, body, both buttons), `role="alert"`, `aria-live="polite"`, `data-testid="file-explorer-state-invalid-datasource"`
- [x] 7.2 Add tests for the `useConsentSession` lifecycle (mock the hook): pending → spinner + buttons disabled; completed → `onReconnectSucceeded()` callback fires; failed/cancelled/timeout → buttons re-enable + inline error line
- [x] 7.3 Add a test for the `providerId` guard: when prop is undefined, Reconnect has `aria-disabled="true"` and clicking does NOT call `startConsent`
- [x] 7.4 Add a test for the Remove button → opens the confirm dialog (just the open-trigger; the dialog itself is a separate component tested in §8) — implemented as `onRequestRemove` callback firing exactly once on click; the parent wires the actual `<ConfirmRemoveDatasourceDialog>` instance per Decision 5
- [x] 7.5 Run failing tests to confirm
- [x] 7.6 Implement `apps/desktop/src/renderer/src/features/file-explorer/states/invalid-datasource.tsx` per design.md Visual direction (red AlertTriangle icon, neutral primary Reconnect button, ghost-destructive Remove button, accessibility attrs); also added `loader-2` to the `<Icon>` adapter (the only sanctioned path for `Loader2` in feature code per the standing lucide-react forbidden-import guardrail)
- [x] 7.7 Run tests to confirm pass — 10 new tests + full apps/desktop renderer suite (78 files / 710 tests) green

## 8. Renderer: shared `<ConfirmRemoveDatasourceDialog>` component

- [x] 8.1 Write tests (`apps/desktop/src/renderer/src/features/datasources/__tests__/confirm-remove-dialog.test.tsx`): dialog opens / closes; destructive Remove button has focus on open; Escape cancels without dispatching `onConfirm`; clicking destructive Remove fires `onConfirm` exactly once
- [x] 8.2 Run failing tests
- [x] 8.3 Implement `apps/desktop/src/renderer/src/features/datasources/confirm-remove-dialog.tsx` using shadcn `Dialog` primitives — copy "Remove this datasource? This deletes the local registry entry; cloud files are not deleted." with Cancel + destructive Remove buttons
- [x] 8.4 Run tests to confirm pass

## 9. Renderer: branch in `file-explorer.tsx`

- [x] 9.1 Extend `apps/desktop/src/renderer/src/features/file-explorer/__tests__/states-integration.test.tsx` with a case: errorTag === "invalid-datasource" → `<InvalidDatasourceState>` is rendered (existing arms for disconnected / auth-revoked / empty stay green)
- [x] 9.2 Extend `file-explorer-composite.test.tsx` with the new branch: service mock returns invalid-datasource envelope → state component renders → click Reconnect → `startConsent` invoked → mocked `completed` event → `store.retryLoad()` called → next service mock returns ok with entries → state component unmounts and entries render
- [x] 9.3 Run failing tests
- [x] 9.4 Add the new branch to `file-explorer.tsx` (~line 489–508): `if (state.errorTag === "invalid-datasource") return <InvalidDatasourceArm ... />` BEFORE the rate-limited / other inline error fallthrough (matched the existing literal pattern at lines 488/491 — `"disconnected"`, `"auth-revoked"` — instead of the const ref to keep the diff focused per design.md Decision 1)
- [x] 9.5 Add `providerId?: string` prop to `FileExplorer`; thread from the route layer (`apps/desktop/src/renderer/src/app/datasources/explore/page.tsx`) — sourced from `match.providerId`. The explore route now also wraps `<FileExplorer>` in `<DatasourcesProvider>` so §7's `useConsentSession` (and §9's `useDatasourceActions`) resolve their context (the dashboard route at `app/page.tsx` already wraps in the same provider; the explore route was missing it because §7's component had not been wired in yet)
- [x] 9.6 Wire `onReconnectSucceeded` to `store.retryLoad()`. The Reconnect button's `startConsent` call stays inside `<InvalidDatasourceState>` per design.md Decision 4 — the component owns its own consent lifecycle, mirroring `AuthErrorBanner`
- [x] 9.7 Wire the Remove button's confirm dialog. Implemented via a tiny `<InvalidDatasourceArm>` subcomponent gated behind the conditional render — preserves contract intent (single shared `<ConfirmRemoveDatasourceDialog>` per arm activation, single `actions.remove({ datasourceId })` IPC) without forcing every existing file-explorer test file (`search-ui`, `rename-guard`, `a11y`, etc.) to wrap in `<DatasourcesProvider>`. Documented deviation from the literal contract wording (which placed `useDatasourceActions` and the dialog at the top of `FileExplorer`); intent satisfied
- [x] 9.8 Run tests to confirm pass

## 10. Renderer: `<InvalidDatasourceBanner>` for dashboard card

- [x] 10.1 Write tests (`apps/desktop/src/renderer/src/features/datasources/__tests__/card-invalid-datasource-banner.test.tsx`, modeled on `card-auth-error-banner.test.tsx`) covering: banner renders iff `summary.status === "error" && summary.errorKind === "invalid-datasource"`; Reconnect → `startConsent`; Remove → confirm dialog; on `consent-completed` event the banner unmounts via summary refresh
- [x] 10.2 Add a test asserting the banner does NOT render for other errorKinds (`network-error` etc. continue to show bare `<p>` text); auth-revoked still shows `<AuthErrorBanner>`
- [x] 10.3 Add a jest-axe test on the new banner (no axe violations) — DEVIATION: project convention rejects jest-axe / vitest-axe (see `features/datasources/__tests__/a11y.test.tsx` header). Used structural a11y assertions instead: non-empty `aria-label`, both buttons have non-empty accessible names, DOM order Reconnect → Remove (= tab order without explicit tabIndex)
- [x] 10.4 Run failing tests
- [x] 10.5 Implement `<InvalidDatasourceBanner>` as a sibling of `<AuthErrorBanner>` inside `card.tsx` (or extract to a new sibling file if `card.tsx` is getting long — design.md does NOT require extraction, leave inline if comfortable)
- [x] 10.6 Update `DatasourceCard` render block (~line 232–246) to dispatch on `errorKind`: auth-class → `<AuthErrorBanner>`, `invalid-datasource` → `<InvalidDatasourceBanner>`, anything else → bare `<p>` (existing behavior)
- [x] 10.7 Run tests to confirm pass — 11 new tests + full apps/desktop datasources suite (18 files / 130 tests) green; broader desktop suite (139 files / 1048 tests) shows 1 unrelated failure in §9 territory (file-explorer states-integration.test.tsx — parallel agent's scope)

## 11. Verification (full-suite + lint + typecheck)

- [x] 11.1 Subagent: dispatch `pnpm typecheck` in background — confirm green (exit 0; `tsc -b` no output)
- [x] 11.2 Subagent: dispatch `pnpm lint` in background — confirm green (exit 0; eslint workspace clean)
- [x] 11.3 Subagent: dispatch `pnpm test` (full vitest workspace) in background — confirm green; investigate any new failures via Superpowers `systematic-debugging` (final run: 247/248 files PASS / 1 file FAIL; the single failure is the documented §1.3 carry-forward in `scripts/preload-bundle.test.ts` — `tsc -b` overwrites the Vite preload bundle; unrelated to this change. The motion-budget regression introduced by the original §7.6 spinner was found and fixed in commit before this checkpoint via `systematic-debugging`: removed `Loader2`/`animate-spin` per `ui-ux-design` Decision 10's standing motion-budget guardrail, reverted the `loader-2` Icon-adapter entry, swapped to AuthErrorBanner's label-swap pattern; design.md `## Visual direction` and the file-explorer spec scenarios were updated to reflect the reconciled approach)
- [x] 11.4 Use Superpowers `verification-before-completion` skill to confirm typecheck + lint + tests are all reporting green before claiming the change complete (typecheck PASS, lint PASS, tests 1954/1962 PASS + 7 skipped + 1 carry-forward failure documented; ready to mark §11 complete)

## 12. Code review (between tasks per CLAUDE.md)

- [x] 12.1 Use Superpowers `requesting-code-review` skill at the natural review checkpoints: after §3 (engine layer), after §6 (sync-service layer), after §10 (renderer layer) — done as a single three-layer review at the end per advisor guidance (engine + sync-service commits had landed before §12 was reached). Reviewer surfaced 1 Critical (C1: explore route did not navigate after Remove confirm — would loop the user back into the same `invalid-datasource` state) + 1 Important (I1: stale "spinner" wording in `specs/datasources-ui/spec.md` lines 63 + 75 after the motion-budget reconciliation in commit e87d445) + 3 Minor notes (M1 hard-coded "google-drive" placeholder in `resolve-client.ts:46`; M2 `__none__` sentinel; M3 factory.ts comment).
- [x] 12.2 Address critical issues before progressing to the next layer — C1 fixed by adding optional `onDatasourceRemoved` prop to `<FileExplorer>` (threaded into `<InvalidDatasourceArm>`'s confirm-dialog `onConfirm` after `await actions.remove(...)` resolves) + the explore route's `onDatasourceRemoved={() => setState({ phase: "not-found" })}` callback which flips the route to render `<DatasourceNotFound>` (with the "Return to dashboard" link). I1 fixed by editing `specs/datasources-ui/spec.md` lines 63 + 75 to drop "spinner" wording and reference the disabled label-swap pattern (matches `card.tsx:283-326` AuthErrorBanner). New integration test in `app/datasources/explore/__tests__/page.test.tsx` exercises the full Remove flow end-to-end (drives explorer into invalid-datasource arm via mocked `files.list` envelope; clicks Remove → confirms → asserts `actions.remove` IPC + route flips to `not-found` heading visible). Minor notes M1, M2, M3 left for follow-up changes — not blockers per CLAUDE.md ("Style nits / refactor suggestions are non-blocking"). Re-verification: `pnpm vitest run` 247/248 files PASS / 1955/1963 tests PASS + 7 skipped (the single carry-forward failure remains the documented `scripts/preload-bundle.test.ts` from §1.3); `pnpm lint` PASS; `openspec validate add-invalid-datasource-state` green.

## 13. End-to-end smoke (deferred — surface in PENDING_TC.MD)

- [x] 13.1 Document in `PENDING_TC.MD`: real GCP datasource → manually delete `~/ft5/sync_app/credentials.json` for that id → open Explore → see `<InvalidDatasourceState>` → click Reconnect → complete consent in browser → see entries appear without manual refresh
- [x] 13.2 Document in `PENDING_TC.MD`: real GCP datasource → manually corrupt the credential JSON for that id (e.g., overwrite `accessToken` with empty string) → open Explore → see `<InvalidDatasourceState>` → click Remove → confirm dialog appears → confirm → datasource removed from dashboard
- [x] 13.3 Document in `PENDING_TC.MD`: dashboard view of a misconfigured datasource (without opening Explore) → `<InvalidDatasourceBanner>` renders → click Reconnect → complete consent → banner unmounts as `summary.status` flips back to `connected`
- [x] 13.4 Both 13.1 + 13.2 require `add-drive-oauth-browser-consent` §1 (HUMAN ops: real GCP credentials in `.env.local`) per existing `PENDING_TC.MD` notes — link the dependency

## 14. Finishing

- [ ] 14.1 Verify all checkboxes in this file are checked off
- [ ] 14.2 Use Superpowers `finishing-a-development-branch` skill — the user picks merge / PR / cleanup
- [ ] 14.3 BEFORE merge: archive this change in the worktree branch via `/opsx:archive` per CLAUDE.md ("Archive in the worktree branch *before* merging. Never merge an unarchived change.")
