# datasources-ui

## Purpose

The `datasources-ui` capability covers the renderer's datasources dashboard: the main window's home view rendering the state machine (loading / empty / populated / error), the standardized `DatasourceCard` surfacing provider icon / status / usage / quick-actions, the add-datasource flow with a provider-agnostic credential-form dispatch over the frozen `providers` registry, the `window.api.datasources.*` IPC surface backing both (real or mocked), the upload path that routes through the main-process file picker, and the shadcn-ui-based foundation with light / dark / Serene Blue themes and a Linear/Vercel dense-quiet visual direction (Geist typography, state-change-only motion, glass on overlays only).
## Requirements
### Requirement: Main window home view is the datasources dashboard

The main window SHALL render a datasources dashboard as the default view loaded at the `app://./` route. The dashboard SHALL have three mutually exclusive states: loading (initial fetch in flight), empty (IPC returned zero datasources), and populated (one or more datasources rendered as cards).

#### Scenario: Loading state on first paint

- **WHEN** the main window mounts and `window.api.datasources.list()` has not yet resolved
- **THEN** the dashboard renders a skeleton placeholder with at least one visible progress indicator, and no card components are mounted

#### Scenario: Empty state when no datasources are registered

- **WHEN** `window.api.datasources.list()` resolves to an empty array
- **THEN** the dashboard renders an empty-state panel containing the heading "No cloud datasources yet", explanatory copy, and a primary call-to-action button labelled "Add datasource" that opens the add-datasource dialog on click or Enter/Space key press

#### Scenario: Populated state renders one card per datasource

- **WHEN** `window.api.datasources.list()` resolves to a non-empty array
- **THEN** the dashboard renders exactly one `DatasourceCard` per returned `DatasourceSummary`, in the order returned by the IPC, with the add-datasource action available in the dashboard toolbar

#### Scenario: Failed list fetch surfaces an error, not a blank screen

- **WHEN** `window.api.datasources.list()` rejects
- **THEN** the dashboard renders an error panel with the error message, a "Retry" button that re-invokes the IPC, and does NOT render stale cards from any previous state

### Requirement: Datasource card surfaces the standardized summary fields

Every `DatasourceCard` SHALL render the following fields from its `DatasourceSummary`: provider icon, datasource display name, connection status badge, last-sync timestamp (or "never" if null), item count, and a quick-actions control surface. The card SHALL additionally render a storage usage bar with used/quota labels IF AND ONLY IF `provider.capabilities.quota === true` for the card's provider descriptor.

Connection status SHALL be one of exactly `connected`, `syncing`, `paused`, `error`. The badge's accessible name SHALL include the status word; colour alone SHALL NOT be the only status signal.

#### Scenario: Card renders all required fields

- **WHEN** a `DatasourceCard` is rendered against a non-null `DatasourceSummary`
- **THEN** the card contains a provider icon, the display name as its accessible heading, a status badge whose accessible name includes the status word, a last-sync text (timestamp or "never"), an item count, and a quick-actions trigger — every element is queryable by role and accessible name

#### Scenario: S3 card omits the usage bar

- **WHEN** a `DatasourceCard` is rendered for a datasource whose provider descriptor has `capabilities.quota === false`
- **THEN** no usage bar, no used/quota text, and no quota-related ARIA label is rendered

#### Scenario: Quick-action menu exposes explore, sync-now, pause, upload, settings, remove

- **WHEN** the user opens the card's quick-actions control (click, Enter, or Space on the trigger)
- **THEN** a menu opens with these items in this order: "Explore", "Sync now", "Pause" / "Resume" (label depends on current status), "Upload from local…", "Settings", "Remove". Each item is keyboard-reachable, has an accessible name, and closing the menu restores focus to the trigger

#### Scenario: Explore quick-action navigates to the file explorer for this datasource

- **WHEN** the user activates the "Explore" item on the quick-actions menu of the card whose datasource id is `<id>`
- **THEN** the renderer navigates to `/datasources/explore?id=<id>`; the dashboard is replaced by the file-explorer view; no IPC call on the datasources surface is issued as part of this navigation (the explorer fetches its own data via the files IPC surface after it mounts)

#### Scenario: Error status exposes the error reason

- **WHEN** a `DatasourceCard` renders a summary with `status === "error"`
- **THEN** the card renders the `errorReason` string from the summary as readable text, and the status badge's accessible name includes both "error" and the reason

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

### Requirement: Upload action opens the in-app Upload dialog

The "Upload from local…" quick action on a datasource card SHALL open the in-app Upload dialog (see the `file-explorer` capability for the dialog's full specification). The dialog's default destination SHALL be the datasource root (`/`) when opened from the card (as there is no explorer context at the card level). The renderer SHALL NOT render or reference a `<input type="file">` element for this flow; inside the dialog, the "+ Add files…" affordance SHALL call `window.api.datasources.pickFilesToUpload()`, which in the main process opens a native OS file picker via `dialog.showOpenDialog` with `properties: ["openFile", "multiSelections"]` and returns `{ filePaths: string[]; canceled: boolean }`.

On dialog submission, uploads SHALL be dispatched via `window.api.files.upload` (see the `file-explorer` capability), which proxies to the `fs-sync-service`'s `sync:enqueue-upload` command. The desktop IPC handler for `files.upload` SHALL NOT invoke the engine's `uploadFile` directly in-process. Upload progress SHALL continue to flow to the renderer via the existing one-way IPC event channel `DATASOURCES_CHANNELS.uploadProgress`, scoped per-job to the `jobId` returned by `files.upload`.

Uploads SHALL survive desktop app quit. Closing the desktop window (or even `app.quit`) SHALL NOT cancel or stall the underlying service-side upload job. Progress events emitted by the service while the desktop is closed SHALL be accessible to a subsequent desktop session via the app-open `sync-state-seed` (see the `fs-sync-supervisor` capability).

#### Scenario: Quick action opens the Upload dialog rooted at the datasource root

- **WHEN** the user activates "Upload from local…" on a datasource card's quick-actions menu
- **THEN** the Upload dialog opens; the destination path is `/`; no native OS file picker opens until the user clicks "+ Add files…" inside the dialog

#### Scenario: Renderer contains no file input for the upload flow

- **WHEN** the Upload dialog is rendered and the user activates "+ Add files…"
- **THEN** no `<input type="file">` or web File API reference is present in the rendered DOM tree at any point; the file-picker UI is the OS-native `dialog.showOpenDialog` surface reached through `window.api.datasources.pickFilesToUpload`

#### Scenario: Upload progress events are typed and scoped per job

- **WHEN** an upload is dispatched via `window.api.files.upload` and returns `{ ok: true, value: { jobId: "job_x" } }`
- **THEN** the main process emits progress events on `DATASOURCES_CHANNELS.uploadProgress` keyed by a `transactionId` equal to `"job_x"`; the renderer subscribes only to events matching `"job_x"`; an emission for an unrelated jobId is ignored by the renderer

#### Scenario: Upload survives desktop quit

- **WHEN** a user triggers an upload of a 100 MB file against a rate-limited provider that takes 30+ seconds, then closes the desktop window after 2 seconds
- **THEN** the service-side job continues running; its `jobs` table row remains in `status = 'running'` (or `waiting-network` if the connection drops); a new desktop launch 40 seconds later sees `status = 'completed'` in the seed (or, if still running at relaunch, sees the live progress resume on the card)

#### Scenario: Main handler does not call engine.uploadFile directly

- **WHEN** a Vitest test grep-scans `apps/desktop/src/main/ipc/files/upload.ts` and `apps/desktop/src/main/ipc/datasources/` for `uploadFile` invocations or `engine.uploadFile`
- **THEN** no match is found; the only call the file-upload handler makes is to `syncClient.enqueueUpload` (or the equivalent wrapper under `apps/desktop/src/main/sync/`)

### Requirement: UI foundation layer — shadcn/ui primitives with light and dark themes

The renderer SHALL use shadcn/ui as its primitive component source, initialized via `npx shadcn@latest init` and generated into `apps/desktop/src/renderer/src/components/ui/` as in-repo source (not a runtime dependency). The generated primitive set SHALL include at minimum `button`, `card`, `badge`, `dialog`, `dropdown-menu`, `progress`, `tooltip`, `input`, `label`, `skeleton`, and `sonner`.

The renderer SHALL ship BOTH the shadcn default light ("white") theme and the default dark theme as CSS variables. The dark theme SHALL be activated by the presence of the `.dark` class on the `<html>` element; its absence SHALL result in the light theme. Both theme variable sets SHALL be defined in the renderer's global stylesheet and SHALL cover every token shadcn generates (background, foreground, muted, primary, secondary, accent, destructive, border, input, ring, card, popover, and their `-foreground` variants).

The renderer SHALL provide a user-facing theme switcher with exactly three options: Light, Dark, and System. The selection SHALL persist across app restarts via `localStorage` under a stable key. Before the React tree mounts, an inline bootstrap script SHALL resolve the effective theme (explicit `localStorage` preference if present, otherwise `prefers-color-scheme`) and set or clear `.dark` on `<html>` so the first paint matches the final theme (no flash of wrong theme).

Primitives SHALL meet a defined accessibility baseline: every interactive primitive has a visible focus ring whose contrast against its background meets WCAG 2.2 non-text contrast (3:1); keyboard activation matches native semantics; composite primitives (`Dialog`, `DropdownMenu`, `Tooltip`) delegate to the corresponding `@radix-ui/react-*` package for focus trapping and ARIA. Feature code SHALL consume colour and spacing through Tailwind utilities that resolve against the token CSS variables (e.g. `bg-background`, `text-foreground`), NOT through hex / rgb / named-colour literals.

#### Scenario: Both themes ship and are activated via `.dark` on `<html>`

- **WHEN** the renderer's global stylesheet is loaded
- **THEN** a `:root` selector defines CSS variables for the light theme and an `html.dark` (or `.dark`) selector defines CSS variables for the dark theme; removing `.dark` from `<html>` SHALL switch the rendered UI to the light theme without any JavaScript rerun, and adding it SHALL switch to the dark theme

#### Scenario: Theme switcher exposes Light / Dark / System

- **WHEN** the user opens the theme switcher in the dashboard toolbar
- **THEN** the menu presents exactly three options labelled "Light", "Dark", and "System"; selecting one persists the choice to `localStorage` under the app's theme key; selecting "System" removes the explicit preference and falls back to `prefers-color-scheme`; the selected theme is reflected in the rendered UI within one frame

#### Scenario: No flash of wrong theme on cold start

- **WHEN** the app launches with an explicit dark preference stored in `localStorage`
- **THEN** the first painted frame SHALL already be in the dark theme; the `.dark` class SHALL be present on `<html>` before React mounts; a Playwright screenshot taken at first paint SHALL show dark-theme colours, not a flash of the light theme

#### Scenario: Feature code uses token-backed utilities, not colour literals

- **WHEN** a Vitest test scans every `.tsx` file under `apps/desktop/src/renderer/src/features/` and the non-shadcn-generated portion of `components/`
- **THEN** no hex colour literal, no `rgb(` / `hsl(` literal outside the global stylesheet, and no hard-coded `font-size` px literal is present; colour and typography are consumed through Tailwind utility classes (`bg-background`, `text-foreground`, etc.) or the exported token module

#### Scenario: Focus is visible on keyboard navigation

- **WHEN** the user presses Tab through the dashboard and add-dialog
- **THEN** every interactive element displays a focus ring whose contrast against its background meets WCAG 2.2 non-text contrast (3:1), using `:focus-visible` styling (not `:focus`), in both the light and dark themes

#### Scenario: Dialog, DropdownMenu, and Tooltip delegate to Radix

- **WHEN** the `Dialog`, `DropdownMenu`, or `Tooltip` primitive is imported
- **THEN** its implementation (from the shadcn-generated file) delegates to the corresponding `@radix-ui/react-*` package for open/close state, focus trapping, and keyboard interaction; hand-rolled focus management is NOT present

### Requirement: Visual direction — dense-quiet, typography-polished, state-change motion only

The renderer's visual design SHALL target a Linear/Vercel-flavoured dense-quiet aesthetic. The following constraints apply:

**Density and radii.** Card root padding SHALL be `p-4` (16px); dashboard grid gap between cards SHALL be `gap-3` (12px); base body type size SHALL be `text-sm` (14px); section headings SHALL be `text-base`/`text-lg`. No routine surface SHALL use a border radius greater than `rounded-md` (6px); `rounded-lg` (8px) is permitted only on Dialog content. No pill-shaped buttons and no fully-rounded cards SHALL exist in this change's code.

**Typography.** The renderer SHALL load Geist Sans (variable) as the UI font and Geist Mono (variable) for monospace surfaces, via `next/font` so font files ship with the app and nothing is fetched at runtime. All numeric fields on datasource cards (storage usage values, item counts, last-sync timestamps that include digits) SHALL render with the `tabular-nums` Tailwind utility.

**Motion budget.** Motion SHALL be delivered via Tailwind transitions and CSS `@keyframes` only — no runtime motion library SHALL be imported. The permitted motion set is exactly: Dialog content open/close, Dialog overlay fade, DropdownMenu content open/close, Tooltip content open/close, Toast open/close, Card border-colour transition on hover, "syncing" status dot opacity pulse, Skeleton shimmer. All other surfaces SHALL NOT animate. All motion SHALL be wrapped in `@media (prefers-reduced-motion: no-preference)` so users with the reduced-motion OS preference see no shimmer, no pulse, no slide — only instantaneous state changes.

**Depth.** `backdrop-blur` glass treatment SHALL be applied to exactly two surfaces: the Dialog overlay/scrim and the DropdownMenu content panel (plus optionally the Tooltip content at a lower blur intensity). Cards, the dashboard toolbar, the empty-state panel, and all always-visible chrome SHALL NOT use `backdrop-blur` or semi-transparent backgrounds.

**Empty-state illustration.** The empty-dashboard state SHALL render a custom inline SVG illustration (not a `lucide-react` icon, not a stock-illustration-pack asset). The SVG SHALL use CSS variable tokens for colour (`hsl(var(--foreground))`, `hsl(var(--primary))`) so it theme-switches correctly. No external HTTP fetch SHALL be used to load it.

#### Scenario: Density constraints are enforced on cards and dashboard grid

- **WHEN** a Vitest test renders the `DatasourceCard` and the populated `DatasourcesDashboard`
- **THEN** the card root element has classes including `p-4` and not `p-6`/`p-8`; the dashboard grid container has `gap-3` and not `gap-4`/`gap-6`/`gap-8`; every `rounded-*` class present in feature code resolves to `rounded`, `rounded-sm`, or `rounded-md` (never `rounded-lg`, `rounded-xl`, or `rounded-full`) with the single exception of Dialog content

#### Scenario: Geist font is loaded via next/font and applied to UI chrome

- **WHEN** the renderer builds
- **THEN** Geist Sans (variable) is imported through `next/font` (or the `geist` package), exposed as a CSS variable like `--font-geist-sans`, and applied as the UI font via Tailwind's `font-sans` resolving to that variable; no `<link rel="stylesheet" href="https://fonts.googleapis.com/...">` or similar runtime font fetch appears in the rendered HTML

#### Scenario: Numeric card fields use tabular-nums

- **WHEN** a `DatasourceCard` renders fields `itemCount`, `usage.used`, `usage.quota`, or a timestamp containing digits
- **THEN** those text nodes are wrapped in elements whose class list includes `tabular-nums`; digit width SHALL be stable when the value changes

#### Scenario: Motion is bounded to the permitted surface set

- **WHEN** a Vitest test parses every `.tsx` file under `apps/desktop/src/renderer/src/` and every `.css` file under `src/styles/`
- **THEN** no `transition-*` or `animate-*` Tailwind class, and no CSS `animation` / `transition` property, appears outside of: the shadcn-generated `components/ui/` files, the `ThemeSwitcher` component, or the `DatasourceCard` component — and within those, only the animations named in the permitted motion set are referenced

#### Scenario: Reduced motion is honoured

- **WHEN** a test sets `prefers-reduced-motion: reduce` and triggers any animated surface (dialog open, skeleton render, syncing badge)
- **THEN** the surface renders in its final state with no transition or keyframe playing; a computed-style assertion confirms `animation-duration: 0s` (or equivalent) on the affected elements

#### Scenario: Glass treatment is limited to overlays

- **WHEN** a Vitest test inspects the rendered DOM for `backdrop-blur-*` classes or `backdrop-filter` inline styles
- **THEN** matches appear only on Dialog overlay, Dialog content, DropdownMenu content, or Tooltip content; no card element, toolbar element, or empty-state-panel element has `backdrop-blur-*` applied

#### Scenario: Empty state renders the custom illustration, not a lucide icon

- **WHEN** the dashboard renders the empty state
- **THEN** an inline `<svg>` element with a distinguishing attribute (e.g. `data-illustration="empty-datasources"`) is present in the DOM, its `fill` / `stroke` resolve to CSS variables (`var(--foreground)`, `var(--primary)`), and no `lucide-react` icon is used as the primary empty-state visual

### Requirement: Renderer subscribes to the datasource event stream

The renderer SHALL expose a typed subscription surface `window.api.datasources.onEvent(callback): () => void` that delivers every engine-emitted `DatasourceEvent<T, K>` to the callback. The callback parameter SHALL be generically typed so TypeScript narrowing via `switch (e.datasourceType)` and `switch (e.event)` works at the consumer call site without manual casts. The returned function SHALL unsubscribe the callback. The subscription SHALL be available after the preload `contextBridge.exposeInMainWorld` runs and before the first React render.

#### Scenario: onEvent delivers typed events

- **WHEN** a renderer test subscribes via `window.api.datasources.onEvent(cb)` and the main process emits a `file-created` event for an `amazon-s3` datasource
- **THEN** `cb` is invoked once with an event whose `datasourceType === "amazon-s3"` and whose `payload` type narrows (under `switch`) to S3's `file-created` payload shape

#### Scenario: Unsubscribe stops delivery

- **WHEN** a renderer test obtains an unsubscribe function from `onEvent` and calls it
- **THEN** subsequent main-process emissions do not invoke the callback

#### Scenario: Dashboard store reconciles optimistic state with events

- **WHEN** a user triggers an upload via a card quick-action, the optimistic-UI path marks the card as `status === "syncing"`, and the main process later emits `file-created` for that datasource
- **THEN** the store transitions the card's status to `"connected"` (or whichever terminal status the engine reports), within one animation frame of the event being delivered

### Requirement: `datasources:event` IPC channel is the single event path

The main process SHALL forward engine events to the renderer over a one-way IPC channel constant `DATASOURCES_CHANNELS.event === "datasources:event"` defined in `packages/ipc-contracts`. The renderer SHALL NOT receive datasource event data through any other channel (including `datasources:upload:progress`, which remains scoped to the legacy upload progress event only during the transition window). The preload SHALL expose exactly one entry point (`window.api.datasources.onEvent`) for this channel; renderers SHALL NOT reach for `ipcRenderer` directly.

#### Scenario: Channel constant is defined in the shared contract

- **WHEN** a test imports `DATASOURCES_CHANNELS` from `@ft5/ipc-contracts`
- **THEN** the object contains `event: "datasources:event"`; the main-process forwarder and the preload both reference this constant rather than string-literal duplicates

#### Scenario: Renderer never accesses ipcRenderer directly for events

- **WHEN** a Vitest test scans every `.ts` / `.tsx` file under `apps/desktop/src/renderer/`
- **THEN** no file imports `ipcRenderer` from `electron`; event subscription is always via `window.api.datasources.onEvent`

### Requirement: Datasource card reflects active sync and upload jobs

`DatasourceCard` SHALL derive display state from the union of (a) the existing datasource-event stream and (b) the new sync-event stream (`window.api.sync.onEvent`) plus the initial `sync-state-seed`. The mapping SHALL be:

- **Active sync indicator.** If there is any job for this `datasourceId` with `kind === 'sync'` AND `status ∈ {running, queued, waiting-network}`, the card's `status` SHALL be `'syncing'` regardless of other engine-reported state (sync trumps idle for display purposes).
- **Active upload progress bar.** If there is at least one job with `kind === 'upload'` AND `status === 'running'` for this `datasourceId`, the card SHALL render a compact progress bar positioned below the card header. The bar SHALL track the progress of the most-recently-started upload (tiebreaker: `startedAt` descending, then `jobId` lexicographically). When the tracked job terminates, the bar SHALL switch to the next-newest active upload, or disappear if none remain.
- **Waiting-network badge.** If a job is in `status === 'waiting-network'` for this datasource, the card SHALL display a small badge or indicator distinguishing "waiting for network" from "queued" or "running." (Minimal visual — implementation may use an icon + tooltip rather than a full badge element, at designer discretion, as long as assistive tech can announce the state.)

These display rules SHALL be computed in a pure derivation from the renderer's in-memory job state; no additional IPC call SHALL be required per card render.

#### Scenario: Sync state trumps idle on card display

- **WHEN** the engine reports a datasource as `idle` on `datasources:event` AND the sync seed includes a running sync job for the same datasource
- **THEN** the card displays `status: 'syncing'` with the existing pulse animation; toggling the ordering of the two event arrivals does not affect the final rendered state

#### Scenario: Upload progress bar tracks the most recent running upload

- **WHEN** two upload jobs for the same datasource start at `t=0` and `t=1 ms`, and both emit `job-progress` events independently
- **THEN** the card's progress bar displays the progress of the `t=1` upload exclusively; when that upload completes, the bar switches to the `t=0` upload; when both complete, the bar unmounts

#### Scenario: Waiting-network is visually distinct from running

- **WHEN** a sync job for a card's datasource transitions to `waiting-network`
- **THEN** the card's syncing indicator persists but gains a distinguishing visual (icon change, modified tooltip, or small badge) such that a user can differentiate "actively working" from "paused awaiting network"; the semantic change is announced via ARIA (e.g., `aria-live` region update or an `aria-label` change on the indicator)

#### Scenario: Seed event applies before live events

- **WHEN** a renderer mounts, a seed event arrives listing `jobs: [{ kind: 'sync', status: 'running', datasourceId: 'ds-1' }]`, and shortly after a `job-completed` live event arrives for the same job
- **THEN** the card for ds-1 briefly shows `syncing`, then transitions to `idle` (or whatever the engine-derived state says) within one frame of the live event; no display flicker in between

### Requirement: Renderer stores zero credential material

The renderer SHALL NOT, at any point, receive, cache, or persist credential material for any datasource. Credential intents that require user input (e.g., the OAuth browser-window flow, the credentials-form dialog for S3) SHALL be mediated by the main process: the renderer sends the user's intent to main, main forwards to the service via `window.api.sync.authenticate`, and the service's `ConfigFileCredentialStore` is the ultimate sink. The renderer SHALL receive only a success / failure boolean (plus a sanitized `AuthResult` that does NOT include token strings in payloads crossing the contextBridge for *persistence*; transient display of connection confirmation is permitted).

Any renderer module that previously imported `SqliteCredentialStore` directly (there should be none, per existing boundary rules, but verified here) SHALL fail to compile after this change because the symbol is deleted.

#### Scenario: Renderer has no credential storage API

- **WHEN** a Vitest test grep-scans `apps/desktop/src/renderer/` for the symbols `safeStorage`, `SqliteCredentialStore`, `CredentialStore`, `encryptString`, `decryptString`, `credentials.json`, `datasource_credentials`
- **THEN** no match is found except possibly in TSDoc comments explicitly marking them as unavailable

#### Scenario: Renderer auth flow routes through service

- **WHEN** a user initiates authentication for a new Google Drive datasource from the renderer
- **THEN** the renderer's call path is `window.api.sync.authenticate(...)` ONLY; no `window.api.datasources.authenticate` exists on the preload; the OAuth browser window (if opened) is launched by the main process via `shell.openExternal`, and the completion code is returned through main → service, never stored in renderer memory beyond the single transaction

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

