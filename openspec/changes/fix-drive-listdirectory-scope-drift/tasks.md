# Tasks — fix-drive-listdirectory-scope-drift

Implementation order is TDD: failing test first, then minimum code, then refactor. Each task names the spec scenario it covers.

## 1. Worktree + setup

- [x] 1.1 Confirm worktree placement with the user (sibling under `<repo>/.worktrees/fix-drive-listdirectory-scope-drift/` per the worktree-location convention) and create it
- [x] 1.2 Sanity-check baseline: `pnpm typecheck` and `pnpm --filter @ft5/fs-datasource-engine test` pass on a clean worktree before any changes (project has no root `build` script — `tsc -b` via the typecheck script is the equivalent)

## 2. Test scaffolding (RED)

- [x] 2.1 In `packages/fs-datasource-engine/src/strategies/googledrive-client.test.ts`, add a new `describe("scope drift detection")` block; verify it imports an `injectFetch` test helper that asserts the URL the strategy fetches against — needed for both `tokeninfo` and the `about.get` skip-check assertions
- [x] 2.2 Add a fixture builder `mkCredsWithScope(scope?: string)` that returns a `StoredCredentials` shape with `meta.clientId/secret/redirectUri` plus an optional `meta.scope`; reuse the existing fake `CredentialStore` if one exists, otherwise add a thin in-memory implementation in the test file with a spy on `update`

## 3. Sufficient-scope happy path (covers "Sufficient scope passes the check" + "embedded in multi-scope grant")

- [x] 3.1 Write a failing test: with `meta.scope = "https://www.googleapis.com/auth/drive"`, calling `status()` returns `"connected"` and the injected fetch is NOT called for the tokeninfo URL (only `about.get` via the duck-typed factory)
- [x] 3.2 Write a failing test: with `meta.scope = "openid email https://www.googleapis.com/auth/drive profile"`, `status()` returns `"connected"`
- [x] 3.3 Implement the helper `isScopeSufficient(scope: string): boolean` — `scope.split(/\s+/).includes("https://www.googleapis.com/auth/drive")` — and wire `doStatusImpl` / `doTestConnectionImpl` to call it BEFORE `about.get` when `this.creds.scope` is set
- [x] 3.4 Confirm tests in 3.1 and 3.2 pass; confirm pre-existing happy-path tests for status/testConnection still pass

## 4. Insufficient-scope rejection (covers "drive.file alone", "drive.readonly", "combined narrow")

- [x] 4.1 Write a failing test: `meta.scope = "https://www.googleapis.com/auth/drive.file"` → `status()` rejects with `tag: "auth-revoked"`, `retryable: false`, `raw.kind === "scope-insufficient"`, `raw.requiredScope === "https://www.googleapis.com/auth/drive"`, `raw.actualScope === "https://www.googleapis.com/auth/drive.file"`, `about.get` NOT called
- [x] 4.2 Write a failing test: `meta.scope = "https://www.googleapis.com/auth/drive.readonly"` → `testConnection()` rejects with the same shape
- [x] 4.3 Write a failing test: `meta.scope = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly"` (combined narrow scopes) → `status()` still rejects with `auth-revoked` + `scope-insufficient`
- [x] 4.4 Implement the rejection branch: when `isScopeSufficient(this.creds.scope)` is false, throw the structured `DatasourceError` per design Decision 5; ensure the error message is the exact "Drive permissions are too narrow — reconnect with full access to see your existing files." string
- [x] 4.5 Confirm 4.1-4.3 pass; check the existing `normalizeError` map is NOT incorrectly intercepting the synthetic `DatasourceError` (it must early-return on `instanceof DatasourceError` — verify in code)

## 5. Bus emission of `status-changed` (covers "Status-changed event carries the auth-revoked tag on scope-insufficient rejection")

> NOTE: original spec/tasks said `authentication-failed`. During Work Unit C pre-flight we discovered the engine's `BaseDatasourceClient.status()` catch path emits `status-changed`, not `authentication-failed` (the latter is reserved for `authenticate()` and refresh-token failures). The structured `raw.kind === "scope-insufficient"` discriminator is on the THROWN error and verified by Work Unit B; the bus event surfaces only the tag. Spec + design updated accordingly. See design.md Decision 5 "Bus event vs thrown error" note.

- [x] 5.1 Write a test: subscribe to the strategy's bus, call `status()` with insufficient scope (e.g. `meta.scope = "https://www.googleapis.com/auth/drive.file"`), assert: (a) exactly one `status-changed` event is observed whose payload is `{ status: "error", error: "auth-revoked" }`; (b) NO `authentication-failed` event is emitted on this path
- [x] 5.2 No new production code needed — the base client's existing emission path covers this. Confirm by running the test green

## 6. New token exchange persists scope (covers "New token exchange persists scope")

- [x] 6.1 Write a failing test: invoke `doAuthenticateImpl()` to get the OAuth intent, call `intent.completeWith("test-code")` with the injected fetch returning `200 { access_token: "...", refresh_token: "...", scope: "https://www.googleapis.com/auth/drive openid email", expires_in: 3599 }`. Assert the resulting `AuthResult.meta.scope === "https://www.googleapis.com/auth/drive openid email"` and `this.creds.scope` matches
- [x] 6.2 Modify `parseTokenResponse` to read `parsed.scope` (string) and copy it onto `result.meta.scope` and `this.creds.scope`
- [x] 6.3 Confirm 6.1 passes; confirm the existing token-exchange tests still pass (the new field is additive)

## 7. Refresh persists scope (covers "Token refresh persists scope")

- [x] 7.1 Write a failing test: with a credential carrying `refreshToken: "rt"`, call `refreshTokenImpl()` with injected fetch returning `200 { access_token: "...", scope: "https://www.googleapis.com/auth/drive", expires_in: 3599 }`. Assert the returned `AuthResult.meta.scope === "https://www.googleapis.com/auth/drive"`
- [x] 7.2 No new code needed if 6.2 was implemented at the right layer (`parseTokenResponse` is shared by exchange and refresh). Confirm by running the test; if it fails, refactor so both paths flow through the same scope-capture logic

## 8. Legacy backfill via tokeninfo (covers "Legacy credential backfilled" + "tokeninfo invalid_token" + "tokeninfo network error")

- [x] 8.1 Write a failing test: credential has `meta` without `scope`. Inject a fetch that returns `200 { scope: "https://www.googleapis.com/auth/drive.file", ... }` for the URL `https://oauth2.googleapis.com/tokeninfo?access_token=<the access token>`. Call `status()`. Assert: (a) the injected fetch is called once with that URL, (b) the credential-store port's `put` method is called once with a credential whose `meta.scope === "https://www.googleapis.com/auth/drive.file"`, (c) the resulting `status()` rejects with `auth-revoked`/scope-insufficient (because `drive.file` is narrow). Then call `status()` again and assert tokeninfo fetch is NOT called a second time
- [x] 8.2 Write a failing test: credential has no `meta.scope`. Inject fetch returning `400 { error: "invalid_token" }` from tokeninfo. Assert `status()` rejects with `tag: "auth-revoked"`, `retryable: false`, and the credential-store `put` is NOT called
- [x] 8.3 Write a failing test: credential has no `meta.scope`. Inject fetch that throws `{ code: "ECONNRESET" }` for the tokeninfo URL. Assert `status()` rejects with `tag: "network-error"`, the credential-store `put` is NOT called, AND a follow-up `status()` re-issues the tokeninfo fetch (no caching of failed backfill)
- [x] 8.4 Implement `fetchTokenScope()`: GET `https://oauth2.googleapis.com/tokeninfo?access_token=<this.creds.accessToken>`, parse JSON, return `parsed.scope` on 200; on non-200, route via `normalizeErrorImpl` with the special `code: "invalid_token"` mapping (already wired in the existing normalizer for token-endpoint errors); on system errors let `normalizeErrorImpl` handle it
- [x] 8.5 Implement `persistScope(scope: string)`: `await ctx.credentialStore.get(this.datasourceId)` to read current cred (skip persistence if it returns null), splice `scope` onto `authResult.meta.scope`, then `ctx.credentialStore.put(this.datasourceId, updated)`; swallow any persistence error (log via the existing logger plumbing if available; otherwise no-op) per design Decision 6
- [x] 8.6 Wire the backfill into the new `checkScopeSufficiency()` prelude in `doStatusImpl` and `doTestConnectionImpl`: if `this.creds.scope` is unset, call `fetchTokenScope()`, persist via `persistScope`, then continue with the sufficiency check
- [x] 8.7 Confirm 8.1-8.3 pass; verify by inspection that no path can call `tokeninfo` when `meta.scope` is set

## 9. Construction reads `meta.scope` into `creds`

- [x] 9.1 Write a failing test: build a `StoredCredentials` with `meta.scope = "https://www.googleapis.com/auth/drive"`, call `createGoogleDriveClient(...)`, then immediately call `status()`. Assert tokeninfo is NOT fetched (the constructor must propagate `meta.scope` into `this.creds.scope`)
- [x] 9.2 Update `readCredsFromStored` to parse `meta.scope` (when string) onto the returned `GoogleDriveCredsMeta` shape; extend the `GoogleDriveCredsMeta` interface with `scope?: string`
- [x] 9.3 Confirm 9.1 passes

## 10. Contract test compatibility

- [x] 10.1 Run `googledrive-client.contract.test.ts`. If it now fails because the contract suite's stub credential lacks `meta.scope`, update the stub builder in the contract suite (or its shared helpers in `__tests__/strategy-contract.ts`) to include a sufficient `meta.scope = "https://www.googleapis.com/auth/drive"` on the synthesized credential
- [x] 10.2 Confirm `pnpm --filter @ft5/fs-datasource-engine test` passes end-to-end

## 11. Operator documentation

- [x] 11.1 Add a short subsection to `docs/` (or wherever onboarding lives — confirm the path before writing) titled "Google Drive: scope drift" explaining the symptom (only app-uploaded files visible), the cause (token issued under narrower consent), and the remediation (re-consent — forward-pointer to `add-drive-oauth-browser-consent`). Keep to ~20 lines
- [x] 11.2 Cross-link the section from the `wire-file-explorer-to-service` archived change notes if such cross-linking is the project convention; otherwise skip (cross-linking convention confirmed in `docs/design/file-explorer.md` §9; added one-line link there — the `AuthRevokedState` UI lives in the file explorer, so that is the tightest fit; archived change notes not touched)

## 12. Verification + close-out

- [x] 12.1 Run `pnpm typecheck` (tsc -b across the workspace) and confirm clean
- [x] 12.2 Run `pnpm lint` and confirm clean
- [x] 12.3 Run `pnpm test` and confirm all packages green (not just the engine package)
- [ ] 12.4 _(reserved — no separate `build` step in this workspace)_
- [x] 12.5 Use the `verification-before-completion` superpower: walk through the proposal's "What Changes" bullets and confirm each is satisfied by the diff
- [x] 12.6 Use `requesting-code-review` for an end-to-end pass before merging
- [ ] 12.7 Use `finishing-a-development-branch` to merge / archive

## 13. Deferred (record but do not implement here)

- [ ] 13.1 **DEFERRED** to `add-drive-oauth-browser-consent`: real reproduction of the bug — start with a `drive.file`-scoped credential, exercise the file-explorer, confirm the user sees the `auth-revoked` UI, click Reconnect, observe the browser flow, confirm the new credential carries `scope: "drive"`, confirm pre-existing files now appear. Track as a manual smoke-test deliverable on that change's tasks.md
- [ ] 13.2 **DEFERRED** to a follow-up paired with `add-drive-oauth-browser-consent`: renderer message tailoring — when `error.raw?.kind === "scope-insufficient"`, render a tailored variant of `AuthRevokedState` ("Drive permissions are too narrow…") instead of the generic copy. This is dead weight without the consent flow on the other side
- [ ] 13.3 **OUT OF SCOPE** — `listDirectory` pagination (tracked as `add-engine-listdirectory-pagination`)
- [ ] 13.4 **OUT OF SCOPE** — Shared-drives visibility (`includeItemsFromAllDrives: true`); orthogonal to scope drift; should own its own change
