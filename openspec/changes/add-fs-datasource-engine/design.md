## Context

The `datasources-ui` change shipped a mocked main-process fixture behind the `window.api.datasources.*` IPC surface. The `ui-file-explorer` change (in proposal, 0/84 tasks) extends the same pattern with `window.api.files.*` and explicitly flags real-provider-backed handlers as a follow-up. Both depend on a backend module that can talk to real providers — Google Drive, OneDrive, S3 — uniformly enough that the renderer never learns about provider SDKs.

This change lands that module: `packages/fs-datasource-engine`. It is framework-agnostic (no Electron imports), strategy-based (one client per provider conforming to a common interface), and observer-bridged (events flow from the engine to the renderer over a one-way IPC channel). It is the backend that `ui-file-explorer`'s follow-up anticipates and the real-handler replacement for `datasources-ui`'s fixture.

The foundational decisions were made in an explore session before drafting; this document captures each decision plus the alternatives that were considered so future readers don't have to reconstruct the reasoning.

## Goals / Non-Goals

**Goals:**

- Single, framework-agnostic module that every main-process IPC handler calls into for provider file-system work. No provider SDK references outside `packages/fs-datasource-engine`.
- Strongly-typed, generic event stream that the renderer can narrow per provider without branching every call site.
- Event flow that is honest about real-time progress (continuous during uploads) without flooding IPC.
- Encrypted credential persistence that survives restart and never exposes plaintext outside the engine's load path.
- A single error vocabulary — the renderer / UI / telemetry all speak `DatasourceError` with one of 8 tags.
- Safe defaults: bulk-destructive operations (`deleteDirectory`) are unsupported until the product is stable; unsupported capabilities throw consistently rather than silently no-op.
- A contract surface (types in `packages/ipc-contracts`) extensible enough that adding a 4th provider requires exactly: one new descriptor entry, one new strategy class, and one new `PayloadMap` entry — no edits to the bus, factory, base class, or renderer.

**Non-Goals:**

- Renderer-originated `Blob` / web-stream input for `uploadFile`. Uploading IS in scope — `uploadFile` accepts a local filesystem path and streams from disk internally (see `fs-datasource-engine` spec, Requirement: *Upload takes a local file path and streams from disk*). What is deferred is accepting a renderer-side `Blob` or `ReadableStream` directly; that lands when a UI flow (drag-and-drop, web-clipboard paste) actually needs it.
- Proactive token refresh. Only reactive refresh (on `auth-expired` response) ships here. A timer-based pre-expiry refresher is a separate follow-up.
- Re-enabling `deleteDirectory`. The engine contract treats it as `Unsupported` for every provider as a product-stability safety rail.
- Background sync service / queued operations. The in-flight UI store awaits handlers directly; a background queue is a separate concern.
- Native integration tests against real provider accounts. Contract tests use a `FakeDatasourceClient` fixture that conforms to `DatasourceClient<T>`. Real-credential integration tests land per-provider in follow-ups.

## Decisions

### Decision 1 — Engine is a workspace package, not a main-process subfolder

The engine lives at `packages/fs-datasource-engine`, imported by `apps/desktop/src/main/ipc/*` handlers. It has no Electron imports, no renderer imports.

**Alternatives considered:**

- *`apps/desktop/src/main/datasources/`* — simpler to start, but couples the engine to Electron forever. Any attempt to reuse it in a non-Electron host (CLI, web, future services) is a refactor.
- *Private npm package* — premature. A workspace package gives the same separation with zero publishing overhead.

**Why this option won:** The separation forces a clean boundary — the engine can't reach for `safeStorage` or `ipcMain` because it can't see them. Tests run in pure Node. Future hosts supply their own implementations of the `CredentialStore` and `AuthHost` ports.

### Decision 2 — Pattern stack: Strategy + Template + Factory + Registry + Observer

The public contract is the `DatasourceClient<T>` interface (Strategy). The internal implementation is `abstract class BaseDatasourceClient<T>` (Template) that wraps every operation with (a) event emission before/after, (b) single-flight token refresh on `auth-expired`, and (c) `normalizeError` so raw provider exceptions never escape. Concrete clients (`S3Client`, `OneDriveClient`, `GoogleDriveClient`) extend the base and implement `protected abstract doX(...)` methods.

A `ProviderRegistry` (map of `providerId → Factory`) plus a `ClientFactory.create(providerId, credentials, ctx)` builds instances on demand. An `EventBus` exposes the engine's event stream to subscribers (IPC forwarder, telemetry, in-process callers).

**Alternatives considered:**

- *Strategy only, no Template.* Pure interface, each provider implements every method including emission boilerplate. Rejected: emission is cross-cutting; without the Template, each provider has to remember to emit `uploading`, `upload-failed`, `file-created` around every op. Drift is inevitable.
- *Registry without Factory.* A simple map from `providerId` to client class. Rejected: clients need credentials + host context (auth host, credential store, event bus) at construction — a factory is the natural place for that DI.

**Why this option won:** Strategy gives a clean public contract (consumers program to the interface). Template eliminates emission drift and centralizes retry/normalize. Factory + Registry decouples "how to look up a provider" from "how to construct a provider's client". Observer bridges the engine to whatever UI or log wants to listen.

### Decision 3 — Hybrid `Target` type (path + handle) at the public interface

All mutating and read-by-location operations accept `type Target = { kind: "path"; path: string } | { kind: "handle"; handle: string }`. `FileEntry<T>` always carries BOTH `path: string` and `handle: string`, so callers can use whichever is cheaper.

**Alternatives considered:**

- *Path-only.* Clean, matches `ui-file-explorer`'s design.md:99 rationale. Rejected at the engine level: Google Drive permits duplicate names in a single folder, so a path can resolve to multiple files. Path-only makes that ambiguity unresolvable from the engine's boundary.
- *Handle-only.* Honest about what Drive/OneDrive natively use. Rejected: the `ui-file-explorer` UI already committed to path-centric (breadcrumbs, back/forward, deep links). Making every caller maintain handle state is a heavy contract to push outward.

**Why this option won:** Paths as the default satisfies the UI's mental model; handles as an optional override rescue the ambiguity and perf cases. Each strategy internally maintains an LRU path↔handle cache; cache invalidation is event-driven (the strategy invalidates on rename/delete events it emits itself). The UI can stay path-only and never learn what a handle is.

### Decision 4 — Event schema is Flavour B (generic, provider-specific payloads)

Events are typed as `DatasourceEvent<T extends DatasourceType, K extends keyof PayloadMap[T]>` with `PayloadMap` keyed by provider → event-name → payload shape. Consumers narrow via `switch (e.datasourceType)` and then the `event` discriminant. The payload on a `file-created` event from S3 is `{ bucket, key, etag }`; from Drive it's `{ fileId, mimeType, parents[] }`.

**Alternatives considered:**

- *Flavour A — provider tag + normalized payload.* Simpler for consumers. Rejected: it throws away provider-specific metadata that power consumers (audit log, telemetry, advanced UI) genuinely need. Every event would have to be pre-normalized even when the consumer doesn't care about cross-provider uniformity.
- *Hybrid (normalized + `raw`).* Carry both a normalized projection and the provider-specific payload. Rejected in favour of purity per the explore session's call ("let's use generic whenever possible and complement SOLID and OOP concepts"). If a future UI wants a unified projection, it can build one adapter on top.

**Why this option won:** Generics give compile-time safety per provider; `PayloadMap` extension is the only schema edit required to add a new provider. Consumers that want uniformity build one narrowing helper; consumers that want provider specificity get it natively.

### Decision 5 — Streaming events throttled at 1 second OR 10% progress delta

High-frequency events (upload progress, large list pagination, long search scans) are tagged `streaming: true` and flow through a coalescing filter keyed by `(datasourceId, transactionId)`. The filter emits on whichever comes first: 1 second elapsed since last emission, OR a 10% change in progress. Terminal events (`completed`, `failed`) bypass the throttle and emit synchronously.

**Alternatives considered:**

- *1 second only.* Rejected: a 500 KB upload on fast link finishes before any progress tick renders. Users see a frozen-then-done UI.
- *10% only.* Rejected: a very slow upload at 0.5% per minute produces no UI feedback for two minutes.
- *Throttle in the renderer store.* Rejected: every consumer (telemetry, audit log, IPC forwarder) would have to duplicate the throttle or diverge on what "live" means.

**Why this option won:** Both axes matter — time for slow uploads, progress-delta for fast ones. Putting the throttle in the engine's bus means every subscriber sees the same coalesced stream, and non-Electron hosts inherit the correct behaviour for free.

### Decision 6 — Authentication via `AuthIntent`

`authenticate()` returns an `AuthIntent` discriminated union: `{ kind: "oauth"; authorizeUrl: string; completeWith(code: string): Promise<AuthResult> }` or `{ kind: "credentials-form"; schema: CredentialsSchema; submit(values: Record<string, unknown>): Promise<AuthResult> }`. The host (Electron main process) opens the browser window / renders the form / captures the callback, then calls the intent's completion method. Engine never imports `electron`, never calls `shell.openExternal`, never owns a `BrowserWindow`.

**Alternatives considered:**

- *Dependency-injected `AuthHost` port.* Engine takes an `AuthHost` interface at construction with methods like `openUrl`, `waitForCallback`. Rejected: leakier abstraction — engine has to know about "hosts" and "windows" even by name. The intent approach leaves all UX vocabulary outside the engine.

**Why this option won:** The engine stays pure (framework-agnostic) and testable (tests drive completion manually). Hosts other than Electron implement their own `AuthIntent` handling — same engine, different glue.

### Decision 7 — Single-flight token refresh in the Template

When any operation throws an error that `normalizeError` tags `auth-expired`, `BaseDatasourceClient` attempts a refresh and retries the operation once. Refresh is gated by a promise-keyed mutex keyed by `datasourceId`: if five operations hit `auth-expired` concurrently, exactly one refresh fires; the other four await the same promise. On success, new credentials are persisted via `CredentialStore.put` before the retry runs, then `token-refreshed` is emitted. On failure, `token-expired` + `authentication-failed` are emitted and the original operation throws `DatasourceError.AuthExpired`.

**Alternatives considered:**

- *Per-operation refresh (no mutex).* Rejected: an OAuth refresh storm can trigger provider rate-limits or, worse, token revocation on some providers that detect simultaneous refresh attempts.
- *Proactive refresh timer.* Rejected for this change (non-goal). Reactive is correct; proactive is a perf optimization that adds meaningful complexity (timer management, clock skew, partial-network recovery).

**Why this option won:** Reactive is sufficient for correctness; single-flight is the one detail that separates a robust implementation from an accidental DoS on the provider's token endpoint. Persisting before retry means a crash mid-retry doesn't lose the refreshed token.

### Decision 8 — Credentials live in SQLite, encrypted via `safeStorage`

`CredentialStore` is an abstract port on the engine with `get`, `put`, `delete` methods keyed by `datasourceId`. The Electron host provides `SqliteCredentialStore`: credentials are serialized, passed to `safeStorage.encryptString`, and stored as a `BLOB` in a new SQLite table `datasource_credentials (datasource_id TEXT PRIMARY KEY, encrypted_blob BLOB NOT NULL, schema_version INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER)`. Reads decrypt on the fly.

**Alternatives considered:**

- *SQLCipher (full-database encryption).* Requires a user-managed key or a derived-at-runtime key. Stronger at rest but more operational complexity (migration, key rotation, unlock UX).
- *OS keychain per credential (no SQLite).* Only workable on mac; Windows has no equivalent native store capacity for arbitrary blobs at scale. Portability issues.
- *Plaintext JSON on disk.* Rejected for security.

**Why this option won:** `safeStorage` delegates the hard part (key management) to the OS — Keychain on macOS, DPAPI on Windows, libsecret on Linux. Storing ciphertext in SQLite means all datasource state lives in one file the app already manages, and the schema-version tag allows future format rotations without breaking existing rows.

### Decision 9 — 8-tag error taxonomy in `packages/ipc-contracts`

`class DatasourceError<T extends DatasourceType = DatasourceType>` extends `Error` and carries `tag: DatasourceErrorTag`, `datasourceType: T`, `datasourceId: string`, `retryable: boolean`, `retryAfterMs?: number`, and `raw?: unknown`. Tags: `auth-expired | auth-revoked | not-found | conflict | unsupported | rate-limited | network-error | provider-error`.

**Alternatives considered:**

- *Per-provider error hierarchies.* Rejected: consumers (renderer store, toast UI, telemetry) should not learn three providers' error models.
- *Message-parsing.* Rejected: brittle; provider messages change; localization complicates matching.

**Why this option won:** One taxonomy means one set of consumer branches. `retryable` + `retryAfterMs` let the UI and the template's own retry logic act intelligently without parsing messages. `raw` preserves the original payload for power consumers (audit log).

### Decision 10 — `deleteDirectory` and `getQuota` throw `Unsupported` consistently

`deleteDirectory` throws `DatasourceError.Unsupported` for every provider in this change (product-stability safety rail). `getQuota` throws the same tag when the provider descriptor's `capabilities.quota === false` (i.e., Amazon S3). Consumers check the descriptor's capability flag before calling.

**Alternatives considered:**

- *Omit the method entirely from the interface when unsupported.* Rejected: loses capability discoverability; each consumer has to do `"deleteDirectory" in client` to check. Explicit throw is more honest.
- *Return `null` or `{ supported: false }`.* Rejected: inconsistent with the rest of the error model; consumers would need two kinds of "not here" handling.

**Why this option won:** One rule — unsupported = `Unsupported` throw. Consumers check descriptor capabilities before calling; tests verify the throw; behaviour is uniform across the entire surface.

## Risks / Trade-offs

- **Risk: safeStorage returns a fallback plaintext encryption on Linux when no desktop secrets service is available.** → Mitigation: `SqliteCredentialStore` calls `safeStorage.isEncryptionAvailable()` at startup; if false, it refuses to operate and emits a startup error telling the user to install `libsecret-1-0` or use a supported environment. No silent plaintext fallback.
- **Risk: Flavour B event types balloon the consumer surface — every new provider adds N event payloads.** → Mitigation: `PayloadMap` is the single schema-extension point; consumers that want uniform handling can write a small normalization adapter over it. Documented in the spec.
- **Risk: Single-flight refresh can deadlock if `refreshToken()` itself depends on another operation that in turn awaits the refresh.** → Mitigation: `refreshToken` is the one method that bypasses the mutex on itself (it is the mutex's critical section). The base class enforces this by accepting `refreshToken` as a primitive on concrete strategies that must not call back into the template.
- **Risk: Throttled progress can hide a stalled upload — no event emitted for seconds while bytes aren't advancing.** → Mitigation: Define a separate watchdog timer inside the base's upload wrapper: if no progress delta for N seconds (N = 30 initial), emit a `status-changed` event with `{ status: "stalled" }`. Watchdog details flagged as follow-up sharpening; initial ship uses plain 1s-or-10%.
- **Trade-off: Generics in event types require care with TypeScript 5+ — union distributivity over `K extends keyof PayloadMap[T]` can surprise.** → Mitigation: contract tests in `packages/ipc-contracts/src/__tests__/` cover every event/provider combination with `expectTypeOf`.
- **Trade-off: Encryption is at the OS keyring — full-disk forensics can still extract plaintext credentials if the attacker has the user's session.** → Accepted: consistent with desktop-app expectations; stronger protections (user-unlock passphrase, Hardware TPM) are separate product choices.
- **Risk: `ui-file-explorer` is in proposal but not applied — its IPC contract shapes might drift before this change lands.** → Mitigation: engine does not hard-depend on `ui-file-explorer`'s types; the IPC rewiring (Phase 9) is additive. If `ui-file-explorer` revises its contract, this change's Phase 9 adapts; earlier phases are unaffected.

## Impact / Dependencies

**Phase 6 adds three package dependencies to `packages/fs-datasource-engine`:**

- **`@aws-sdk/client-s3` (runtime)** — canonical AWS SDK v3 client for S3. Required for every `doXImpl` primitive in the S3 strategy (`ListObjectsV2`, `HeadObject`, `HeadBucket`, `PutObject`, `DeleteObject`). Choosing the official SDK is non-negotiable: any alternative (hand-rolled REST, third-party S3 clients) would reimplement request signing, retry middleware, and regional endpoint resolution, all of which the SDK does correctly by default.
- **`@aws-sdk/lib-storage` (runtime)** — the high-level `Upload` helper that coordinates multipart and single-part uploads with a unified `httpUploadProgress` event. Used by `doUploadFileImpl` to stream local files to S3 while emitting per-chunk progress ticks through the base class's `onProgress` callback. Reimplementing multipart coordination (CreateMultipartUpload → UploadPart → CompleteMultipartUpload with part-size tuning, concurrency, and error recovery) would duplicate a non-trivial piece of AWS infrastructure and is not justifiable.
- **`aws-sdk-client-mock` (dev)** — intercepts AWS SDK command dispatch at the middleware boundary so tests exercise the real SDK code paths (command serialization, middleware chain, pagination, error shapes) without real network calls or real credentials. The alternative — spinning up a localstack container or mocking at the HTTP layer — is heavier and pulls in a runtime that the engine package does not need. `aws-sdk-client-mock` is the community-standard test harness for AWS SDK v3 strategies.

**Phases 7 and 8** will add their own provider SDKs (`@microsoft/microsoft-graph-client` and `googleapis`) under the same rule: each runtime SDK dep carries a one-paragraph justification here before it lands.

**Phase 7 adds one package dependency to `packages/fs-datasource-engine`:**

- **`@microsoft/microsoft-graph-client` (runtime)** — Microsoft's official Graph JavaScript/Node SDK and the canonical way to talk to OneDrive from Node. Used by the OneDrive strategy's `doXImpl` primitives to issue the fluent `client.api(path).get() / .put() / .delete() / .post()` requests that back `listDirectory`, `getMetadata`, `createFile`, `deleteFile`, `search`, and `getQuota`. The client also drives the large-file resumable upload session handshake (`/createUploadSession`) whose `uploadUrl` is then PUT against directly with `globalThis.fetch`. Reimplementing the Graph request layer (auth-header injection, retry middleware, OData error shape parsing, per-endpoint response shapes) against raw `fetch` would duplicate a non-trivial piece of Microsoft's SDK surface and keep us on the hook for every Graph error-shape change. No dev-side mock package exists (unlike `aws-sdk-client-mock` for AWS); the strategy is tested via factory injection — tests supply a fake `Client`-shaped object exposing the `api(path)` fluent chain, and stub `globalThis.fetch` for the resumable-upload and token-refresh paths.

**Phase 8 adds one package dependency to `packages/fs-datasource-engine`:**

- **`googleapis` (runtime)** — Google's official Node SDK for Drive, Sheets, Docs, etc. Used by the Google Drive strategy for every Drive primitive (`files.list`, `files.get`, `files.create`, `files.delete`, `about.get`) that backs `listDirectory`, `getMetadata`, `createFile`, `uploadFile`, `deleteFile`, `search`, and `getQuota`. Alternatives (hand-rolled REST against `www.googleapis.com/drive/v3`, community SDKs) would reimplement OAuth / JWT token exchange, exponential-backoff middleware, resumable-upload session management, and TPC / proxy config — all correct-by-default in the official SDK. Like Microsoft Graph, there is no community-standard command-level mock (no `aws-sdk-client-mock` equivalent); the strategy is tested via factory injection — tests supply a fake object exposing the `drive.files.list / .get / .create / .delete` + `drive.about.get` shape the strategy calls. `globalThis.fetch` is stubbed separately for the OAuth token endpoint (`https://oauth2.googleapis.com/token`) and, when the SDK's resumable-upload abstraction is insufficient, for direct chunk PUTs to the resumable session URL returned by Drive.

## Migration Plan

This change is additive for the renderer (new event subscription surface, same call shapes) and replacement for the main-process handlers (fixture → engine-backed). Deployment happens within one app release.

1. Ship the engine package + all contract additions (Phases 1–8). No behaviour change yet — the package exists but nothing calls into it.
2. Rewire IPC handlers (Phase 9). Feature-flag a runtime toggle (`DATASOURCE_ENGINE_LIVE=1`) so a broken strategy can be reverted by a setting flip while the code is still in-tree.
3. Wire the event-bridge IPC (Phase 10). The renderer subscribes but tolerates zero events (the fixture path emits nothing).
4. Flip the flag on. Monitor the `datasources:event` stream for `authentication-failed`, `rate-limited`, and `network-error` events across providers.
5. Once stable across a release cycle, remove the fixture code path and retire the flag.

**Rollback:** toggle the feature flag off. Engine package stays installed but dormant; the old fixture handler code path takes over. No DB migration rollback required — the `datasource_credentials` table is additive and harmless if unused.

## Open Questions

- **RESOLVED (Phase 8) — Path ambiguity on Google Drive surfaces via `providerMetadata`.** Drive permits duplicate sibling names, so a `{kind: "path"}` `Target` can resolve to multiple fileIds. The strategy picks the OLDEST hit (`orderBy: "createdTime asc"`) as the bound entry and attaches `providerMetadata.ambiguous = true` + `providerMetadata.ambiguousSiblings: string[]` listing the other fileIds. This is NOT a `status-changed` event: events describe operation lifecycle, not result data, and late subscribers would miss event-carried ambiguity. Ambiguity belongs on the entry that is ambiguous, and the sibling fileIds remain reachable via handle-form `Target` — without them, the non-chosen siblings would be silent data loss. This keeps the "strategies do not emit events" invariant intact (the strategy subscribes to the bus for cache invalidation; it does not emit). Only `google-drive`'s `ProviderMetadataMap` entry carries these fields; S3 has no name ambiguity (unique-key semantics) and OneDrive's Graph API refuses duplicate names at creation time.
- **RESOLVED (Phase 8 — review fix) — Mutations on a path-form target with ambiguous resolution are REJECTED.** A read (`getMetadata`, `listDirectory`) on an ambiguous path returns the "oldest" entry with the ambiguity metadata — the caller can see that the path is ambiguous and has the sibling handles to disambiguate. A MUTATION (`deleteFile`, and future `moveFile` / in-place rewrites that address a single file by path) cannot safely default to "oldest wins": a caller working purely by path would delete a file with no signal that the path was ambiguous, and the siblings would silently remain. The strategy therefore rejects mutating ops on ambiguous path-form `Target`s with a `DatasourceError` tagged `"conflict"` (non-retryable), with `raw.ambiguousSiblings` carrying the full candidate fileId list. Handle-form targets bypass the guard — they explicitly name one fileId. Rationale: discoverability + data-loss prevention. Alternatives rejected: (1) "oldest wins silently" — the original behaviour, unsafe; (2) an out-of-band warning event — events are lifecycle, not result data, and late subscribers miss them. The decision scopes to `google-drive`; S3 and OneDrive have no analogous ambiguity.
- **RESOLVED (Phase 8 — review fix) — Cached entries preserve ambiguity metadata.** The Drive strategy's path↔fileId LRU cache previously stored only `fileId`; a cache hit on a previously-ambiguous path therefore returned a `FileEntry` with no `ambiguous` / `ambiguousSiblings` on `providerMetadata`. The cache value shape is now `{fileId, ambiguousSiblings?}`, so consumers rendering from a cache hit see the same ambiguity badge the initial walk produced. Bus-event invalidation still keys on path; handle-based eviction compares on the cached `fileId` field.
- **RESOLVED (Phase 8 — review fix) — Synthesized paths on search and handle-form listings are not re-addressable.** `search` and `listDirectory` by handle synthesize `path: "/<name>"` on each returned `FileEntry` for display purposes, because Drive responses lack engine-facing path context. Re-addressing such entries via `{kind: "path"}` is not guaranteed to reach the original file (and may return a different root-level file or `not-found`). Callers MUST re-address via `{kind: "handle", handle: entry.handle}`. The strategy documents this in the class header and at each synthesis site; the spec's "Hybrid Target" requirement carries a scenario making the rule explicit.
- **Concurrency across operations on the same datasource.** Should the engine serialize mutating operations (uploads, deletes) on the same `datasourceId` to avoid provider-side races (e.g., two renames of the same file)? Leaning toward per-datasource mutation queues inside the base class, but deferring until integration tests reveal real race scenarios.
- **Event replay for late subscribers.** If the renderer's `onEvent` subscriber registers after an upload has already started, should it see the `uploading` event retroactively? Leaning no (streaming is ephemeral; terminal `file-created` / `upload-failed` is authoritative), but flagging for review once the renderer store integration lands.
- **Upload cancellation.** The public interface does not expose `cancelUpload(transactionId)` yet. The renderer currently has no UX for cancel. Adding the method is cheap; exposing it across provider SDKs that handle cancellation inconsistently is not. Deferred until a UI flow needs it.
- **`authentication-failed` event payload semantics.** Does it carry the underlying `DatasourceError` or only a reason string? The normalized error is richer; the Flavour B payload typing already supports it. Leaning toward full error payload; will confirm during Phase 3 base-class tests.
