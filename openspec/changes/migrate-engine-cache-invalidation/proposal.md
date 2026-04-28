# Proposal: Invalidate engine-side path-keyed caches on path-mutating events

**Status**: Stub. Spawned during `add-engine-rename-download` §7 (Drive strategy) on 2026-04-28 — surfaced when the rename code-path observed that no cache layer is invalidated post-rename, leaving stale path entries until the cache TTL expires.

## Why

Every engine read (`list`, `stat`, `search`) may cache by `(datasourceId, path)`. Path-mutating ops (`rename`, `delete`, `upload`, `createFile`) change which paths exist, but no broadcast invalidation is wired today. Result: a renamed entry's old path still resolves to a stale entry in subsequent `list` / `stat` / `search` calls until cache expiry. The user-facing symptom is inconsistent display state on the renderer side — a freshly-renamed file appearing under both its old AND new name in another window, or a deleted file lingering in a list result for the duration of the cache window.

This is **NOT data loss**. The underlying provider is correct; the cache is wrong. But for a multi-window or rapid-edit workflow, the inconsistency is visible long enough to cause user confusion (and breaks tests that assert post-rename listings reflect the new name immediately).

The §7 Drive subagent specifically observed: the constructor's bus subscription evicts the path↔fileId LRU on `deleted` and `file-created` events but NOT on `entry-renamed`. After a successful rename, the OLD path stays cached pointing to the (now-renamed) fileId. A subsequent `getMetadata({path: oldPath})` would resolve via cache, fetch the file by its current fileId, and return an entry with `path: oldPath` but `name: newName` — silently inconsistent.

The same gap likely exists across every strategy that maintains a path-keyed cache (Drive's path↔fileId LRU is one example; OneDrive and S3 strategies may add similar caches as their listDirectory / stat paths mature). A uniform invalidation hook on the base class is the right place to solve it once.

## What this change does

- Audit current engine cache surfaces (existing or planned): the Drive strategy's path↔fileId LRU, any per-strategy stat / list result cache, plus any future caches the OneDrive / S3 strategies grow.
- Add a uniform invalidation hook on path-mutating events (`entry-renamed`, `deleted`, `file-created`). The hook is wired at the base class so every strategy benefits without per-strategy plumbing.
- The hook drops cache entries for the affected `(datasourceId, path)` AND any directory-prefix matches: e.g., a rename from `/foo` to `/bar` invalidates `/foo/*` (any descendants of the renamed directory) AND `/bar/*` (any pre-fetched paths now superseded by the moved entry).
- Decide whether the invalidation is broadcast (every consumer's local cache, e.g., the renderer's optimistic store) or engine-internal only. Default position: engine-internal first, since the renderer's optimistic store already handles its own invalidation via the `entry-renamed` event it already subscribes to.

## Out of scope

- Disk-persisted cache. This change is scoped to in-memory caches only.
- Cache hit/miss telemetry. Useful but separate concern.
- Provider-side webhooks for external mutations (e.g., a rename done in the Drive web UI propagating back). Different problem; different change.

## Open questions (resolve during `/opsx:propose`)

1. **Is there an existing engine-side cache today, or is this preemptive?** The Drive strategy clearly has a path↔fileId LRU (per the §7 subagent's observation). An audit during the proposal phase would catalog every cache surface across the three current strategies.
2. **If cache exists, where?** The Drive LRU lives inside the strategy class. A uniform invalidation hook on the base class needs each strategy to expose an invalidation entry point — `protected onPathMutated(path: string): void` or similar — that the base calls before emitting the bus event.
3. **For multi-window scenarios, how does cache invalidation coordinate across processes?** The engine instance is per-process (one in the fs-sync service, one in the desktop main if any). If both keep caches, the bus events that flow over the IPC channel already trigger cache eviction on the consumer side; engine-internal caches in different processes are independent and each one's bus subscription handles its own. Cross-process cache coherence is not a concern as long as the bus event reaches every process.

## Acceptance criteria (once promoted)

- A rename of `/foo` to `/bar` causes any subsequent `list` / `stat` / `search` for `/foo` to either return not-found OR re-fetch from the provider (cache miss, fresh data); no stale `/foo` entries persist beyond the `entry-renamed` event timestamp.
- A delete of `/foo` causes subsequent `list` / `stat` / `search` for `/foo` to re-fetch (which then surfaces the not-found from the provider).
- A directory rename of `/foo/` invalidates every cached descendant under `/foo/*` (since their paths no longer resolve in the provider).
- The Drive strategy's path↔fileId LRU is cleared for the affected paths on `entry-renamed`, closing the §7 gap directly.

## Provenance

- Spawned during `add-engine-rename-download` §7 on 2026-04-28; the §7 Drive subagent flagged in the post-task notes that "the constructor's bus subscription evicts the path↔fileId LRU on `deleted` and `file-created` events but NOT on `entry-renamed`" — this change is the chartered follow-up.
- Touches every path-keyed cache across the engine, so the right place to solve it is the base class, not piecemeal per strategy.
