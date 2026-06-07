# Spec delta: `fs-sync-service`

## ADDED Requirements

### Requirement: `files:list` plumbs `cursor` and `pageSize` through to the engine

The `files:list` command request SHALL accept optional `cursor: string` and `pageSize: number` fields in addition to `datasourceId` and `path`. The handler SHALL forward both to `client.listDirectory(target, { cursor, pageSize })`. The response envelope SHALL include `nextCursor: string | null` populated from the engine's return value. The `truncated: boolean` field on the response envelope SHALL be derived as `nextCursor !== null` and SHALL NOT be hard-coded.

The `cursor` and `pageSize` fields SHALL be optional on the request — a request omitting them SHALL be equivalent to `{ cursor: undefined, pageSize: undefined }` and the engine SHALL apply per-provider defaults (per `fs-datasource-engine` requirement "`listDirectory` exposes opaque-cursor pagination").

#### Scenario: First-page request omits cursor and pageSize

- **WHEN** a unit test dispatches `{ command: "files:list", datasourceId, path }` (no `cursor`, no `pageSize`) against a handler whose `resolveClient` returns a mock strategy whose `listDirectory` resolves to `{ entries: [<10 entries>], nextCursor: "tokA" }`
- **THEN** the handler's call to `client.listDirectory` carries an options object whose `cursor` and `pageSize` are both `undefined`; the response is `{ ok: true, value: { entries: <mapped 10>, truncated: true, nextCursor: "tokA" } }`

#### Scenario: Next-page request forwards cursor and pageSize

- **WHEN** a unit test dispatches `{ command: "files:list", datasourceId, path, cursor: "tokA", pageSize: 500 }` against the same mock strategy whose `listDirectory` resolves to `{ entries: [<5 entries>], nextCursor: null }`
- **THEN** the handler's call to `client.listDirectory` carries `{ cursor: "tokA", pageSize: 500 }`; the response is `{ ok: true, value: { entries: <mapped 5>, truncated: false, nextCursor: null } }`

### Requirement: `files:list` auto-retries paged failures with a fixed back-off schedule

The `files:list` handler SHALL wrap its call to `client.listDirectory` in a back-off retry loop. On rejection with `tag` ∈ `{ "network-error", "rate-limited", "provider-error" }` AND `retryable === true`, the handler SHALL re-attempt up to **3 additional times** (4 total attempts), waiting **2 seconds before attempt 2, 5 seconds before attempt 3, and 7 seconds before attempt 4**. A rejection with `retryable === false` (e.g. a deterministic client-side malformed-cursor `provider-error`) SHALL surface immediately, never consuming the retry budget.

For `tag: "rate-limited"` rejections that carry `retryAfterMs`, the handler SHALL use `max(retryAfterMs, scheduledBackoff)` as the wait for that attempt.

After exhaustion (the final attempt also rejects), the handler SHALL return the last attempt's normalized error envelope unchanged. The original request's `cursor` SHALL be preserved on the renderer side (separately tracked) so the user-visible Retry button can re-issue with the same cursor.

For `tag` values not in the retry set (`auth-expired` is handled by the inner `withAuthRefresh` wrap BEFORE the env-retry loop — per `migrate-engine-retry-policy-to-consumer` — so a post-refresh `auth-expired` reaching the loop is terminal; `auth-revoked`, `cancelled`, `invalid-datasource`, `unsupported`, `other`, `conflict`, `exhausted-retries` are all terminal at the handler layer), the handler SHALL return the first failure envelope without retry.

#### Scenario: Transient network failure retries up to 4 attempts

- **WHEN** a unit test wires `client.listDirectory` to reject with `tag: "network-error"` on attempts 1-3 and resolve to `{ entries: [<3>], nextCursor: null }` on attempt 4, with fake timers advancing 2s / 5s / 7s between attempts
- **THEN** the handler's response is `{ ok: true, value: { entries: <mapped 3>, truncated: false, nextCursor: null } }`; `client.listDirectory` was invoked exactly 4 times; the cumulative fake-timer advancement was 14 seconds

#### Scenario: Exhausted retries surface the last error

- **WHEN** a unit test wires `client.listDirectory` to reject with `tag: "network-error"` on all 4 attempts
- **THEN** the handler's response is `{ ok: false, error: { tag: "disconnected", message, retryable: true } }` (the handler's `catch` runs `normalizeFilesError`, which collapses the engine `network-error` tag to the wire `disconnected` tag); `client.listDirectory` was invoked exactly 4 times; no `exhausted-retries` tag is introduced

#### Scenario: Rate-limited honors `retryAfterMs` when greater than scheduled back-off

- **WHEN** a unit test wires `client.listDirectory` to reject with `{ tag: "rate-limited", retryAfterMs: 8000 }` on attempt 1 and resolve on attempt 2, with fake timers
- **THEN** the handler waits 8000 ms (not 2000 ms) before attempt 2; total fake-timer advancement is 8 seconds

#### Scenario: Non-retryable tag returns immediately

- **WHEN** a unit test wires `client.listDirectory` to reject with `tag: "auth-revoked"` on attempt 1
- **THEN** the handler's response is `{ ok: false, error: { tag: "auth-revoked", ... } }`; `client.listDirectory` was invoked exactly once; no back-off occurred

#### Scenario: Non-retryable `provider-error` (malformed cursor) returns immediately

- **WHEN** a unit test wires `client.listDirectory` to reject with `{ tag: "provider-error", retryable: false }` on attempt 1 (e.g. OneDrive's deterministic malformed-cursor guard, which fails before any network call)
- **THEN** the handler's response is `{ ok: false, error: { tag: "other", ... } }` (engine `provider-error` collapsed by `normalizeFilesError`); `client.listDirectory` was invoked exactly once; no back-off occurred — even though `provider-error` is in the retry-tag set, `retryable: false` short-circuits the loop
