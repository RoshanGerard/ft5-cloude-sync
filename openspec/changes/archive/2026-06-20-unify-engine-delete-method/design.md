# Design: Unify engine delete into a single `delete` method

## Context

The engine exposes exactly one delete primitive today: `deleteFile(target)` → the abstract strategy hook `doDeleteFileImpl(target)` (`base-client.ts:544,370`). The companion `deleteDirectory(target): Promise<never>` (`base-client.ts:559-569`) is a **base-resident, unconditional** refusal — it discards `target` and always throws `DatasourceError { tag: "unsupported", retryable: false, raw: "disabled-for-product-stability" }` (Decision 10 of `add-fs-datasource-engine`). There is no `doDeleteDirectoryImpl`; no strategy is consulted for directory delete.

The directory-delete refusal is currently enforced by **two signals working together**: (a) the base `deleteDirectory()` hard-throw, and (b) consumers routing directory targets to it. The engine's `deleteFile` itself does **not** introspect kind — Drive/OneDrive `files.delete` / `DELETE /items/{id}` on a folder handle would cascade server-side. So removing the method-name signal means re-homing the refusal.

The rename precedent this change is measured against (`rename(target, newName, conflictPolicy)` → `doRenameImpl`) resolves file-vs-directory **inside each strategy**, because rename's directory handling is genuinely provider-specific (e.g., directory rename with `overwrite` is refused per-strategy). Delete's directory refusal, by contrast, is a single global policy.

Directory delete is already wired end-to-end through the renderer and the fs-sync `files-remove` handler; the only thing stopping it is the engine refusal. The IPC wire (`FilesRemoveTarget`, the `files:remove` command, the result envelope) is independent of whether the engine exposes one delete method or two.

## Goals / Non-Goals

**Goals:**
- Collapse `deleteFile` + `deleteDirectory` into one `delete(target, entryKind): Promise<void>`, matching rename's one-method-per-concern shape.
- Preserve the Decision-10 directory-delete `Unsupported` refusal byte-for-byte (same `tag`/`raw`), relocated to the new method.
- Give the new `entryKind` argument a named const-ref representation consistent with the repo's `FilesErrorTag` / `DatasourceErrorTag` convention.
- Update consumers and tests to the unified call with **zero** caller-visible behavior change.

**Non-Goals:**
- Enabling directory delete — per-provider (Drive/OneDrive server-side recursion, S3 list-then-batch-delete) or empty-directory-only — and its recursive-confirm / tree-count-preview / undo-window UX. Deferred to a dedicated future change.
- Any `files:remove` IPC wire change; mock-fs changes; renderer changes; renaming the `doDeleteFileImpl` hook; unrelated refactor.

## Decisions

### Decision 1 — Collapse to one `delete(target, entryKind)`; directory stays refused (branch α)
Replace `deleteFile(target)` + `deleteDirectory(target)` with a single `delete(target: Target, entryKind: EntryKind): Promise<void>`. (`delete` is valid as a method name — cf. `Map.prototype.delete`.) Directory delete remains **unsupported**; this change is interface-shape only. Enabling directory delete (branch β per-provider / branch γ empty-only) plus its destructive-UX guardrails is explicitly deferred.

### Decision 2 — Refusal is BASE-enforced, not strategy-introspected (load-bearing)
The base `delete(target, entryKind)`:
- `entryKind === EntryKind.Directory` → throw the **same** `DatasourceError { tag: "unsupported", retryable: false, raw: "disabled-for-product-stability", message: "directory delete is disabled for product stability" }`, relocated verbatim from today's `deleteDirectory`. Identical `tag`/`raw` ⇒ callers catching `unsupported` see zero change. No `*-failed` event (the engine has no event bus).
- otherwise → dispatch to the existing strategy primitive `doDeleteFileImpl(target)`.

**Rationale:** directory refusal is a *global* product policy (all providers, Decision 10) → it belongs in one place, the base. This deliberately diverges from rename's strategy-introspection, which existed because rename's directory handling is *provider-specific*. Delete's blanket refusal is not provider-specific, so copying rename's strategy-introspection here would be cargo-culting (and would add a per-delete introspection round-trip — an extra provider metadata call on every file delete — for no current benefit). Advisor-confirmed.

### Decision 3 — `entryKind` uses the `as const` const-ref `EntryKind` (the repo's "enum")
Promote `EntryKind` (`packages/ipc-contracts/src/files.ts`, currently `export type EntryKind = "directory" | "file";`) to the `as const` const-ref form, mirroring the existing `FilesErrorTag` / `DatasourceErrorTag` precedent:
```ts
export const EntryKind = { Directory: "directory", File: "file" } as const;
export type EntryKind = (typeof EntryKind)[keyof typeof EntryKind]; // still "directory" | "file"
```
**Non-breaking:** the derived type is unchanged, so every current consumer (`FilesRemoveTarget`, sync-service commands, renderer) keeps compiling and existing string literals still assign; new code references `EntryKind.File` / `EntryKind.Directory`. This is *not* a raw TS `enum` keyword type — that would be breaking (string literals would stop assigning) and against the `FilesErrorTag` convention. The engine imports `EntryKind` from `@ft5/ipc-contracts`, **already a workspace dependency** (`base-client.ts:54-55` imports `DatasourceError` and other contract types) — so no new dependency is added. Aligns with the in-flight `migrate-error-tag-literals-to-const-refs` direction.

### Decision 4 — No `conflictPolicy` parameter for delete
Unlike rename, delete has no conflict semantics, and branch α adds no recursion — so `delete` takes no policy parameter. (If a future change enables directory delete, recursion would be its own explicit flag, designed there.)

### Decision 5 — Strategy hooks and inline cache eviction are unchanged
`doDeleteFileImpl` keeps its name in all three strategies — it accurately deletes a *file*; the directory guard sits above it in the base. Its inline path-cache eviction from `migrate-engine-cache-invalidation` (Drive `googledrive-client.ts:1542-1548`, OneDrive `onedrive-client.ts:1048-1052`, S3 vacuous — no cache) is untouched. No `doDeleteDirectoryImpl` is introduced.

### Decision 6 — Consumer updates (code only, behavior identical)
- `services/fs-sync/src/commands/files-remove.ts` — collapse `if (target.kind === "directory") client.deleteDirectory(...) else client.deleteFile(...)` into one `client.delete({ kind: "handle", handle: target.handle }, target.kind)`, still inside `withAuthRefresh`. Directory targets still surface `unsupported` per-target; the `files:remove` envelope is unchanged.
- `services/fs-sync/src/executors/mirror-sync.ts` — the file delete `client.deleteFile({ kind: "handle", handle: op.remoteHandle })` becomes `client.delete({ kind: "handle", handle: op.remoteHandle }, EntryKind.File)` (mirror-sync deletes individual remote files; the op kind is verified during apply).
- No mock-fs change (`apps/desktop/.../mock-fs.ts` `remove` is a separate in-process implementation that never touches the engine). No IPC wire change. No renderer change. No capability-descriptor update (verified by grep: no delete-granularity capability flag exists — only comments reference the unsupported refusal).
- **`fs-sync-service` spec delta (added per advisor checkpoint #2):** because `mirror-sync.ts` now calls `client.delete(..., "file")`, the canonical `fs-sync-service` spec's engine-call references are refreshed `deleteFile` → `delete` in three requirements — `MirrorSyncJobExecutor` (body clause (e) + the "Locally-deleted file triggers remote delete" scenario), source-health (the "Missing source root" scenario's zero-remote-calls assertion), and system-retry (the `auth-expired` `withAuthRefresh`-wrapped-calls bullet). Behavior is unchanged — a method-name refresh, not a contract change. The initial "engine-only delta" framing missed these; advisor check #2 (grep canonical specs) caught the stale `fs-sync-service` references.

## Risks / Trade-offs

- **`entryKind` trusts the caller.** The base refuses based on the caller-supplied kind rather than introspecting. This is the *exact* trust model today: fs-sync already routes on this kind, and the engine's `deleteFile` never introspected (a folder handle passed to `deleteFile` already cascades on Drive/OneDrive). So there is no regression; self-enforcing introspection (rejected in Decision 2) would be a new guarantee at a per-delete cost.
- **Loses the static `Promise<never>` signal.** Today `deleteDirectory(): Promise<never>` statically encodes "never resolves." The unified `delete(): Promise<void>` replaces that with a runtime refusal. Accepted: uniform `Promise<void>` is forward-compatible — a `Promise<never>` directory overload would become wrong once a future change enables directory delete. No overloads.
- **Naming asymmetry.** Public `delete` vs protected `doDeleteFileImpl`. Accepted for accuracy (the hook only ever deletes files) and minimal churn (no rename across 3 strategies + their eviction code + tests).
- **Deliberate divergence from rename's strategy-introspection** — justified by global vs provider-specific refusal (Decision 2); a reader expecting literal symmetry with rename is pointed to that rationale.
