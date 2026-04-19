## Why

The renderer's datasources dashboard and the in-flight `ui-file-explorer` change both assume a backend that can actually talk to Google Drive, OneDrive, and S3 — but today the main-process IPC handlers return hard-coded fixtures. Every provider SDK call, credential refresh, error translation, and progress event has to live somewhere, and without a shared module it will either (a) get re-implemented per provider inside each IPC handler, or (b) leak into the renderer. This change introduces the shared, framework-agnostic FS Datasource Engine that every IPC handler calls into, so the whole app speaks one datasource vocabulary.

## What Changes

- Introduce a new workspace package `packages/fs-datasource-engine` that defines a generic `DatasourceClient<T>` strategy interface plus a `BaseDatasourceClient<T>` template that wraps every operation with event emission, error normalization, and single-flight token refresh.
- Ship concrete strategy implementations for `amazon-s3`, `onedrive`, and `google-drive` behind the common interface.
- Add a typed, discriminated-union event bus (`DatasourceEvent<T, K>`) whose streaming events are throttled to 1s-or-10%-progress, with terminal events flushed synchronously. Events bridge from main to renderer over a new one-way `datasources:event` IPC channel.
- Introduce `AuthIntent` — engine returns an intent object; the Electron host drives OAuth browser windows and credential prompts. Engine never imports `electron`.
- Add a `CredentialStore` port in the engine with a `SqliteCredentialStore` implementation in `apps/desktop` that encrypts credential blobs via Electron `safeStorage` and persists them in SQLite.
- Add a normalized `DatasourceError` class + 8-tag taxonomy (`auth-expired`, `auth-revoked`, `not-found`, `conflict`, `unsupported`, `rate-limited`, `network-error`, `provider-error`) in `packages/ipc-contracts`. Every strategy maps provider exceptions into this taxonomy.
- Add `Target`, `FileEntry<T>`, `FileMetadata<T>`, `PayloadMap`, and `Quota` types in `packages/ipc-contracts`. `Target` is a path/handle discriminated union; `FileEntry<T>` always carries both a user-visible path and a provider-native handle.
- Enforce `deleteDirectory` as unsupported across all providers as a product-stability safety rail — it throws `DatasourceError.Unsupported`. `getQuota` throws the same tag when the provider descriptor's `capabilities.quota === false`.
- Rewire `apps/desktop/src/main/ipc/files/*` handlers to call the engine instead of returning mocked fixtures, preserving the existing contract shapes owned by `ui-file-explorer`. This change is the "real provider-backed handlers" follow-up that `ui-file-explorer`'s design anticipated.
- Add an `engine-events` subscriber on the renderer side wired through `window.api.datasources.onEvent(cb)`, exposed via `contextBridge` in preload, conforming to the four-layer guardrail.

## Capabilities

### New Capabilities

- `fs-datasource-engine`: the shared main-process module's public contract — the strategy interface, the template's emission/refresh behaviour, the factory/registry wiring, the event-bus throttle semantics, the credential-store port contract, and the normalized error taxonomy.

### Modified Capabilities

- `datasources-ui`: requirement additions for the new `datasources:event` one-way IPC channel, the renderer-side event subscriber, and the real-handler path for collection operations (`list`, `add`, `remove`, `action`) that currently return fixtures. No existing scenario is removed — the fixture-backed behaviour described in the current spec is replaced by engine-backed behaviour behind the same IPC shape.

## Impact

- **New package.** `packages/fs-datasource-engine` — framework-agnostic. Depends on `packages/ipc-contracts` for types only. Added to the pnpm workspace.
- **New runtime dependencies** (to be justified in `design.md`): `@aws-sdk/client-s3`, `@microsoft/microsoft-graph-client`, `googleapis`, `better-sqlite3` (or the already-present SQLite driver if one is wired), plus small utilities for streaming (Node built-ins sufficient). `@aws-sdk/credential-providers` for S3 STS support if we later need it — NOT in this change.
- **Contract surface expands.** `packages/ipc-contracts` gains `DatasourceError`, `Target`, `FileEntry<T>`, `FileMetadata<T>`, `PayloadMap`, `DatasourceEvent<T, K>`, `AuthIntent`, `Quota`, and the `datasources:event` channel constant. All additive; no existing export changes shape.
- **IPC handlers.** `apps/desktop/src/main/ipc/files/*` handlers are rewritten from fixture to engine calls; their contract shapes are unchanged. `apps/desktop/src/main/ipc/datasources/*` collection handlers gain engine-backed implementations replacing their mocked fixture.
- **Preload surface.** `apps/desktop/src/preload/` gains a typed `onEvent` subscription for `datasources:event`, routed through `contextBridge`.
- **Renderer.** `ui-file-explorer`'s store and the dashboard's card components gain a subscription to `window.api.datasources.onEvent`; optimistic-UI paths reconcile with engine-emitted events.
- **SQLite schema.** One new table (`datasource_credentials`) holding `datasource_id`, encrypted blob, schema-version tag, created/updated timestamps. Migration shipped with this change.
- **Cross-change.** `ui-file-explorer` (proposed, 0/84 tasks) is a direct consumer — a note is added to its `design.md` identifying this change as the real-handler foundation. No contract conflict: the engine is called BY `files/*` IPC handlers, it does not replace their `ipc-contracts` types.
- **Security.** Credentials are never stored in plaintext and never cross the IPC boundary after the authenticate flow completes. `safeStorage` uses OS-level keying (Keychain / DPAPI / libsecret).
- **Testing.** Engine ships with an in-memory `FakeDatasourceClient` fixture used by contract tests so every concrete strategy can be verified against the same scenarios. Real-provider integration tests are out of scope for this change and will land per-provider in follow-ups.
