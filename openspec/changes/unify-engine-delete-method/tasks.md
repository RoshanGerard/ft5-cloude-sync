# Tasks: Unify engine delete into a single `delete` method

> TDD per slice (failing test → minimum code → green). Subagent-per-task with two-stage code review between slices during `/opsx:apply`. Engine tests run via root vitest (`pnpm exec vitest run packages/fs-datasource-engine`) — the engine has NO per-package `test` script. Slices 1→2→3 are ordered (type → interface → tests); slice 4 (fs-sync consumers) depends on slice 2's new signature; slice 5 verifies.

## 1. `EntryKind` const-ref promotion (ipc-contracts)

- [x] 1.1 In `packages/ipc-contracts/src/files.ts`, promote `EntryKind` from the bare union to the `as const` const-ref form mirroring `FilesErrorTag` / `DatasourceErrorTag`: `export const EntryKind = { Directory: "directory", File: "file" } as const; export type EntryKind = (typeof EntryKind)[keyof typeof EntryKind];`. Keep the export name and the derived type identical (`"directory" | "file"`).
- [x] 1.2 Confirm the value export is re-exported where the type is (`packages/ipc-contracts/src/index.ts`) so `EntryKind.File` / `EntryKind.Directory` are importable by consumers. (Moved `EntryKind` from the `export type { … }` block to the value `export { EntryKind, FilesErrorTag }` line — the merged type travels with the value export.)
- [x] 1.3 `pnpm typecheck` (tsc -b) over the whole workspace PROVES non-breaking — every existing `EntryKind` consumer (`FilesRemoveTarget`, sync-service commands, renderer, mock-fs) still compiles and existing string-literal assignments still hold. Added `__tests__/entry-kind.test-d.ts` (mirrors `files-error-tag.test-d.ts`) locking the `as const` shape + derived-union type + literal coexistence.

## 2. Engine: collapse to `delete(target, entryKind)` (base-enforced refusal)

- [x] 2.1 Failing test first: added a base-client describe asserting `delete(target, "directory")` throws `DatasourceError { tag: "unsupported", retryable: false, raw: "disabled-for-product-stability" }` (without calling `doDeleteFileImpl`) and that `delete(target, "file")` dispatches to `doDeleteFileImpl`. Watched it fail (`client.delete is not a function`).
- [x] 2.2 In `packages/fs-datasource-engine/src/base-client.ts`: added `delete(target: Target, entryKind: EntryKind): Promise<void>` to the `DatasourceClient<T>` interface and a base wrapper that — `entryKind === EntryKind.Directory` → throws the relocated `unsupported` error (verbatim tag/raw, message "directory delete is disabled for product stability"); else → `await this.doDeleteFileImpl(target)` under the same normalize-on-throw (`ensureNormalized`) wrapper. Imported `EntryKind` (value+type) from `@ft5/ipc-contracts`. (Add-migrate-remove sequence: `delete` coexists with `deleteFile`/`deleteDirectory` until callers migrate.)
- [ ] 2.3 Remove the public `deleteFile(target)` and `deleteDirectory(target)` methods (interface declarations + base wrappers) — done AFTER slices 3+4 migrate all callers. Keep the `protected abstract doDeleteFileImpl(target)` hook and all three strategies' implementations + inline path-cache eviction UNTOUCHED.
- [ ] 2.4 Green the unified-delete test (done — 40/40 base-client); confirm no `doDeleteDirectoryImpl` was introduced and no strategy file changed (re-confirm after removal step).

## 3. Engine test-surface migration

- [x] 3.1 Migrated every `deleteFile` / `deleteDirectory` call site to `delete(target, entryKind)`: `base-client.test.ts` (error-normalization test → `delete(…, "file")`), `s3-client.test.ts`, `onedrive-client.test.ts` (×3, incl. describe/it labels), `googledrive-client.test.ts` (×6) — all `"file"`.
- [x] 3.2 The slice-2 unified-delete describe already covers file-dispatch + directory→Unsupported, so the redundant old `base-client.test.ts` "deleteFile resolves to void" it and "deleteDirectory unsupported" describe were removed (relocated onto the unified method); the unique error-normalization test was migrated.
- [x] 3.3 Updated the shared strategy-contract suite (`__tests__/strategy-contract.ts`): the delete conformance call + "delete (file) resolves to void" desc, the "delete (directory) throws Unsupported" scenario → `delete(…, "directory")`, the cached-eviction invariant call → `delete(…, "file")`, and the doc comment.
- [x] 3.4 `pnpm exec vitest run packages/fs-datasource-engine` — 328/328 green, no type errors, zero `.deleteFile(`/`.deleteDirectory(` call sites remain in the engine package.

## 4. fs-sync consumer updates (code only — no spec/wire change)

- [ ] 4.1 `services/fs-sync/src/commands/files-remove.ts:61-72` — collapse the `if (target.kind === "directory") client.deleteDirectory(...) else client.deleteFile(...)` branch into one `client.delete({ kind: "handle", handle: target.handle }, target.kind)`, still wrapped in `withAuthRefresh`. Update the explanatory comment (:55).
- [ ] 4.2 `services/fs-sync/src/commands/files-remove.test.ts` — update the directory-target test (desc at :62) to assert the unified `delete(handle, "directory")` call still surfaces a per-target `unsupported` error and the `files:remove` envelope stays `ok: true`.
- [ ] 4.3 `services/fs-sync/src/executors/mirror-sync.ts:134` — `client.deleteFile({ kind: "handle", handle: op.remoteHandle })` → `client.delete({ kind: "handle", handle: op.remoteHandle }, EntryKind.File)` (verify the op is a file delete in mirror-sync's context). Update its tests if they assert the call shape.
- [ ] 4.4 Grep the whole repo once more for any remaining `.deleteFile(` / `.deleteDirectory(` reference (prod or test) and confirm zero remain outside archived specs.

## 5. Verification + spec sync

- [ ] 5.1 Full suite: `pnpm abi:node` + `pnpm --filter @ft5/desktop build` + `pnpm test` — green.
- [ ] 5.2 `pnpm typecheck` (tsc -b) EXIT 0; `pnpm lint` clean.
- [ ] 5.3 `openspec validate unify-engine-delete-method --strict` — VALID.
- [ ] 5.4 Advisor checkpoint #2 (before `/opsx:archive`) — verify the as-built matches the design (base-enforced refusal, identical `unsupported` tag/raw, `doDeleteFileImpl` + eviction untouched, EntryKind const-ref non-breaking).
- [ ] 5.5 After archive sync: `openspec validate fs-datasource-engine --type spec` green; confirm the `getQuota` scenarios survived the Decision-10 REMOVE+ADD and no scenario was dropped.
