# Proposal: Migrate the fs-sync download registry from in-memory to SQLite

**Status**: Stub. Spawned during `add-engine-rename-download`
brainstorming on 2026-04-27.

## Why

`add-engine-rename-download` ships an **in-memory** `DownloadRegistry`
in the fs-sync service:

```typescript
Map<transactionId, DownloadJob>
```

The handler updates the map on every download event (start, throttled
progress, terminal). The `downloads:list-active` RPC returns a snapshot
of the map. App-restart hydration on first supervisor connect reads it.

This is correct as long as the service is running. Three gaps:

1. **No durability across service restart.** If the service crashes,
   is killed (OS shutdown, kill -9, debug-build relaunch), or is
   upgraded, the in-memory state is lost. In-flight downloads are
   orphaned: the partial file is stranded on disk, and the renderer
   has no way to find out the download was happening when it
   reconnects.

2. **No download history.** The registry is a transient view of
   "currently in-flight." Completed / failed / cancelled downloads
   disappear immediately. There's no way to surface "your last 10
   downloads" in the UI, run telemetry on success rates, or audit
   what was downloaded when.

3. **No foundation for service-crash recovery.** The follow-up
   `add-download-resilience` originally considered service-crash
   recovery as a scope option (replay partial files on service
   launch, decide resume vs orphan vs complete per-entry). That
   change explicitly excluded service-crash recovery on the
   architectural-boundary argument ("service is the durable owner;
   reliability bugs live in the service"). But replay would be
   trivial to add IF the registry were already persistent — the data
   would just be there. Migrating to SQLite is the prerequisite.

The fs-sync service already has a SQLite database at
`~/ft5/sync_app/sync.db` with Drizzle ORM, migrations infrastructure,
a connection pool, and existing tables for jobs and credentials. A
new `downloads` table is incremental work on a foundation that exists.

## Out of scope

- Service-crash recovery (replay). Stays scoped to
  `add-download-resilience` per the architectural boundary. This
  change just makes the data durable; replay is a separate decision.
- Download history UI in the renderer (a "Recent downloads" panel,
  search, etc.). The data is available after this change; the UI to
  surface it is a separate follow-up.
- Cross-machine sync of the registry (e.g., if the user runs
  ft5-cloude-sync on two laptops, share download history). Way out.

## Open questions (resolve during `/opsx:propose`)

1. **Throttle policy for progress updates.** Writing to SQLite on every
   `downloading` event would be hundreds of writes per second on a
   fast download. Recommend: write on milestones — every 10MB of
   progress OR every 30 seconds of wall time, whichever first. The
   in-memory tracker (kept as a write-through cache for
   `downloads:list-active` performance, see Q4) accumulates progress
   between flushes; loss of in-memory cache on crash means the
   registry shows a slightly-old `bytes_downloaded` value, off by at
   most 10MB / 30s — acceptable for a "current snapshot" view.

2. **Retention of completed/failed/cancelled rows.** Three branches:
   (a) Keep forever. Audit-friendly; eventually grows large.
   (b) Prune after N days (e.g., 90).
   (c) Cap by row count (e.g., last 1000 across all statuses).
   Recommend (b) with N=90; matches typical browser download history.

3. **Schema versioning.** The Drizzle migrations infrastructure is in
   place. New table added via standard migration. No data to migrate
   from the in-memory registry — it's transient, the upgrade window
   between versions just drops any in-flight downloads (and
   re-orphans their partial files, same as today).

4. **In-memory cache vs SQLite-only.** Two patterns:
   (i) SQLite-only. Every read hits the DB. Latency ≈ tens of
       microseconds for indexed lookups; fine.
   (ii) In-memory cache + write-through. Faster reads, slight risk
        of cache drift on bugs.
   Recommend (i). The `downloads:list-active` query is small and
   indexed; complexity savings of (i) outweigh the perf gain of (ii).

5. **Concurrent writes to the same row.** Multiple progress events for
   the same `transactionId` may arrive in quick succession. Use the
   existing better-sqlite3 transaction wrapper to serialize writes;
   the throttle at Q1 already limits the rate.

## Acceptance criteria (once promoted)

- New `downloads` table in `sync.db` via Drizzle migration with the
  schema (transaction_id PK, datasource_id, source_path, target_path,
  bytes_downloaded, content_length, started_at, last_updated_at,
  status enum, failure_tag, failure_message). Indexes on `status`
  and `started_at`.
- Service write points (start, throttled progress, terminal) all
  flow through the new SQLite-backed registry. The in-memory `Map`
  in `services/fs-sync/src/downloads/registry.ts` is deleted.
- `downloads:list-active` RPC reads from SQLite via the chosen
  pattern (Q4); response shape unchanged from the wire contract
  established by `add-engine-rename-download`.
- Retention pruning (Q2) implemented as a periodic background sweep
  (e.g., on service start + every 24h) over `last_updated_at <
  now - 90 days AND status != 'in-flight'`.
- Performance: `downloads:list-active` returns within 5ms for typical
  registry sizes (≤ 100 active rows + ≤ 90 days of history).
- Existing tests for `add-engine-rename-download` § registry pass
  unchanged at the wire level (the API stays the same).

## Provenance

- Spawned during `add-engine-rename-download` brainstorming on
  2026-04-27, when the user surfaced "can we keep the state in
  sqlite by sync service if the app got disconnected from the
  service due to desktop app close, desktop app crash, when desktop
  app connect back it can review the last state based on that adapt".
- The architectural boundary set by `add-engine-rename-download`
  (service is the durable owner; in-memory is the v1 trade-off) is
  preserved — this change strengthens "durable" without changing
  the boundary.
- Foundation work for `add-download-resilience` if/when that change
  expands scope to service-crash recovery (currently excluded on
  the architectural-boundary argument).
