## Context

The file explorer renders a full-replace state when `files:list` returns a tagged-error envelope (`file-explorer.tsx` `errorTag` switch). Two of those tags mean "this datasource needs to reconnect," and today they render different components:

- `invalid-datasource` → `InvalidDatasourceState` (via `InvalidDatasourceArm`): an inline view (alert-triangle, heading, **Reconnect** + **Remove**). Reconnect calls `window.api.sync.authenticateStart({ providerId, datasourceId })` and, on `kind === "oauth"`, subscribes via `useAuthSession`; on `_authCompleted`/success the parent runs `store.retryLoad()`.
- `auth-revoked` → `AuthRevokedState`: an amber "Sign in again" view whose Reconnect prop is wired to `handleReconnect` in `file-explorer.tsx`, which is just `router.push("/")` — it navigates to the dashboard and does no inline reauth.

`errorTag` is **not** provider-specific in principle (`invalid-datasource` = credentials missing; `auth-revoked` = dead token), but in practice users see a per-provider difference because Google Drive raises `auth-revoked` on insufficient OAuth scope (`googledrive-client.ts` scope-sufficiency gate from `fix-drive-listdirectory-scope-drift`) while other reconnect-needed conditions surface as `invalid-datasource`. The mapping is coincidental on the user's particular state, not an inherent provider trait.

Separately, **all** reconnect surfaces (file-explorer states and dashboard card banners) only act on the OAuth branch of `authenticateStart`; the `credentials-form` branch is silently ignored, so Amazon S3's "Reconnect" does nothing.

The credential forms already own the authenticate flow (`add-dialog.tsx` dispatches purely on `descriptor.credentialsSchema` → `OAuthForm` / `AwsAccessKeyForm` / `CustomForm`, each driving `authenticate{Start,Complete}` and signalling `_authCompleted`). `OAuthForm` already accepts a `datasourceId` ("present on reconnect path only"); `AwsAccessKeyForm` / `CustomForm` do not.

**Verified service-side support (sizes this change to renderer-only):** `authenticate-start.ts` applies `params.datasourceId ?? ds-${randomUUID()}` to **both** the OAuth and credentials-form branches and threads it into `factory.createForAuth(..., datasourceId)`; `authenticate-complete.ts` writes credentials at `metadata.datasourceId` (engine `credentialStore.put(this.datasourceId, ...)`) and returns that **same** id — it does not mint a new datasource. So credentials-form reconnect via `datasourceId` is already supported end-to-end; only the renderer never passes the id.

## Goals / Non-Goals

**Goals:**

- One shared reconnect-required view in the explorer, rendered for both `auth-revoked` and `invalid-datasource`.
- Reconnect works for every datasource type: OAuth opens the browser directly; credential-based providers reconnect via their inline keys form, targeting the existing datasource.
- Remove the `auth-revoked` navigate-to-dashboard behaviour (the "nothing happens" defect).
- Inline error feedback on a failed Reconnect, instead of a silent button re-enable.

**Non-Goals:**

- The dashboard **card** reconnect banners (`card.tsx` `AuthErrorBanner` / `InvalidDatasourceBanner`) — they share the OAuth-only limitation but are out of scope here; tracked as a follow-up rather than bundled.
- The `disconnected` (offline) state — that is a network retry (`DisconnectedState`), not a reconnect, and stays as-is.
- Any change to `fs-sync-service`, `fs-datasource-engine`, IPC contracts, or the OAuth/credentials-form wire shapes.
- No new dependencies.

## Decisions

### Decision 1 — One shared reconnect view for both tags

Generalize today's `InvalidDatasourceState` **in place** so it renders for both `auth-revoked` and `invalid-datasource`. Delete `states/auth-revoked.tsx` and its test; route `auth-revoked` through the same arm in `file-explorer.tsx`. The visual is the inline view the user identified as best (alert-triangle icon, heading, Reconnect + Remove) — the amber sign-in view is retired.

**Keep the component name `InvalidDatasourceState` and the `file-explorer-state-invalid-datasource` testid** (both tags render the same component + testid). Renaming to e.g. `ReconnectRequiredState` is deliberately deferred: the file-explorer spec and tests couple to the current name in requirements this change does not functionally touch (the Remove-confirm requirement, the WCAG testid refs), so a rename would cascade churn without changing user-facing behaviour. A focused follow-up can rename if desired. The component does gain a clear doc comment that it now serves both reconnect-needed tags.

_Alternative considered:_ rename to `ReconnectRequiredState` now. Rejected for this change — cross-cutting name churn (spec + tests) for no UX gain; the user's "make it proper" is about the consistent view, not the internal symbol.

_Alternative considered:_ keep two components but make them visually identical. Rejected — "common among all datasources" means one code path, not two that happen to look alike; two components drift again.

### Decision 2 — Reconnect dispatches on `credentialsSchema` (no provider-id branches)

The Reconnect action dispatches on the provider's `credentialsSchema`, resolved from the descriptor (`providers[providerId]`), the same extensible pattern as `add-dialog.tsx`'s `selectFormComponent` (no `providerId === "..."` branches anywhere):

- **OAuth** (`google-drive`, `onedrive`): clicking Reconnect calls `authenticateStart({ providerId, datasourceId })` **directly** → browser opens; `useAuthSession(correlationId)` drives Connecting…/failed/timeout. This preserves the exact one-click OAuth behaviour the user called best — no intermediate form or dialog is introduced for OAuth.
- **Credentials-form** (`amazon-s3`, custom): clicking Reconnect **expands the keys form inline** (replacing the prompt with `AwsAccessKeyForm` / `CustomForm`), with a Back affordance to return to the prompt.

_Alternative considered:_ render the dispatched `FormComponent` inline for **all** schemas (including `OAuthForm` for OAuth). Rejected — `OAuthForm` adds an intermediate "Connect {provider}" step, which changes the liked one-click OAuth behaviour.

_Alternative considered:_ open the credentials form in an Add-style dialog. Rejected — the user chose inline so they stay in the explorer surface.

### Decision 3 — Thread `datasourceId` into the credential forms

Add a `datasourceId?` prop to `AwsAccessKeyForm` and `CustomForm` and thread it into their `authenticateStart` call (mirroring `OAuthForm`). On `_authCompleted` the parent runs `store.retryLoad()` and the unified view transitions out as `files:list` succeeds. This is the actual fix for S3's silent no-op — the service already re-auths the existing datasource when given its id (see Context).

### Decision 4 — Provider identity comes from the summary, never the error

The unified view reads `providerId` from `summary.providerId` (already threaded into `FileExplorerProps.providerId` and passed to the invalid arm). It MUST NOT read provider from the engine error: `resolve-client.ts` emits a placeholder `providerId` ("google-drive") when credentials are null, so the error is not a trustworthy source. When `providerId` is undefined (isolation/unit tests mount the component without it), Reconnect is `aria-disabled` with an explanatory tooltip — preserving the current `InvalidDatasourceState` behaviour. Routing `auth-revoked` through this view makes that arm `providerId`-dependent for the first time; sourcing from the summary keeps it reliable.

### Decision 5 — Surface failed-reconnect feedback inline

Keep the existing failed/cancelled/timeout inline copy + retry from `useAuthSession`. Additionally, when `authenticateStart` resolves `{ ok: false }` (e.g. `service-config-missing` / engine-error), surface inline copy rather than silently re-enabling the button (today's file-explorer states only show `isFailed` on session cancelled/failed/timeout, not on `res.ok === false`). Keep the existing **Remove datasource** secondary action (opens the shared `ConfirmRemoveDatasourceDialog` via the arm).

## Visual direction

_Resolved in the Workflow step-4 visual-refinement pass (user-approved 2026-06-20)._

**Prompt (both tags), reused verbatim.** Keep the existing `InvalidDatasourceState` scaffolding unchanged: centered column, 40px `text-destructive` `AlertTriangle` icon, `text-[15px]` heading "This datasource needs reconfiguring", `text-[13px]` muted body, `mt-2` button row (Reconnect primary + Remove `ghost`/`text-destructive`). The same copy serves both `auth-revoked` and `invalid-datasource` — the user wanted OneDrive's exact view, so no copy is invented. The amber `KeyRound` "Sign in again" treatment is retired.

**Inline credentials-form arm — "keep header, form below" (chosen).** When a non-OAuth datasource's Reconnect is clicked, the column keeps the `AlertTriangle` icon and a short heading for context (`Reconnect {providerDisplayName}`, e.g. "Reconnect Amazon S3" — `providerDisplayName` is already passed to the form), and the existing `AwsAccessKeyForm` / `CustomForm` renders **below** it (the body + action buttons of the prompt are replaced by the form; the icon + heading remain). The form is reused as-is — its four stacked fields (Access key ID / Secret access key / Region / Bucket), its `Back` button (returns to the prompt), and its `Connect {providerDisplayName}` submit. Widen the form container to ~`max-w-sm` (≈384px) so the inputs are not cramped by the prompt's ~320px body-text cap; the `max-w` cap only applies to the form arm, the prompt text stays width-capped as today.

**Accessibility.** Preserve `role="alert"` / `aria-live="polite"` on the prompt; the inline form keeps its existing `aria-label`; the `aria-disabled` + tooltip path is retained for the no-`providerId` case; WCAG AA contrast on the destructive icon/text (red-600 on white ≥ 4.83:1). No `animate-spin` (the `scripts/motion-budget.test.ts` guardrail) — pending states use the label-swap to "Connecting…" only.

## Risks / Trade-offs

- **Routing `auth-revoked` through a `providerId`-dependent view** → Mitigation: provider comes from `summary.providerId` (Decision 4), never the error; the no-`providerId` path degrades to an `aria-disabled` Reconnect with a tooltip, never a crash.
- **Prose over-claiming a provider→tag law** → Mitigation: the design treats the OneDrive=`invalid-datasource` / Drive=`auth-revoked` split as coincidental on user state; the unified view is correct regardless of which provider hits which tag, so the mapping need not be pinned down.
- **Credentials-form reconnect via `datasourceId` has zero existing callers** (server-supported but never exercised end-to-end) → Mitigation: an apply-time test MUST assert `authenticateStart` receives the existing `datasourceId` and that the existing id is reused (no new `ds-*` minted).
- **Behaviour change for `auth-revoked`** (navigate-away → inline reauth) → Acceptable and intended; this is the reported defect. Captured as **BREAKING** (UI behaviour) in the proposal and as a REMOVED behaviour in the file-explorer spec delta with Reason + Migration.

## Migration Plan

Renderer-only; ships in one change. No data migration, no wire change, no rollback coordination beyond reverting the renderer commit. Existing persisted datasources are unaffected — reconnect reuses their ids.

## Open Questions

None — service-side `datasourceId` support for the credentials-form path was verified during design (see Context). Remaining verification is an apply-time test obligation (Risks).
