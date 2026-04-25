## MODIFIED Requirements

### Requirement: Non-usable datasource states render as pattern-A full-replace treatments

When the datasource is not in a state that permits browsing — `disconnected`, `auth-revoked`, `invalid-datasource`, or `syncing` (initial sync in progress) — the entries area of the file explorer SHALL be replaced by a centered state component with a Lucide icon (40px), a 15px semibold headline, 13px body at `text-muted-foreground` (width-capped ~320px), and, for the actionable states, action buttons. Specifically: the `disconnected` state has a single primary `Retry` button; the `auth-revoked` state has a single primary `Reconnect` button; the new `invalid-datasource` state has a primary `Reconnect` button (constructive, neutral `bg-primary` styling) PLUS a secondary `Remove datasource` button (`variant="ghost" size="sm"` with `text-destructive`). The `syncing` state SHALL include a progress label (e.g., "~1,240 files · 32%") rendered in `text-blue-600` but no action button. The `connected-but-empty` state (the datasource is reachable, sync is complete, and the current folder contains zero entries) SHALL render the same pattern with neutral iconography (`FolderOpen`, `text-muted-foreground`) and no action button. The toolbar, breadcrumb, history buttons, and Details pane SHALL remain rendered above / beside the state area in every case.

#### Scenario: Disconnected state renders when list rejects with tag "disconnected"

- **WHEN** `window.api.files.list` rejects with `{ error: { tag: "disconnected", message: "Network unreachable", retryable: true } }` for the currently-viewed folder
- **THEN** the explorer renders a centered component with the `CloudOff` icon in `text-amber-600`, headline "Can't reach this datasource", body "Check your network or try again in a moment.", and an amber `Retry` button that re-dispatches the list when clicked; no file rows are rendered

#### Scenario: Auth-revoked state renders when list rejects with tag "auth-revoked"

- **WHEN** `window.api.files.list` rejects with `{ error: { tag: "auth-revoked", message: "Refresh token expired", retryable: false } }`
- **THEN** the explorer renders a centered component with the `KeyRound` icon in `text-amber-600`, headline "Sign in again to view files", body "Your session for this datasource expired or was revoked.", and an amber `Reconnect` button that routes to the datasource reconnect flow; no file rows are rendered

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

- **WHEN** any of the five state components renders
- **THEN** the primary text / icon against the component's background passes WCAG AA contrast (amber-600 on white meets 4.66:1; red-600 on white meets 4.83:1); the component carries `role="status"` (for syncing and connected-but-empty) or `role="alert"` (for disconnected, auth-revoked, and invalid-datasource) with `aria-live="polite"`; icons are marked `aria-hidden="true"`; the primary action button is focusable via keyboard and lands in the tab order immediately after the toolbar. The loading skeleton (separate requirement) is decorative, carries `aria-hidden="true"`, and is NOT a live region — the syncing state is the canonical loading cue for assistive technology

## ADDED Requirements

### Requirement: Invalid-datasource Reconnect runs in-place via `startConsent` and refreshes on completion

The `<InvalidDatasourceState>` component's `Reconnect` button SHALL call `window.api.datasources.startConsent({ providerId, datasourceId })` directly, capture the returned `sessionId`, and subscribe to consent events scoped to that `sessionId` via the existing `useConsentSession(sessionId)` hook. While `sessionState.status === "pending"`, BOTH action buttons (Reconnect and Remove) SHALL be disabled and the Reconnect button SHALL render an inline `Loader2` spinner (`animate-spin`) with the visible label "Connecting…". On `sessionState.status === "succeeded"`, the component SHALL invoke its parent's `onReconnectSucceeded` callback (which the file-explorer wires to `store.retryLoad()` so `useExplorerData` re-dispatches `files:list`); on a successful subsequent list, the explorer naturally transitions out of the `<InvalidDatasourceState>` arm. On `sessionState.status ∈ {"cancelled", "failed", "timeout"}`, both buttons SHALL re-enable and an inline error line ("Reconnect failed — please try again.") SHALL render below the buttons; the user MAY click Reconnect again to start a fresh session.

The component SHALL NOT route the user back to the dashboard at any point; the Reconnect lifecycle stays inside the file-explorer view.

The `providerId: string` value SHALL be threaded from the route layer (where `summary.providerId` is in scope) through a sibling `providerId?: string` prop on `<FileExplorer>` to the state component. When `providerId` is unavailable (e.g., a test renders the component in isolation without it), the Reconnect button SHALL be disabled with `aria-disabled="true"` and a tooltip "Provider information unavailable — return to the dashboard to reconnect"; this guards against attempting `startConsent` with a missing `providerId`.

#### Scenario: Reconnect button starts a scoped consent session and disables both buttons during pending

- **WHEN** a test renders `<InvalidDatasourceState providerId="google-drive" datasourceId="ds-1" ... />`, clicks the Reconnect button, and `window.api.datasources.startConsent` resolves with `{ sessionId: "sess-1" }`
- **THEN** `startConsent` is called exactly once with `{ providerId: "google-drive", datasourceId: "ds-1" }`, the `sessionId` is recorded, both Reconnect and Remove buttons report `disabled === true` (or `aria-disabled="true"`), and the Reconnect button renders the spinner with label "Connecting…"

#### Scenario: Successful consent triggers `onReconnectSucceeded` callback

- **WHEN** the consent session reaches `status === "succeeded"` (simulated via the `useConsentSession` mock)
- **THEN** the component's `onReconnectSucceeded()` prop is invoked exactly once; the parent (file-explorer) wires this to `store.retryLoad()`, which bumps `refetchToken` and triggers `useExplorerData` to re-dispatch `files:list`

#### Scenario: Cancelled / failed / timeout re-enables the buttons and shows an error line

- **WHEN** the consent session reaches `status === "cancelled"` (or `"failed"` / `"timeout"`)
- **THEN** both Reconnect and Remove buttons re-enable, the spinner is removed from the Reconnect button (label returns to "Reconnect"), and an inline `<p>` element with text "Reconnect failed — please try again." is rendered below the buttons; clicking Reconnect again starts a fresh `startConsent` flow with a new `sessionId`

#### Scenario: Reconnect button is disabled when providerId is unavailable

- **WHEN** a test renders `<InvalidDatasourceState datasourceId="ds-1" ... />` without the `providerId` prop
- **THEN** the Reconnect button has `aria-disabled="true"`, its tooltip reads "Provider information unavailable — return to the dashboard to reconnect", and clicking it does NOT invoke `startConsent`

### Requirement: Invalid-datasource Remove flows through a shared confirm dialog

The `<InvalidDatasourceState>` component's `Remove datasource` button SHALL open a shared `<ConfirmRemoveDatasourceDialog>` (shadcn `Dialog`) before invoking `window.api.datasources.remove({ datasourceId })`. The dialog SHALL display the headline "Remove this datasource?" and body "This deletes the local registry entry; cloud files are not deleted." with a Cancel button and a destructive Remove button. The destructive Remove button SHALL be the focus target on dialog open, and pressing Escape SHALL cancel without removing.

On successful Remove (the IPC call resolves and a `datasource-removed` event arrives), the file-explorer route SHALL navigate back to `/` because the underlying datasource no longer exists; the `<InvalidDatasourceState>` component does NOT need explicit cleanup logic — the route unmounts the explorer.

The same `<ConfirmRemoveDatasourceDialog>` SHALL be reused by the dashboard card's invalid-datasource banner Remove button (per the `datasources-ui` capability spec) so destructive removal goes through one consistent confirm flow.

#### Scenario: Remove button opens the confirm dialog without invoking the IPC

- **WHEN** a test renders `<InvalidDatasourceState ... />` and clicks the "Remove datasource" button
- **THEN** the `<ConfirmRemoveDatasourceDialog>` opens (visible / `aria-hidden="false"`), `window.api.datasources.remove` has NOT been called yet, the destructive Remove button inside the dialog has focus, and pressing Escape closes the dialog without dispatching any IPC

#### Scenario: Confirming Remove dispatches the datasources.remove IPC

- **WHEN** the confirm dialog is open and the user clicks the destructive Remove button
- **THEN** `window.api.datasources.remove({ datasourceId })` is called exactly once with the component's `datasourceId` prop value; the dialog closes; subsequent navigation to `/` is driven by the route layer (out of scope for this component)
