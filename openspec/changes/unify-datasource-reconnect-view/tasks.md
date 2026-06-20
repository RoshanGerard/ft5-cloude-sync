## 1. Credential forms accept `datasourceId` (datasources-ui)

- [ ] 1.1 (TDD red) Add a failing test to `aws-access-key-form.test.tsx`: rendered with `datasourceId="ds-9"` and submitted, `authenticateStart` is called with `{ providerId: "amazon-s3", datasourceId: "ds-9" }`; rendered WITHOUT `datasourceId`, the request omits the field.
- [ ] 1.2 Add a `datasourceId?: string` prop to `AwsAccessKeyForm`; thread it into the `authenticateStart` call (build the request object conditionally, mirroring `OAuthForm` lines 107-110). Make 1.1 green.
- [ ] 1.3 (TDD) Apply the same `datasourceId?` prop + threading to `CustomForm`; add/adjust its test for both paths.
- [ ] 1.4 Verify the add-datasource dialog still works unchanged (the dialog passes no `datasourceId`, so the add path is unaffected) — `add-dialog.test.tsx` + `add-dialog-extensibility.test.tsx` stay green.

## 2. Generalize the shared reconnect view (file-explorer)

- [ ] 2.1 (TDD red) In `invalid-datasource.test.tsx`, add failing tests: for a `credentialsSchema === "oauth"` provider, clicking Reconnect calls `sync.authenticateStart({ providerId, datasourceId })` directly (existing behaviour, asserted); for `amazon-s3` (`aws-access-key`), clicking Reconnect reveals the inline `AwsAccessKeyForm` (its fields present) with a Back control, and submitting threads `datasourceId` then runs `onReconnectSucceeded`.
- [ ] 2.2 Generalize `InvalidDatasourceState`: resolve the provider descriptor via `providers[providerId]`; dispatch Reconnect on `credentialsSchema` — OAuth keeps the direct `authenticateStart` + `useAuthSession` path; non-OAuth reveals the matching inline credential form (`AwsAccessKeyForm` / `CustomForm`) threaded with `datasourceId`, with a Back affordance returning to the prompt; on the form's `_authCompleted` call `onReconnectSucceeded`. Keep the `providerId`-undefined `aria-disabled` + tooltip behaviour. Update the component doc comment to note it serves both `auth-revoked` and `invalid-datasource`. Make 2.1 green.
- [ ] 2.3 (TDD) Surface inline error copy when `authenticateStart` resolves `{ ok: false }` (Decision 5) rather than a silent button re-enable; add a test asserting the inline message renders.

## 3. Route both error tags to the shared view; delete the navigate-away state (file-explorer)

- [ ] 3.1 (TDD red) In `states-integration.test.tsx`, add a failing test: `files.list` rejecting with `auth-revoked` renders the `file-explorer-state-invalid-datasource` component (NOT the amber `KeyRound` view) and clicking Reconnect calls `sync.authenticateStart` (NOT `router.push`).
- [ ] 3.2 In `file-explorer.tsx`, route BOTH `auth-revoked` and `invalid-datasource` `errorTag` arms to the unified `InvalidDatasourceArm` (passing `providerId` from `summary.providerId`). Remove the `AuthRevokedState` import and the `handleReconnect` `router.push("/")` handler if no longer referenced. Make 3.1 green.
- [ ] 3.3 Delete `states/auth-revoked.tsx` and `states/__tests__/auth-revoked.test.tsx` (the navigate-away component is retired).
- [ ] 3.4 Grep `apps/desktop/src/renderer` for residual `AuthRevokedState` / `auth-revoked.tsx` imports and the now-dead `handleReconnect`/`router` usages; clean up any dangling references.

## 4. Cross-cutting tests

- [ ] 4.1 (Risk c) Add an explicit test that S3 reconnect re-auths the EXISTING datasource: `authenticateStart` receives the existing `datasourceId` and the completion returns that same id — assert no freshly minted `ds-*` is used.
- [ ] 4.2 Update any explorer composite / state tests that referenced the removed `AuthRevokedState` or the old `auth-revoked` view treatment.

## 5. Verification

- [ ] 5.1 `pnpm abi:node && pnpm --filter @ft5/desktop build` then `pnpm test` — full suite green (modulo the documented main-checkout `authenticate-flow` S3 `vi.mock` flake, which this renderer-only change does not touch).
- [ ] 5.2 `pnpm typecheck` (`tsc -b`) and `pnpm lint` clean — including the `scripts/motion-budget.test.ts` guardrail (no `animate-spin` introduced).
- [ ] 5.3 `openspec validate unify-datasource-reconnect-view --strict` green.
- [ ] 5.4 Advisor checkpoint #2 before declaring done (deliverable durable first).
- [ ] 5.5 Exercise the feature against a running build where possible (OneDrive/Drive reconnect inline; S3 reconnect inline keys form) or record the manual-smoke deferral in `PENDING_TC.MD`.
