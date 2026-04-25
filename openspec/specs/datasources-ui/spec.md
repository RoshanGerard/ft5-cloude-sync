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

### Requirement: Upload action uses the main-process file picker, never the renderer

The "Upload from local…" quick action SHALL call `window.api.datasources.upload({ datasourceId })`, which in the main process opens a native OS file picker via `dialog.showOpenDialog`. The renderer SHALL NOT render or reference a `<input type="file">` element for this flow.

The main-process handler SHALL enqueue the selected file as an upload job on the fs-sync service via `sync:enqueue-upload`; it SHALL NOT invoke the engine's `uploadFile` directly in-process. The returned `jobId` SHALL serve as the `transactionId` returned to the renderer. Upload progress SHALL be delivered from main to renderer via the existing one-way IPC event channel `DATASOURCES_CHANNELS.uploadProgress`, scoped to the upload transaction id; the underlying source SHALL be service-emitted `job-progress` events, translated into the existing `DatasourcesUploadProgressEvent` shape. The renderer SHALL NOT need to know whether the upload is service-backed; the existing call sites SHALL continue to compile and function without edit.

Uploads SHALL survive desktop app quit. Closing the desktop window (or even `app.quit`) SHALL NOT cancel or stall the underlying service-side upload job. Progress events emitted by the service while the desktop is closed SHALL be accessible to a subsequent desktop session via the app-open `sync-state-seed` (see the `fs-sync-supervisor` capability).

#### Scenario: Renderer contains no file input for the upload flow

- **WHEN** the upload quick action is invoked
- **THEN** no `<input type="file">` or web File API reference is present in the rendered DOM tree, and the file-picker UI is the OS-native `dialog.showOpenDialog` surface

#### Scenario: Upload progress events are typed and scoped per transaction

- **WHEN** an upload is initiated
- **THEN** the main process emits progress events on `DATASOURCES_CHANNELS.uploadProgress` keyed by a `transactionId` equal to the service's `jobId`; the renderer subscribes only to events matching that id; an emission for an unrelated id is ignored by the renderer

#### Scenario: Upload survives desktop quit

- **WHEN** a user triggers an upload of a 100 MB file against a rate-limited provider that takes 30+ seconds, then closes the desktop window after 2 seconds
- **THEN** the service-side job continues running; its `jobs` table row remains in `status = 'running'` (or `waiting-network` if the connection drops); a new desktop launch 40 seconds later sees `status = 'completed'` in the seed (or, if still running at relaunch, sees the live progress resume on the card)

#### Scenario: Main handler does not call engine.uploadFile directly

- **WHEN** a Vitest test grep-scans `apps/desktop/src/main/ipc/datasources/` for `uploadFile` invocations or `engine.uploadFile`
- **THEN** no match is found; the only call the handler makes for upload is to the `SyncClient.enqueueUpload` helper (or the equivalent wrapper in the `sync/` subdirectory)

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

