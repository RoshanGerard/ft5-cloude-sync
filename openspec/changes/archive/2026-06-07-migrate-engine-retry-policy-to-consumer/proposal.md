# Proposal: Migrate engine retry policy (`withRefresh`) to fs-sync

## Why

The engine's `BaseDatasourceClient` bakes in a fixed retry policy: on
`auth-expired`, it refreshes credentials once and retries the operation
once (the private `withRefresh` wrapper). That policy is invisible to
fs-sync (a call that "succeeds" may have silently refreshed mid-flight),
unchangeable per call site, and forces the engine — a vendor-API
translation library — to own an orchestration concern that belongs to
its caller. This is the last piece of the engine-as-vendor-primitives
push (after `add-engine-rename-download` and
`migrate-upload-orchestration-out-of-engine`), and it **blocks**
`add-engine-listdirectory-pagination`, whose fs-sync auto-retry has to
coordinate with whoever owns retry (`tasks.md 0.1`).

## What Changes

- **BREAKING** — Remove the private `withRefresh` wrapper from
  `BaseDatasourceClient`. Every operation (`status`, `testConnection`,
  `listDirectory`, `search`, `getMetadata`, `getQuota`, `uploadFile`,
  `deleteFile`, `rename`, `downloadFile`) stops auto-refreshing; a
  normalized `auth-expired` `DatasourceError` now surfaces to the caller
  unchanged.
- **BREAKING** — Expose a public single-flight `refreshCredentials():
  Promise<AuthResult>` on `DatasourceClient<T>`. This is today's private
  `singleFlightRefresh` made public: it refreshes via the strategy's
  `refreshTokenImpl()`, persists via `CredentialStore.put` BEFORE the
  promise resolves, emits `token-refreshed` on success, and emits
  `token-expired` + `authentication-failed` on failure (the failure
  emission relocates out of `withRefresh`'s catch into this method).
- Ship `withAuthRefresh(client, op)` — an exported engine helper
  implementing the default one-shot refresh-then-retry policy: run `op`;
  on a normalized `auth-expired`, call `client.refreshCredentials()` and
  retry `op` once; a second `auth-expired` propagates. The policy is now
  explicit and replaceable rather than baked into the engine.
- Migrate all 8 fs-sync engine call sites to own their auth-expired
  retry. **7 take a one-line `withAuthRefresh` wrap** — `files:list`,
  `files:stat`, `files:search`, `files:remove`, `files:rename`,
  `files:upload`, and the `mirror-sync` executor's upload + delete calls.
  Each is a single engine call, so the helper reproduces today's
  engine-driven retry byte-for-byte.
- **Rework fs-sync's download handler** (`files:download`). Today it
  reads a bare `auth-expired` as "the engine already refreshed and it
  STILL failed → dead refresh token → `auth-revoked`." With `withRefresh`
  gone, a *first* `auth-expired` means no refresh has happened yet — so
  both the pre-stream and mid-stream catch points MUST explicitly
  `await client.refreshCredentials()` then re-issue the GET, and
  "dead token → `auth-revoked`" is redefined as `auth-expired` *again,
  after* a refresh. The existing environmental-retry layer
  (network / rate-limited / provider-error) is untouched and stays the
  outer layer; auth refresh is the inner one-shot.
- Token-cycle events (`token-refreshed` / `token-expired` /
  `authentication-failed`) are **preserved** — relocated into
  `refreshCredentials()`. The desktop EventBridge → renderer contract is
  unchanged. The sibling stub `migrate-engine-events-to-consumer` removes
  the engine bus entirely later; keeping the events here keeps each
  change single-purpose.

## Capabilities

### New Capabilities

(none — no new capability folder)

### Modified Capabilities

- `fs-datasource-engine`: remove engine-owned auto-retry (`withRefresh`);
  expose a public single-flight `refreshCredentials()`; export a
  `withAuthRefresh(client, op)` helper; operations surface `auth-expired`
  raw.
- `fs-sync-service`: fs-sync now owns the auth-expired refresh-and-retry
  — read / upload / rename / remove handlers + the mirror-sync executor
  via `withAuthRefresh`; the download handler via explicit
  `refreshCredentials()` at both catch points.

## Impact

**Code:**

- `packages/fs-datasource-engine/src/base-client.ts` — delete
  `withRefresh`; promote `singleFlightRefresh` to a public
  `refreshCredentials()` (carry the `token-expired` /
  `authentication-failed` emission into it); every public wrapper calls
  its `doXImpl` directly (read ops, `uploadFile`, `deleteFile`,
  `rename`, `downloadFile`, `status`, `testConnection`).
- `packages/fs-datasource-engine/src/with-auth-refresh.ts` (new) +
  `src/index.ts` — author and export the `withAuthRefresh` helper.
- `DatasourceClient<T>` interface (`base-client.ts`) — add
  `refreshCredentials(): Promise<AuthResult>`.
- `services/fs-sync/src/commands/{files-list,files-stat,files-search,files-remove,files-rename,files-upload}.ts`
  — wrap the engine call in `withAuthRefresh`.
- `services/fs-sync/src/executors/mirror-sync.ts` — wrap `uploadFile` /
  `deleteFile` in `withAuthRefresh`.
- `services/fs-sync/src/commands/files-download.ts` — explicit
  `refreshCredentials()` + retry at the pre-stream (~L1101-1108) and
  mid-stream (~L1204-1215) catch points; redefine the dead-token
  determination.
- `packages/fs-datasource-engine/src/base-client.test.ts` — transform
  the 6 `withRefresh` / single-flight tests (one-shot-retry +
  not-re-refreshed → `withAuthRefresh` tests; single-flight + persist +
  failure-events → `refreshCredentials()` tests); add the inversion
  guard (op surfaces `auth-expired` with no `refreshTokenImpl` call).

**APIs / Contracts:**

- `DatasourceClient<T>.refreshCredentials()` (engine) — ADDED (public).
- `withAuthRefresh(client, op)` (engine) — ADDED (exported helper).
- `BaseDatasourceClient.withRefresh` — REMOVED (was private; no public
  symbol change, but the observable behavior of every operation changes:
  `auth-expired` now surfaces raw instead of being silently refreshed).
- No fs-sync RPC wire-contract change: end-to-end behavior (a
  refreshable-but-stale token succeeds; a dead token surfaces
  `auth-revoked`) is preserved; only the layer that performs the refresh
  moves from the engine to fs-sync.

**Dependencies:** none new. `withAuthRefresh` is hand-rolled
(try / catch + a single retry) — no `p-retry` or similar.

**Sequencing / blocking:**

- Prerequisites `add-engine-rename-download` (merged 2026-04-29) and
  `migrate-upload-orchestration-out-of-engine` (merged 2026-05-06) are
  both in `master`. This is the "finish the job" step.
- Unblocks `add-engine-listdirectory-pagination` (`tasks.md 0.1`
  BLOCKING). Soft-coordinates with `migrate-engine-events-to-consumer`
  (the event seam above) and `migrate-engine-cache-invalidation`.

## Provenance

- Spawned during `add-engine-rename-download` brainstorming on
  2026-04-28 alongside the engine-as-vendor-primitives push.
- Promoted from stub on 2026-06-07; the stub's 4 open questions
  (migration sequence, refresh-primitive naming, the `withAuthRefresh`
  helper, behavior-change / event-timing risk) were resolved via
  `superpowers:brainstorming` — decisions recorded in `design.md`.
