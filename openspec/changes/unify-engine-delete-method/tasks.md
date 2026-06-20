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

- [ ] 3.1 Migrate every `deleteFile` / `deleteDirectory` call site to `delete(target, entryKind)`: `base-client.test.ts` (:378, :514 → `delete(…, "file")`; :976 → `delete(…, "directory")`), `s3-client.test.ts:333`, `onedrive-client.test.ts` (:489, :502, :1295), `googledrive-client.test.ts` (:979, :1113, :1155, :1182, :1213, :2141) — all `"file"`.
- [ ] 3.2 Relocate the base "directory → Unsupported" describe (`base-client.test.ts:967-`) onto the unified `delete(target, "directory")` (keep asserting `tag === "unsupported"`).
- [ ] 3.3 Update the shared strategy-contract suite (`__tests__/strategy-contract.ts`): the delete conformance call (:514 → `delete(…, "file")`), the "deleteDirectory throws Unsupported" scenario (:521-525 → `delete(…, "directory")`), the cached-eviction invariant call (:777 → `delete(…, "file")`), and the comment at :158.
- [ ] 3.4 Run `pnpm exec vitest run packages/fs-datasource-engine` — all engine tests green.

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
