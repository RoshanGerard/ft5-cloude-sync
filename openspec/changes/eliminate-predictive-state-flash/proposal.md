# Proposal: Eliminate predictive-state flash in the file explorer

**Status**: Stub. Spawned by Risk #3 in `add-invalid-datasource-state`'s
`design.md` on 2026-04-25.

## Why

Per `wire-file-explorer-to-service` Decision 3 (engine wins), the
file-explorer MAY consult `summary.status` / `summary.errorKind` from
the datasources store to render a *predictive* initial state before
the first `files:list` response arrives — for example, showing
`<SyncingState>` while the store says `syncing`, or showing
`<InvalidDatasourceState>` while the store says
`errorKind: "invalid-datasource"`. The engine response, when it
arrives, is authoritative and can disagree with the predictive hint.

When the predictive hint and the engine response disagree, the user
sees a brief flash: the predictive state renders for ~50–250ms, then
the engine response replaces it with a different state (or with
populated entries). On fast networks the flash is barely perceptible;
on slow networks or first-time-mount cases it can be jarring.

This change explores ways to reduce or eliminate the flash without
violating the engine-wins invariant.

## Out of scope

- Changing the engine-wins invariant. The engine response remains
  authoritative.
- Removing predictive state entirely — that would mean every initial
  mount shows skeleton until the network round-trip completes,
  hurting the steady-state UX where store and engine almost always
  agree.

## Open questions (resolve during `/opsx:propose`)

1. **Strategy**: which approach reduces the flash best?
   (a) Add a small render-delay (e.g., 100ms) before showing the
       predictive state — "skeleton first, predictive only if the
       engine call hasn't returned by 100ms". Risks: more flicker
       at the skeleton boundary on slow networks.
   (b) Render the skeleton + the predictive state's IDENTITY hint
       (e.g., a small "expected: invalid-datasource" badge) so the
       user has context but the layout doesn't fully shift.
   (c) Defer rendering the predictive state until the engine response
       arrives, then commit to either the predictive arm OR the
       engine arm — never both. This is essentially "wait for
       engine, don't predict" — counter-proposal that reduces flash
       but loses the predictive benefit.
   (d) CSS transition (e.g., 150ms fade) between predictive and
       engine state to soften the flash. Cheapest implementation,
       lowest UX impact.
2. **Measurement**: do we have telemetry to know how often this
   flash actually fires in the wild? If <1% of mounts, this might be
   YAGNI. If >5%, worth fixing. Need data first.
3. **Scope**: which states are most affected?
   (a) Disconnected — store often agrees with engine, low flash rate
   (b) Auth-revoked — moderate flash rate
   (c) Invalid-datasource (new) — likely high flash rate when the
       service has not yet pushed a status-changed event
   (d) Syncing — already debounced; low flash rate
4. **Interaction with `useExplorerData`'s stale-response guard**:
   the existing guard handles the navigate-mid-flight case. Does the
   anti-flash strategy need to coordinate with it?

## Acceptance criteria (once promoted)

- The chosen strategy is documented in design.md with measurement
  data (or a justification for proceeding without).
- A composite test demonstrates the flash is eliminated (or
  measurably reduced) for at least the invalid-datasource case.
- No regression in the existing predictive-state behavior for
  syncing / disconnected / auth-revoked.
- WCAG AA accessibility unchanged (transitions and delays do not
  break screen-reader announcement timing).

## Provenance

- Spawned by `add-invalid-datasource-state` design.md Risk #3 on
  2026-04-25.
- Risk text quoted: "Predictive state from `summary.errorKind` could
  flash before the engine response arrives. → Per Decision 3 of
  `wire-file-explorer-to-service` (engine wins), the predictive hint
  is OK. The `<InvalidDatasourceState>` may render briefly while
  `useExplorerData` is in flight; once the response arrives the
  errorTag is authoritative. Acceptable per the established
  precedent."
- Marked as "acceptable per the established precedent" in the
  parent change — promote this stub only if the flash becomes a
  user-reported issue or telemetry shows it's frequent.
