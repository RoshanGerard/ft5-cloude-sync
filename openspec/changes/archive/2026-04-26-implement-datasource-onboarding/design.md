# Design: implement-datasource-onboarding

## Context

The fs-sync service shipped in `wire-fs-sync-service` (archived 2026-04-24) with two stubbed handlers — `sync:authenticate-start` and `sync:authenticate-complete` — that return `{ ok: false, error: { tag: "not-implemented", … } }`. Decision 11 of that change explicitly chartered this follow-up to replace them, after surfacing two architecture gaps too big to handle inline:

1. `factory.create(...)` requires real `StoredCredentials`; you cannot construct a client at all when no tokens exist yet.
2. OAuth app config (`clientId`, `clientSecret`, `redirectUri`) is read by `doAuthenticateImpl` at authenticate-time. There is no service-level source for that config.

Since then `add-drive-oauth-browser-consent` (archived 2026-04-25) shipped a working OAuth UI inside the desktop main process. That broker (`apps/desktop/src/main/oauth/consent-broker.ts`) hosts the loopback HTTP listener, runs `intent.completeWith(code)`, and writes through a `noopCredentialStore` declared in `apps/desktop/src/main/index.ts`. Credentials never reach the fs-sync service. Every PENDING_TC entry tagged `add-drive-oauth-browser-consent §12.x` and `add-invalid-datasource-state §13.x` is blocked on closing this gap.

The architectural framing we lock in this change — **service is the backend, desktop is the frontend, engine package is shared library** — was the explicit user direction during `/opsx:explore`. It applies Decision 1 of `wire-fs-sync-service` ("credential ownership lives on the service") to its full scope: not just credential storage but the whole authenticate flow, the OAuth loopback that exchanges codes for tokens, and the OAuth app config that identifies our application to providers. The follow-up change `move-datasource-registry-to-service` will complete the inversion by moving the datasource registry table itself; this change deliberately stops short of that to keep the proposal reviewable.

## Goals / Non-Goals

**Goals:**
- Replace the `not-implemented` stubs at `services/fs-sync/src/commands/authenticate-{start,complete}.ts` with handlers that drive a real engine `authenticate()` flow end-to-end.
- Move the OAuth loopback HTTP listener from `apps/desktop/src/main/oauth/consent-broker.ts` into the service. Desktop process retains only the responsibility it cannot delegate: `shell.openExternal` and dialog rendering.
- Source per-provider OAuth app config from a service-owned config file (`~/ft5/sync_app/config.json`) read at `sync:authenticate-start` time. New `sync:get-config` / `sync:set-config` wire commands expose it for a future settings UI.
- Add an explicit `factory.createForAuth(providerId, oauthAppConfig)` factory method on the engine. Eliminate the empty-token-blob hack the desktop broker currently uses.
- Migrate the renderer's authenticate request/response surface from `window.api.datasources.startConsent` / `cancelConsent` / `actions.add` to `window.api.sync.authenticateStart` / `authenticateComplete` / `authenticateCancel`. Migrate the renderer's authenticate event subscription from `datasources:event` (`consent-*`) to `sync:event` (`auth-*`).
- Make `getEngine().registry.add(...)` idempotent so the service-emitted `credential-persisted` event can be safely redelivered without wedging the desktop bridge.
- Remove the `not-implemented` variant from the `sync:authenticate-start` and `sync:authenticate-complete` command-error unions.
- Document per-provider OAuth app registration (GCP for Google Drive, Azure for OneDrive) in `README.md` and ship a committed `services/fs-sync/config.example.json` template.

**Non-Goals (deferred to `move-datasource-registry-to-service`):**
- Move the `datasources` SQLite table from the desktop DB to `sync.db`.
- Migrate `datasources:list` / `datasources:add` / `datasources:remove` / `datasources:action` IPC commands to the `sync:*` namespace.
- Reduce or remove the desktop `getEngine()` singleton.
- Switch the renderer's datasource-list subscription source from `datasources:event` to `sync:event`.

**Non-Goals (other deferrals):**
- Layer 2 (toast) and Layer 3 (dashboard banner) error notification surfaces for config issues. Layer 1 (inline copy in the existing oauth-form failure state) is the v1 affordance.
- An in-app settings UI that edits `~/ft5/sync_app/config.json` via `sync:set-config`. The wire commands exist for the future UI; this change does not consume them from the renderer.
- Auto-seeding the config file on first run, or shipping it as part of the installer. Manual `cp services/fs-sync/config.example.json ~/ft5/sync_app/config.json` is the documented setup.
- Encrypted-at-rest storage for OAuth app config or per-user credentials. Plaintext is the documented v1 deferred tradeoff.
- Migrating per-user credentials from `~/ft5/sync_app/credentials.json` to a SQLite table in `sync.db`. The store-implementation swap is a separable concern, scheduled as the follow-up change `migrate-credentials-to-sqlite`. In this change, `sync:delete-credentials` calls `ConfigFileCredentialStore.delete(...)` against the existing JSON file; the handler interface is store-agnostic so the eventual SQLite swap requires no IPC contract change. Pairs naturally with `move-datasource-registry-to-service` (registry + credentials both end up in `sync.db`, opening the door to transactional remove).

## Decisions

### Decision 1 — Architectural framing: service-as-backend, desktop-as-frontend, engine shared

**Context.** The desktop main process today instantiates an engine, owns the `DatasourceRegistry`, hosts the OAuth broker, and persists the in-memory event bus that feeds the renderer's datasource-event channel. The service runs a separate engine instance that reads the credential store but otherwise does not see authentication. Two engines in two processes is fine for runtime independence (Electron security, scheduler isolation) but makes credential ownership ambiguous.

**What.** This change locks in the framing **the service is the backend; the desktop is the frontend; the engine package is a shared library**. Concretely for this change:
- `engine.authenticate()` runs in the service process. The desktop process never calls it.
- The OAuth loopback HTTP listener runs in the service process.
- OAuth app config (`clientId`, `clientSecret`, `redirectUri`) is read by the service at authenticate-time.
- Per-user credentials (post-consent tokens) continue to live at `~/ft5/sync_app/credentials.json` via the existing `ConfigFileCredentialStore`.
- The desktop process retains: `shell.openExternal` (Electron-only API), the renderer (Chromium), the IPC supervisor (named-pipe transport to the service), and — for this change only — the `DatasourceRegistry` table.
- The engine package (`@ft5/fs-datasource-engine`) stays a shared library. Both processes import types; only the service constructs a live engine instance going forward.

**Why this over a desktop-side broker that writes through a service IPC.**
Considered: keep the broker in the desktop, add a `sync:persist-credentials({datasourceId, authResult})` command, broker calls it after `intent.completeWith(code)` resolves. That is a smaller delta — it leaves the freshly-merged broker module in place — but it permanently splits ownership: the desktop owns the loopback and the engine call; the service owns the credential file. Two processes can both call `engine.authenticate()` for the same `datasourceId` (because the desktop holds the loopback closure for the in-flight session, the service holds the persisted creds), and reasoning about which is canonical becomes a lifecycle problem. Locking "service runs the engine for everything authenticate-flavored" eliminates that branch.

**Why this over moving the registry too in this change.**
Considered: bundle the `DatasourceRegistry` migration into this change so the service owns datasource state end-to-end. Rejected on size grounds — the registry move touches the service DB schema, four `datasources:*` IPC commands, the sync event-bridge's error-healing path, and ~6 test files; bundling roughly doubles the change. The orphan-credentials window during the temporary state where credentials live on the service but the registry row still lives on desktop is a documented risk (Risks §1) with concrete mitigations. The follow-up change `move-datasource-registry-to-service` closes the window structurally.

### Decision 2 — Loopback HTTP listener: relocate from desktop to service

**Context.** The desktop broker today binds `127.0.0.1:0`, hosts a per-session HTTP server with a `/callback` route, and validates CSRF state before invoking `intent.completeWith(code)`. PKCE was wired in `add-drive-oauth-browser-consent`. Relocating this listener to the service is the largest single piece of code motion in this change.

**What.** A new module `services/fs-sync/src/oauth/loopback-broker.ts` ports the entire `consent-broker.ts` surface — same per-session map, same 5-minute timer, same CSRF state check, same idempotent `cancel()`, same dev-credentials override path — into the service process. Tests under `services/fs-sync/src/oauth/__tests__/` mirror the existing `apps/desktop/src/main/oauth/__tests__/consent-broker*.test.ts` suite (~12 test files). The desktop module is deleted; its tests are deleted.

The loopback now writes directly to the service's `ConfigFileCredentialStore` via the engine's `decorateIntent` pathway — no `noopCredentialStore`, no `addToRegistry` callback (the registry is on the desktop for now; see Decision 5 for the cross-process write).

**Why service-side and not desktop-side.**
The user's framing in Decision 1 is "the service is the backend." The loopback is the thing that actually exchanges the OAuth code for tokens and lands the result somewhere. If the desktop hosted the loopback, then either (a) the desktop would write credentials into a service-owned file (cross-process file writes; no good), or (b) the desktop would IPC-forward the AuthResult to the service for persistence (a workable shape, but it splits the engine.authenticate() call across processes — desktop holds the live `OAuthIntent` closure, service handles the persist side). Service-side loopback collapses both halves of the engine flow into one process; the closure lifecycle stays local to whoever returned it.

**Why not host the loopback in a third process or sandboxed worker.**
Considered: spawn a one-shot loopback worker per session, kill it after either `/callback` or timeout. Rejected — adds a process model the codebase does not use elsewhere, and the existing in-service `AuthCorrelationStore` already handles per-session lifecycle bookkeeping with `unref()`'d timers.

**Latency note.** A renderer-driven dialog status update now takes one extra IPC hop: `service event → desktop main bridge → renderer event channel`. The existing `add-drive-oauth-browser-consent` design.md has the same path for everything-not-the-loopback, so adding the loopback to it is uniform with existing event flow rather than a regression.

### Decision 3 — Renderer entry-point migration: `datasources.startConsent` → `sync.authenticateStart`

**Context.** `oauth-form.tsx` calls `window.api.datasources.startConsent({providerId, datasourceId?})` today. The non-OAuth forms (`aws-access-key-form.tsx`, `custom-form.tsx`) call `actions.add({providerId, credentials})` which goes through `datasources:add`. Both surfaces orphan credentials.

**What.** All three forms migrate to a unified surface:
- OAuth forms call `window.api.sync.authenticateStart({providerId, datasourceId?})`. The response carries `{correlationId, kind: "oauth"}` and triggers a service-side event sequence: `auth-initiated` → `oauth-open-url` (intercepted by the desktop bridge for `shell.openExternal`) → user consents → `auth-completed` (carries the new datasourceId).
- Credentials-form forms call `window.api.sync.authenticateStart({providerId, datasourceId?})`. The response carries `{correlationId, kind: "credentials-form", formSchema}`. The form renders fields per the schema, the user submits, the form calls `window.api.sync.authenticateComplete({correlationId, completion: {kind: "credentials-form", values}})`. The service's complete handler runs `intent.submit(values)`, persists, and emits `auth-completed`.
- Both forms call `window.api.sync.authenticateCancel({correlationId})` on dialog unmount or user cancel (parallel to the existing broker.cancel idempotency).

`useConsentSession` → `useAuthSession` (rename + retarget). Subscribes via `window.api.sync.onEvent` for the `auth-*` event family. Tests migrate.

**Why migrate the entry point even though the visible UX is unchanged.**
Decision 1 commits to the service-as-backend principle. Keeping `datasources.startConsent` on the desktop side as a permanent shape would require either (a) a permanent thin proxy that adds a hop with no value, or (b) two parallel surfaces (desktop-broker for OAuth, service-handler for credentials-form). Migrating the renderer once now means the follow-up change does not need to touch the renderer's authenticate code at all — only the registry-list subscription path.

**Why a single command surface for OAuth and credentials-form.**
The existing `AuthIntent` type already discriminates on `kind`. The wire `sync:authenticate-start` response polymorphises on the same `kind`. Using one command (versus two — `sync:authenticate-oauth-start` and `sync:authenticate-credentials-form-start`) keeps the existing `AuthCorrelationStore` "intent-kind-agnostic" comment honest. The renderer dispatches on `response.kind` to pick the right form-rendering branch.

### Decision 4 — OAuth app config sourcing: service-owned file, manual copy, no auto-seed

**Context.** Decision 11 of `wire-fs-sync-service` named the OAuth-app-config sourcing problem explicitly. Three branches exist: (3a) service has its own build-time injection; (3b) desktop forwards app config in the `authenticate-start` request; (3c) service reads from a config file. The desktop today uses build-time `__FT5_GOOGLE_OAUTH_CLIENT_ID__` / `_SECRET__` constants inlined by esbuild `define` (see `electron.vite.config.ts`).

**What.** Service-owned plaintext JSON file at `~/ft5/sync_app/config.json` (Unix) / `%USERPROFILE%/ft5/sync_app/config.json` (Windows):

```json
{
  "schemaVersion": 1,
  "providers": {
    "google-drive": {
      "clientId":     "<from GCP Console → APIs & Services → Credentials>",
      "clientSecret": "<from same place>"
    },
    "onedrive": {
      "clientId":     "<from Azure Portal → App registrations>",
      "clientSecret": "<from same place>"
    }
  }
}
```

The S3 entry is omitted by design — S3 is access-key auth, not OAuth, so no app registration is required.

A new `ServiceConfigStore` class lives at `services/fs-sync/src/config/service-config-store.ts`. It is constructed in `bootstrap.ts` (new stage between `construct-credential-store` and `construct-provider-registry`, or folded into `construct-credential-store`). Its `getOAuthAppConfig(providerId): OAuthAppConfig` method returns the per-provider entry or throws a typed `ServiceConfigMissingError` when (a) the file is absent OR (b) the requested provider entry has any empty string. The thrown error surfaces through `handleAuthenticateStart` as `{ ok: false, error: { tag: "service-config-missing", path, providerId } }`.

The repo ships a committed `services/fs-sync/config.example.json` template with empty values. README §Setup gains a section: "Copy `services/fs-sync/config.example.json` to your home directory at `ft5/sync_app/config.json`, then edit the `clientId` / `clientSecret` for each provider you intend to use. Get the values from the per-provider OAuth registration steps in §Provider OAuth registration."

**Why 3c (file) over 3a (build-time inject).**
The service is plain `tsc` output today — no esbuild `define` mechanism, no electron-vite build orchestration. Adding one to the service build solely to inline OAuth secrets is busywork. A file the user edits is the v1 minimum.

**Why 3c (file) over 3b (desktop forwards in request).**
3b leaks app config across the desktop ↔ service IPC every authenticate call. It also pins the desktop as the source-of-truth for app config, which contradicts Decision 1. The service-as-backend framing wants the service to be self-sufficient.

**Why no auto-seed (option 3b in the bootstrap-clarification round).**
Auto-seeding writes a templated empty file on first read. It saves the user one `cp` command in exchange for a side-effect at startup, a code path to test, and a chmod concern (the auto-seeded file must land at 0o600). The repo already uses the manual-copy pattern with `apps/desktop/.env.example` (per `add-drive-oauth-browser-consent` §1.3). Mirroring that pattern keeps the operational model uniform.

**Build-time inlining transition.** The desktop's `__FT5_GOOGLE_OAUTH_CLIENT_ID__` / `_SECRET__` build-time constants become unused for the running auth flow under this change — the broker that consumed them moves to the service, and the service reads its config file. We delete the constants from `electron.vite.config.ts` and the broker's options. CI continues to consume the GitHub Actions secrets per `add-drive-oauth-browser-consent §1.2` only if they are referenced by another consumer; if not, the secrets become unused-but-harmless and are removed in a follow-up cleanup.

### Decision 5 — Engine `factory.createForAuth(providerId, oauthAppConfig)`

**Context.** Decision 11 of `wire-fs-sync-service` enumerated this exact gap. `factory.create(providerId, datasourceId, credentials, ctx)` calls `readCredsFromStored(...)` per strategy, which throws on empty fields. Today's desktop broker dodges the rejection by passing a hand-built `StoredCredentials` blob with `accessToken: ""` and the OAuth app config tucked in `meta`. That works only because Drive's `doAuthenticateImpl` does not actually read the access token at authenticate-time. It is a fragile coincidence, not a designed contract.

**What.** A new factory method (one definition site, dispatched by `providerId` enum):

```ts
factory.createForAuth(
  providerId: ProviderId,
  oauthAppConfig: OAuthAppConfig | null,
  ctx: EngineContext,
): DatasourceClient<DatasourceType>
```

Where `OAuthAppConfig = { clientId: string; clientSecret: string; redirectUri: string }` for OAuth providers, and `null` for credentials-form providers (S3, custom). The method internally:
- For OAuth providers (`google-drive`, `onedrive`): constructs the strategy with the app config in a typed `PreAuthConfig` slot — NOT in the `StoredCredentials.meta` slot. The strategy reads it from the new slot at `doAuthenticateImpl` time.
- For credentials-form providers (`s3`, future `custom`): constructs the strategy with no creds. `doAuthenticateImpl` returns a `CredentialsFormIntent` whose `submit(values)` validates and persists.

Per-strategy work:
- `googledrive-client.ts` and `onedrive-client.ts` gain a constructor variant that accepts `PreAuthConfig` instead of `creds.authResult.meta`. The PKCE wiring from `add-drive-oauth-browser-consent` continues to live inside `doAuthenticateImpl`; only the source of `clientId`/`clientSecret`/`redirectUri` changes.
- `s3-client.ts` already supports no-creds construction (its `authenticate()` returns a `CredentialsFormIntent` from an empty StoredCredentials per `s3-client.test.ts:307-355`); only the factory dispatch entry needs adjustment.

**Why a separate factory method instead of overloading `create()`.**
`create()` has a strict shape — it represents "construct an authenticated client for an existing datasource." Overloading it to accept `null | StoredCredentials` weakens the type guarantee for all the call sites that expect the existing semantics. A separate `createForAuth` is explicit; its name documents its single use case.

**Why move app config out of `StoredCredentials.meta`.**
Today's desktop broker stuffs `clientId`/`clientSecret`/`redirectUri` into `meta` because `meta` is the only place the engine reads at authenticate-time. That conflates per-user state (`accessToken`, `refreshToken`) with vendor-side app registration (`clientId`, `clientSecret`). A typed `PreAuthConfig` slot fixes the conflation. Per-user state stays in `StoredCredentials`; app config stays in service config; the engine sees them as distinct inputs.

### Decision 6 — Browser-open mechanism: A1 (service emits event, desktop bridges to `shell.openExternal`)

**Context.** The service cannot call `shell.openExternal` — that API is Electron-main-only. After the loopback move (Decision 2), the service has the authorize URL but no way to launch a browser tab.

**What.** Service emits a new internal event `oauth-open-url` on its event stream with payload `{ correlationId, authorizeUrl }`. The desktop main's existing sync event-bridge (`apps/desktop/src/main/sync/event-bridge.ts`) gains a new subscription: on `oauth-open-url`, call `shell.openExternal(authorizeUrl)`. The renderer never sees the URL.

**Why event-driven (A1) over request/response carrying the URL (A2/A3).**
Considered A2: the `sync:authenticate-start` response includes `authorizeUrl`; the renderer calls a new `window.api.system.openExternal(url)` IPC. Rejected because (a) it leaks the authorize URL into the sandboxed renderer, (b) it adds a new general-purpose IPC `system:open-external` whose security review surface is broader than this change's scope (URL validation, allowlist policy), (c) it makes the renderer's authenticate-start behavior asymmetric — OAuth requires a client-side openExternal call, credentials-form does not.

Considered A3: desktop main intercepts the `sync:authenticate-start` response, opens the URL, returns a redacted version to the renderer. Rejected — the desktop main would need to inspect every sync command response to decide whether to intervene, breaking the IPC handler's identity-proxy property (proxies pass through unmodified per the `wire-fs-sync-service` task 5.A.14 invariants).

A1 keeps the renderer URL-blind, keeps the desktop main's `sync:*` proxy invariants, and routes the openExternal call through the existing event-bridge pattern that already handles four other event families.

### Decision 7 — Event taxonomy: `auth-*` names on the `sync:event` channel

**Context.** Today the renderer's `useConsentSession` hook subscribes via `window.api.datasources.onEvent` for the `consent-*` event family (`consent-started`, `consent-completed`, `consent-cancelled`, `consent-failed`, `consent-timeout`). The service emits its events on the `sync:event` channel via the existing event-bridge. After the loopback move, the authenticate flow's source-of-truth events come from the service.

**What.**

| Event | Channel | Producer | Consumer | Payload |
|---|---|---|---|---|
| `auth-initiated` | `sync:event` | service authenticate-start | renderer hook + dialog | `{ correlationId, providerId, datasourceId? }` |
| `auth-completed` | `sync:event` | service loopback / submit | renderer hook + dialog (closes), bridge → `registry.add` | `{ correlationId, datasourceId, summary: DatasourceSummary }` |
| `auth-cancelled` | `sync:event` | service authenticate-cancel | renderer hook (Retry surface) | `{ correlationId }` |
| `auth-failed` | `sync:event` | service loopback (state mismatch, completeWith reject) | renderer hook (failure copy) | `{ correlationId, tag, message? }` |
| `auth-timeout` | `sync:event` | service timer | renderer hook (timeout copy) | `{ correlationId }` |
| `oauth-open-url` | `sync:event` | service authenticate-start (oauth kind) | desktop bridge ONLY | `{ correlationId, authorizeUrl }` |
| `credential-persisted` | `sync:event` | service loopback / submit | desktop bridge ONLY | `{ correlationId, datasourceId, summary }` |

`auth-completed` and `credential-persisted` carry overlapping data. They are distinct events because their consumers are distinct: `auth-completed` is the user-facing terminal event the renderer consumes for UI updates; `credential-persisted` is the bridge-facing event the desktop main consumes for `registry.add`. Emitting them as a single event would conflate audiences. The bridge filters out the bridge-only events (`oauth-open-url`, `credential-persisted`) before fanning to the renderer.

`useConsentSession` → `useAuthSession`. Tests under `apps/desktop/src/renderer/src/features/datasources/__tests__/` migrate from `datasources.onEvent` mocks (consent-*) to `sync.onEvent` mocks (auth-*). Affected: `oauth-form.test.tsx`, `store-consent.test.tsx` (renamed `store-auth.test.tsx`), `card-auth-error-banner.test.tsx`, `card-invalid-datasource-banner.test.tsx`. Existing assertions on event shape change `event` from `consent-completed` to `auth-completed`, etc.

**Why rename `consent-*` → `auth-*`.**
"Consent" is the OAuth subset. With credentials-form authentication funnelling through the same surface (Decision 3), the broader name is more accurate. A grep for `consent-` in the renderer post-change should find zero hits in non-test code.

**Why migrate the channel, not just the names.**
The user's explicit direction was "desktop must depend on service for the consent process." The `datasources:event` channel is fed by the desktop's local engine bus; the `sync:event` channel is fed by the service event stream. Keeping authenticate events on `datasources:event` would require a translation step in the desktop main (subscribe to service events, re-emit on the desktop bus). That is real-but-disposable infrastructure — a translation layer that exists only until the registry move sweeps the renderer fully onto `sync:event`. Better to migrate the renderer once now.

**Addendum (§9 implementation):** For OAuth flows the `OAuthLoopbackBroker` (not the `sync:authenticate-start` handler) is the producer of BOTH `auth-initiated` and `oauth-open-url`. The handler delegates the whole OAuth lifecycle to the broker: bind loopback → resolve `OAuthAppConfig` via `ServiceConfigStore.getOAuthAppConfig` → emit `auth-initiated` → `factory.createForAuth(...)` → `client.authenticate()` → emit `oauth-open-url`. This satisfies two otherwise-incompatible spec scenarios simultaneously: "OAuth start: `auth-initiated` precedes `oauth-open-url` on the stream" AND "Service-config-missing on OAuth start: no event is emitted; no loopback server is bound." A handler-side emit of `auth-initiated` BEFORE `broker.start(...)` would violate the no-event invariant on the config-missing branch; emitting it AFTER would put `auth-initiated` after `oauth-open-url` on the stream. Broker-side emission post-config-validation is the only ordering that satisfies both. For credentials-form flows the handler emits `auth-initiated` itself (no broker is involved on that branch). The `Producer` column in the event-taxonomy table reads "service authenticate-start" loosely — it identifies the logical operation, not the source file.

**Dev-override timing note (§9 / FT5_DEV_CREDENTIALS):** When the broker takes the dev-override branch (env var set + `<dataDir>/dev-credentials.json` parses), it emits `credential-persisted` + `auth-completed` synchronously *inside* `broker.start(...)`. The §9 handler's response then resolves with `{kind: "oauth"}`. A renderer that subscribes to events on the **response's** correlationId could therefore miss the events. In production the renderer subscribes to the global event stream (no correlation-filter) on dialog mount — i.e. before the start request lands — so this is a non-issue in the current renderer wiring. If a future renderer rework changes the subscription pattern to per-response correlation, the dev-override path will need a microtask delay between `start()` resolving and the events firing.

### Decision 8 — Registry stays in desktop temporarily; idempotent `registry.add` triggered by `credential-persisted` event

**Context.** Decision 1 commits to "service is the backend," but the registry table itself migrates in the follow-up change. During the transition, credentials live on the service while the registry row lives on the desktop.

**What.** When `intent.completeWith(code)` (OAuth) or `intent.submit(values)` (credentials-form) resolves successfully on the service side:
1. Engine's `decorateIntent` writes the AuthResult through `ConfigFileCredentialStore.put(datasourceId, …)`.
2. Service constructs a `DatasourceSummary` (`id`, `displayName`, `providerId`, `status: "connected"`, `lastSyncAt: null`, `itemCount: 0`, `errorKind: null`) using the same shape the desktop broker constructs today.
3. Service emits `credential-persisted` with the summary.
4. Desktop sync event-bridge picks up the event and calls `getEngine().registry.add(summary)`. The call is **idempotent**: when a row with the same `id` already exists, `add` updates the columns (display name, status, etc.) instead of failing the insert.

`DatasourceRegistry.add` becomes idempotent via `INSERT ... ON CONFLICT(id) DO UPDATE SET ...`. This is a one-line change to the prepared statement plus a one-line change to the migration that owns the `id PRIMARY KEY` constraint (already there per the existing schema). Existing `add` callers expect insertion semantics; the new idempotency does not break them — duplicate-id callers today already see a SQLite `UNIQUE constraint` exception, which we can show is unreachable in production via grep.

**Why idempotent `add` instead of `addOrUpdate` as a separate method.**
A separate `addOrUpdate` would force callers to choose between "this is the first add" (insert-only) and "this is an event-redelivery" (insert-or-update). The bridge cannot reliably distinguish — it only knows the event arrived. Making `add` itself idempotent collapses the choice. The callers we keep (`apps/desktop/src/main/ipc/datasources/add.ts`) have id-collision-by-construction protection from `mintId` already; idempotency does not affect their behavior in practice.

**Why this is acceptable as a transition state.**
The follow-up change `move-datasource-registry-to-service` removes the cross-process write entirely — the service becomes both the credential store AND the registry, with no event-driven hop. The orphan-credentials window (Risks §1) is real but bounded: it requires the desktop to crash between the bridge receiving the event and the SQLite insert completing. Concrete mitigation lives in Risks §1.

### Decision 9 — Stub-tag removal: `not-implemented` exits the contract in this change

**Context.** Decision 11 of `wire-fs-sync-service` said the `not-implemented` variant on `sync:authenticate-{start,complete}` error unions "should be handled defensively as 'the service does not yet support this operation' rather than as a domain error" and that "the follow-up change removes that variant when the real implementation ships."

**What.** Both error unions lose `{ tag: "not-implemented"; message: string }` in this change. The renderer's authenticate code never had a defensive branch for it — the service simply never returned it because the desktop broker handled the auth flow itself. Post-change, the unions look like:

```ts
type SyncAuthenticateStartError =
  | { tag: "service-config-missing"; path: string; providerId: string }
  | { tag: "unknown-provider"; providerId: string }
  | { tag: "engine-error"; message: string }
  // … (continues with whatever the real handler can produce)

type SyncAuthenticateCompleteError =
  | { tag: "correlation-expired"; correlationId: string }
  | { tag: "intent-kind-mismatch"; expected, actual }
  | { tag: "engine-error"; message: string }
  // … (continues likewise)
```

`SyncAuthenticateCancelError` is added concurrently as a small union (`correlation-not-found` only — cancel is otherwise idempotent).

**Why remove rather than retain as a "soft" variant.**
The variant exists as a transitional contract slot. Once the real handler ships, retaining it is a permanent lie — the handler will never return it. Renderer / test code that checks for it would dead-code itself. Type-driven exhaustiveness elsewhere in the codebase (the `migrate-error-tag-literals-to-const-refs` change in flight) wants every variant of an error union to be reachable. Removing now keeps the typed surface honest.

### Decision 10 — Error notification: Layer 1 only (inline copy in oauth-form failure state)

**Context.** Three layers of error visibility were considered for `service-config-missing`: inline in the dialog (L1), global toast (L2), persistent dashboard banner (L3). L2 requires a `<Toaster />` mount that the renderer does not have today (per the `add-dialog.tsx:17` comment). L3 requires a service health-check command and a dashboard-level banner component.

**What.** L1 only. The existing `oauth-form.tsx` failure-state rendering already supports a `failed` status with a `message`. The new `service-config-missing` tag arriving through the `auth-failed` event surfaces the message:

> Service configuration missing. Add OAuth credentials to `<path>`. See README §Provider OAuth registration.

The credentials-form path (S3, custom) does not need this branch — credentials-form authentication does not consult the OAuth app config (no `clientId`/`clientSecret` is required; the user supplies the access key directly). `service-config-missing` is unreachable on that branch; tests assert the unreachability via the typed handler return.

**Why not L2 / L3 in this change.**
L2 + L3 each add infrastructure (toast mount, dashboard banner) that has scope beyond this change's "wire the authenticate flow" charter. They are filed as future follow-ups, not blockers.

**Visual specifics.** The error copy lives in `apps/desktop/src/renderer/src/features/datasources/credential-forms/oauth-form.tsx`. The path string is rendered inline as code (`<code>`) so the user can select-copy it. The README link is rendered as plain text (no anchor tag — the renderer is sandboxed with no off-domain navigation; documentation pointer is good enough). No new icon. No new color.

### Decision 11 — Visual direction (recap)

The visible UI surface in this change is small. Existing components are rewired without layout, color, or motion changes:
- `oauth-form.tsx` keeps its existing `flex flex-col gap-4` layout. Status copy strings change from `"Waiting for consent in your browser…"` → `"Waiting for authentication in your browser…"`. New copy for `service-config-missing` follows the existing `text-destructive text-sm` failure-state pattern.
- `aws-access-key-form.tsx` and `custom-form.tsx` keep their existing form layouts. The submit handler swaps from `actions.add(...)` to a two-step `sync.authenticateStart` + `sync.authenticateComplete` flow. No visual change.
- `add-dialog.tsx` adjusts its OAuth-completion sentinel handling (the form signals completion via `auth-completed` event observation, not via the existing `_oauthConsent: "completed"` sentinel). DialogTitle / DialogDescription strings change from "consent" wording to "authentication" wording.

Accessibility:
- `role="status"` and `aria-live="polite"` on the pending / cancelled / timeout copy is preserved.
- `role="alert"` on the failed copy is preserved.
- Error copy passes WCAG AA contrast at the existing `text-destructive` token (already covered in `add-drive-oauth-browser-consent` design.md §Visual direction).

No Visual Companion engagement was used for this change — the surface is all rewiring of existing components with no layout/color/motion decisions to explore. If implementation reveals an unexpected visual choice (e.g., the `service-config-missing` copy is too long for the existing dialog width), brainstorming engages at that point per the workflow.

## Risks / Trade-offs

**§1 — Orphan-credentials window during the registry-on-desktop transition.**

`auth-completed` event delivery → `getEngine().registry.add(summary)` is two IPC hops apart. Failure modes during this window:

| Failure | Effect | Mitigation in this change |
|---|---|---|
| Desktop crashes after service writes creds, before bridge receives event | Creds in `~/ft5/sync_app/credentials.json` for a `datasourceId` that has no row in the desktop registry. Dashboard shows nothing; service holds an orphan credential entry. | **None in this change.** Window is bounded by a sub-millisecond IPC round-trip under normal operation. Closed structurally by the follow-up `move-datasource-registry-to-service`: once the registry source-of-truth is the service, the desktop fetches it fresh on every startup via `sync:list-datasources`, automatically reconciling any stale state. |
| Bridge receives event, `registry.add` throws (DB write failure, FK constraint) | Same orphan as above. | Bridge logs a structured `bridge-registry-add-failed` line with `datasourceId`, `errorMessage`. Same structural close as above on the next service+desktop pairing once the follow-up ships. |
| User clicks "Remove" from the dashboard; `datasources:remove` succeeds locally; service-side `sync:delete-credentials` rejects | Row gone, creds linger in `~/ft5/sync_app/credentials.json`. Future re-add of the same provider with a freshly-minted `datasourceId` does NOT collide (ids are unique per add), so the leftover entry is harmless but accumulates. | The desktop's `datasources:remove` handler calls `await client.deleteCredentials({datasourceId})` after `registry.remove`. Failures log + return `{ok: true, deleted: false}` (best-effort). The follow-up `move-datasource-registry-to-service` collapses both deletion paths into a single service-side `sync:remove-datasource` that owns the transactional cleanup; the orphan-on-rejection scenario closes there. |

**Why no replay buffer.** A service-side replay buffer for `credential-persisted` events on next desktop reconnect was considered (~3 tasks: ring buffer + replay-on-connect protocol + ack handling). Rejected because the orphan window requires a desktop crash specifically between service-emit and bridge-add — sub-millisecond under normal conditions — AND the follow-up `move-datasource-registry-to-service` makes the entire orphan class disappear by inverting the source-of-truth. Building disposable infrastructure that the follow-up deletes was poor return on complexity.

Idempotent `registry.add` (Decision 8) plus the symmetric `sync:delete-credentials` deletion path (Decision 12 below) are the only mitigations in this change. The follow-up structurally closes the rest.

**§2 — Plaintext OAuth secrets on disk at `~/ft5/sync_app/config.json`.**

Same security profile as today's `apps/desktop/.env.local` build-time-inlined `__FT5_GOOGLE_OAUTH_CLIENT_ID__` / `_SECRET__` constants — both end up on disk as plaintext (the build inlines them into the bundled JS; the service config file holds them as a JSON property). File mode is 0o600 on Unix (mirrors `ConfigFileCredentialStore`'s widening check). Windows ACL is set by the installer.

This is a documented v1 deferred tradeoff. Mirrors `add-fs-sync-service` design.md D4 (plaintext per-user credentials). A future change can add OS-keychain-backed encryption for both files.

**§3 — Desktop process crash during the loopback HTTP request.**

The loopback HTTP server lives in the service. The desktop's role is just `shell.openExternal` and dialog rendering. If the desktop crashes after `oauth-open-url` is consumed (browser opened) but before `auth-completed` is received (consent finished), the service's loopback continues to listen, the user can complete consent, the service writes credentials AND adds the registry row on next desktop start (per the §1 replay buffer mitigation). No orphan in the most-likely crash path.

**§4 — Migration of test files.**

The renderer has ~6 test files that mock the `datasources.onEvent` channel for consent-* events. Each migrates to mocking `sync.onEvent` for auth-* events. This is mechanical but volume-heavy (~40 individual `consent-` → `auth-` renames). Subagents will diverge if they encounter this without guidance — `tasks.md` will explicitly call out the rename pattern and reference this Decision 7.

**§5 — `not-implemented` tag removal as a contract change.**

The `wire-fs-sync-service` design said callers "should handle defensively as a non-domain error." A grep confirms no caller in the renderer or desktop main does so. The contract change is type-only — TypeScript narrowing surfaces any missed call site at compile time. Risk: zero callers, zero runtime exposure.

## Test infrastructure

- `services/fs-sync/package.json` takes a `devDependencies` entry on `@aws-sdk/client-s3` (matching the engine's `^3.1032.0` pin) so the §14.4 integration test (`services/fs-sync/src/__tests__/authenticate-flow.integration.test.ts`) can `vi.mock("@aws-sdk/client-s3", ...)` to stub the S3 strategy's `HeadBucket` verification call. Without the dep on the test package, vitest in pnpm strict mode resolves the mock path differently from the engine's import path and the interception silently fails. No production import of `@aws-sdk/client-s3` exists from `services/fs-sync/src/` — the dep is test-only.

## Migration Plan

This change is internally complete (no rolling-deploy concern — the desktop and service ship together as one Electron installer). Implementation proceeds in TDD-disciplined phases per `tasks.md`:

1. **Engine first** (`createForAuth`, per-strategy adaptations) — pure library, no IPC.
2. **Contracts** — new commands, new events, new error tag, removed `not-implemented` variant.
3. **Service** — `ServiceConfigStore`, `OAuthLoopbackBroker` port, real authenticate handlers, `sync:authenticate-cancel`, `sync:get-config`/`sync:set-config`, replay buffer.
4. **Desktop main** — bridge subscriptions for `oauth-open-url` and `credential-persisted`, idempotent `registry.add`, deletion of `consent-broker.ts` and `noopCredentialStore`.
5. **Renderer** — form rewires, hook rename, test migrations.
6. **Repo + docs** — `config.example.json`, `README.md` per-provider OAuth registration section.
7. **Verification** — full test suite + typecheck + lint, plus a manual smoke-test of OAuth and credentials-form authentication against real GCP credentials (PENDING_TC §12.1 is unblocked at this point).

**Rollback.** If the change fails verification, revert is `git revert <merge>` — there are no DB schema migrations in `sync.db` (the registry stays in the desktop DB). The desktop's existing migration adds the idempotent `add` path via `INSERT ... ON CONFLICT(id) DO UPDATE` which is forward-compatible with the existing schema.

### Decision 12 — `sync:delete-credentials` is the symmetric counterpart to authenticate

**Context.** The authenticate flow writes to `ConfigFileCredentialStore`. The corresponding deletion path is needed when a user removes a datasource — otherwise `~/ft5/sync_app/credentials.json` accumulates leftover entries that the registry no longer references.

**What.** A new wire command `sync:delete-credentials({datasourceId})` whose handler invokes `ConfigFileCredentialStore.delete(datasourceId)` and responds with `{ok: true, result: {deleted: boolean}}` (where `deleted` is `true` when an entry existed and was removed). Failures log a structured warning but do NOT throw — best-effort cleanup. The desktop's `datasources:remove` IPC handler calls `await syncClient.deleteCredentials({datasourceId})` after `registry.remove` succeeds.

**Why ship in this change rather than defer.** Without it, every datasource removal leaks a credential entry. Even though leftover entries are harmless (the registry's freshly-minted `datasourceId` on re-add never collides), accumulating dead state is poor hygiene. The handler is small (~30 LOC) and store-agnostic — when the SQLite credential migration ships in `migrate-credentials-to-sqlite`, only the store implementation flips; the handler signature and IPC contract stay identical.

### Decision 13 — Open questions resolved

The four open questions raised during exploration are resolved as follows. Each links to the design section that captures the lock.

| Question | Resolution | Captured in |
|---|---|---|
| `sync:delete-credentials` shape | Ship in this change against `ConfigFileCredentialStore`. SQLite migration is a separable follow-up. | Decision 12 above; Goals/Non-Goals; tasks.md §13 + §20 |
| Replay buffer scope | Skip. Closed structurally by the follow-up registry move (desktop fetches registry from service on startup). | Risks §1 "Why no replay buffer" |
| `datasources:start-consent` / `cancel-consent` IPC fate | Delete entirely. No external callers; the renderer migrates fully to `sync.authenticateStart/Cancel`. | tasks.md §19 |
| Per-strategy `PreAuthConfig` slot location | Optional 4th constructor parameter `preAuth?: PreAuthConfig` on `GoogleDriveClient` / `OneDriveClient`. Read precedence at `doAuthenticateImpl()` time: `preAuth` if present (createForAuth path), else `creds.authResult.meta` (legacy meta path during transition; deletion of legacy path is a future cleanup). `S3Client` accepts the param for type uniformity, ignores it. | Decision 5; tasks.md §2 |

**OneDrive `tenantId` clarification (§2.5).** `OAuthAppConfig` deliberately omits `tenantId` — see the `onedrive` entry in the `config.example.json` shape under Decision 4 (lines 106-110), which carries `clientId` + `clientSecret` only. On the `preAuth` path the OneDrive strategy SHALL default `tenantId` to `"common"` (Microsoft's multi-tenant authority), matching the consumer-facing OneDrive scope this change targets. On the legacy `creds.authResult.meta` path the strategy continues to read `tenantId` from meta as before. Single-tenant deployments are out of scope for this change; if needed in the future, `tenantId` migrates to a separate per-deployment knob (e.g., a `tenantId` sibling field in `config.json`'s onedrive entry) rather than being reintroduced into `OAuthAppConfig`, which stays vendor-neutral.

No open questions remain. Implementation may proceed once the proposal is approved.
