# Proposal: Migrate `DatasourceErrorTag` / `FilesErrorTag` literal call sites to constant references

**Status**: Stub. Spawned by Risk #1 in `add-invalid-datasource-state`'s
`design.md` on 2026-04-25.

## Why

`add-invalid-datasource-state` converted `DatasourceErrorTag` and
`FilesErrorTag` from string-literal unions to `as const` objects with
derived types, but left ~262+ existing literal call sites
(143+ for `DatasourceErrorTag`, 119+ for `FilesErrorTag`) unmigrated to
keep the original PR's diff focused on the new feature. The literals
continue to type-check because the derived type IS the same string
union, but new contributors face an inconsistent style ("which form do
I use?") and the codebase loses the awareness benefit of grep'ing for
`DatasourceErrorTag.AuthRevoked` (constant ref, semantic) instead of
`"auth-revoked"` (raw string, easy to miss in renames).

This change is the mechanical follow-up: walk every literal occurrence
and replace it with the constant reference, in lock-step with TDD
discipline (each file's existing tests still pass after migration).

## Out of scope

- Changing the underlying values or member set of either union. This is
  a literal-to-constant rename only.
- Introducing additional const objects elsewhere in the codebase
  (e.g., `DatasourceStatus`, `ProviderId`). Each gets its own change
  if and when migrated.
- Tooling changes — no ESLint rule added in this PR. A follow-up
  change can land an ESLint rule that forbids the literal form once
  the migration is complete.

## Open questions (resolve during `/opsx:propose`)

1. **Per-package or all-at-once?** Land the migration package by
   package (engine first, then sync-service, then renderer) so
   reviewers can scope each PR, or one big mechanical PR? Recommend
   per-package if the diff lands clean per layer.
2. **Test fixtures**: many `*.test.ts` files use string literals like
   `tag: "auth-revoked"` for arrange/assert. Migrate those too, or
   leave test fixtures as literals to keep the test bodies
   self-contained? Recommend migrating — drift is a real cost.
3. **Comment occurrences**: should comments referring to the tag
   (e.g., `// auth-revoked path`) be reworded? Recommend leaving
   comments alone; only code references move.
4. **JSON / serialized payloads**: any literals embedded in test
   fixtures' JSON (e.g., MSW handlers, recorded fixtures) are
   protocol-level and stay as strings. Confirm the grep does not
   sweep them up.
5. **Dist artifacts**: `packages/ipc-contracts/dist/` files contain
   compiled literals. These are build outputs and rebuild on the next
   `pnpm build` — exclude from the grep + migration.

## Acceptance criteria (once promoted)

- Every TypeScript source file under `packages/`, `services/`, `apps/`,
  and `scripts/` references the constant form
  (`DatasourceErrorTag.AuthRevoked`, `FilesErrorTag.Disconnected`,
  etc.) instead of the raw literal `"auth-revoked"` /
  `"disconnected"` etc., EXCEPT where the literal is part of a
  serialized protocol payload (JSON test fixtures) or an external
  contract (provider-side response shape recordings).
- A new ESLint rule (or a CI grep step) enforces the convention going
  forward.
- Every existing test passes unchanged after the migration — this is
  a no-behavior-change refactor.
- A follow-up cleanup memo notes any sites intentionally kept as
  literals and why.

## Provenance

- Spawned by `add-invalid-datasource-state` design.md Risk #1 on
  2026-04-25.
- Original counts gathered via `rg -c` (143+ DatasourceErrorTag,
  119+ FilesErrorTag) — actual numbers may be higher as
  `rg --head-limit 30` truncated.
