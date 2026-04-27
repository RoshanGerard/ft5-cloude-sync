# Proposal: Migrate engine-side retry policy (`withRefresh`) to consumer

**Status**: Stub. Spawned during `add-engine-rename-download` brainstorming on 2026-04-28 alongside the broader engine-as-vendor-primitives push.

## Why

The engine today wraps every operation that might hit `auth-expired` with an internal `withRefresh` mechanism:

```
private async withRefresh<R>(op: () => Promise<R>): Promise<R> {
  try { return await op(); }
  catch (firstError) {
    if (normalized.tag !== "auth-expired") throw normalized;
    await this.singleFlightRefresh();   // refresh once
    return await op();                  // retry once
  }
}
```

This is a baked-in retry policy: **on auth-expired, refresh once, retry once.** Different consumers might reasonably want different policies:

- A test consumer might want zero retries (fail fast; the test is asserting the auth-expired path).
- A CLI sync tool might want N retries with backoff.
- The fs-sync service today wants exactly one retry (the existing default).
- A future "background fetch" consumer might want retry-with-jitter for politeness.

Encoding "exactly one retry" in the shared engine library forces that choice on every consumer. Worse, the policy is invisible to the consumer — calls that succeed silently might have done a refresh internally, making it harder to reason about cost / behavior.

## What this change does

1. Remove `withRefresh` from `BaseDatasourceClient`. Every `do*Impl` call returns / throws as the strategy produced.
2. Expose a public `refreshCredentials(): Promise<AuthResult>` method on `DatasourceClient<T>`. Idempotent, single-flight (the existing `singleFlightRefresh` guard moves into this public method). Persists via `CredentialStore.put`.
3. Each consumer wraps the engine call in its own retry logic. The fs-sync service's typical wrapper looks like:

```typescript
async function withAuthRefresh<R>(client: DatasourceClient<T>, op: () => Promise<R>): Promise<R> {
  try { return await op(); }
  catch (err) {
    const normalized = client.normalizeError(err);
    if (normalized.tag !== "auth-expired") throw normalized;
    await client.refreshCredentials();
    return await op();   // retry once — consumer choice
  }
}
```

The consumer can change the retry count, add backoff, log, instrument, etc., without touching the engine.

4. Migrate every existing call site that depends on `withRefresh`'s implicit retry to the explicit consumer-side wrapper.

## Out of scope

- Changing the credential persistence path. `CredentialStore.put` continues to be the post-refresh write contract.
- Changing what an `auth-expired` error means to consumers. The error taxonomy stays.
- Removing the `singleFlightRefresh` mutex; that's correctness machinery (concurrent callers should share one in-flight refresh), not policy. It survives but becomes the implementation of `refreshCredentials()`.

## Open questions (resolve during `/opsx:propose`)

1. **Migration sequence.** `add-engine-rename-download`'s download path already moves retry to the consumer (the service handler's loop). Upload's parallel migration in `migrate-upload-orchestration-out-of-engine` would also stop relying on `withRefresh`. After both, the only remaining `withRefresh` callers are read ops (list, search, getMetadata, getQuota), createFile, deleteFile, authenticate, status, testConnection, and the new rename. This change finishes the migration.

2. **Renaming.** With retry out, the public refresh primitive name should be clear. `refreshCredentials()` is one option; `refreshAccessToken()` is another (more specific). Recommend `refreshCredentials` since the persisted shape is `StoredCredentials`, which includes more than just an access token.

3. **Consumer-side helper.** Every consumer will write the same thin retry-once wrapper. Rather than duplicate, ship it as an exported utility from `@ft5/fs-datasource-engine` — `withAuthRefresh(client, op)` — that consumers can adopt or replace. Keeps the engine's API surface useful without forcing the policy.

4. **Behavior change risk.** Some current call sites might depend on `withRefresh`'s behavior in subtle ways (timing of `token-refreshed` event emission, ordering relative to other operations). Sweep test surface carefully during the migration.

## Acceptance criteria (once promoted)

- `BaseDatasourceClient.withRefresh` is removed. Every `do*Impl` call's success/failure is observable directly to the consumer.
- `refreshCredentials(): Promise<AuthResult>` is a public method on `DatasourceClient<T>`. Single-flight and credential-store-persistent.
- A `withAuthRefresh(client, op)` utility is exported from the engine package for consumer convenience.
- Every existing consumer call site wraps its operation in `withAuthRefresh` (or its own custom retry policy) where retry is desired.
- Engine tests for retry behavior move to consumer-side tests.

## Provenance

- Spawned during `add-engine-rename-download` brainstorming on 2026-04-28 when the user stated the engine-as-vendor-primitives principle and asked for follow-up stubs covering similar architectural concerns.
- Sequencing: depends on `add-engine-rename-download` and `migrate-upload-orchestration-out-of-engine` landing first; this change is the "finish the job" step.
