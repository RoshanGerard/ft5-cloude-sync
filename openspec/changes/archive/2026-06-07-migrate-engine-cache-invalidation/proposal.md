# Proposal: Invalidate engine-side path-keyed caches inline on path-mutating ops

## Why

Each engine strategy keeps a path→handle LRU cache (Google Drive's `pathHandleCache` carries `{ fileId, ambiguousSiblings? }`; OneDrive's carries the driveItemId; S3 has none). On a successful `rename`, **neither strategy evicts the old path** — so a later `getMetadata` / `listDirectory` / `search` for that path hits the cache and resolves to the renamed entry: a stale, silently-inconsistent result. This is the §7 gap observed during `add-engine-rename-download` (`googledrive-client.ts` rename impl: *"Cache invalidation on rename is a follow-up concern"*).

The staleness is **latent today**, not a live user-visible bug: fs-sync constructs a fresh, cold-cache client per command and never reuses it, so the stale entry is discarded with the client before any cross-op re-read. But it is a real correctness defect — the invariant *"a strategy's path-keyed cache never returns a stale entry after a successful mutation on that path"* MUST hold before any caller pools clients (and the desktop main could already trip it within a single read→rename→read sequence). Two problems compound it: delete-eviction is wired through a **circuitous engine-bus self-subscription** (the strategy subscribes to its own `deleted` emissions to evict), and because fs-sync never disposes its per-op clients, every Drive/OneDrive client **leaks that subscription** onto the shared per-process bus (unbounded subscribers, O(n) emission cost).

This change establishes the invariant by moving **all** cache eviction inline into the strategy mutation methods and removing the bus self-subscription entirely — closing the rename gap, eliminating the subscription leak, and decoupling cache invalidation from the engine bus so the sibling `migrate-engine-events-to-consumer` change becomes cache-free.

## What Changes

- Drive + OneDrive evict their path-handle cache **inline** in the success branch of `doDeleteFileImpl` and `doRenameImpl`, mirroring the upload-population precedent from `migrate-upload-orchestration-out-of-engine`:
  - **File** rename/delete → evict the single path (`evictPath`) or handle (`evictHandle`), the exact logic the bus subscription ran.
  - **Directory** rename → evict the old path **and** every cached descendant under `<oldPath>/` (prefix scan); evict-only (the new path resolves fresh on next access).
  - **Overwrite-rename** that internally deletes a colliding sibling → evict that sibling's cached path (a gap the bus could not close — no `deleted` event fires for the internally-deleted sibling).
- **REMOVED:** the constructor engine-bus self-subscription (the `deleted` arm) and the `unsubscribe` field in both strategies; `dispose()` becomes a no-op retained for contract stability.
- S3 is unchanged (no path cache). The **base class is unchanged** — it still emits `deleted` / `entry-renamed` for consumer notification; the desktop EventBridge→renderer contract is untouched (`migrate-engine-events-to-consumer` removes those emissions later).
- The invariant is **enforced in the shared `strategy-contract.ts` suite** (gated on the existing `hasPathHandleCache` flag), so every present and future cached strategy must evict on delete/rename — recovering OCP-safety without teaching the base class about caching.

No **BREAKING** marker: no public signature, wire shape, IPC, or event change — engine-internal behavior only.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `fs-datasource-engine`: the cache-invalidation requirement changes from *"on successful `deleteFile`, invalidation is bus-driven — the strategy's constructor subscribes to `deleted`"* to *"the strategy evicts its path-keyed cache inline in the successful mutating op (delete, rename, upload-population); no bus event drives invalidation."* Adds scenarios for rename eviction, directory-descendant eviction, overwrite-sibling eviction, the cross-strategy contract invariant, and "strategy constructors no longer subscribe to the bus for invalidation."

## Impact

- **Code:** `packages/fs-datasource-engine/src/strategies/googledrive-client.ts` + `onedrive-client.ts` (inline eviction; remove bus subscription; `dispose()` → no-op). `s3-client.ts` and `base-client.ts` unchanged.
- **Tests:** `src/__tests__/strategy-contract.ts` (add the invariant scenarios); the Drive/OneDrive `*.test.ts` (transform the `deleted`-event-evicts tests to call `deleteFile()`; remove the OneDrive dispose test; add rename-eviction file+directory and overwrite-sibling tests). All stay in the engine package.
- **Spec:** `openspec/specs/fs-datasource-engine/spec.md` — MODIFIED invalidation requirement + scenario rename + added scenarios.
- **No dependency, wire/IPC, or renderer changes.** Consumer-facing bus emissions untouched.
- **Enables** the cache-free `migrate-engine-events-to-consumer` follow-on. Prereqs `add-engine-rename-download` (2026-04-29) + `migrate-upload-orchestration-out-of-engine` (2026-05-06) both merged.
