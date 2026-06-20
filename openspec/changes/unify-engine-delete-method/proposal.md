# Proposal: Unify engine delete into a single `delete` method

## Why

The engine consolidated its rename surface into a single `rename(target, newName, conflictPolicy)` method (`add-engine-rename-download`), resting on the strategy pattern: the strategy dispatches provider-specific quirks within its own context. Delete still carries the older split — `deleteFile` + `deleteDirectory` — which predates that principle. The split exists for a different reason: `deleteDirectory` is hardcoded to throw `Unsupported` for product stability (Decision 10 of `add-fs-datasource-engine`), because recursive directory delete was deemed too dangerous for v1 across every provider.

Against the rename design the split now reads as inconsistent — a new contributor reasonably asks "why does rename use one method but delete use two?", and the answer ("historical, plus a global product policy encoded in the interface shape") is harder to defend than collapsing both to one method. This change collapses delete to one method `delete(target, entryKind)` while keeping the directory-delete refusal exactly as-is. The consolidation is purely about interface shape and method count — **not** about enabling directory delete.

## What Changes

- The engine's `DatasourceClient<T>` interface replaces `deleteFile(target)` + `deleteDirectory(target)` with a single `delete(target, entryKind): Promise<void>`.
- The global directory-delete refusal (Decision 10) moves from the dedicated `deleteDirectory` method into the base `delete()` wrapper: when `entryKind` is `directory`, the base throws the **same** `DatasourceError { tag: "unsupported", retryable: false, raw: "disabled-for-product-stability", … }` as before — identical tag/`raw`, so callers catching `unsupported` see no change. File deletes dispatch to the unchanged strategy primitive `doDeleteFileImpl`.
- `EntryKind` (in `ipc-contracts`) is promoted from a bare string union to the `as const` const-ref form (mirroring `FilesErrorTag` / `DatasourceErrorTag`) so the new `entryKind` argument is referenced by name (`EntryKind.File` / `EntryKind.Directory`) rather than as a magic string. **Non-breaking** — the derived type stays `"directory" | "file"`, so every current consumer keeps compiling.
- Consumers update to the new call shape: the fs-sync `files:remove` handler collapses its file/directory branch into one `client.delete(...)` call, and the mirror-sync executor's file delete updates. No IPC wire change, no behavior change.

**Out of scope (Non-Goals):** enabling directory delete (per-provider or empty-only) and its recursive-confirm / tree-count-preview / undo-window UX — a dedicated future change. No `files:remove` wire change; no mock-fs or renderer change; no renaming of the `doDeleteFileImpl` hook.

## Capabilities

### Modified Capabilities
- `fs-datasource-engine`: the public delete surface collapses to one `delete(target, entryKind)` method; the Decision-10 directory-delete `Unsupported` refusal is preserved but relocated from the removed `deleteDirectory` method to the base `delete()` wrapper.

## Impact

- **Engine** (`packages/fs-datasource-engine`): `DatasourceClient<T>` interface + base `delete()` wrapper; public `deleteFile`/`deleteDirectory` removed; the `doDeleteFileImpl` strategy hook and its inline path-cache eviction (from `migrate-engine-cache-invalidation`) are unchanged.
- **ipc-contracts** (`packages/ipc-contracts`): `EntryKind` promoted to the `as const` const-ref form. Already an engine workspace dependency — no new dependency.
- **fs-sync** (`services/fs-sync`): `files-remove.ts` + `mirror-sync.ts` call-site updates (code only — no fs-sync spec or IPC wire change; behavior identical).
- **Tests**: the engine test suite (~6 files) + the shared strategy-contract suite + the fs-sync handler tests migrate to the unified `delete(target, entryKind)` call.
