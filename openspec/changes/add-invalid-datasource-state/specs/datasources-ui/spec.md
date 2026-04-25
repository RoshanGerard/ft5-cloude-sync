## MODIFIED Requirements

### Requirement: DatasourceSummary carries a taxonomy `errorKind` alongside the human `errorReason`

`DatasourceSummary` SHALL gain a required-when-errored field `errorKind: DatasourceErrorTag | null`. When `status !== "error"`, `errorKind` SHALL be `null`. When `status === "error"`, `errorKind` SHALL be exactly one of the engine's documented `DatasourceErrorTag` values: `auth-revoked`, `auth-expired`, `not-found`, `rate-limited`, `network-error`, `conflict`, `provider-error`, `cancelled`, `unsupported`, or `invalid-datasource`. The existing `errorReason` string field remains for human display and is unchanged.

The main-process summary-construction code SHALL derive `errorKind` from the `DatasourceError.tag` raised by the engine's last operation, the service-side `resolveClient` adapter (for the `invalid-datasource` case — emitted when `credentialStore.get(datasourceId)` returns `null`), or from the most-recent `status-changed`-equivalent event; it SHALL NOT derive it by parsing `errorReason`.

#### Scenario: errorKind is null when healthy

- **WHEN** a test reads a `DatasourceSummary` for a datasource whose engine status is `connected`
- **THEN** `summary.errorKind === null`, `summary.errorReason === undefined`, and both fields are typed as nullable at the contract level

#### Scenario: errorKind mirrors the engine's DatasourceError tag on error

- **WHEN** the engine raises a `DatasourceError { tag: "auth-revoked" }` and the registry rebuilds the summary
- **THEN** the resulting `summary.status === "error"` and `summary.errorKind === "auth-revoked"`; `errorReason` carries a human-readable message; the renderer can discriminate without parsing the human string

#### Scenario: errorKind reflects invalid-datasource when the service detects misconfiguration

- **WHEN** an executor invokes the shared `resolveClient` port for a datasource whose credential is missing, `resolveClient` throws `DatasourceError({ tag: "invalid-datasource" })`, and the executor's status-changed handling rebuilds the summary
- **THEN** `summary.status === "error"`, `summary.errorKind === "invalid-datasource"`, and `summary.errorReason` carries the message "Credentials are missing — reconnect this datasource"; the dashboard card's `<InvalidDatasourceBanner>` (per a separate requirement) SHALL render

### Requirement: `AuthErrorBanner` renders in place of bare error text for auth-class errors

`DatasourceCard` SHALL render an `AuthErrorBanner` instead of the bare `<p className="text-destructive text-xs">{errorReason}</p>` when BOTH `summary.status === "error"` AND `summary.errorKind ∈ {"auth-revoked", "auth-expired"}`. When `summary.errorKind === "invalid-datasource"`, the card SHALL render the sibling `<InvalidDatasourceBanner>` (per a separate requirement) instead of the bare paragraph. For every other error kind (`not-found`, `rate-limited`, `network-error`, `conflict`, `provider-error`, `cancelled`, `unsupported`) the card SHALL continue to render the bare error paragraph as before. The quick-actions menu SHALL NOT gain a "Reconnect" item.

The `AuthErrorBanner` SHALL be a horizontal panel inside the card stack with: a destructive-tinted background (`color-mix(in srgb, var(--destructive) 8%, transparent)`), a destructive-tinted border (`color-mix(in srgb, var(--destructive) 30%, transparent)`), `rounded-md` corners (radii-ceiling capped), `p-3` padding, the error copy on the left (`text-xs` body), and a right-aligned `destructive`-variant `size="sm"` Button labeled "Reconnect".

Activating the Reconnect button SHALL call `window.api.datasources.startConsent({ providerId, datasourceId })` for the card's current datasource, record the returned `sessionId` in local state, and subscribe to consent events scoped to that `sessionId` to dispatch the same terminal-state handling as the add-datasource OAuth form.

#### Scenario: Banner renders iff errorKind is auth-class

- **WHEN** a test renders `DatasourceCard` against `summary = { status: "error", errorKind: "auth-revoked", errorReason: "Access revoked by provider" }`
- **THEN** the card contains an element with `data-testid="auth-error-banner"`, the button inside the banner has the accessible name "Reconnect", and the bare `<p className="text-destructive text-xs">` with the error reason is NOT rendered

#### Scenario: Non-auth, non-invalid errors render the bare paragraph unchanged

- **WHEN** a test renders `DatasourceCard` against `summary = { status: "error", errorKind: "network-error", errorReason: "Connection refused" }`
- **THEN** no `data-testid="auth-error-banner"` is present, no `data-testid="invalid-datasource-banner"` is present, the bare `<p className="text-destructive text-xs">Connection refused</p>` is rendered, and the quick-actions menu contains no "Reconnect" item (menu items exactly match the pre-existing set)

#### Scenario: Reconnect starts a scoped consent session

- **WHEN** the user activates the banner's "Reconnect" button for a datasource with id `ds-42`
- **THEN** `window.api.datasources.startConsent({ providerId: "google-drive", datasourceId: "ds-42" })` is called exactly once, the returned `sessionId` is stored in the banner's local state, and a subsequent `consent-completed` event with that `sessionId` and `datasourceId: "ds-42"` flips the card's status back to `connected` via the event stream

#### Scenario: Banner meets WCAG AA contrast and has an accessible name

- **WHEN** jest-axe runs against the rendered errored card
- **THEN** no axe violations are reported; the banner's role surfaces its copy and the button as two separable focusable elements; keyboard Tab order is banner-copy then Reconnect then next card element

## ADDED Requirements

### Requirement: `InvalidDatasourceBanner` renders for invalid-datasource errorKind

`DatasourceCard` SHALL render an `<InvalidDatasourceBanner>` (sibling component to `AuthErrorBanner`, defined in the same file or as a sibling module) when BOTH `summary.status === "error"` AND `summary.errorKind === "invalid-datasource"`. The banner SHALL be a horizontal panel inside the card stack with the same visual scaffolding as `AuthErrorBanner` (destructive-tinted background, destructive-tinted border, `rounded-md` corners, `p-3` padding) and the following content layout:

- Left: `<p className="text-destructive text-xs">Datasource needs reconfiguring — credentials are missing or invalid.</p>`
- Right (stacked horizontally, `gap-2`): `<Button variant="outline" size="sm">Reconnect</Button>` and `<Button variant="outline" size="sm" className="text-destructive">Remove</Button>`

The container element SHALL carry `data-testid="invalid-datasource-banner"` and `aria-label="Reconfiguration required"`. Tab order SHALL be banner-copy → Reconnect → Remove → next card element.

The Reconnect button SHALL call `window.api.datasources.startConsent({ providerId, datasourceId })` and follow the same `useConsentSession` lifecycle as `AuthErrorBanner` (pending → "Connecting…" with spinner; succeeded → banner unmounts via summary refresh; failed/cancelled/timeout → banner re-enables with "Reconnect failed — please try again." inline).

The Remove button SHALL open the shared `<ConfirmRemoveDatasourceDialog>` defined by the `file-explorer` capability (the same component used by the explorer state's Remove button) before dispatching `window.api.datasources.remove({ datasourceId })`. On a successful Remove, the card unmounts via the existing `datasource-removed` event flow.

#### Scenario: Banner renders iff errorKind is invalid-datasource

- **WHEN** a test renders `DatasourceCard` against `summary = { status: "error", errorKind: "invalid-datasource", errorReason: "Credentials are missing — reconnect this datasource" }`
- **THEN** the card contains an element with `data-testid="invalid-datasource-banner"`, both buttons render with their respective labels, the bare `<p className="text-destructive text-xs">` with the error reason is NOT rendered, and the `<AuthErrorBanner>` is also NOT rendered

#### Scenario: Reconnect button drives the same consent flow as AuthErrorBanner

- **WHEN** the user activates the banner's Reconnect button for a datasource with id `ds-42` and provider `google-drive`
- **THEN** `window.api.datasources.startConsent({ providerId: "google-drive", datasourceId: "ds-42" })` is called exactly once, the returned `sessionId` is recorded, the button reads "Connecting…" with a spinner during pending, and on a `consent-completed` event with that `sessionId` the card's status flips back to `connected` via the existing event stream and the banner unmounts

#### Scenario: Remove button opens the shared confirm dialog before dispatching IPC

- **WHEN** the user clicks the banner's Remove button
- **THEN** the `<ConfirmRemoveDatasourceDialog>` opens, `window.api.datasources.remove` has NOT been called yet, and pressing Escape closes the dialog without dispatching the IPC; clicking the destructive Remove button inside the dialog dispatches `window.api.datasources.remove({ datasourceId })` exactly once

#### Scenario: Banner meets WCAG AA contrast and has an accessible name

- **WHEN** jest-axe runs against the rendered errored card with `errorKind: "invalid-datasource"`
- **THEN** no axe violations are reported; the `aria-label="Reconfiguration required"` surfaces the banner's purpose to assistive technology; both buttons are independently focusable; tab order is banner-copy → Reconnect → Remove → next card element
