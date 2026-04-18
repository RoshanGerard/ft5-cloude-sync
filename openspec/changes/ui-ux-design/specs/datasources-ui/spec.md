## ADDED Requirements

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

#### Scenario: Quick-action menu exposes pause, sync-now, upload, settings, remove

- **WHEN** the user opens the card's quick-actions control (click, Enter, or Space on the trigger)
- **THEN** a menu opens with these items in this order: "Sync now", "Pause" / "Resume" (label depends on current status), "Upload from local…", "Settings", "Remove". Each item is keyboard-reachable, has an accessible name, and closing the menu restores focus to the trigger

#### Scenario: Error status exposes the error reason

- **WHEN** a `DatasourceCard` renders a summary with `status === "error"`
- **THEN** the card renders the `errorReason` string from the summary as readable text, and the status badge's accessible name includes both "error" and the reason

### Requirement: Add-datasource flow uses a provider-agnostic step sequence

The add-datasource dialog SHALL present a two-step flow: step 1 is a provider picker listing every entry in the `providers` registry with its display name and icon; step 2 is a credential form selected by the chosen provider's `credentialsSchema`. Submitting the credential form SHALL call `window.api.datasources.add({ providerId, credentials })` and, on success, close the dialog and append the new card to the dashboard.

Adding a new provider type to the system SHALL require exactly (a) adding a `ProviderDescriptor` entry to the frozen `providers` registry in `packages/ipc-contracts/`, and (b) if `credentialsSchema` is a value not already supported, adding one new credential-form component under `features/datasources/credential-forms/`. No changes to the dashboard, card, dialog shell, or store SHALL be required.

#### Scenario: Provider picker lists exactly the registered providers

- **WHEN** the add-datasource dialog opens
- **THEN** step 1 renders one selectable option per entry in the `providers` registry — in this change, exactly `google-drive`, `onedrive`, and `amazon-s3` — each with its display name and icon, and no hard-coded provider branches in the dialog component

#### Scenario: Credential step is picked from the descriptor, not the provider id

- **WHEN** the user selects a provider whose `credentialsSchema === "oauth"`
- **THEN** the OAuth credential form component is rendered; swapping the descriptor's `credentialsSchema` to `"aws-access-key"` SHALL cause the access-key form to be rendered instead, without any change to the dialog's code

#### Scenario: Successful add appends a card to the dashboard

- **WHEN** the credential form submits and `window.api.datasources.add(...)` resolves with a `DatasourceSummary`
- **THEN** the dialog closes, the dashboard renders a new `DatasourceCard` for the returned summary in the populated state, and focus returns to the add-datasource trigger in the dashboard toolbar

#### Scenario: Extensibility is enforceable, not just documented

- **WHEN** a hypothetical fourth provider is added to the registry in a test fixture with a new `credentialsSchema`
- **THEN** a Vitest test SHALL render the dialog, select the new provider, and assert that the matching credential form component mounts — failing if the dialog contains provider-id branching

### Requirement: Datasource IPC surface is the single data path

All datasource reads and mutations from the renderer SHALL go through the `window.api.datasources.*` surface. The renderer SHALL NOT import any provider SDK, any `fs`/`child_process`/`electron`/`drizzle-orm` specifier, or any module under `apps/desktop/src/main/` or `apps/desktop/src/preload/`. This requirement is enforced independently of whether the main-process handlers return real or mocked data.

The surface in this change SHALL expose: `list()`, `add(req)`, `remove(req)`, `action(req)` (unified pause / resume / sync-now), and `upload(req)`. Each call SHALL have a typed request/response pair in `packages/ipc-contracts/src/datasources.ts`. Each call SHALL have an `ipcMain.handle` implementation under `apps/desktop/src/main/ipc/datasources/`. Each call SHALL be bound in the preload via `contextBridge.exposeInMainWorld`.

#### Scenario: Renderer has no direct SDK import

- **WHEN** `pnpm lint` runs
- **THEN** ESLint reports an error for any file under `apps/desktop/src/renderer/` that imports from `googleapis`, `@microsoft/microsoft-graph-client`, `@aws-sdk/client-s3`, or any other provider SDK package; a dedicated CI grep step SHALL back the ESLint rule

#### Scenario: Four-layer wiring per IPC method

- **WHEN** a new datasources IPC method is added
- **THEN** the build SHALL require all four layers (contract type, main handler, preload exposure, renderer call site) to be present; missing any one SHALL cause a TypeScript error or a failing contract test in `packages/ipc-contracts/src/__tests__/datasources.test-d.ts`

#### Scenario: Mocked data round-trips through the IPC boundary

- **WHEN** `window.api.datasources.list()` is called in a packaged build during this change's lifetime
- **THEN** the main-process handler SHALL return a hard-coded array of `DatasourceSummary` values (structured-clone-safe), and the renderer SHALL receive that exact payload with all fields typed per the contract

### Requirement: Upload action uses the main-process file picker, never the renderer

The "Upload from local…" quick action SHALL call `window.api.datasources.upload({ datasourceId })`, which in the main process opens a native OS file picker via `dialog.showOpenDialog`. The renderer SHALL NOT render or reference a `<input type="file">` element for this flow. Upload progress SHALL be delivered from main to renderer via a one-way IPC event channel scoped to the upload transaction id.

#### Scenario: Renderer contains no file input for the upload flow

- **WHEN** the upload quick action is invoked
- **THEN** no `<input type="file">` or web File API reference is present in the rendered DOM tree, and the file-picker UI is the OS-native `dialog.showOpenDialog` surface

#### Scenario: Upload progress events are typed and scoped per transaction

- **WHEN** an upload is initiated
- **THEN** the main process emits progress events on an IPC channel keyed by a server-issued `transactionId`; the renderer subscribes only to events matching that id; an emission for an unrelated id is ignored by the renderer

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

## MODIFIED Requirements

### Requirement: Desktop app launches with a single main window

The desktop app SHALL, when launched on macOS, Windows, or Linux, open exactly one `BrowserWindow` that loads the renderer via a custom `app://` protocol handler registered in the main process. The app SHALL NOT expose a local HTTP dev server in production builds. The window's initial route SHALL be `app://./`, which the renderer maps to the datasources dashboard; the ping-wiring probe is relocated to `app://./diagnostics` and is no longer the home view.

#### Scenario: Production launch on a supported platform

- **WHEN** a packaged build is started on macOS, Windows, or Linux
- **THEN** Electron registers the `app://` protocol, creates exactly one `BrowserWindow`, loads the renderer's `index.html` via `app://`, the window becomes visible within 5 seconds, and the visible view on first paint is the datasources dashboard (loading, empty, or populated state per the dashboard requirement), NOT a timestamp or diagnostics output

#### Scenario: Second instance prevented

- **WHEN** a second instance of the packaged app is launched while the first is running
- **THEN** the main process calls `app.requestSingleInstanceLock()`, the second instance exits, and the original window is focused

#### Scenario: Diagnostics route remains reachable for wiring verification

- **WHEN** the user navigates to `app://./diagnostics` (deep link) or triggers the developer shortcut `Ctrl/Cmd + Shift + D`
- **THEN** the renderer displays the ping probe's result, the existing `ping` IPC wiring is exercised unchanged, and the Playwright end-to-end test at `apps/desktop/e2e/ping.spec.ts` navigates to `/diagnostics` to assert the ping round-trip
