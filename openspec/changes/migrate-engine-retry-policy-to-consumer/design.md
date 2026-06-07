# Design: Migrate engine retry policy (`withRefresh`) to fs-sync

## Context

`BaseDatasourceClient` (in `packages/fs-datasource-engine/src/base-client.ts`)
wraps every public operation except `authenticate()` with a private
`withRefresh<R>(op)`: it runs `op`; on a normalized `auth-expired` it
calls `singleFlightRefresh()` (refresh once, persist, emit
`token-refreshed`) and retries `op` once; a second `auth-expired`
propagates. `singleFlightRefresh()` is the per-instance single-flight
guard; `withRefresh`'s catch additionally emits `token-expired` +
`authentication-failed` when the refresh itself fails.

The stub's open-question framing assumed download and upload had already
moved retry to fs-sync. **They had not.** Exploration (2026-06-07)
confirmed all 8 fs-sync engine call sites still rely on the engine's
`withRefresh` for the actual credential refresh:

| fs-sync site | op | consumer-side logic today |
|---|---|---|
| `commands/files-list.ts:36` | `listDirectory` | none |
| `commands/files-stat.ts:30` | `getMetadata` | none |
| `commands/files-search.ts:34` | `search` | none |
| `commands/files-remove.ts:58,63` | `deleteDirectory`/`deleteFile` | none |
| `commands/files-rename.ts:54` | `rename` | none |
| `commands/files-upload.ts:317` | `uploadFile` | none |
| `commands/files-download.ts` | `downloadFile` | resume + environmental retry, **but auth refresh is the engine's** |
| `executors/mirror-sync.ts:89,121` | `uploadFile`/`deleteFile` | none |

`resolveClient` (`services/fs-sync/src/main/resolve-client.ts:31`)
constructs a fresh client per call. Desktop main (`apps/desktop`)
constructs an engine factory but makes **zero** live engine-op calls
(verified: no `.status(` / `.testConnection(` / `.authenticate(` /
`factory.create(` outside tests) — its own comment states "the desktop
main process neither reads nor writes credentials; every provider call
that needs them goes through the service over the sync IPC channel." So
the complete set of callers relying on `withRefresh` is exactly these 8
fs-sync sites.

Stakeholders: engine maintainers (the base-class surface + every
strategy's `refreshTokenImpl` are unaffected, but the contract shifts);
fs-sync maintainers (own the new retry); `add-engine-listdirectory-pagination`
(blocked on this — its 4-attempt auto-retry must compose over whoever
owns auth refresh); the desktop EventBridge (consumes the token-cycle
events, which this change preserves).

## Goals / Non-Goals

**Goals:**

- Remove the engine's baked-in `withRefresh` auto-retry. Operations
  surface `auth-expired` raw.
- Expose a public single-flight `refreshCredentials()` so fs-sync can
  refresh explicitly and observe the cost.
- Ship `withAuthRefresh(client, op)` as the default, replaceable
  one-shot refresh-then-retry policy.
- Migrate all 8 fs-sync call sites with **no end-to-end behavior change**
  (a refreshable token still succeeds; a dead token still surfaces
  `auth-revoked`); only the layer that refreshes moves.
- Leave a layering that `add-engine-listdirectory-pagination` composes
  cleanly: auth refresh = inner one-shot (`withAuthRefresh`);
  environmental retry = outer N-attempt (fs-sync's existing schedule).

**Non-Goals:**

- Removing the engine bus or the token-cycle event emission — that is
  `migrate-engine-events-to-consumer`. This change KEEPS those events,
  relocated into `refreshCredentials()`.
- Coalescing single-flight refresh *across* client instances. It stays
  per-instance (fresh client per `resolveClient` call). A future change
  may revisit if instance churn proves wasteful.
- Changing the strategy `refreshTokenImpl()` signature, the credential
  persistence path (`CredentialStore.put`), or the `DatasourceError`
  taxonomy.
- Changing any fs-sync RPC wire contract.

## Decisions

### Decision 1 — Remove `withRefresh`; operations surface `auth-expired` raw

`BaseDatasourceClient.withRefresh` is deleted. Each public wrapper
(`status`, `testConnection`, `runReadOp` → list/search/getMetadata/getQuota,
`uploadFile`, `deleteFile`, `rename`, `downloadFile`) calls its `doXImpl`
directly. A normalized `auth-expired` `DatasourceError` propagates to the
caller unchanged — no refresh, no retry. The base's emission and error
normalization wrappers are retained (emission leaves later, via the
events migration).

*Alternative considered:* keep `withRefresh` but make the policy
injectable (a per-client retry strategy). Rejected — it keeps the policy
inside the engine and invisible at the call site, which is the exact
property this change exists to eliminate.

### Decision 2 — Public `refreshCredentials()` = today's `singleFlightRefresh`, made public

Add `refreshCredentials(): Promise<AuthResult>` to `DatasourceClient<T>`.
Its body IS today's `singleFlightRefresh`: per-instance single-flight
(concurrent callers share one in-flight `refreshTokenImpl()` call),
persist via `CredentialStore.put` BEFORE the promise resolves, emit
`token-refreshed` on success. The token-cycle FAILURE emission that lived
in `withRefresh`'s catch (`token-expired` + `authentication-failed`)
moves INTO `refreshCredentials()` so the event contract is identical
regardless of who triggers the refresh.

**Naming:** `refreshCredentials` over `refreshAccessToken` — the
persisted shape is `StoredCredentials` (broader than an access token).
Strategies keep `protected abstract refreshTokenImpl(): Promise<AuthResult>`
unchanged; `refreshCredentials()` is the public single-flight wrapper
around it.

### Decision 3 — Ship `withAuthRefresh(client, op)` from the engine

Export a helper from `@ft5/fs-datasource-engine`:

```typescript
export async function withAuthRefresh<R>(
  client: Pick<DatasourceClient<DatasourceType>, "refreshCredentials">,
  op: () => Promise<R>,
): Promise<R> {
  try {
    return await op();
  } catch (err) {
    if (!(err instanceof DatasourceError) || err.tag !== "auth-expired") throw err;
    await client.refreshCredentials();
    return await op(); // retry once — a second auth-expired propagates
  }
}
```

This is the default one-shot refresh-then-retry — the behavior
`withRefresh` baked in, now explicit and replaceable. The engine package
stays framework-agnostic: the helper's contract refers to **callers**,
never to fs-sync. `auth-expired` detection uses the exported
`DatasourceError` class + tag (errors are already normalized by the base
before they cross the boundary), so no new public `normalizeError`
export is needed.

*Alternative considered:* a central retry proxy applied at
`resolveClient` (one place, handlers unchanged). Rejected — it
re-introduces the invisible, one-size-fits-all policy this change
eliminates, and it would double-wrap the bespoke download path. Per-site
application keeps the policy visible and lets the download handler opt
out of the generic helper.

### Decision 4 — 7 fs-sync sites take the helper; only download is bespoke

The 7 single-call sites wrap in `withAuthRefresh` and are otherwise
unchanged — `files:list`, `files:stat`, `files:search`, `files:remove`
(each of its two deletes), `files:rename`, `files:upload`, and the
`mirror-sync` executor's `uploadFile` + `deleteFile`. Because each is a
single engine call, `withAuthRefresh` reproduces today's engine-driven
"refresh once, retry once" exactly. `files:upload`'s retry-once
re-uploads the whole file — identical to today.

### Decision 5 — Download-handler auth-expired INVERSION (the centerpiece)

`files-download.ts` is the one real rework. Today its catch points read
a bare `auth-expired` as *"the engine's `withRefresh` already refreshed
and the post-refresh GET STILL returned auth-expired → the refresh token
is dead → surface `auth-revoked`."* Two sites encode this:

- **Pre-stream** (~L1101-1108): a first `engine.downloadFile()` rejection
  with `auth-expired` falls through to the terminal catch, which
  `normalizeFilesError` collapses to `auth-revoked`.
- **Mid-stream** (~L1204-1215): on a mid-stream `auth-expired` within the
  per-cycle budget, the handler re-issues `engine.downloadFile()` and
  *trusts its `withRefresh`* to refresh before the new GET.

After `withRefresh` is removed, a *first* `auth-expired` means **no
refresh has happened yet**. Without rework, every download that merely
needs a token refresh would fail-fast as `auth-revoked` — a regression.

The rework: at BOTH catch points, on `auth-expired`, explicitly
`await client.refreshCredentials()` then retry / re-issue the GET (with
`rangeStart = bytesWritten` for resume). The dead-token determination is
redefined as **`auth-expired` again, immediately after a successful
`refreshCredentials()`** → only then surface `auth-revoked`. The
per-cycle `MAX_AUTH_RETRIES = 1` budget now counts *refresh-and-retry*
attempts (mirroring today's one-shot). The environmental-retry layer
(Layer 3: network / rate-limited / provider-error, with its 5-attempt /
30-min budget) is untouched and remains the outer layer; auth refresh is
the inner one-shot.

This is the migration's highest-risk surface and gets dedicated tasks +
its own spec scenarios (pre-stream refresh, mid-stream refresh,
refresh-then-still-expired → `auth-revoked`).

### Decision 6 — Keep token-cycle events here (seam with `migrate-engine-events-to-consumer`)

`refreshCredentials()` retains `token-refreshed` (success) and
`token-expired` + `authentication-failed` (failure). The desktop
EventBridge relays these to renderer windows; preserving them keeps that
contract intact. `migrate-engine-events-to-consumer` later removes the
engine bus and relocates all event emission — this change deliberately
does not, so each change stays single-purpose and independently
reviewable.

### Decision 7 — Single-flight stays per-instance

`refreshCredentials()` preserves the per-instance single-flight guard
(the `refreshPromise` field). Concurrent operations on the *same* client
instance that all hit `auth-expired` share one refresh. Cross-instance
coalescing is explicitly out of scope (Non-Goal). Since `resolveClient`
mints a fresh client per call, two concurrent fs-sync commands on the
same datasource may each refresh once — acceptable and unchanged from
today.

## Risks / Trade-offs

- **[Download inversion missed or half-done]** → Regression: stale-token
  downloads fail as `auth-revoked` instead of refreshing. *Mitigation:*
  Decision 5 is a first-class task with explicit pre-stream + mid-stream
  + refresh-then-expired spec scenarios and reactive TDD (a failing test
  reproducing the fail-fast before the fix).
- **[A migrated call site silently degrades]** → If a site is missed, its
  op now fails on the first `auth-expired` instead of refreshing.
  *Mitigation:* the 8-site list is enumerated and exhaustive (verified by
  exploration); each gets a refresh-once test; the engine inversion guard
  proves `withRefresh` is gone.
- **[Test surface drift]** → The 6 engine tests assert engine-owned
  retry. *Mitigation:* transform in place — one-shot-retry +
  not-re-refreshed become `withAuthRefresh` tests; single-flight +
  persist + failure-events become `refreshCredentials()` tests; all stay
  in the engine package. Add a new inversion guard.
- **[Event-timing shift]** → `token-refreshed` now fires when fs-sync
  calls `refreshCredentials()` rather than mid-`withRefresh`. *Mitigation:*
  the event still fires exactly once per successful refresh; the
  EventBridge relays it identically; no subscriber depends on the precise
  call-stack origin.
- **[Scheduler auth-expired contract]** → fs-sync-service's "System-level
  retry" requirement says the scheduler does NOT intercept `auth-expired`
  because the engine refreshes. *Mitigation:* the mirror-sync executor's
  `withAuthRefresh` wrap performs the refresh BEFORE anything escapes to
  the scheduler, so the scheduler contract ("don't intercept; a surfacing
  `auth-expired` is terminal") stays valid — the surfacing error is now a
  post-refresh dead token.

## Migration Plan

1. Engine: add `refreshCredentials()` (+ carry failure emission), export
   `withAuthRefresh`, delete `withRefresh`, repoint every wrapper to
   `doXImpl`. Transform engine tests + add the inversion guard.
2. fs-sync simple sites: wrap the 7 single-call sites in `withAuthRefresh`
   (+ a refresh-once test each, lightest-touch on the executor).
3. fs-sync download handler: implement Decision 5 (pre-stream +
   mid-stream refresh, dead-token redefinition) with reactive TDD.
4. Specs: sync the engine + fs-sync-service deltas; `openspec validate`.

No runtime data migration. Rollback = revert the branch (no schema /
persisted-state change). Order matters: the engine change (step 1) lands
the new surface the fs-sync steps depend on; within a single branch the
whole set ships together.

## Open Questions

(none — the stub's 4 open questions are resolved in Decisions 1-7.)
