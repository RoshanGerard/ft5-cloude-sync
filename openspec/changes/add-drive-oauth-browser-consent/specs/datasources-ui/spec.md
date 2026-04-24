## MODIFIED Requirements

### Requirement: Add-datasource flow uses a provider-agnostic step sequence

The add-datasource dialog SHALL present a two-step flow: step 1 is a provider picker listing every entry in the `providers` registry with its display name and icon; step 2 is a credential form selected by the chosen provider's `credentialsSchema`.

Submission branches on `credentialsSchema`:
- For `credentialsSchema === "oauth"`, the form SHALL call `window.api.datasources.startConsent({ providerId })`, render in-dialog status copy conveying that the system browser has opened, subscribe to `consent-*` events scoped to the returned `sessionId`, and transition to the dialog-close state when `consent-completed` fires. On `consent-cancelled` or `consent-timeout` the form SHALL surface an inline message (`role="status"`, `aria-live="polite"`) and a Retry control that restarts `startConsent`. The form SHALL NOT call `window.api.datasources.add` for OAuth providers.
- For non-OAuth schemas (`aws-access-key`, `custom`), the form SHALL continue to call `window.api.datasources.add({ providerId, credentials })` unchanged.

Adding a new provider type to the system SHALL require exactly (a) adding a `ProviderDescriptor` entry to the frozen `providers` registry in `packages/ipc-contracts/`, and (b) if `credentialsSchema` is a value not already supported, adding one new credential-form component under `features/datasources/credential-forms/`. No changes to the dashboard, card, dialog shell, or store SHALL be required.

#### Scenario: Provider picker lists exactly the registered providers

- **WHEN** the add-datasource dialog opens
- **THEN** step 1 renders one selectable option per entry in the `providers` registry — in this change, exactly `google-drive`, `onedrive`, and `amazon-s3` — each with its display name and icon, and no hard-coded provider branches in the dialog component

#### Scenario: Credential step is picked from the descriptor, not the provider id

- **WHEN** the user selects a provider whose `credentialsSchema === "oauth"`
- **THEN** the OAuth credential form component is rendered; swapping the descriptor's `credentialsSchema` to `"aws-access-key"` SHALL cause the access-key form to be rendered instead, without any change to the dialog's code

#### Scenario: OAuth form calls startConsent, not add

- **WHEN** the user clicks "Connect Google Drive" in the OAuth form
- **THEN** the form invokes `window.api.datasources.startConsent({ providerId: "google-drive" })` exactly once, does NOT invoke `window.api.datasources.add`, displays `role="status"` copy such as "Opening browser — complete consent and return here", and awaits consent events scoped to the returned `sessionId`

#### Scenario: OAuth form transitions to done on consent-completed

- **WHEN** a `consent-completed` event arrives with a matching `sessionId`
- **THEN** the dialog closes, the dashboard refreshes and renders a new `DatasourceCard` for the newly live datasource, and focus returns to the add-datasource trigger in the dashboard toolbar

#### Scenario: OAuth form surfaces cancel and timeout inline

- **WHEN** a `consent-cancelled` or `consent-timeout` event arrives with a matching `sessionId`
- **THEN** the dialog stays open, the inline status region announces "Consent cancelled — you can try again" or "Consent timed out — please try again" (polite live region), and a Retry control is rendered that re-invokes `startConsent` with the same `providerId` when activated

#### Scenario: Non-OAuth submission is unchanged

- **WHEN** the user submits the S3 access-key form with valid credentials
- **THEN** the form invokes `window.api.datasources.add({ providerId: "amazon-s3", credentials })` exactly once, the dialog closes on resolution, and a new `DatasourceCard` appends to the dashboard — the flow matches the behavior specified for non-OAuth providers prior to this change

#### Scenario: Successful add (non-OAuth) appends a card to the dashboard

- **WHEN** the credential form submits and `window.api.datasources.add(...)` resolves with a `DatasourceSummary`
- **THEN** the dialog closes, the dashboard renders a new `DatasourceCard` for the returned summary in the populated state, and focus returns to the add-datasource trigger in the dashboard toolbar

#### Scenario: Extensibility is enforceable, not just documented

- **WHEN** a hypothetical fourth provider is added to the registry in a test fixture with a new `credentialsSchema`
- **THEN** a Vitest test SHALL render the dialog, select the new provider, and assert that the matching credential form component mounts — failing if the dialog contains provider-id branching

### Requirement: Datasource IPC surface is the single data path

All datasource reads and mutations from the renderer SHALL go through the `window.api.datasources.*` surface. The renderer SHALL NOT import any provider SDK, any `fs`/`child_process`/`electron`/`drizzle-orm` specifier, or any module under `apps/desktop/src/main/` or `apps/desktop/src/preload/`. The main-process handlers route all list/add/remove/action requests through the persistent `DatasourceRegistry`; there is no feature-flagged "engine-backed vs fixture" dichotomy — the registry is the single source of truth. Long-running sync and upload work is owned by the `fs-sync-service` (see its capability), not by the in-process engine.

The surface SHALL expose: `list()`, `add(req)`, `remove(req)`, `action(req)` (unified pause / resume / sync-now), `upload(req)`, `startConsent(req)`, `cancelConsent(req)`, and `onEvent(cb)`. Each call SHALL have a typed request/response (or callback) pair in `packages/ipc-contracts/src/datasources.ts`. Each call SHALL have an `ipcMain.handle` or event-forwarder implementation under `apps/desktop/src/main/ipc/datasources/`. Each call SHALL be bound in the preload via `contextBridge.exposeInMainWorld`.

The `DatasourceEvent` discriminated union SHALL carry — in addition to any previously specified variants — the consent events `consent-started`, `consent-completed`, `consent-cancelled`, `consent-failed`, and `consent-timeout`. Each consent event SHALL carry a `sessionId: string`. `consent-started` and `consent-completed` SHALL carry a `datasourceId` (required on `consent-completed`, optional on `consent-started` for the re-consent case where the id pre-exists). `consent-failed` SHALL carry a `tag` (one of the engine's 8-tag values, typically `auth-revoked` for state mismatch or `provider-error` for token-endpoint failures) and an optional human `message`.

#### Scenario: Renderer has no direct SDK import

- **WHEN** `pnpm lint` runs
- **THEN** ESLint reports an error for any file under `apps/desktop/src/renderer/` that imports from `googleapis`, `@microsoft/microsoft-graph-client`, `@aws-sdk/client-s3`, or any other provider SDK package; a dedicated CI grep step SHALL back the ESLint rule

#### Scenario: Four-layer wiring per IPC method

- **WHEN** a new datasources IPC method is added
- **THEN** the build SHALL require all four layers (contract type, main handler, preload exposure, renderer call site) to be present; missing any one SHALL cause a TypeScript error or a failing contract test in `packages/ipc-contracts/src/__tests__/datasources.test-d.ts`

#### Scenario: onEvent is bound in preload and typed at the consumer

- **WHEN** a renderer module imports `window.api.datasources.onEvent` and passes a callback typed as `(e: DatasourceEvent) => void`
- **THEN** the call site compiles under `strict` mode, the returned value is a function `() => void`, and invoking the returned function unsubscribes the callback from further deliveries

#### Scenario: startConsent is a first-class IPC method

- **WHEN** a type test imports `DatasourcesStartConsentRequest` and `DatasourcesStartConsentResponse` from `@ft5/ipc-contracts`
- **THEN** the request type is exactly `{ providerId: string; datasourceId?: string }`, the response type is exactly `{ sessionId: string }`, the preload exposes `startConsent` as a function of that shape, and a call site in the renderer compiles under strict mode

#### Scenario: cancelConsent is a first-class IPC method

- **WHEN** a type test imports `DatasourcesCancelConsentRequest` and `DatasourcesCancelConsentResponse` from `@ft5/ipc-contracts`
- **THEN** the request type is exactly `{ sessionId: string }`, the response type is exactly `void`, the preload exposes `cancelConsent` as a function of that shape, and a call site in the renderer compiles under strict mode

#### Scenario: Consent events flow through the existing onEvent stream

- **WHEN** a renderer callback registered with `onEvent` runs during a consent session
- **THEN** the callback receives `{ event: "consent-started", sessionId }` at session start, exactly one of `{ event: "consent-completed", sessionId, datasourceId }` / `{ event: "consent-cancelled", sessionId }` / `{ event: "consent-failed", sessionId, tag, message? }` / `{ event: "consent-timeout", sessionId }` at session end, and nothing else for that `sessionId` thereafter

## ADDED Requirements

### Requirement: Main-process consent broker hosts a loopback HTTP listener per session

The main process SHALL own an `OAuthConsentBroker` module under `apps/desktop/src/main/oauth/`. The broker SHALL expose at least `start({providerId, datasourceId?})` and `cancel({sessionId})` methods consumed by the `startConsent` and `cancelConsent` IPC handlers.

`broker.start(...)` SHALL: (1) generate a random `sessionId` (32 bytes base64url), a CSRF `state` (32 bytes base64url), and a PKCE `code_verifier` (48 bytes base64url yielding 64 characters); (2) create an HTTP server via `http.createServer()` and bind it to `127.0.0.1` on port `0`, letting the OS pick the port; (3) compute the redirect URI as `http://127.0.0.1:<port>/callback`; (4) construct a pre-auth `StoredCredentials` blob whose `authResult.meta` carries the build-time `clientId` and `clientSecret` and the dynamically-computed `redirectUri`; (5) instantiate a `GoogleDriveClient` via the engine's factory and call `client.authenticate()` to obtain the `OAuthIntent`; (6) pass the PKCE `code_challenge` and `state` into the intent's authorize-URL construction (engine-side per the `fs-datasource-engine` delta); (7) call `shell.openExternal(authorizeUrl)`; (8) store a pending-session record in an in-memory `Map<sessionId, PendingSession>`; (9) return `{sessionId}` to the IPC handler, which emits `consent-started` on the datasource event stream.

The loopback HTTP handler SHALL accept exactly one request at `GET /callback` per pending session. On match it SHALL: (a) verify `state` against the pending-session record's `state` (strict equality; reject otherwise with `consent-failed` carrying `tag: "auth-revoked"`); (b) respond `200 OK` with a minimal HTML page reading "You can close this tab and return to the app"; (c) invoke the intent's `completeWith(code)` (engine-side threads the verifier into the token exchange); (d) on resolution, persist the live `DatasourceSummary` into the registry and emit `consent-completed`; on rejection, emit `consent-failed`; (e) close the HTTP server, clear the 5-minute timer, delete the pending-session record.

`broker.cancel({sessionId})` SHALL close the HTTP server for that session, clear the timer, delete the pending-session record, and emit `consent-cancelled`. The method is idempotent — cancelling a session that is already terminated SHALL be a no-op.

#### Scenario: Loopback binding returns an ephemeral port

- **WHEN** a unit test calls `broker.start({providerId: "google-drive"})` in a fixture where `shell.openExternal` is stubbed
- **THEN** the pending-session record carries a port in the range 1024–65535, the loopback HTTP listener is actually listening on `127.0.0.1:<port>` (as verified by a subsequent HTTP request from the same test), and the authorize URL's `redirect_uri` parameter decodes to `http://127.0.0.1:<port>/callback`

#### Scenario: State mismatch rejects the callback

- **WHEN** a test simulates a GET to `/callback?code=fake-code&state=ATTACKER_STATE` against an active session whose stored `state` is `LEGITIMATE_STATE`
- **THEN** the handler does NOT invoke `completeWith`, the HTTP response is a 400-class status with an error message, the next event on the event stream is `consent-failed` with `tag: "auth-revoked"`, and the pending session is cleared

#### Scenario: Valid callback invokes completeWith and emits consent-completed

- **WHEN** a test simulates a GET to `/callback?code=valid-code&state=<correct-state>` and the engine's mock token endpoint returns tokens
- **THEN** `completeWith("valid-code")` is invoked exactly once, the engine's `decorateIntent` persists the `AuthResult` via `CredentialStore.put`, a new row is present in the `DatasourceRegistry`, the next event on the stream is `consent-completed` carrying both `sessionId` and the new `datasourceId`, and the loopback server is closed

#### Scenario: Cancel closes listener and emits consent-cancelled

- **WHEN** a test calls `broker.cancel({sessionId})` on an active session
- **THEN** subsequent HTTP requests to `http://127.0.0.1:<port>/callback` fail with `ECONNREFUSED`, the next event on the stream is `consent-cancelled` with matching `sessionId`, and a second `cancel` on the same `sessionId` is a no-op (no duplicate event, no error)

### Requirement: Consent session has a 5-minute timeout

Every pending consent session SHALL carry a timer set to 5 minutes (300000 ms) when the session starts. On timer expiry the broker SHALL close the loopback HTTP server, clear the pending-session record, and emit `consent-timeout` on the event stream. The timer SHALL be cancelled cleanly on every other terminal path (`consent-completed`, `consent-cancelled`, `consent-failed`).

#### Scenario: Timer fires at 5 minutes

- **WHEN** a test uses Vitest fake timers, calls `broker.start(...)`, and advances the clock by 300001 ms without any callback hit
- **THEN** the next event on the stream is `consent-timeout`, the loopback server for that session is closed, the pending-session record is gone, and no further events fire for that `sessionId`

#### Scenario: Timer is cancelled on successful completion

- **WHEN** a test completes a valid callback at t=60000 ms and then advances the clock past t=300000 ms
- **THEN** exactly one `consent-completed` event fires at t=60000 and NO `consent-timeout` event fires after; the timer handle is returned to the pool (verified via a test-time timer-leak check)

### Requirement: DatasourceSummary carries a taxonomy `errorKind` alongside the human `errorReason`

`DatasourceSummary` SHALL gain a required-when-errored field `errorKind: DatasourceErrorTag | null`. When `status !== "error"`, `errorKind` SHALL be `null`. When `status === "error"`, `errorKind` SHALL be exactly one of the engine's 8-tag values: `auth-revoked`, `auth-expired`, `not-found`, `rate-limited`, `network-error`, `conflict`, `provider-error`, `cancelled`. The existing `errorReason` string field remains for human display and is unchanged.

The main-process summary-construction code SHALL derive `errorKind` from the `DatasourceError.tag` raised by the engine's last operation or from the most-recent `status-changed`-equivalent event; it SHALL NOT derive it by parsing `errorReason`.

#### Scenario: errorKind is null when healthy

- **WHEN** a test reads a `DatasourceSummary` for a datasource whose engine status is `connected`
- **THEN** `summary.errorKind === null`, `summary.errorReason === undefined`, and both fields are typed as nullable at the contract level

#### Scenario: errorKind mirrors the engine's DatasourceError tag on error

- **WHEN** the engine raises a `DatasourceError { tag: "auth-revoked" }` and the registry rebuilds the summary
- **THEN** the resulting `summary.status === "error"` and `summary.errorKind === "auth-revoked"`; `errorReason` carries a human-readable message; the renderer can discriminate without parsing the human string

### Requirement: `AuthErrorBanner` renders in place of bare error text for auth-class errors

`DatasourceCard` SHALL render an `AuthErrorBanner` instead of the bare `<p className="text-destructive text-xs">{errorReason}</p>` when BOTH `summary.status === "error"` AND `summary.errorKind ∈ {"auth-revoked", "auth-expired"}`. For every other error kind (`not-found`, `rate-limited`, `network-error`, `conflict`, `provider-error`, `cancelled`) the card SHALL continue to render the bare error paragraph as before. The quick-actions menu SHALL NOT gain a "Reconnect" item.

The `AuthErrorBanner` SHALL be a horizontal panel inside the card stack with: a destructive-tinted background (`color-mix(in srgb, var(--destructive) 8%, transparent)`), a destructive-tinted border (`color-mix(in srgb, var(--destructive) 30%, transparent)`), `rounded-md` corners (radii-ceiling capped), `p-3` padding, the error copy on the left (`text-xs` body), and a right-aligned `destructive`-variant `size="sm"` Button labeled "Reconnect".

Activating the Reconnect button SHALL call `window.api.datasources.startConsent({ providerId, datasourceId })` for the card's current datasource, record the returned `sessionId` in local state, and subscribe to consent events scoped to that `sessionId` to dispatch the same terminal-state handling as the add-datasource OAuth form.

#### Scenario: Banner renders iff errorKind is auth-class

- **WHEN** a test renders `DatasourceCard` against `summary = { status: "error", errorKind: "auth-revoked", errorReason: "Access revoked by provider" }`
- **THEN** the card contains an element with `data-testid="auth-error-banner"`, the button inside the banner has the accessible name "Reconnect", and the bare `<p className="text-destructive text-xs">` with the error reason is NOT rendered

#### Scenario: Non-auth errors render the bare paragraph unchanged

- **WHEN** a test renders `DatasourceCard` against `summary = { status: "error", errorKind: "network-error", errorReason: "Connection refused" }`
- **THEN** no `data-testid="auth-error-banner"` is present, the bare `<p className="text-destructive text-xs">Connection refused</p>` is rendered, and the quick-actions menu contains no "Reconnect" item (menu items exactly match the pre-existing set)

#### Scenario: Reconnect starts a scoped consent session

- **WHEN** the user activates the banner's "Reconnect" button for a datasource with id `ds-42`
- **THEN** `window.api.datasources.startConsent({ providerId: "google-drive", datasourceId: "ds-42" })` is called exactly once, the returned `sessionId` is stored in the banner's local state, and a subsequent `consent-completed` event with that `sessionId` and `datasourceId: "ds-42"` flips the card's status back to `connected` via the event stream

#### Scenario: Banner meets WCAG AA contrast and has an accessible name

- **WHEN** jest-axe runs against the rendered errored card
- **THEN** no axe violations are reported; the banner's role surfaces its copy and the button as two separable focusable elements; keyboard Tab order is banner-copy then Reconnect then next card element

### Requirement: Development builds may bypass consent via `FT5_DEV_CREDENTIALS`

When the Electron main process starts with `process.env.FT5_DEV_CREDENTIALS === "1"`, the consent broker SHALL log a single warning line (`⚠ FT5_DEV_CREDENTIALS active — browser consent bypassed`) and subsequent `startConsent` calls SHALL: (a) read `$HOME/ft5/sync_app/dev/credentials.json` via the existing `ConfigFileCredentialStore` shape; (b) construct the engine client with the file-derived credentials; (c) emit `consent-completed` synchronously (on the next tick) with a synthetic `sessionId` and the resulting `datasourceId`; (d) NOT open the browser, NOT bind a loopback listener, NOT generate PKCE/state. In packaged production builds the env var SHALL NEVER be set — electron-builder configuration SHALL NOT propagate it into the packaged `process.env`.

#### Scenario: Dev override short-circuits the browser flow

- **WHEN** a test starts the main process with `FT5_DEV_CREDENTIALS=1`, a valid `dev/credentials.json` in the fixture userData dir, and a stubbed `shell.openExternal`
- **THEN** a `startConsent` call resolves, the stubbed `shell.openExternal` is NOT invoked, no HTTP server is bound to `127.0.0.1:<port>`, and the next event on the stream is `consent-completed` carrying a new `datasourceId`

#### Scenario: Production build does not propagate the env var

- **WHEN** a smoke test inspects the packaged main-process binary's embedded env / startup logs
- **THEN** `FT5_DEV_CREDENTIALS` is not in the packaged process env; the warning line is NOT printed on production startup

#### Scenario: Startup warning fires once when dev override is active

- **WHEN** the main process starts with `FT5_DEV_CREDENTIALS=1`
- **THEN** exactly one log line matching `/FT5_DEV_CREDENTIALS active/` is emitted during main-process bootstrap, and no further warnings fire on subsequent `startConsent` calls within the same session
