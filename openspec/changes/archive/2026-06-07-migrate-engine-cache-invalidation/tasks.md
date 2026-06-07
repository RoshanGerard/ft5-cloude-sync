# Tasks: migrate-engine-cache-invalidation

Engine-only change. TDD per slice (failing test → watch fail → minimal code).
Groups 1 and 2 are independent strategies; group 3 depends on both. Base class
and S3 strategy require NO code change.

## 1. Google Drive strategy — inline cache eviction, decoupled from the bus

- [x] 1.1 (TDD) Write/transform failing Drive tests in `strategies/googledrive-client.test.ts`: (a) transform the `deleted`-event-evicts tests (`:2118`, `:2210`, and the ambiguity re-walk `:930`) from "emit a synthetic `deleted` bus event → assert eviction" to "call `client.deleteFile(target)` → assert the cached path/handle is evicted"; (b) add "rename evicts the old path" (file; path-form and handle-form); (c) add "directory rename evicts cached `<oldPath>/` descendants"; (d) add "overwrite rename evicts the displaced sibling's cached path"; (e) add a guard asserting the constructor does NOT call `ctx.bus.subscribe`. Watch them fail.
- [x] 1.2 Implement in `strategies/googledrive-client.ts`: evict inline in `doDeleteFileImpl` success branch (path-form → `evictPath`, handle-form → `evictHandle`); evict inline in `doRenameImpl` success branch (old path + directory-descendant prefix scan over `pathHandleCache` keys starting with `<oldPath>/`; evict the overwrite-deleted sibling's path); remove the constructor `ctx.bus.subscribe` block + the `unsubscribe` field; make `dispose()` a no-op (retain the method + `disposed` guard for contract stability). Make 1.1 green. **Evict-only** — do NOT repopulate the new path.
- [x] 1.3 Code review (Drive slice): no `ctx.bus` reference remains for invalidation; base class untouched; consumer-facing emissions unchanged.

## 2. OneDrive strategy — inline cache eviction, decoupled from the bus

- [x] 2.1 (TDD) In `strategies/onedrive-client.test.ts`: (a) transform the `deleted`-event-evicts test (`:1297`) to a `deleteFile()` call; (b) REMOVE the now-obsolete dispose test (`:1425–1473`, which asserts the bus subscription is cleaned up on dispose); (c) add rename-eviction (file), directory-descendant eviction, and overwrite-sibling eviction tests; (d) add the constructor-no-subscription guard. Watch them fail.
- [x] 2.2 Implement in `strategies/onedrive-client.ts` (mirror of 1.2): inline eviction in `doDeleteFileImpl` + `doRenameImpl` (file + directory-descendant prefix + overwrite-sibling); remove the constructor subscription + `unsubscribe` field; `dispose()` → no-op. Make 2.1 green.
- [x] 2.3 Code review (OneDrive slice).

## 3. Shared strategy-contract invariant (OCP enforcement) + S3 vacuous confirmation

- [x] 3.1 (TDD) Add two scenarios to `src/__tests__/strategy-contract.ts`, gated on the existing `hasPathHandleCache` flag, mirroring the upload-population assertion (~L418–427): "after `deleteFile` of a cached path, the cache no longer holds it" and "after `rename`, the old path is evicted". Wire any required fixture priming (a cache-populating read before the mutation) in `googledrive-client.contract.test.ts`, `onedrive-client.contract.test.ts`, and `s3-client.contract.test.ts`.
- [x] 3.2 Run the contract suite across all three strategies: Drive + OneDrive (`hasPathHandleCache: true`) enforce eviction; S3 (`hasPathHandleCache: false`) satisfies it vacuously — confirm S3 needs NO code change (keys are paths, no cache).
- [x] 3.3 Code review (contract slice): the invariant is enforced via the contract suite, NOT via base-class changes; the base remains cache-agnostic.

## 4. Verification, spec validation, advisor checkpoint

- [x] 4.1 Engine package: `tsc -b` clean, `@ft5/fs-datasource-engine` tests green, eslint clean. (351/351; tsc + eslint clean.)
- [x] 4.2 Full-repo suite green (env setup: `pnpm abi:node` + `pnpm --filter @ft5/desktop build` → `pnpm test`); typecheck + lint clean. (2818 passed / 9 skipped, 0 type errors. The lone failure — `services/fs-sync/.../authenticate-flow.integration.test.ts` S3 credentials-form — is the documented main-checkout env flake [`vi.mock @aws-sdk/client-s3` fails to apply]; fails in isolation too, branch touches NO fs-sync/auth-flow/s3-client/aws-sdk files → not a regression of this engine-only change.)
- [x] 4.3 `openspec validate migrate-engine-cache-invalidation --strict`; after archive-sync, `openspec validate fs-datasource-engine --type spec`. (`--strict` green; per-cap spec validated post-sync in the archive step.)
- [x] 4.4 DRY decision: evaluate extracting `evictPathSubtree(map, path)` to de-dup the Drive/OneDrive prefix scan; lean YAGNI for two strategies — update `design.md` only if the decision changes. (Evaluated: still only two cached strategies; value types differ — Drive `{fileId,ambiguousSiblings?}` vs OneDrive `string`. Decision UNCHANGED — keep deferred per design.md Risks; no design edit.)
- [x] 4.5 Advisor checkpoint #2 (before `/opsx:archive`): verify the implementation matches the design decisions; make the deliverable durable first. (Done — archive justified; flake confirmed non-regression; spec-delta re-read vs as-built [no drift]; handle-form OCP-scoping note + resolved open-question added to design.md.)
