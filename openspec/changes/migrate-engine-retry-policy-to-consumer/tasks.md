# Tasks: `migrate-engine-retry-policy-to-consumer`

> TDD discipline (CLAUDE.md): every code task is failing-test-first →
> watch it fail → minimum code to pass. Subagent-per-task + two-stage
> review; advisor at the two checkpoints. Name **fs-sync** concretely;
> the engine package stays framework-agnostic ("callers").

## 0. Prerequisites (satisfied)

- [x] 0.1 `add-engine-rename-download` merged to `master` (2026-04-29)
- [x] 0.2 `migrate-upload-orchestration-out-of-engine` merged to `master` (2026-05-06)

## 1. Engine — new public surface (additive, before removal)

- [ ] 1.1 Write failing unit tests for a new `withAuthRefresh<R>(client, op)` helper in `packages/fs-datasource-engine/src/__tests__/with-auth-refresh.test.ts`: (a) op throws `auth-expired` then succeeds → `refreshCredentials()` called exactly once, helper resolves with the 2nd result; (b) op throws `auth-expired` twice → `refreshCredentials()` called once, helper rejects with the 2nd error; (c) op throws `network-error` → `refreshCredentials()` NOT called, error propagates immediately
- [ ] 1.2 Implement `withAuthRefresh` in `packages/fs-datasource-engine/src/with-auth-refresh.ts`; export it from `src/index.ts`. Detection uses `err instanceof DatasourceError && err.tag === "auth-expired"`. Watch 1.1 pass
- [ ] 1.3 Write failing tests for a PUBLIC `refreshCredentials()` (adapt the single-flight cases from `base-client.test.ts`): (a) 5 concurrent `refreshCredentials()` calls on one client → exactly one `refreshTokenImpl` call + one `token-refreshed` event, all resolve with same `AuthResult`; (b) `CredentialStore.put` awaited BEFORE the promise resolves (ordering spy); (c) `refreshTokenImpl` throws → `refreshCredentials()` rejects, emits exactly one `token-expired` + one `authentication-failed`, `put` NOT called
- [ ] 1.4 Add `refreshCredentials(): Promise<AuthResult>` to the `DatasourceClient<T>` interface; implement on `BaseDatasourceClient` by promoting `singleFlightRefresh` to public and relocating the `token-expired` + `authentication-failed` failure emission (currently in `withRefresh`'s catch) INTO `refreshCredentials()`. Watch 1.3 pass

## 2. Engine — remove `withRefresh` (inversion guard)

- [ ] 2.1 Write the failing inversion-guard test in `base-client.test.ts`: an operation whose `doXImpl` throws an `auth-expired`-tagged error surfaces it RAW — `refreshTokenImpl` is NOT called, no retry occurs (assert on at least `listDirectory` and `uploadFile`). Fails against the current `withRefresh`
- [ ] 2.2 Delete `private withRefresh` from `base-client.ts`; repoint every public wrapper (`status`, `testConnection`, `runReadOp` → list/search/getMetadata/getQuota, `uploadFile`, `deleteFile`, `rename`, `downloadFile`) to call its `doXImpl` directly. Keep emission + `normalizeError` wrappers intact. Watch 2.1 pass
- [ ] 2.3 Retire the now-invalid `withRefresh` assertions in `base-client.test.ts` (the "withRefresh still applies to uploadFile" one-shot-retry case and the "retry auth-expired is NOT re-refreshed" case) — their intent now lives in the `withAuthRefresh` tests (1.1). Confirm the full engine package test suite is green
- [ ] 2.4 Update engine JSDoc/comments that reference `withRefresh` (e.g. `uploadFile`/`downloadFile` wrapper comments, the class header) to describe the new explicit-refresh model

## 3. fs-sync — simple call sites (7 one-line helper wraps)

- [ ] 3.1 `commands/files-list.ts:36` — wrap `client.listDirectory(...)` in `withAuthRefresh(client, () => …)`; add a handler test: list throws `auth-expired` once then succeeds → `refreshCredentials()` called once, list returns
- [ ] 3.2 `commands/files-stat.ts:30` — wrap `client.getMetadata(...)`; mirror test
- [ ] 3.3 `commands/files-search.ts:34` — wrap `client.search(...)`; mirror test
- [ ] 3.4 `commands/files-remove.ts:58,63` — wrap each of `client.deleteDirectory(...)` and `client.deleteFile(...)`; mirror test for the file delete path
- [ ] 3.5 `commands/files-rename.ts:54` — wrap `client.rename(...)`; mirror test
- [ ] 3.6 `commands/files-upload.ts:317` — wrap `client.uploadFile(...)`; test: upload throws `auth-expired` once then succeeds → `refreshCredentials()` once, whole-file re-upload, success (byte-for-byte today's behavior)
- [ ] 3.7 `executors/mirror-sync.ts:89,121` — wrap `client.uploadFile(...)` and `client.deleteFile(...)`; tests: (a) auth-expired-once-then-succeed completes the job; (b) auth-expired again post-refresh escapes the executor to the scheduler (job → failed)

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
