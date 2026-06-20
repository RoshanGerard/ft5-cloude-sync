# Proposal: Lint-enforce the error-tag const-reference convention + close the guard blind-spots

**Status**: Stub. Spawned by `migrate-error-tag-literals-to-const-refs`
design.md Decision 5 + Decision 6 on 2026-06-20.

## Why

`migrate-error-tag-literals-to-const-refs` migrated every raw
`DatasourceErrorTag` / `FilesErrorTag` literal in tag-context to the const
reference and shipped a Vitest grep-scan guard
(`packages/ipc-contracts/src/__tests__/error-tag-const-convention.test.ts`)
that keeps the tree green. Two pieces of enforcement were deliberately
deferred to this follow-up:

1. **ESLint editor-integration rule** (Decision 5). The Vitest guard is a
   CI/test-time backstop; it does not give editor-time feedback or
   auto-fix. A custom ESLint rule (e.g. `no-raw-error-tag-literal`) would
   flag a raw literal as the developer types it and offer a fix to the
   const reference — closing the loop the guard can only catch after the
   fact.

2. **Guard pattern blind-spots** (Decision 6). The Vitest guard matches
   `tag` / `errorTag` / `.tag` construction + comparison + `case` arms.
   It does NOT match sibling string-typed fields that ALSO carry an engine
   tag value verbatim:
   - `lastErrorTag` (the job persistence / `JobSummary` field, typed
     `string`, carrying engine tags like `"network-error"` /
     `"unsupported"` AND non-enum sentinels like `"service-restart"`).
   - `engineCause` (the `download-retrying` event diagnostic field, typed
     `string`).
   These were left as raw literals by the migration (out of the guard's
   pattern). This change decides whether to widen enforcement to them and,
   if so, how to handle the non-enum sentinel values (`"service-restart"`,
   test placeholders) that legitimately appear on those fields.

## Out of scope

- Re-migrating the in-scope `tag`/`errorTag` sites (already done).
- Changing the underlying tag values or the const-object member sets.
- Introducing const objects for the OTHER tag vocabularies surfaced
  during the migration — `ServiceErrorTag` and `AuthFailedTag` are plain
  type unions today; converting either to an `as const` object (so its
  literals could also be migrated) is its own separate change.

## Open questions (resolve during `/opsx:propose`)

1. **ESLint rule scope.** Match the Vitest guard exactly (tag-context
   references), or widen to all `*errorTag` / `*Tag` string fields? The
   wider net catches `lastErrorTag` / `engineCause` but risks
   false-positives on unrelated `*Tag` identifiers (`JobKind`-style).
   Recommend: start matched to the guard, add an opt-in widened mode.
2. **Sentinel handling on widened fields.** `lastErrorTag` carries
   `"service-restart"` (not a `DatasourceErrorTag` member) and test
   placeholders (`"err"`). If `lastErrorTag` is enforced, these need an
   allowlist or a `ServiceRestart`-style const. Decide the vocabulary.
3. **Auto-fix safety.** A naive auto-fix from `"auth-revoked"` to a const
   cannot know WHICH enum (the 5 shared values + the four-vocabulary
   overlap — `DatasourceErrorTag` / `FilesErrorTag` / `ServiceErrorTag` /
   `AuthFailedTag`). The rule likely must be flag-only (no auto-fix) for
   shared values, or type-aware via `@typescript-eslint`'s type services.
4. **Retire the Vitest guard, or keep both?** If the ESLint rule fully
   covers the convention, the grep-scan test may become redundant — or
   kept as a cheap CI backstop independent of the ESLint toolchain.

## Acceptance criteria (once promoted)

- A custom ESLint rule forbids raw error-tag literals in tag-context and
  is wired into `eslint.config` so `pnpm lint` enforces it.
- A decision (with rationale) on whether `lastErrorTag` / `engineCause`
  are brought into enforcement, and if so, how their non-enum sentinel
  values are handled.
- The `WIRE_LITERAL_ALLOWLIST` in the Vitest guard is reconciled with the
  ESLint rule's exceptions so the two enforcement layers agree.
- No behavior change; existing tests pass.

## Provenance

- Spawned by `migrate-error-tag-literals-to-const-refs` (the migration
  that established the convention + the grep-scan guard). Decision 5
  deferred the ESLint rule; Decision 6 documented the `lastErrorTag` /
  `engineCause` guard-pattern boundary. Both land here.
