# Design: add-invalid-datasource-state

## Context

The file-explorer feature today branches its `files:list` error envelope
on a 4-tag union (`auth-revoked | disconnected | rate-limited | other`)
and renders Pattern-A full-replace state components for the first two.
Anything else falls through to a `<div role="alert">Failed to load:
{error.message}</div>` inline surface. A real-world failure mode the
inline surface handles poorly is a misconfigured datasource: the
sync-service rejects the call before any provider call happens because
(a) the registry has no entry for the requested datasourceId, (b) the
credential file is absent, or (c) the credential's shape does not match
the declared `providerKind`. Today these surface as a terse "Failed to
load: no credentials registered for datasourceId=…" line — the user has
no actionable next step.

The dashboard card has the same problem: its `AuthErrorBanner` only
renders for `errorKind === "auth-revoked" | "auth-expired"`; everything
else surfaces as raw `errorReason` text below the meta row.

The `DatasourceErrorTag` (engine-side, 9 variants) and `FilesErrorTag`
(envelope, 4 variants) are both string-literal unions today. The
codebase convention for constant sets elsewhere (`FILES_CHANNELS`,
`DATASOURCES_CHANNELS`, `providers`) is `as const` objects with a
derived type. The literal-union shape predates this convention and has
no constant ref for refactor-safety / autocomplete / runtime
iteration.

## Goals / Non-Goals

**Goals:**

- Surface misconfigured datasources as a Pattern-A full-replace state
  in the file-explorer, distinguishable from the existing
  `disconnected` / `auth-revoked` / `rate-limited` / `other` arms via
  a dedicated tag (`invalid-datasource`).
- Surface the same condition on the dashboard card via a banner
  mirroring the existing `AuthErrorBanner` so the user does not need
  to open Explore to see the actionable Reconnect / Remove offer.
- Cover three trigger conditions: registry drift (datasourceId unknown
  to the service), missing credential file, wrong credential shape for
  the declared `providerKind`.
- Convert `DatasourceErrorTag` and `FilesErrorTag` from string-literal
  unions to `as const` objects with derived types, matching the
  existing convention. Net-new code uses the constant ref;
  pre-existing literal call sites continue to type-check unchanged.
- Reuse existing infrastructure: the `useConsentSession` hook for
  Reconnect lifecycle, `useDatasourceActions().remove` for Remove,
  shadcn `Dialog` for confirm.

**Non-Goals:**

- Cover permanent provider revocation (account deleted, scope change
  beyond auth-revoked). Stays under the existing `auth-revoked` tag.
- Mechanically migrate 262+ existing literal references like
  `"auth-revoked"` to `DatasourceErrorTag.AuthRevoked`. Existing
  literals continue to type-check; future cleanup change can migrate
  on its own schedule.
- Add new IPC channels or sync-service RPC commands. Reuses
  `datasources:start-consent` and `datasources:remove`.
- Handle dashboard ↔ explorer cross-surface coordination beyond what
  the existing event bus already provides (status-changed event is
  enough; no explicit signal needed).
- Touch the engine's per-strategy `normalizeError` (Drive / OneDrive /
  S3). Provider-side errors continue to map through the existing
  vocabulary.
- Pagination, search, rename, download — all out of scope.

## Decisions

### Decision 1: Refactor `DatasourceErrorTag` and `FilesErrorTag` to const objects, but do not migrate existing literal call sites

**Choice:** Convert both unions in `packages/ipc-contracts/src/{fs-datasource-engine,files}.ts` to the `as const` object + derived-type pattern:

```typescript
export const DatasourceErrorTag = {
  AuthExpired: "auth-expired",
  AuthRevoked: "auth-revoked",
  // ...
  InvalidDatasource: "invalid-datasource",
} as const;
export type DatasourceErrorTag =
  (typeof DatasourceErrorTag)[keyof typeof DatasourceErrorTag];
```

Net-new code in this change references via `DatasourceErrorTag.InvalidDatasource`.
The 262+ existing literal occurrences (143+ for DatasourceErrorTag,
119+ for FilesErrorTag, counted via `rg`) continue to type-check
because the derived type is the same string union. No mechanical
migration in this PR.

**Alternatives considered:**

- **Migrate all 262+ literals in this PR.** Rejected — bloats the
  diff with mechanical churn that delivers no behavior change. Fails
  CLAUDE.md's "Don't add features, refactor, or introduce
  abstractions beyond what the task requires" guidance for the
  unrelated literals; the new tag is the actual task.
- **Keep both unions as string literals.** Rejected — loses the
  refactor-safety + autocomplete benefit; perpetuates an
  inconsistent style with the rest of the contracts package.
- **Use TS `enum` keyword.** Rejected — codebase has zero `enum`
  usage; modern TS guidance prefers `as const` objects (smaller
  bundle, tree-shakeable, no numeric/string ambiguity, friendly to
  `verbatimModuleSyntax`).

**Why:** Minimum invasive change that enables future migration on a
separate schedule while landing the new tag using the better pattern
from day one.

### Decision 2: Detection in the engine layer only — single choke point at `resolveClient`

**Choice:** All three trigger conditions are detected at the engine
boundary, not in the per-command sync-service handlers.

- **`factory.create(providerId, datasourceId, creds, ...)`** in
  `packages/fs-datasource-engine`: throw
  `new DatasourceError({ tag: DatasourceErrorTag.InvalidDatasource, ... })`
  for unknown providerId or wrong-shape credential.
- **`resolveClient`** in `services/fs-sync/src/main/bootstrap.ts:189`:
  replace the existing
  `throw new Error("no credentials registered for datasourceId=…")`
  with `throw new DatasourceError({ tag: DatasourceErrorTag.InvalidDatasource, datasourceId, retryable: false, message: "Credentials are missing — reconnect this datasource" })`.

Per-command handlers (`files-list.ts`, `files-stat.ts`,
`files-search.ts`, `files-remove.ts`) stay unchanged — their
existing `try/catch → normalizeFilesError` flow propagates the new
tag automatically.

**Alternatives considered:**

- **Per-command pre-flight checks.** My first-pass design had each
  `files:*` handler call `serviceRegistry.has(id)` and
  `credentialStore.get(id)` before delegating to the engine. Rejected
  by user push-back during brainstorming: duplicates logic across
  four commands, two-tier risk where service check disagrees with
  engine check.
- **Detect at the per-strategy `normalizeError` level.** Rejected —
  by the time a request reaches a strategy, the credential has
  already been loaded and a client constructed; that's the wrong
  layer. Misconfiguration is detected EARLIER, before any provider
  request goes out.

**Why:** Single source of truth, minimum code surface, and the
executors (`upload`, `mirror-sync`) that share the `resolveClient`
port get free coverage — the dashboard card learns about misconfig
even when the user never opens the file-explorer.

### Decision 3: Reconnect runs in-place from the explorer; no dashboard redirect

**Choice:** When the user clicks Reconnect from the
`<InvalidDatasourceState>` component, call
`window.api.datasources.startConsent({ providerId, datasourceId })`
directly (mirroring the dashboard `AuthErrorBanner` lifecycle in
`card.tsx:283-326`). Capture `sessionId`; subscribe via
`useConsentSession(sessionId)`. While `status === "pending"`, render a
spinner + "Connecting…" copy and disable both action buttons. On
`status === "completed"`, call `store.retryLoad()` so
`useExplorerData` re-dispatches `files:list`; the engine now resolves
the credential successfully, the response is `ok: true`, and the
component naturally transitions out of the state. On
`cancelled`/`failed`/`timeout`, re-enable the buttons + show an
inline "Reconnect failed — please try again" line.

**Alternatives considered:**

- **`router.push("/")` back to the dashboard.** Rejected — loses the
  user's context (they were inside the explorer for a reason); their
  navigation history (back/forward stack) gets disrupted.
- **A separate "Reconnect" route or full-screen modal.** Rejected —
  introduces a new surface for one button click; the in-place
  spinner + button-disable affordance is the standard pattern this
  codebase already uses for `AuthErrorBanner`.

**Why:** Symmetry with `AuthErrorBanner`, minimum disruption to the
user's workflow, no new route surface.

### Decision 4: Threading `providerId` through to the explorer state component

**Choice:** Add a sibling `providerId?: string` prop to
`FileExplorer` (alongside the existing `providerKind` prop). Passed
in from the route layer where `summary.providerId` is in scope.
Forwarded to the new `<InvalidDatasourceState>` component so it can
construct the `startConsent` request directly — mirroring the
existing `AuthErrorBanner` pattern in `card.tsx:283-326`, which
also owns its `startConsent` call inline. The component takes
`providerId?: string`, `datasourceId: string`,
`onReconnectSucceeded: () => void` (parent wires this to
`store.retryLoad()` so the explorer transitions out of the state),
and `onRequestRemove: () => void` (parent owns the shared
`<ConfirmRemoveDatasourceDialog>` instance per Decision 5).

**Alternatives considered:**

- **Pull `providerId` from the datasources store via a hook in the
  state component.** Rejected — coupling a state component to the
  store complicates rendering it in isolation in tests.
- **Have the parent do the `startConsent` call and pass an
  `onReconnect: () => void` closure.** Rejected — diverges from the
  established `AuthErrorBanner` pattern, which is the explicit
  visual / behavioural sibling per Decision 3, and the
  `useConsentSession` lifecycle is naturally co-located with the
  component that owns the spinner / disabled-state rendering.
  Splitting it across parent and component for a single button
  click introduces avoidable indirection.

**Why:** Symmetry with `AuthErrorBanner`; the lifecycle hook and
its rendered side-effects (spinner, button-disable, inline error
line) live together. The `providerId` guard for "test renders the
component without it" stays internal to the component.

### Decision 5: Shared `<ConfirmRemoveDatasourceDialog>` for both surfaces

**Choice:** Add a single confirm-dialog component (location:
`apps/desktop/src/renderer/src/features/datasources/confirm-remove-dialog.tsx`)
used by both the explorer-state Remove button AND the dashboard
banner Remove button. Standard shadcn `Dialog` + destructive
button. Copy: "Remove this datasource? This deletes the local
registry entry; cloud files are not deleted." Cancel + Remove
buttons.

**Alternatives considered:**

- **Inline confirm per surface.** Rejected — two implementations of
  the same destructive flow drift over time.
- **Reuse `<ConfirmDeleteDialog>` from file-explorer.** Rejected —
  the file-explorer dialog is for entry deletion (different copy,
  different domain semantics); same shape but mixing them couples
  unrelated features.

**Why:** One destructive flow, one component, easy to test once.

### Decision 6: Reconnect button uses neutral primary color, not destructive-red

**Choice:** In the `<InvalidDatasourceState>` component, the
Reconnect button uses the app's neutral `bg-primary` styling (the
constructive default). The `Remove` button uses
`variant="ghost" size="sm"` with `text-destructive` (red text on
ghost background, lower visual weight). The 40px `AlertTriangle`
icon at the top is rendered in `text-destructive` to carry the
red sentiment.

**Alternatives considered:**

- **Both buttons in red (Reconnect destructive-styled).** Rejected
  per advisor review — inverts the shadcn convention that
  destructive-styled buttons signal destructive actions. Reconnect
  is constructive; styling it red would confuse users.
- **Amber primary Reconnect** (matching disconnected/auth-revoked
  states). Considered; rejected because the user explicitly picked
  the red sentiment in the visual companion. Amber primary on a
  red-icon state would feel inconsistent.

**Why:** The icon carries the red sentiment; button styling matches
action semantics. WCAG: neutral primary already passes AA;
`text-destructive` (red-600) on ghost background passes AA.

### Decision 7: Const-object refactor included in this change despite scope question

**Choice:** This change converts both unions to const objects (per
Decision 1) AND adds the new `InvalidDatasource` member, instead of
splitting into two separate openspec changes.

**Alternatives considered:**

- **Refactor first as a separate change, then add the tag.**
  Rejected by user — two trips through the openspec lifecycle for
  closely related work.
- **Skip the const-object refactor entirely; just add a string
  literal.** Rejected by user — loses the refactor + awareness
  benefit they explicitly asked for.

**Why:** The new tag lands using the new pattern from day one;
existing literals stay valid (Decision 1) so the diff stays
focused.

## Visual direction

- **Aesthetic:** Quiet, utilitarian. Mirrors the existing file-explorer
  Pattern-A states (`disconnected`, `auth-revoked`, `empty`,
  `syncing`). No decorative gradients or illustrations; visual
  hierarchy from spacing and semantic color.
- **Layout pattern (file-explorer state):** Pattern A full-replace —
  centered column with 48px vertical padding, 10px gap between
  elements. The entries area is replaced by:
  - 40px Lucide `AlertTriangle` icon at the top
  - 15px / 600 headline: "This datasource needs reconfiguring"
  - 13px / 400 body at `text-muted-foreground`, max-width 320px,
    text-center: "Its connection details are missing or invalid.
    Sign in again or remove the datasource and add it back."
  - Primary action button: "Reconnect" — neutral
    `bg-primary text-primary-foreground` with 8px top margin
  - Secondary action button: "Remove datasource" — `variant="ghost"`
    `size="sm"` with `text-destructive` styling
- **Layout pattern (dashboard card banner):** Renders inline below the
  meta row (same vertical position as the existing `AuthErrorBanner`).
  Two-line layout: short label "Datasource needs reconfiguring —
  credentials are missing or invalid." on the left;
  `Reconnect` + `Remove` buttons stacked horizontally on the right,
  both `variant="outline"` `size="sm"`. Container:
  `<div data-testid="invalid-datasource-banner" aria-label="Reconfiguration required" class="flex items-center justify-between gap-2">`.
- **Type:** Inherits the project default (system / Tailwind defaults
  via shadcn). No new display typeface. Headline 15px/600, body
  13px/400, banner copy 12px/400 (matches existing card text).
- **Color palette (semantic, Tailwind):**
  - `text-destructive` (red-600 = `#dc2626`) — applied to the
    AlertTriangle icon AND the secondary Remove button text. WCAG AA:
    `#dc2626` on white = 4.83:1 (passes for 14px+).
  - `bg-primary text-primary-foreground` — Reconnect button (neutral,
    constructive). The exact primary color follows the app's theme
    tokens — already WCAG AA per shadcn defaults.
- **Iconography:** Lucide `AlertTriangle`, 40px, `aria-hidden="true"`
  (decorative — semantics flow through text).
- **Spacing:** 48px top / 48px bottom padding, 10px gap between
  icon/headline/body/buttons. Matches existing
  `disconnected.tsx` / `auth-revoked.tsx`.
- **Motion:** No motion in the static state. While consent is pending,
  the Reconnect button's label swaps to "Connecting…" and the button
  is disabled (matches the existing `AuthErrorBanner` pattern in
  `card.tsx:316-324`). No animated spinner — Decision 10 of the
  `ui-ux-design` change pins the renderer's motion vocabulary to the
  three whitelisted classes (`animate-skeleton-shimmer`,
  `animate-sync-pulse`, `animate-sync-ripple`); `animate-spin` is
  forbidden in feature code by the `scripts/motion-budget.test.ts`
  guardrail. Reconciled here vs. an earlier draft that mandated
  `Loader2` + `animate-spin` — the standing motion budget overrides;
  the disabled label-swap carries the same visual semantics.
- **Accessibility:**
  - File-explorer state component:
    `<div role="alert" aria-live="polite" data-testid="file-explorer-state-invalid-datasource">`
    so screen readers announce on entry.
  - Dashboard banner: `aria-label="Reconfiguration required"` on the
    container; the buttons have plain visible labels (no extra
    aria-label needed).
  - Both Reconnect and Remove buttons are keyboard-focusable; Tab
    order is Reconnect → Remove → (rest of explorer chrome).
  - Confirm dialog inherits shadcn `Dialog` accessibility (focus
    trap, Escape closes, primary destructive button is the focus
    target on open).
  - WCAG AA contrast verified for `text-destructive` (red-600) on
    white = 4.83:1 ≥ 4.5 (AA for 14px+ normal text).
- **No deviations from WCAG AA.** Flagged none.

## Risks / Trade-offs

- **Const-object migration creates style inconsistency in the
  codebase.** → Existing 262+ literal call sites continue to type-check.
  Future contributors may write either form. Mitigation: Decision 1's
  rationale documents this explicitly; a follow-up cleanup change can
  migrate at its own pace.
- **`factory.create` shape-check requires per-provider knowledge of
  expected credential shape.** → The factory already dispatches per
  `providerId` for client construction; the shape check uses the
  same dispatch. Mitigation: a shared `validateCredentialShape(providerId, creds)`
  helper inside the engine package keeps the per-provider rules in
  one place.
- **Predictive state from `summary.errorKind` could flash before the
  engine response arrives.** → Per Decision 3 of
  `wire-file-explorer-to-service` (engine wins), the predictive hint
  is OK. The `<InvalidDatasourceState>` may render briefly while
  `useExplorerData` is in flight; once the response arrives the
  errorTag is authoritative. Acceptable per the established precedent.
- **User reconnects from explorer, dashboard banner unmounts mid-flight
  due to status-changed event.** → No issue: the explorer's
  `useConsentSession` hook owns its own subscription; the dashboard
  banner unmounting does not affect it. Both paths converge on
  `consent-completed` → `store.retryLoad()`.
- **Race: user clicks Remove while consent is pending.** → Pending
  consent session in main is orphaned; the loopback server times out
  on its own (5min, per existing broker). The route observes the
  `datasource-removed` event and navigates back to `/`. Pending
  `useConsentSession` subscription cleans up on unmount.
- **Const-object refactor for `FilesErrorTag` requires a small update
  to `normalizeFilesError`'s mapping table** — covered by
  `files-error-mapping.test.ts` extension.

## Migration Plan

No data migration. Pure code change.

Roll-out order (per `/opsx:apply` phase sequence, each behind its own
failing test per Superpowers `test-driven-development`):

1. **Refactor `DatasourceErrorTag` to const object** in
   `packages/ipc-contracts/src/fs-datasource-engine.ts`. Add the new
   `InvalidDatasource` member. Run typed tests + the engine package's
   own test suite to confirm no regressions in existing literal
   call sites.
2. **Refactor `FilesErrorTag` to const object** in
   `packages/ipc-contracts/src/files.ts`. Add the new
   `InvalidDatasource` member.
3. **Engine `factory.create` typed-error**: extend factory to throw
   `DatasourceError({ tag: InvalidDatasource })` for unknown
   providerId / wrong credential shape. New unit test.
4. **Sync-service `resolveClient` typed-error**: replace raw `Error`
   throw in `bootstrap.ts:189` with the typed
   `DatasourceError({ tag: InvalidDatasource })`. New unit test.
5. **`normalizeFilesError` mapping**: extend the mapping table to
   route engine `InvalidDatasource` → envelope `InvalidDatasource`.
   Extend `files-error-mapping.test.ts`.
6. **Renderer `<InvalidDatasourceState>`**: new component file +
   tests. Branch in `file-explorer.tsx` for the new errorTag value.
7. **Renderer `<InvalidDatasourceBanner>`**: new component sibling of
   `AuthErrorBanner` in `card.tsx` + tests.
8. **Shared `<ConfirmRemoveDatasourceDialog>`**: new component +
   tests. Wired from both the state component and the banner.
9. **Composite tests**: extend `file-explorer-composite.test.tsx` and
   `states-integration.test.tsx` with the new branch.
10. **End-to-end smoke (manual, surfaced in PENDING_TC.MD)**: real
    GCP datasource → manually delete `~/ft5/sync_app/credentials.json`
    for that id → open Explore → see new state → click Reconnect →
    complete consent → see entries appear. Plus the corruption + Remove
    path.

Rollback: revert the commits. No schema, no persistent state written.

## Open Questions

None at this time. All five open questions from the stub proposal are
resolved (see Decisions above + the brainstorming session that
preceded this design).
