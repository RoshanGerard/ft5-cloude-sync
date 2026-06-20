## MODIFIED Requirements

### Requirement: Non-usable datasource states render as pattern-A full-replace treatments

When the datasource is not in a state that permits browsing — `disconnected`, `auth-revoked`, `invalid-datasource`, or `syncing` (initial sync in progress) — the entries area of the file explorer SHALL be replaced by a centered state component with a Lucide icon (40px), a 15px semibold headline, 13px body at `text-muted-foreground` (width-capped ~320px), and, for the actionable states, action buttons. Specifically: the `disconnected` state has a single primary `Retry` button; the `auth-revoked` and `invalid-datasource` tags BOTH render the same reconnect-required treatment — an `AlertTriangle` icon (`text-destructive`), a primary `Reconnect` button (constructive, neutral `bg-primary` styling) PLUS a secondary `Remove datasource` button (`variant="ghost" size="sm"` with `text-destructive`). The `syncing` state SHALL include a progress label (e.g., "~1,240 files · 32%") rendered in `text-blue-600` but no action button. The `connected-but-empty` state (the datasource is reachable, sync is complete, and the current folder contains zero entries) SHALL render the same pattern with neutral iconography (`FolderOpen`, `text-muted-foreground`) and no action button. The toolbar, breadcrumb, history buttons, and Details pane SHALL remain rendered above / beside the state area in every case.

#### Scenario: Disconnected state renders when list rejects with tag "disconnected"

- **WHEN** `window.api.files.list` rejects with `{ error: { tag: "disconnected", message: "Network unreachable", retryable: true } }` for the currently-viewed folder
- **THEN** the explorer renders a centered component with the `CloudOff` icon in `text-amber-600`, headline "Can't reach this datasource", body "Check your network or try again in a moment.", and an amber `Retry` button that re-dispatches the list when clicked; no file rows are rendered

#### Scenario: Auth-revoked state renders the shared reconnect-required treatment

- **WHEN** `window.api.files.list` rejects with `{ error: { tag: "auth-revoked", message: "Refresh token expired", retryable: false } }`
- **THEN** the explorer renders the SAME reconnect-required component used for the `invalid-datasource` tag — the `AlertTriangle` icon in `text-destructive`, headline "This datasource needs reconfiguring", body "Its connection details are missing or invalid. Sign in again or remove the datasource and add it back.", a primary neutral `Reconnect` button, and a secondary `Remove datasource` button (`variant="ghost" size="sm"` with `text-destructive`); container element carries `data-testid="file-explorer-state-invalid-datasource"`, `role="alert"`, and `aria-live="polite"`; the explorer does NOT render the retired amber `KeyRound` "Sign in again to view files" view and does NOT navigate to the dashboard; no file rows are rendered

#### Scenario: Invalid-datasource state renders when list rejects with tag "invalid-datasource"

- **WHEN** `window.api.files.list` rejects with `{ error: { tag: "invalid-datasource", message: "Credentials are missing — reconnect this datasource", retryable: false } }`
- **THEN** the explorer renders a centered component with the `AlertTriangle` icon in `text-destructive` (red-600), headline "This datasource needs reconfiguring", body "Its connection details are missing or invalid. Sign in again or remove the datasource and add it back.", a primary neutral `Reconnect` button, and a secondary `Remove datasource` button with `variant="ghost" size="sm"` and `text-destructive` styling; no file rows are rendered; container element carries `data-testid="file-explorer-state-invalid-datasource"`, `role="alert"`, and `aria-live="polite"`

#### Scenario: Syncing state renders when datasources-store status is "syncing" before the first list response resolves

- **WHEN** the explorer mounts against a datasource whose status in the datasources store is `syncing`, and no prior list response has resolved for the current folder
- **THEN** the explorer renders a centered component with the `RefreshCw` icon spinning at 2.4s linear in `text-blue-600`, headline "Indexing your files…", body "This happens once on first connect. Files will appear as they're discovered."; no action button is rendered; the component includes `role="status"` and `aria-live="polite"`

#### Scenario: Connected-but-empty state renders when the list returns zero entries

- **WHEN** `window.api.files.list` resolves successfully with an empty `entries` array for the current folder, and the datasource status is `connected` or `paused`
- **THEN** the explorer renders a centered component with the `FolderOpen` icon in `text-muted-foreground`, headline "This folder is empty", body "Drop files on your datasource or upload from the sync service — they'll appear here.", and no action button

#### Scenario: State components meet WCAG AA color contrast and expose live regions

- **WHEN** any of the four state components renders (disconnected, the shared reconnect-required state serving `auth-revoked` + `invalid-datasource`, syncing, connected-but-empty)
- **THEN** the primary text / icon against the component's background passes WCAG AA contrast (amber-600 on white meets 4.66:1; red-600 on white meets 4.83:1); the component carries `role="status"` (for syncing and connected-but-empty) or `role="alert"` (for disconnected and the reconnect-required state) with `aria-live="polite"`; icons are marked `aria-hidden="true"`; the primary action button is focusable via keyboard and lands in the tab order immediately after the toolbar. The loading skeleton (separate requirement) is decorative, carries `aria-hidden="true"`, and is NOT a live region — the syncing state is the canonical loading cue for assistive technology

### Requirement: Engine response is authoritative over datasources-store status

When the datasources-store status and the response from the live engine conflict, the live engine response SHALL govern what the explorer displays. The store MAY be consulted to pick a predictive initial state before the first response resolves (e.g., `syncing` status → show the syncing skeleton optimistically) but once the response lands, the tag on that response determines the rendered state.

#### Scenario: Store says connected but list returns auth-revoked

- **WHEN** the datasources-store status for the current datasource is `connected` and `window.api.files.list` rejects with `{ error: { tag: "auth-revoked" } }`
- **THEN** the explorer renders the reconnect-required state (the same component used for the `invalid-datasource` tag) immediately; a subsequent `status-changed` event from the store that updates the status to `error` SHALL NOT cause a visible flicker

#### Scenario: Store says syncing but list returns a populated folder

- **WHEN** the datasources-store status is `syncing` and `window.api.files.list` resolves with a non-empty entries array
- **THEN** the explorer renders the entries list, not the syncing state; the store's `syncing` value does not suppress live successful results

## REMOVED Requirements

### Requirement: Invalid-datasource Reconnect runs in-place via `startConsent` and refreshes on completion

**Reason**: Superseded by the unified "Datasource reconnect runs in-place via `sync.authenticateStart` and refreshes on completion" requirement. The original named the retired `window.api.datasources.startConsent` command and the `useConsentSession` hook — the shipped code migrated to `window.api.sync.authenticateStart` + `useAuthSession` in `implement-datasource-onboarding` and the spec was never re-synced — and it only covered the `invalid-datasource` tag plus OAuth providers.

**Migration**: The replacement requirement covers both the `auth-revoked` and `invalid-datasource` tags through one shared component, pins the correct `sync.authenticateStart` / `useAuthSession` lifecycle, and adds the credential-form inline reconnect path for non-OAuth providers (see "Credential-form datasources reconnect via an inline form in the explorer").

## ADDED Requirements

### Requirement: Datasource reconnect runs in-place via `sync.authenticateStart` and refreshes on completion

The shared `<InvalidDatasourceState>` component (rendered for BOTH the `auth-revoked` and `invalid-datasource` error tags) SHALL drive reconnect in place and SHALL NOT route the user back to the dashboard at any point — the reconnect lifecycle stays inside the file-explorer view.

The `Reconnect` button SHALL dispatch on the datasource provider's `credentialsSchema` (resolved from the frozen `providers` registry via `providers[providerId]`), with NO `providerId === "..."` branches:

- For OAuth providers (`credentialsSchema === "oauth"`), the button SHALL call `window.api.sync.authenticateStart({ providerId, datasourceId })` directly, capture the returned `correlationId`, and subscribe via the `useAuthSession(correlationId)` hook. While the session status is `pending`, BOTH action buttons (Reconnect and Remove) SHALL be disabled and the Reconnect label SHALL swap to "Connecting…" (no animated spinner — `animate-spin` is forbidden in feature code by the `scripts/motion-budget.test.ts` guardrail; the label-swap matches the existing pattern). On session status `completed` the component SHALL invoke its parent's `onReconnectSucceeded` callback (which the file-explorer wires to `store.retryLoad()` so `useExplorerData` re-dispatches `files:list`); on a successful subsequent list the explorer naturally transitions out of the state. On session status `cancelled` / `failed` / `timeout`, both buttons SHALL re-enable and an inline error line ("Reconnect failed — please try again.") SHALL render below the buttons.
- For non-OAuth providers (`credentialsSchema !== "oauth"`), the button SHALL reveal the inline credential form (see the credential-form reconnect requirement) rather than calling `authenticateStart` directly.

When `window.api.sync.authenticateStart` resolves with `{ ok: false, error }` (e.g. `service-config-missing` / `engine-error`), the component SHALL surface inline error copy rather than silently re-enabling the button with no feedback.

The `providerId: string` value SHALL be sourced from the route layer's `summary.providerId` (threaded through a `providerId?: string` prop on `<FileExplorer>`), NEVER from the engine error (the service-side `resolveClient` emits a placeholder `providerId` when credentials are missing). When `providerId` is unavailable (e.g. a test renders the component in isolation without it), the Reconnect button SHALL be `aria-disabled="true"` with a tooltip "Provider information unavailable — return to the dashboard to reconnect", and clicking it SHALL NOT invoke `authenticateStart`.

#### Scenario: auth-revoked tag routes to the shared in-place reconnect, not the dashboard

- **WHEN** `window.api.files.list` rejects with `{ error: { tag: "auth-revoked" } }`, the explorer renders the shared `<InvalidDatasourceState>`, and the user clicks Reconnect for an OAuth datasource `{ providerId: "onedrive", datasourceId: "ds-1" }`
- **THEN** `window.api.sync.authenticateStart({ providerId: "onedrive", datasourceId: "ds-1" })` is called exactly once; the renderer does NOT call `router.push("/")` and does NOT navigate away from the explorer

#### Scenario: OAuth Reconnect starts a scoped authenticate session and disables both buttons during pending

- **WHEN** a test renders the shared state with `providerId="google-drive" datasourceId="ds-1"`, clicks the Reconnect button, and `window.api.sync.authenticateStart` resolves with `{ ok: true, result: { correlationId: "corr-1", kind: "oauth" } }`
- **THEN** `authenticateStart` is called exactly once with `{ providerId: "google-drive", datasourceId: "ds-1" }`, the `correlationId` is recorded, both Reconnect and Remove buttons report `disabled === true` (or `aria-disabled="true"`), and the Reconnect button's visible label swaps to "Connecting…"

#### Scenario: Successful authenticate triggers `onReconnectSucceeded` callback

- **WHEN** the `useAuthSession` session reaches `status === "completed"`
- **THEN** the component's `onReconnectSucceeded()` prop is invoked exactly once; the parent (file-explorer) wires this to `store.retryLoad()`, which re-dispatches `files:list`

#### Scenario: Cancelled / failed / timeout re-enables the buttons and shows an error line

- **WHEN** the session reaches `status === "cancelled"` (or `"failed"` / `"timeout"`)
- **THEN** both Reconnect and Remove buttons re-enable, the Reconnect button's label returns to "Reconnect", and an inline `<p>` element with text "Reconnect failed — please try again." is rendered below the buttons; clicking Reconnect again starts a fresh `authenticateStart` flow

#### Scenario: authenticateStart failure surfaces inline rather than silently re-enabling

- **WHEN** the user clicks Reconnect and `window.api.sync.authenticateStart` resolves with `{ ok: false, error: { tag: "service-config-missing", path, providerId } }`
- **THEN** the component renders inline error copy referencing the failure (not a silent button re-enable with no message); the Reconnect button is usable again so the user can retry

#### Scenario: Reconnect button is disabled when providerId is unavailable

- **WHEN** a test renders the shared state with `datasourceId="ds-1"` but WITHOUT the `providerId` prop
- **THEN** the Reconnect button has `aria-disabled="true"`, its tooltip reads "Provider information unavailable — return to the dashboard to reconnect", and clicking it does NOT invoke `authenticateStart`

### Requirement: Credential-form datasources reconnect via an inline form in the explorer

For a datasource whose provider `credentialsSchema !== "oauth"` (e.g. `amazon-s3` → `aws-access-key`, or a `custom` schema), clicking `Reconnect` in the shared `<InvalidDatasourceState>` SHALL reveal the matching credential form **inline within the explorer view** (the same `AwsAccessKeyForm` / `CustomForm` components the add-datasource dialog uses, dispatched on `credentialsSchema` with NO provider-id branches). The form SHALL render BELOW the prompt's icon and a short context heading (the icon and heading remain; the prompt's body text and Reconnect/Remove buttons are replaced by the form). The form's existing `Back` affordance SHALL return the user to the prompt without leaving the explorer.

The inline form SHALL be threaded with the existing `datasourceId` so the reconnect re-authenticates the EXISTING datasource (the service writes credentials at the supplied `datasourceId` and returns that same id — no new datasource is minted). On the form's `_authCompleted` completion, the parent SHALL run `store.retryLoad()` and the explorer naturally transitions out of the state on the next successful list.

#### Scenario: S3 Reconnect reveals the inline access-key form

- **WHEN** the shared state renders for `{ providerId: "amazon-s3", datasourceId: "ds-9" }` (provider `credentialsSchema === "aws-access-key"`) and the user clicks Reconnect
- **THEN** the `AwsAccessKeyForm` renders inline within the explorer (its Access key ID / Secret access key / Region / Bucket fields are present); the browser is NOT opened and no OAuth `authenticateStart` path runs; a Back control is present that returns to the reconnect prompt

#### Scenario: S3 inline reconnect threads datasourceId and re-auths the existing datasource

- **WHEN** the inline `AwsAccessKeyForm` (rendered for `datasourceId="ds-9"`) is submitted with valid keys
- **THEN** `window.api.sync.authenticateStart` is called with `{ providerId: "amazon-s3", datasourceId: "ds-9" }` (the existing id, not a freshly minted one), then `window.api.sync.authenticateComplete({ correlationId, completion: { kind: "credentials-form", values } })`; on `ok: true` the component fires its completion and the parent runs `store.retryLoad()`
