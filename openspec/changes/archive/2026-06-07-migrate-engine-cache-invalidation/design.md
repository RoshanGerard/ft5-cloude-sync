# Design: Inline path-cache invalidation, decoupled from the engine bus

## Context

The `fs-datasource-engine` uses a **Template-Method base** (`BaseDatasourceClient<T>` implements every public op once — emit / normalize / delegate — deferring provider work to `protected abstract doXImpl` primitives) plus the **Strategy pattern** (concrete S3 / OneDrive / Google Drive clients behind `DatasourceClient<T>`, selected at runtime by `ClientFactory` + `ProviderRegistry`). The base has **zero knowledge of caching** — the path↔handle LRU is private state of each strategy: Drive's `pathHandleCache: Map<path, { fileId, ambiguousSiblings? }>`, OneDrive's `Map<path, driveItemId>`; S3 has none (its keys are paths).

Current cache-mutation wiring (after `migrate-upload-orchestration-out-of-engine`):
- **upload** → inline population in `doUploadFileImpl`'s success branch (`cachePathHandle`), not bus-driven.
- **delete** → bus-driven: the strategy constructor subscribes to its OWN `deleted` emissions and evicts (a circuitous self-loop: base emits → same instance's subscription evicts).
- **rename** → nothing — the §7 gap (`googledrive-client.ts` rename impl notes *"Cache invalidation on rename is a follow-up concern"*).

The engine bus is **shared per-process** (`EngineContext` is built once at bootstrap and passed to every `ClientFactory.create`; `resolve-client.ts:57` forwards the shared `engineBus`). fs-sync constructs a **fresh client per command** (`files-list`, `files-remove`, `files-rename`, `files-download`, `mirror-sync` each call `resolveClient` per op) and never calls `.dispose()`, so every Drive/OneDrive client leaks its bus subscription onto the shared bus. The sibling stub `migrate-engine-events-to-consumer` will remove the engine bus entirely.

## Goals / Non-Goals

**Goals:**
- Establish the invariant: **a strategy's path-keyed cache never returns a stale entry after a successful mutation on that path.**
- Close the §7 rename gap (Drive + OneDrive).
- Decouple cache eviction from the engine bus, so `migrate-engine-events-to-consumer` is cache-free.
- Incidentally eliminate the per-op bus-subscription leak (a consequence of removing the subscription, not a separately-scoped fix).
- Enforce the invariant across every present and future cached strategy.

**Non-Goals:**
- Directory **delete** (still `Unsupported` — that is `unify-engine-delete-method`).
- Broadcast / cross-process cache invalidation (the renderer self-invalidates via the still-emitted wire `entry-renamed`; engine-internal eviction suffices — YAGNI).
- Broadly fixing the dispose-leak — fs-sync handlers still won't call `.dispose()` (separate concern; removing the subscription makes the leak moot for cache invalidation).
- Any change to consumer-facing bus emissions (`deleted` / `entry-renamed` keep firing for the desktop EventBridge→renderer contract).
- Re-populating the new path on rename (evict-only).

## Decisions

### Decision 1 — Inline per-strategy eviction (Option A)
Eviction lives in each strategy's mutation primitive success branch (`doDeleteFileImpl`, `doRenameImpl`), mirroring the upload-population precedent.

- *Over a base-class hook (Option B):* a base `onPathMutated()` / `invalidatePaths()` hook would teach the base that strategies have caches — leaking a strategy-private optimization into the cache-agnostic Template-Method base and violating its single responsibility (op-lifecycle orchestration). It also cannot compute directory-descendant invalidation sets generically (that needs the strategy's cache + file/dir knowledge), so the abstraction leaks back into the strategy anyway.
- *Over a minimal bus-patch (Option C — add an `entry-renamed` arm to the existing subscription):* C is smallest now but throwaway — `migrate-engine-events-to-consumer` removes the bus, so all bus-driven eviction must be re-done inline regardless; C also deepens bus coupling immediately before the bus is removed and does not fix the subscription leak.
- Inline keeps the cache's full lifecycle (populate + evict) in one place (the strategy), is consistent with the established upload pattern, and is the more SOLID choice.

### Decision 2 — Remove the bus self-subscription; `dispose()` → no-op
Both strategies drop the constructor `ctx.bus.subscribe(...)` (the `deleted` arm) and the `unsubscribe` field. `dispose()` is retained as a no-op for contract stability (callers still call it harmlessly; `migrate-engine-events-to-consumer` or a later cleanup can remove it). This eliminates the per-op subscription leak as a side effect.

### Decision 3 — Eviction semantics
- **File** rename/delete → evict the single path (path-form → `evictPath`; handle-form → `evictHandle`) — the exact logic the bus subscription ran.
- **Directory rename** (`/foo → /bar`) → evict `/foo` AND every cached key starting with `/foo/` (descendants whose paths no longer resolve). **Evict-only**: `/bar` and its descendants resolve fresh on next access. The moved entry's handle/fileId is still valid — only the path KEY is stale — so eviction (not re-mapping) is the correct minimal action.
- **Overwrite-rename's internally-deleted sibling** → evict that sibling's path inline; closes a latent gap the bus structurally could not (the overwrite path deletes the sibling directly, emitting no `deleted` event).
- **S3** → no-op (no path cache).

### Decision 4 — Engine-internal eviction only
No broadcast / cross-process invalidation. The renderer's optimistic store already self-invalidates on the wire `entry-renamed` event (still emitted). YAGNI.

### Decision 5 — Enforce the invariant in the shared contract suite (OCP resolution — load-bearing)
Inline eviction (Decision 1) is open for extension but **not self-enforcing**: a future cached strategy could forget to evict and silently reintroduce §7. Resolve by adding cache-invalidation scenarios to `src/__tests__/strategy-contract.ts`, gated on the existing `hasPathHandleCache` fixture flag (Drive/OneDrive `true`; S3 `false` → vacuous), mirroring the existing upload-population assertion (`strategy-contract.ts` ~L418–427 `expect(cache.has(entry.path)).toBe(true)`). Because every strategy MUST pass the suite, a new cached strategy that forgets eviction fails the contract.

This recovers cross-strategy OCP-enforcement **via the contract, not shared base code** — the SOLID-correct way to enforce a cross-strategy invariant. A base hook would also enforce it but at the cost of the base's SRP (Decision 1). Pattern faithfulness:
- **Template Method** — eviction is a strategy primitive detail; the base stays unchanged and cache-agnostic.
- **Strategy / LSP** — public interface unchanged; the invariant holds for every strategy (Drive/OneDrive by eviction, S3 vacuously since a re-read always hits the provider).
- **SRP** — the base stays op-lifecycle-only; the bus stops doubling as an internal cache-invalidation channel.
- **OCP** — extension stays safe via the contract gate.

### Decision 6 — Base class unchanged; single-purpose seam with the events migration
The base keeps emitting `deleted` / `entry-renamed` for consumer notification. This change touches ZERO consumer-facing emissions; `migrate-engine-events-to-consumer` removes them later. Each change stays single-purpose.

## Risks / Trade-offs

- **Loses cross-instance bus eviction** (instance A's delete no longer evicts instance B's cache for the same datasource via the shared bus) → *Mitigation:* not load-bearing — fs-sync uses per-op cold-cache clients (no pooling), so concurrent same-datasource instances sharing live cache state is not a real flow; and `migrate-engine-events-to-consumer` removes the bus regardless. The dominant correctness case is intra-instance (read→mutate→read), which inline eviction covers.
- **`dispose()` becomes a no-op** → *Mitigation:* retained for contract stability (no caller breakage); flagged for removal in `migrate-engine-events-to-consumer`.
- **DRY** — the directory-prefix eviction is structurally similar across Drive + OneDrive (different cache value types: `{ fileId, ambiguousSiblings? }` vs `string`) → a generic `evictPathSubtree(map: Map<string, V>, path: string)` helper could de-dup it. Lean YAGNI for two strategies; extract only if a third cached strategy lands. (Flagged, not forced.)
- **§7 is latent, not a live user-visible bug** (honest framing) → the value is the correctness invariant (must hold before any caller pools clients), the subscription-leak elimination, and the events-migration decoupling.
- **Contract net covers path-form eviction only** (honest OCP scoping) → the two shared scenarios (Decision 5) delete/rename a **path-form** target, so they pin `evictPath` / `evictPathAndDescendants` but NOT `evictHandle`. A future cached strategy that wires path-form eviction yet forgets handle-form eviction would pass the contract while still leaking on handle-addressed mutations. *Not a hole today:* handle-form eviction is covered by each provider's unit tests (Drive/OneDrive `deleteFile` + `rename` handle-form eviction cases, transformed in slices 1–2). Extend the contract with a handle-form scenario if handle-addressed mutation becomes a primary caller path.

## Migration Plan

Engine-internal refactor — no deploy/data migration, no wire/IPC/renderer change. Rollback = revert the commit. The contract-suite invariant (Decision 5) plus the transformed strategy tests guard against regression.

## Open Questions

None outstanding (resolved via brainstorming + advisor checkpoint 1). The one apply-time detail — the contract-suite assertion shape — was resolved as **white-box** `cache.has(path) === false` after the op (mirrors the existing `hasPathHandleCache` upload assertion), with a load-bearing precondition `cache.has(path) === true` populated via `listDirectory("/")` BEFORE the mutation. The precondition both defeats a trivial post-mutation pass and forces cache-HIT resolution (notably required for OneDrive, whose `resolveTargetUrl` reads but never populates the cache on a miss). Two required fixture hooks (`primeDeleteOfListedFile` / `primeRenameOfListedFile`) prime the cache-hit mutation per provider; S3 implements them as no-ops.
