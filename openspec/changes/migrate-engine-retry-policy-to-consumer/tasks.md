# Tasks: `migrate-engine-retry-policy-to-consumer`

> TDD discipline (CLAUDE.md): every code task is failing-test-first →
> watch it fail → minimum code to pass. Subagent-per-task + two-stage
> review; advisor at the two checkpoints. Name **fs-sync** concretely;
> the engine package stays framework-agnostic ("callers").

## 0. Prerequisites (satisfied)

- [x] 0.1 `add-engine-rename-download` merged to `master` (2026-04-29)
- [x] 0.2 `migrate-upload-orchestration-out-of-engine` merged to `master` (2026-05-06)

## 1. Engine — new public surface (additive, before removal)

- [x] 1.1 Write failing unit tests for a new `withAuthRefresh<R>(client, op)` helper in `packages/fs-datasource-engine/src/__tests__/with-auth-refresh.test.ts`: (a) op throws `auth-expired` then succeeds → `refreshCredentials()` called exactly once, helper resolves with the 2nd result; (b) op throws `auth-expired` twice → `refreshCredentials()` called once, helper rejects with the 2nd error; (c) op throws `network-error` → `refreshCredentials()` NOT called, error propagates immediately
  - As-implemented: test landed at `src/with-auth-refresh.test.ts` (co-located beside source, matching the existing `base-client.test.ts` placement per the implementation dispatch) rather than the `__tests__/` subdir this line literally names; both match the vitest glob `packages/**/src/**/*.test.ts`. Added a 4th case (raw non-`DatasourceError` → not refreshed) for completeness. 4 tests pass.
- [x] 1.2 Implement `withAuthRefresh` in `packages/fs-datasource-engine/src/with-auth-refresh.ts`; export it from `src/index.ts`. Detection uses `err instanceof DatasourceError && err.tag === "auth-expired"`. Watch 1.1 pass
- [x] 1.3 Write failing tests for a PUBLIC `refreshCredentials()` (adapt the single-flight cases from `base-client.test.ts`): (a) 5 concurrent `refreshCredentials()` calls on one client → exactly one `refreshTokenImpl` call + one `token-refreshed` event, all resolve with same `AuthResult`; (b) `CredentialStore.put` awaited BEFORE the promise resolves (ordering spy); (c) `refreshTokenImpl` throws → `refreshCredentials()` rejects, emits exactly one `token-expired` + one `authentication-failed`, `put` NOT called
  - As-implemented: adapted the four former single-flight cases (5-concurrent, persist-before-resolve, refresh-throws, put-rejects) to call `client.refreshCredentials()` directly + added a 5th case proving a typed `DatasourceError` from `refreshTokenImpl` propagates unchanged (no re-synthesis). The put-reject case now asserts `token-refreshed` is NOT emitted (the cycle's success emit lives after `persistCredentials`).
- [x] 1.4 Add `refreshCredentials(): Promise<AuthResult>` to the `DatasourceClient<T>` interface; implement on `BaseDatasourceClient` by promoting `singleFlightRefresh` to public and relocating the `token-expired` + `authentication-failed` failure emission (currently in `withRefresh`'s catch) INTO `refreshCredentials()`. Watch 1.3 pass
  - As-implemented: failure emission lives INSIDE the single-flight cycle (not per-caller as the old `withRefresh` catch did), so 5 concurrent failing callers observe exactly one `token-expired` + one `authentication-failed`. Typed `DatasourceError` from `refreshTokenImpl` rejects as-is; otherwise a synthesized `auth-expired` (carrying raw) is thrown.

## 2. Engine — remove `withRefresh` (inversion guard)

- [x] 2.1 Write the failing inversion-guard test in `base-client.test.ts`: an operation whose `doXImpl` throws an `auth-expired`-tagged error surfaces it RAW — `refreshTokenImpl` is NOT called, no retry occurs (assert on at least `listDirectory` and `uploadFile`). Fails against the current `withRefresh`
  - As-implemented: two guard cases (`listDirectory` throwing a typed `auth-expired`; `uploadFile` throwing a RAW `{ __tag: "auth-expired" }` marker that the new normalize-only wrapper must still convert to a `DatasourceError`). Both verified RED against the pre-removal `withRefresh`, GREEN after.
- [x] 2.2 Delete `private withRefresh` from `base-client.ts`; repoint every public wrapper (`status`, `testConnection`, `runReadOp` → list/search/getMetadata/getQuota, `uploadFile`, `deleteFile`, `rename`, `downloadFile`) to call its `doXImpl` directly. Keep emission + `normalizeError` wrappers intact. Watch 2.1 pass
  - As-implemented: `uploadFile` (which previously had NO try/catch of its own — normalization came entirely from `withRefresh`) gained a normalize-only `try { return await doUploadFileImpl } catch { throw ensureNormalized(err) }` so raw provider errors still surface as `DatasourceError` (no bus emit — uploadFile is bus-exempt). All other wrappers already had their own normalizing catch.
- [x] 2.3 Retire the now-invalid `withRefresh` assertions in `base-client.test.ts` (the "withRefresh still applies to uploadFile" one-shot-retry case and the "retry auth-expired is NOT re-refreshed" case) — their intent now lives in the `withAuthRefresh` tests (1.1). Confirm the full engine package test suite is green
  - As-implemented: both retired (the "retry auth-expired NOT re-refreshed" case was inside the transformed single-flight block; the uploadFile one-shot-retry case replaced with an explanatory comment pointing to `with-auth-refresh.test.ts`). Engine package: 319 tests pass.
- [x] 2.4 Update engine JSDoc/comments that reference `withRefresh` (e.g. `uploadFile`/`downloadFile` wrapper comments, the class header) to describe the new explicit-refresh model
  - As-implemented: updated the class header (responsibility #2 + strategy-contract note), the interface JSDoc for `uploadFile`/`rename`/`downloadFile`, the abstract `doUploadFileImpl`/`doDownloadFileImpl`/`refreshTokenImpl` docs, the `authenticate` comment, and the download initial-catch comment. `grep '\bwithRefresh\b' base-client.ts` now returns zero. (Pre-existing stale `withRefresh` mentions in `strategies/s3-client.ts` left untouched — out of scope, terminology-only, rewritten during the fs-sync migration; noted as follow-up.)

## 3. fs-sync — simple call sites (7 one-line helper wraps)

- [x] 3.1 `commands/files-list.ts:36` — wrap `client.listDirectory(...)` in `withAuthRefresh(client, () => …)`; add a handler test: list throws `auth-expired` once then succeeds → `refreshCredentials()` called once, list returns
  - As-implemented: `listDirectory` call wrapped in `withAuthRefresh` (import added). Added auth-expired-once-then-succeed test asserting `refreshCredentials` called once + `listDirectory` called twice + `ok:true`. Added `refreshCredentials` stub to `makeFakeClient`. Verified RED before the wrap, GREEN after. 6 tests pass.
- [x] 3.2 `commands/files-stat.ts:30` — wrap `client.getMetadata(...)`; mirror test
  - As-implemented: `getMetadata` wrapped; once-then-succeed test (refresh once, getMetadata twice, ok:true); `refreshCredentials` added to fake. 3 tests pass.
- [x] 3.3 `commands/files-search.ts:34` — wrap `client.search(...)`; mirror test
  - As-implemented: `search` wrapped; once-then-succeed test (refresh once, search twice, ok:true); `refreshCredentials` added to fake. 3 tests pass.
- [x] 3.4 `commands/files-remove.ts:58,63` — wrap each of `client.deleteDirectory(...)` and `client.deleteFile(...)`; mirror test for the file delete path
  - As-implemented: BOTH `deleteDirectory` and `deleteFile` wrapped per-target (each per-target delete owns its own refresh-once/retry-once). File-delete once-then-succeed test (refresh once, deleteFile twice, results[0].ok:true); `refreshCredentials` added to fake. 8 tests pass.
- [x] 3.5 `commands/files-rename.ts:54` — wrap `client.rename(...)`; mirror test
  - As-implemented: `rename` wrapped. The PRE-EXISTING always-reject `auth-expired→auth-revoked` test (which passed today unwrapped, a false-green risk per advisor) was repurposed into TWO tests: (1) once-then-succeed (refresh once, rename twice, ok:true) for §3.5; (2) a dead-token guard (refresh once, rename twice, → `auth-revoked`) with load-bearing call-count assertions. `refreshCredentials` added to the shared fake (REQUIRED — without it the dead-token test would have hit `refreshCredentials is not a function` at runtime). 13 tests pass.
- [x] 3.6 `commands/files-upload.ts:317` — wrap `client.uploadFile(...)`; test: upload throws `auth-expired` once then succeeds → `refreshCredentials()` once, whole-file re-upload, success (byte-for-byte today's behavior)
  - As-implemented: `uploadFile` wrapped (single call ⇒ retry re-uploads whole file, identical to today; a 2nd auth-expired propagates into the existing catch → `auth-revoked`). Once-then-succeed test (refresh once, uploadFile twice, one `file-created`, no `upload-failed`, registry cleared, ok:true); `refreshCredentials` added to fake. 13 tests pass.
- [x] 3.7 `executors/mirror-sync.ts:89,121` — wrap `client.uploadFile(...)` and `client.deleteFile(...)`; tests: (a) auth-expired-once-then-succeed completes the job; (b) auth-expired again post-refresh escapes the executor to the scheduler (job → failed)
  - As-implemented: BOTH `uploadFile` and `deleteFile` wrapped. (a) once-then-succeed → `outcome:"completed"`, refresh once, uploadFile twice, `sync-completed` emitted. (b) dead-token → `outcome:"failed"` with `errorTag:"auth-expired"` (the executor returns the RAW tag with no remap — auth-revoked is the download handler's Decision 5, not mirror-sync; the spec scenario *body* says "auth-expired escapes → job to failed", which is what's testable), refresh once, uploadFile twice, no `sync-completed`. Asserting the executor's terminal `failed` is the unit-level proxy for the scheduler's job→failed transition: `system-retry.ts` classifies `auth-expired` as `terminal` (unchanged behavior, already covered by `system-retry.test.ts`). `refreshCredentials` added to the `fakeClient()` helper. 6 tests pass.

## 4. fs-sync — download handler rework (Decision 5)

- [ ] 4.1 Write a failing test reproducing the regression: with `withRefresh` removed, the initial `engine.downloadFile` GET rejecting with `auth-expired` currently fails-fast as `auth-revoked` (no refresh). This is the bug Decision 5 fixes
- [ ] 4.2 Implement PRE-stream refresh at the initial-GET catch (~`files-download.ts:1101-1108`): on `auth-expired`, `await client.refreshCredentials()` once, re-issue `engine.downloadFile` with `rangeStart = 0`. Watch 4.1 pass
- [ ] 4.3 Write a failing test: a MID-stream `auth-expired` must call `client.refreshCredentials()` then re-issue (not rely on the engine)
- [ ] 4.4 Implement mid-stream refresh at the cycle catch (~`files-download.ts:1204-1215`): call `refreshCredentials()` once within the `MAX_AUTH_RETRIES` budget, set `rangeStart = bytesWritten`, re-issue. Watch 4.3 pass
- [ ] 4.5 Write failing test + implement the dead-token redefinition: `auth-expired` AGAIN immediately after a successful `refreshCredentials()` → surface `tag: "auth-revoked"`, emit `download-failed`, no further retry
- [ ] 4.6 Verify the environmental-retry layer (Layer 3: network/rate-limited/provider-error, 5-attempt / 30-min budget) is untouched and composes correctly — auth refresh is the inner one-shot, env-retry the outer layer. Re-run the existing download-resilience + download-conflict integration suites green
- [ ] 4.7 Update `files-download.ts` comments that describe the old "engine's withRefresh refreshes the credential" model (handler header lines ~41-49, the pre-stream and mid-stream catch comments)

## 5. Validation & verification

- [ ] 5.1 `openspec validate migrate-engine-retry-policy-to-consumer --strict` is green
- [ ] 5.2 Engine package: `vitest run` green (incl. 1.1 / 1.3 / 2.1 new tests); fs-sync: targeted handler + executor + integration suites green
- [ ] 5.3 Full repo: `pnpm typecheck` (`tsc -b`) + `pnpm lint` (`eslint .`) clean; full `vitest run` green
- [ ] 5.4 Confirm NO `withRefresh` reference remains in `packages/fs-datasource-engine/src` (grep guard); confirm `refreshCredentials` + `withAuthRefresh` are exported from `@ft5/fs-datasource-engine`
- [ ] 5.5 Confirm the desktop EventBridge → renderer token-event contract is intact (token-refreshed / token-expired / authentication-failed still emitted by `refreshCredentials()`)
