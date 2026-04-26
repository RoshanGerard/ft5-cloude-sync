## MODIFIED Requirements

### Requirement: Add-datasource flow uses a provider-agnostic step sequence

The add-datasource dialog SHALL present a two-step flow: step 1 is a provider picker listing every entry in the `providers` registry with its display name and icon; step 2 is a credential form selected by the chosen provider's `credentialsSchema`.

Submission SHALL flow through a single backend surface — the service's `sync:authenticate-{start,complete,cancel}` commands — for every `credentialsSchema` value:

- For `credentialsSchema === "oauth"`, the form SHALL call `window.api.sync.authenticateStart({ providerId, datasourceId? })`. The response carries `{ correlationId, kind: "oauth" }`. The form SHALL render in-dialog status copy conveying that the system browser has opened, subscribe to `auth-*` events scoped to the returned `correlationId` via `window.api.sync.onEvent`, and transition to the dialog-close state when `auth-completed` fires for the matching correlationId. On `auth-cancelled`, `auth-failed`, or `auth-timeout` the form SHALL surface an inline message (`role="status"`, `aria-live="polite"`) and a Retry control that restarts `authenticateStart`. On dialog unmount before terminal state, the form SHALL call `window.api.sync.authenticateCancel({ correlationId })`. The form SHALL NOT call `window.api.datasources.add` or `window.api.datasources.startConsent` for OAuth providers (the latter no longer exists on the surface).
- For non-OAuth schemas (`aws-access-key`, `custom`), the form SHALL call `window.api.sync.authenticateStart({ providerId, datasourceId? })`. The response carries `{ correlationId, kind: "credentials-form", formSchema }`. The form SHALL render fields per the schema, and on user submit call `window.api.sync.authenticateComplete({ correlationId, completion: { kind: "credentials-form", values } })`. On the response's `ok === true` the dialog closes; on `ok === false` an inline error renders. The form SHALL NOT call `window.api.datasources.add`.

When `sync.authenticateStart` resolves with `{ ok: false, error: { tag: "service-config-missing", path, providerId } }`, the form SHALL render an inline message reading "Service configuration missing. Add OAuth credentials to `<path>` (rendered as inline code). See README §Provider OAuth registration." A Retry control SHALL be available — though it will surface the same error until the user fixes the file. The `service-config-missing` tag is NOT a member of `AuthFailedTag`; it surfaces exclusively via the `authenticateStart` response envelope, never via the `auth-failed` event.

Adding a new provider type to the system SHALL require exactly (a) adding a `ProviderDescriptor` entry to the frozen `providers` registry in `packages/ipc-contracts/`, (b) if `credentialsSchema` is a value not already supported, adding one new credential-form component under `features/datasources/credential-forms/`, and (c) for OAuth-class providers, adding the `clientId`/`clientSecret` slot to `services/fs-sync/config.example.json` plus a per-provider OAuth-app-registration section in `README.md`. No changes to the dashboard, card, dialog shell, store, or service handlers SHALL be required.

#### Scenario: Provider picker lists exactly the registered providers

- **WHEN** the add-datasource dialog opens
- **THEN** step 1 renders one selectable option per entry in the `providers` registry — in this change, exactly `google-drive`, `onedrive`, and `amazon-s3` — each with its display name and icon, and no hard-coded provider branches in the dialog component

#### Scenario: Credential step is picked from the descriptor, not the provider id

- **WHEN** the user selects a provider whose `credentialsSchema === "oauth"`
- **THEN** the OAuth credential form component is rendered; swapping the descriptor's `credentialsSchema` to `"aws-access-key"` SHALL cause the access-key form to be rendered instead, without any change to the dialog's code

#### Scenario: OAuth form calls sync.authenticateStart, not datasources.startConsent or datasources.add

- **WHEN** the user clicks "Connect Google Drive" in the OAuth form
- **THEN** the form invokes `window.api.sync.authenticateStart({ providerId: "google-drive" })` exactly once; does NOT invoke `window.api.datasources.startConsent` (which no longer exists on the surface); does NOT invoke `window.api.datasources.add`; displays `role="status"` copy such as "Opening browser — complete authentication and return here"; awaits `auth-*` events scoped to the returned `correlationId`

#### Scenario: OAuth form transitions to done on auth-completed

- **WHEN** an `auth-completed` event arrives via `window.api.sync.onEvent` with a matching `correlationId`
- **THEN** the dialog closes, the dashboard refreshes and renders a new `DatasourceCard` for the newly live datasource (the registry row was added by the desktop event-bridge in response to the paired `credential-persisted` event), and focus returns to the add-datasource trigger in the dashboard toolbar

#### Scenario: OAuth form surfaces cancel, timeout, and failed inline

- **WHEN** an `auth-cancelled`, `auth-timeout`, or `auth-failed` event arrives via `window.api.sync.onEvent` with a matching `correlationId`
- **THEN** the dialog stays open, the inline status region announces the corresponding copy ("Authentication cancelled — you can try again", "Authentication timed out — please try again", or the message from `auth-failed`), and a Retry control is rendered that re-invokes `authenticateStart` with the same `providerId` when activated

#### Scenario: OAuth form surfaces service-config-missing with file path + README pointer

- **WHEN** the renderer calls `window.api.sync.authenticateStart({ providerId: "google-drive" })` and the response is `{ ok: false, error: { tag: "service-config-missing", path: "/home/u/ft5/sync_app/config.json", providerId: "google-drive" } }`
- **THEN** the form renders inline copy: "Service configuration missing. Add OAuth credentials to `/home/u/ft5/sync_app/config.json` (rendered as inline `<code>`). See README §Provider OAuth registration."; the path string is selectable text; no anchor tag points to the README (sandboxed renderer with no off-domain navigation); a Retry button is present

#### Scenario: Non-OAuth submission flows through sync.authenticateStart + authenticateComplete

- **WHEN** the user submits the S3 access-key form with valid credentials
- **THEN** the form invokes `window.api.sync.authenticateStart({ providerId: "amazon-s3" })` exactly once, receives `{ correlationId, kind: "credentials-form", formSchema }`, then invokes `window.api.sync.authenticateComplete({ correlationId, completion: { kind: "credentials-form", values: { accessKeyId, secretAccessKey, region } } })` exactly once; on `ok: true` the dialog closes; the form does NOT invoke `window.api.datasources.add`

#### Scenario: Successful add (non-OAuth) appends a card to the dashboard

- **WHEN** the credential form submits, `window.api.sync.authenticateComplete(...)` resolves with a `DatasourceSummary`, and the desktop event-bridge has handled the paired `credential-persisted` event by adding the registry row
- **THEN** the dialog closes, the dashboard renders a new `DatasourceCard` for the returned summary in the populated state, and focus returns to the add-datasource trigger in the dashboard toolbar

#### Scenario: Extensibility is enforceable, not just documented

- **WHEN** a hypothetical fourth provider is added to the registry in a test fixture with a new `credentialsSchema`
- **THEN** a Vitest test SHALL render the dialog, select the new provider, and assert that the matching credential form component mounts — failing if the dialog contains provider-id branching

### Requirement: Datasource IPC surface is the single data path

All datasource reads and mutations from the renderer SHALL go through the `window.api.datasources.*` and `window.api.sync.*` surfaces. The renderer SHALL NOT import any provider SDK, any `fs`/`child_process`/`electron`/`drizzle-orm` specifier, or any module under `apps/desktop/src/main/` or `apps/desktop/src/preload/`. The main-process handlers route list/add/remove/action requests through the persistent `DatasourceRegistry`; authenticate requests route through the service via `window.api.sync.authenticate{Start,Complete,Cancel}`. There is no feature-flagged "engine-backed vs fixture" dichotomy — the registry is the single source of truth for datasource membership, and the service is the single source of truth for credentials.

The `window.api.datasources.*` surface SHALL expose: `list()`, `add(req)`, `remove(req)`, `action(req)` (unified pause / resume / sync-now), `pickFilesToUpload()`, and `onEvent(cb)`. The `startConsent(req)` and `cancelConsent(req)` methods SHALL NOT be present — they have been retired and replaced by the service-mediated `window.api.sync.authenticate{Start,Cancel}` surface. The `upload(req)` method SHALL also be absent (retired earlier — Upload dialog uses `pickFilesToUpload()` + `files.upload`).

The `window.api.sync.*` surface SHALL expose (in addition to the previously specified `enqueueUpload`, `enqueueMirror`, `listJobs`, `getJob`, `cancelJob`, `setRetryPolicy`, `getRetryPolicy`, `getStatus`, `subscribeEvents`, `unsubscribeEvents`, `onEvent`): `authenticateStart(req)`, `authenticateComplete(req)`, `authenticateCancel(req)`. Each call SHALL have a typed request/response pair in `packages/ipc-contracts/src/sync-service-desktop/`.

The `DatasourceEvent` discriminated union SHALL NOT carry consent-related variants any longer — the `consent-started`, `consent-completed`, `consent-cancelled`, `consent-failed`, and `consent-timeout` variants SHALL be removed. Authentication lifecycle events flow exclusively on the sync event stream as `auth-*` events (see the new "Renderer subscribes to the sync event stream for authenticate lifecycle" requirement).

#### Scenario: Renderer has no direct SDK import

- **WHEN** `pnpm lint` runs
- **THEN** ESLint reports an error for any file under `apps/desktop/src/renderer/` that imports from `googleapis`, `@microsoft/microsoft-graph-client`, `@aws-sdk/client-s3`, or any other provider SDK package; a dedicated CI grep step SHALL back the ESLint rule

#### Scenario: startConsent and cancelConsent are absent from the surface

- **WHEN** a Vitest test inspects `window.api.datasources` at runtime AND grep-scans the contract, preload, and main-handler trees
- **THEN** `startConsent` and `cancelConsent` are NOT present on `window.api.datasources`; `DatasourcesStartConsentRequest` / `DatasourcesStartConsentResponse` / `DatasourcesCancelConsentRequest` / `DatasourcesCancelConsentResponse` types do NOT exist in `packages/ipc-contracts/src/datasources.ts`; no `ipcMain.handle` under `apps/desktop/src/main/ipc/datasources/` registers a `start-consent` or `cancel-consent` channel; the existing `DATASOURCES_CHANNELS` constant in `packages/ipc-contracts/src/datasources.ts` no longer carries `startConsent` / `cancelConsent` keys

#### Scenario: authenticateStart, authenticateComplete, authenticateCancel are first-class on sync surface

- **WHEN** a type test imports `SyncAuthenticateStartRequest`, `SyncAuthenticateCompleteRequest`, `SyncAuthenticateCancelRequest` from `@ft5/ipc-contracts/sync-service-desktop`
- **THEN** all three types are present, the preload exposes the matching methods on `window.api.sync`, the renderer call sites compile under strict mode, and each method has a typed response

#### Scenario: Consent event variants are absent from DatasourceEvent

- **WHEN** a type test imports `DatasourceEvent` from `@ft5/ipc-contracts`
- **THEN** the union does NOT contain `consent-started`, `consent-completed`, `consent-cancelled`, `consent-failed`, or `consent-timeout` variants; a switch over `e.event` does NOT need to handle any consent-* arm

### Requirement: `AuthErrorBanner` renders in place of bare error text for auth-class errors

`DatasourceCard` SHALL render an `AuthErrorBanner` instead of the bare `<p className="text-destructive text-xs">{errorReason}</p>` when BOTH `summary.status === "error"` AND `summary.errorKind ∈ {"auth-revoked", "auth-expired"}`. When `summary.errorKind === "invalid-datasource"`, the card SHALL render the sibling `<InvalidDatasourceBanner>` (per a separate requirement) instead of the bare paragraph. For every other error kind the card SHALL continue to render the bare error paragraph as before. The quick-actions menu SHALL NOT gain a "Reconnect" item.

The `AuthErrorBanner` visual specification (background, border, padding, button styling) SHALL match the existing pattern unchanged.

Activating the Reconnect button SHALL call `window.api.sync.authenticateStart({ providerId, datasourceId })` for the card's current datasource, record the returned `correlationId` in local state, and subscribe to `auth-*` events via `window.api.sync.onEvent` scoped to that `correlationId` to dispatch the same terminal-state handling as the add-datasource OAuth form. The `useAuthSession` hook (renamed from `useConsentSession`) SHALL drive the lifecycle.

#### Scenario: Banner renders iff errorKind is auth-class

- **WHEN** a test renders `DatasourceCard` against `summary = { status: "error", errorKind: "auth-revoked", errorReason: "Access revoked by provider" }`
- **THEN** the card contains an element with `data-testid="auth-error-banner"`, the button inside the banner has the accessible name "Reconnect", and the bare `<p className="text-destructive text-xs">` with the error reason is NOT rendered

#### Scenario: Reconnect starts a scoped authenticate session

- **WHEN** the user activates the banner's "Reconnect" button for a datasource with id `ds-42`
- **THEN** `window.api.sync.authenticateStart({ providerId: "google-drive", datasourceId: "ds-42" })` is called exactly once; the returned `correlationId` is stored in the banner's local state; a subsequent `auth-completed` event with that `correlationId` and `datasourceId: "ds-42"` flips the card's status back to `connected` via the existing event stream

#### Scenario: Banner meets WCAG AA contrast and has an accessible name

- **WHEN** structural a11y assertions run against the rendered errored card
- **THEN** the banner's role surfaces its copy and the button as two separable focusable elements; keyboard Tab order is banner-copy then Reconnect then next card element

### Requirement: `InvalidDatasourceBanner` renders for invalid-datasource errorKind

`DatasourceCard` SHALL render an `<InvalidDatasourceBanner>` (sibling component to `AuthErrorBanner`) when BOTH `summary.status === "error"` AND `summary.errorKind === "invalid-datasource"`. The banner's visual scaffolding (destructive-tinted background, destructive-tinted border, `rounded-md` corners, `p-3` padding, the `Reconnect` and `Remove` button layout) SHALL match the existing specification unchanged.

The Reconnect button SHALL call `window.api.sync.authenticateStart({ providerId, datasourceId })` and follow the same `useAuthSession` lifecycle (renamed from `useConsentSession`): pending → button disabled and label swapped to "Connecting…"; completed → banner unmounts via summary refresh; failed/cancelled/timeout → banner re-enables with "Reconnect failed — please try again." inline. No animated spinner — `animate-spin` is forbidden in feature code by the `scripts/motion-budget.test.ts` guardrail per `ui-ux-design` Decision 10.

The Remove button SHALL open the shared `<ConfirmRemoveDatasourceDialog>` before dispatching `window.api.datasources.remove({ datasourceId })`. On a successful remove, the desktop main-process handler SHALL ALSO call `window.api.sync.deleteCredentials({ datasourceId })` (the new IPC) so the per-user credential entry is cleaned up alongside the registry row.

#### Scenario: Banner renders iff errorKind is invalid-datasource

- **WHEN** a test renders `DatasourceCard` against `summary = { status: "error", errorKind: "invalid-datasource", errorReason: "Credentials are missing — reconnect this datasource" }`
- **THEN** the card contains an element with `data-testid="invalid-datasource-banner"`, both buttons render with their respective labels, the bare `<p className="text-destructive text-xs">` with the error reason is NOT rendered, and the `<AuthErrorBanner>` is also NOT rendered

#### Scenario: Reconnect button drives the same authenticate flow as AuthErrorBanner

- **WHEN** the user activates the banner's Reconnect button for a datasource with id `ds-42` and provider `google-drive`
- **THEN** `window.api.sync.authenticateStart({ providerId: "google-drive", datasourceId: "ds-42" })` is called exactly once; the returned `correlationId` is recorded; the button is disabled with its visible label swapped to "Connecting…" during pending; on an `auth-completed` event with that `correlationId` the card's status flips back to `connected` via the existing event stream and the banner unmounts

#### Scenario: Remove button cleans up registry row AND service credential entry

- **WHEN** the user clicks the banner's Remove button, confirms in the shared dialog, and the main-process `datasources:remove` handler runs
- **THEN** the local `registry.remove(datasourceId)` is called exactly once; the service-side `sync:delete-credentials({ datasourceId })` is called exactly once via the desktop's `SyncClient`; failures of the latter are logged but do NOT block the local remove from succeeding (best-effort cleanup)

## ADDED Requirements

### Requirement: Renderer subscribes to the sync event stream for authenticate lifecycle

The renderer SHALL consume the `auth-*` event family via `window.api.sync.onEvent(callback): () => void` (the existing sync event subscription, also used for job-* events). The `useAuthSession(correlationId)` hook SHALL be the single point of consumption — it subscribes via `sync.onEvent`, filters events by `event.correlationId === correlationId`, and exposes a `{ status: "pending" | "completed" | "cancelled" | "failed" | "timeout", message?, datasourceId?, tag? }` shape to consuming components.

`useConsentSession` SHALL NOT be exported any longer — call sites migrate to `useAuthSession`. The renderer's existing `window.api.datasources.onEvent` subscription remains in place for non-authenticate datasource events (status-changed, etc.) but receives NO `auth-*` events.

#### Scenario: useAuthSession resolves to completed on matching auth-completed event

- **WHEN** a test mounts a component using `useAuthSession("corr-123")`, then the test fires `window.api.sync.onEvent`-delivered `auth-completed { correlationId: "corr-123", datasourceId: "ds-X", summary }`
- **THEN** the hook's returned status flips to `"completed"` with `datasourceId === "ds-X"` within one render

#### Scenario: useAuthSession ignores events for other correlationIds

- **WHEN** a test mounts a component using `useAuthSession("corr-123")`, then fires `auth-completed { correlationId: "corr-456", … }`
- **THEN** the hook's returned status remains `"pending"`; no state transition occurs

#### Scenario: useConsentSession is no longer exported

- **WHEN** a TypeScript build runs over the renderer code
- **THEN** no module exports a symbol named `useConsentSession`; existing import sites have been migrated to `useAuthSession`

### Requirement: Desktop main-process bridge translates service authenticate events into local actions

The desktop main-process `apps/desktop/src/main/sync/event-bridge.ts` SHALL subscribe to two service event types in addition to its existing subscriptions:

- `oauth-open-url` → call `shell.openExternal(authorizeUrl)`. The renderer SHALL NEVER receive this event — the bridge filters it out of the renderer-bound forward.
- `credential-persisted` → call `getEngine().registry.add(summary)` (idempotent insert-or-update; see fs-datasource-engine for the registry semantics during this transition window). The renderer SHALL NEVER receive this event — it is bridge-only.

All other `auth-*` events (`auth-initiated`, `auth-completed`, `auth-cancelled`, `auth-failed`, `auth-timeout`) SHALL be forwarded to the renderer over the existing `SYNC_CHANNELS.event` channel without modification.

#### Scenario: Bridge calls shell.openExternal on oauth-open-url

- **WHEN** a bridge test fires `oauth-open-url { correlationId, authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?..." }`
- **THEN** the bridge's injected `shell.openExternal` is called exactly once with that URL; the renderer-window subscriber is NOT called for this event

#### Scenario: Bridge calls registry.add on credential-persisted

- **WHEN** a bridge test fires `credential-persisted { correlationId, datasourceId: "ds-X", summary: { id: "ds-X", providerId: "google-drive", … } }`
- **THEN** the bridge's `registry.add(summary)` is called exactly once with the supplied summary; the renderer-window subscriber is NOT called for this event

#### Scenario: Bridge forwards auth-completed to renderer

- **WHEN** a bridge test fires `auth-completed { correlationId, datasourceId, summary }` AND has a renderer-window subscriber registered
- **THEN** the renderer-window subscriber receives the same event verbatim on `SYNC_CHANNELS.event`; the bridge does NOT separately call `registry.add` (the paired `credential-persisted` event handles that)

## REMOVED Requirements

### Requirement: Main-process consent broker hosts a loopback HTTP listener per session

**Reason**: Relocated to the fs-sync service per the architectural framing committed in this change (Decision 1 + Decision 2 of `design.md`). The main-process broker contradicted the "service is the backend" principle: it owned the loopback HTTP listener, the credential-write callback, and the OAuth app config consumption — three responsibilities that now live entirely on the service side.

**Migration**: The equivalent functionality is now specified by the `fs-sync-service` capability under the requirement "`OAuthLoopbackBroker` hosts a per-correlation loopback HTTP listener inside the service". The main-process module `apps/desktop/src/main/oauth/consent-broker.ts` is deleted; its tests are deleted. Renderer consumers migrate to `window.api.sync.authenticateStart` per the modified "Add-datasource flow uses a provider-agnostic step sequence" requirement above.

### Requirement: Consent session has a 5-minute timeout

**Reason**: The 5-minute timeout was a property of the main-process consent broker. With the broker relocated to the service (see the `fs-sync-service` capability's `OAuthLoopbackBroker` requirement), the timeout requirement migrates with it.

**Migration**: The 5-minute timer is now specified by the `fs-sync-service` capability under the "`OAuthLoopbackBroker` hosts a per-correlation loopback HTTP listener inside the service" requirement. The terminal event name changed from `consent-timeout` to `auth-timeout` per the new event taxonomy.

### Requirement: Development builds may bypass consent via `FT5_DEV_CREDENTIALS`

**Reason**: The dev-credentials override was a property of the main-process consent broker. With the broker relocated to the service, the override migrates with it.

**Migration**: The equivalent override is specified by the `fs-sync-service` capability under "Development builds may bypass authenticate via `FT5_DEV_CREDENTIALS` (service-side)". The override now reads from `<service-data-dir>/dev-credentials.json` (service-side path) instead of `<userData>/dev-credentials.json` (Electron-userData path); the env var consumer is the service process, not the desktop main process.
