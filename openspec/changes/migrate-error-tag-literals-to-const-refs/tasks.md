## 1. Baseline & discovery

- [x] 1.1 Confirm green baseline in the worktree: full `pnpm test` + `pnpm -r typecheck` (or `tsc -b`) pass before any edit. Record the test count.
- [x] 1.2 Build the literal→const lookup table from the two definitions: `DatasourceErrorTag` (`packages/ipc-contracts/src/fs-datasource-engine.ts`) and `FilesErrorTag` (`packages/ipc-contracts/src/files.ts`). Note the 5 shared values (`auth-revoked`, `rate-limited`, `conflict`, `cancelled`, `invalid-datasource`) that require type-aware disambiguation (design Decision 2) and the unique-to-one-enum values that do not.
- [x] 1.3 Establish the exclusion checklist (design Decision 4 + Non-Goals): protocol JSON / MSW handlers / recorded provider responses, `openspec/specs/**`, comments, `dist/`, `node_modules/`. Confirm the discovery grep excludes these.
- [x] 1.4 **TDD anchor (RED):** write the grep-scan guard test `packages/ipc-contracts/src/__tests__/error-tag-const-convention.test.ts` (design Decision 5) — scans `.ts`/`.tsx` under `packages/`, `services/`, `apps/`, `scripts/` for raw error-tag literals in `tag`/`errorTag`/`.tag` construction/comparison + `case` arms, honoring the exclusions. Watch it FAIL against the current tree (~600 literals). This guard is what every package task below drives toward green and what backs both spec scenarios.

## 2. packages/ipc-contracts

- [x] 2.1 Discover tag-literal sites in `packages/ipc-contracts/src/**` (source + `__tests__`), excluding the two const-object definitions themselves and any serialized-payload fixtures.
- [x] 2.2 Migrate source literals to const refs, choosing the enum by the local declared type (Decision 2).
- [x] 2.3 Migrate test-file literals (arrange/assert), leaving protocol/JSON payloads as raw strings.
- [x] 2.4 Run `packages/ipc-contracts` tests + typecheck — confirm still green. Code review (enum-correctness focus on shared values). Commit.

## 3. packages/fs-datasource-engine

- [x] 3.1 Discover tag-literal sites across `base-client.ts`, `factory.ts`, `with-auth-refresh.ts`, `strategies/{googledrive,onedrive,s3}-client.ts`, `strategy-contract.ts`, and their tests.
- [x] 3.2 Migrate source literals (engine errors are `DatasourceError.tag` → `DatasourceErrorTag.*`).
- [x] 3.3 Migrate test literals, leaving recorded provider-response fixtures as raw strings.
- [x] 3.4 Run engine tests + typecheck — confirm still green. Code review. Commit.

## 4. services/fs-sync

- [x] 4.1 Discover tag-literal sites across `commands/*` (esp. `files-download.ts`, `files-error-mapping.ts`, `files-upload.ts`, `files-rename.ts`, `files-list.ts`, `files-remove.ts`), `retry/*`, `util/*`, `scheduler`, `executors`, `oauth`, `main`, and their tests.
- [x] 4.2 Migrate source literals, disambiguating per site: engine-facing values → `DatasourceErrorTag.*`; `files:*` envelope values → `FilesErrorTag.*` (Decision 2).
- [x] 4.3 Migrate test literals, leaving serialized wire payloads as raw strings.
- [x] 4.4 Run fs-sync tests + typecheck — confirm still green. Code review (heavy shared-value surface here). Commit.

## 5. apps/desktop — main process

- [x] 5.1 Discover tag-literal sites across `main/ipc/files/*` (incl. `mock-fs.ts`, `error-envelope.ts`), `main/ipc/sync/*`, `main/sync/*`, and their tests.
- [x] 5.2 Migrate source literals, disambiguating per site.
- [x] 5.3 Migrate test literals, leaving serialized payloads as raw strings.
- [x] 5.4 Run desktop-main tests + typecheck — confirm still green. Code review. Commit.

## 6. apps/desktop — renderer

- [x] 6.1 Discover tag-literal sites across `renderer/src/features/file-explorer/*` (incl. `file-explorer.tsx`, `store.ts`, `use-download-orchestrator.ts`, `download-job-toast`, `rename-conflict-dialog.tsx`, `status-row.tsx`, toolbar, states) and `renderer/src/features/datasources/*`, plus their tests.
- [x] 6.2 Migrate source literals — renderer branches on `FilesErrorTag.*` (the `files:*` envelope); confirm none are engine `DatasourceErrorTag` values.
- [x] 6.3 Migrate test literals, leaving serialized payloads as raw strings.
- [x] 6.4 Run renderer tests + typecheck — confirm still green. Code review. Commit.

## 7. scripts/ and stragglers

- [x] 7.1 Discover any remaining tag-literal sites under `scripts/` and anywhere else the repo-wide grep flags (outside exclusions).
- [x] 7.2 Migrate + run affected checks. Commit.

## 8. Verification & finish

- [x] 8.1 **TDD anchor (GREEN):** the grep-scan guard test from 1.4 now passes — zero non-excluded error-tag literals remain across `packages/`, `services/`, `apps/`, `scripts/`. Document any intentionally-kept literals (protocol/fixture) and confirm each is covered by an exclusion the guard honors.
- [x] 8.2 Full suite: `pnpm test` + `pnpm -r typecheck` (or `tsc -b`) + `pnpm lint` all green; test count matches the 1.1 baseline (no coverage regression).
- [x] 8.3 `openspec validate migrate-error-tag-literals-to-const-refs --strict` green.
- [x] 8.4 Advisor checkpoint #2 (before done) — verify the migration is behavior-preserving and enum-correct on shared values.
- [x] 8.5 Spawn follow-up stub `add-error-tag-literal-lint` for the deferred enforcement (design Decision 5).
- [x] 8.6 Archive via `/opsx:archive`, then finish the branch via `finishing-a-development-branch`.
