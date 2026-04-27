# Proposal: Migrate engine-side bus event emission to consumer-side IPC events

**Status**: Stub. Spawned during `add-engine-rename-download` brainstorming on 2026-04-28 alongside the broader push to keep the engine as a thin vendor-API translator.

## Why

The engine today owns an `EventBus` that emits structured events on every operation:

```
- file-created       (uploadFile success, createFile success)
- deleted             (deleteFile success)
- entry-renamed       (rename success — added in add-engine-rename-download)
- uploading           (streaming, during upload)
- upload-failed       (upload terminal failure)
- upload-cancelled    (upload terminal cancel)
- delete-failed       (deleteFile failure; also rename failure with
                       via: "rename")
- status-changed      (status / testConnection / failed read ops)
- rate-limited        (when normalized error tag is rate-limited)
- token-refreshed     (after singleFlightRefresh succeeds)
- token-expired       (refresh-token-itself-failed)
- authenticated       (authenticate completion)
- authentication-failed (authenticate or refresh failure)
```

These are **consumer-domain events** dressed up as engine concerns. The engine knows whether an SDK call succeeded; the consumer is what decides "this is the kind of success/failure my domain cares about, here's the event shape my consumers want."

When the engine ships these events:
- The engine has to model every event the consumer might want.
- Two consumers wanting different event shapes is impossible (one consumer is hardcoded).
- The engine carries domain-specific concerns into a shared library.
- Tests need to assert on engine bus emission, coupling test surface to engine internals.

`add-engine-rename-download` already moves download's events out (the service handler emits `downloading` / `file-downloaded` / `download-failed` / `download-cancelled` on the IPC stream, not on the engine bus). `migrate-upload-orchestration-out-of-engine` does the same for upload. After both, the engine bus carries only auth-cycle events: `token-refreshed`, `token-expired`, `authenticated`, `authentication-failed`.

Those auth-cycle events are also consumer-domain — the consumer is the one that wants to know "credentials were just refreshed; my UI should reflect that." This change finishes the job: remove the engine bus entirely; engine methods return values or throw normalized errors; consumers emit their own events on their own pub/sub mechanism (the service's IPC event stream for the sync service; `window.api.*` events for the desktop main).

## What this change does

1. Engine method semantics shift: every public method on `DatasourceClient<T>` returns a typed result or throws a typed `DatasourceError`. No bus side effects.
2. Cross-cutting hooks the engine needs (e.g., "the credential store should be updated after a successful refresh") become explicit return values or callbacks rather than bus events.
3. The engine's `EventBus` infrastructure is removed entirely.
4. Each consumer (fs-sync service, desktop main) wires its own observation pattern around engine method calls — typically a thin wrapper that runs the operation and emits domain events on success/failure.
5. Existing event subscribers migrate to subscribe at the consumer layer instead of the engine bus.

## Out of scope

- Changing wire-level event names or shapes. The renderer's view of events stays identical; only the internal source changes.
- Removing the credential store's `put` callback (the engine still needs to persist credentials post-refresh). That's a different abstraction (port) than the bus.
- Changing the strategy's `normalizeErrorImpl` or error taxonomy. Those are vendor-API translation concerns and stay in the engine.

## Open questions (resolve during `/opsx:propose`)

1. **Authentication flow.** `authenticate()` decorates the strategy's intent (`decorateIntent`) so credentials are persisted on completion + auth events emitted. The persistence side is genuine engine concern (the credential store is a port); the event side is consumer concern. Restructuring: engine returns the raw intent + a callback for "I just succeeded with this AuthResult"; consumer wraps that callback to persist + emit. Recommend: keep the credential persistence as part of the engine's contract via the `CredentialStore` port; remove ONLY the event emission.

2. **Status / testConnection.** The engine emits `status-changed` events for these reads. Without it, how does the consumer know the operation's outcome? Trivially: by the return value of the call. Status / testConnection both already return their result; the consumer can emit on receiving the return.

3. **rate-limited.** The engine emits `rate-limited` events when normalizing the error tag. Same answer: the consumer reads the thrown DatasourceError's tag and emits its own event if it cares.

4. **Migration sequencing.** This change can't land before `add-engine-rename-download` (which establishes the pattern for download) and `migrate-upload-orchestration-out-of-engine` (which does the same for upload). Both must be merged first; this change finishes the cleanup.

5. **Test surface impact.** Existing engine tests that assert on bus emission (~50+ test files) need migration. Strategy: a sweep PR that converts every "expect bus.emit('foo', …)" assertion to "expect the operation to return X / throw Y." Mechanical but voluminous.

## Acceptance criteria (once promoted)

- `EventBus` and its associated types are removed from `packages/fs-datasource-engine`.
- Every `DatasourceClient<T>` method returns a typed result or throws `DatasourceError`. No bus side effects in the engine.
- Each consumer owns its own event taxonomy (the fs-sync service's IPC event stream; the desktop main's `datasources:event` channel — any other consumer that arises in the future).
- Wire-level event names + shapes are unchanged from the renderer's perspective. UX is unaffected.
- `CredentialStore.put` continues to be called post-refresh by the engine (still a port, not a bus event).
- All engine tests pass without bus assertions.

## Provenance

- Spawned during `add-engine-rename-download` brainstorming on 2026-04-28 alongside `migrate-upload-orchestration-out-of-engine`. Both addressed by the user-stated principle "engine = vendor primitives; consumer = orchestration / events."
- Sequencing depends on the prior two changes landing first.
