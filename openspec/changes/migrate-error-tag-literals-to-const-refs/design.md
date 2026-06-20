## Context

`add-invalid-datasource-state` (archived 2026-04-26) converted the two
error-tag unions from bare string-literal unions into `as const` objects
with derived types, but deliberately left every existing literal call
site unmigrated to keep that PR's diff focused on the new feature:

- `DatasourceErrorTag` — `packages/ipc-contracts/src/fs-datasource-engine.ts:231`
  (10 members: `auth-expired`, `auth-revoked`, `not-found`, `conflict`,
  `unsupported`, `rate-limited`, `network-error`, `provider-error`,
  `cancelled`, `invalid-datasource`).
- `FilesErrorTag` — `packages/ipc-contracts/src/files.ts:22`
  (8 members: `auth-revoked`, `disconnected`, `rate-limited`, `other`,
  `invalid-datasource`, `conflict`, `cancelled`, `exhausted-retries`).

The literals continue to type-check because each derived type IS the
same string union. This change is the mechanical follow-up: walk every
literal occurrence in TypeScript source + test files and replace it with
the corresponding constant reference, keeping the existing test suite
green at every step.

**Actual scope (inventory, 2026-06-20).** A repo-wide grep over `tag` /
`errorTag` / `.tag` comparisons + constructions + `case` arms (excluding
`dist/`, `node_modules/`, `.worktrees/`, `openspec/changes/archive/`)
found **~600 literal occurrences across 100+ files**. Heaviest
concentrations: `services/fs-sync/src/commands/files-download.ts` (38) +
its test (43); the engine strategies (`googledrive-client.ts` 18,
`onedrive-client.ts` 15, `s3-client.ts` 13) + tests; `base-client.ts`
(13) + test (19); `apps/desktop/src/main/ipc/files/mock-fs.ts` (11);
renderer `file-explorer.tsx` (13) + the file-explorer test suite. The
proposal's earlier estimate (262+) undercounted because `rg --head-limit`
truncated; the real figure is higher once tests are included. Markdown
spec/doc hits (`openspec/specs/*.md` 66+37+20, `PENDING_TC.MD`, READMEs)
are protocol/documentation, NOT migration targets (see Non-Goals).

## Goals / Non-Goals

**Goals:**

- Every TypeScript **source and test** file under `packages/`,
  `services/`, `apps/`, and `scripts/` references the constant form
  (`DatasourceErrorTag.AuthRevoked`, `FilesErrorTag.Disconnected`, …)
  instead of the raw literal (`"auth-revoked"`, `"disconnected"`, …) for
  error-tag values — EXCEPT the explicit exclusions below.
- The migration is **behavior-preserving**: wire values, the derived
  type unions, and every error-envelope shape stay byte-identical. The
  existing test suite passes unchanged.
- Each layer lands as its own reviewable, independently-green commit.

**Non-Goals:**

- Changing the underlying values or member set of either union
  (literal-to-constant rename only).
- Introducing new const objects elsewhere (`DatasourceStatus`,
  `ProviderId`, etc.) — each is its own future change.
- **Enforcement tooling** (ESLint rule or CI grep gate) — deferred to a
  dedicated follow-up (see Decision 5). This PR is the migration only.
- Editing **protocol-level literals**: serialized JSON in fixtures / MSW
  handlers / recorded provider responses, and `openspec/specs/**/*.md`
  (which document the wire values and are also off-limits to direct
  edits per the project hard rule). These stay as raw strings.
- Rewording **comments** that mention a tag value (`// auth-revoked
  path`). Only code references move.
- Touching `dist/` build outputs (rebuilt by `pnpm build`).

## Decisions

### Decision 1 — Per-package, independently-green commits

Migrate package by package rather than in one mega-diff, in dependency
order so each layer's tests are run against an already-migrated
dependency:

1. `packages/ipc-contracts` — the home of both const objects; migrate its
   own internal literal references first.
2. `packages/fs-datasource-engine` — `base-client`, the three strategies,
   `factory`, `with-auth-refresh`, `strategy-contract`.
3. `services/fs-sync` — `commands/*`, `retry/*`, `util/*`, `scheduler`,
   `executors`, `oauth`, `main`.
4. `apps/desktop` main — `ipc/files/*`, `ipc/sync/*`, `sync/*`.
5. `apps/desktop` renderer — `features/file-explorer/*`,
   `features/datasources/*`.
6. `scripts/` — if any tag literals remain.

**Why:** scoped review per layer; a per-package test run isolates any
regression to the package just touched. Because the change is
behavior-preserving, migration order is not load-bearing for
correctness — it is purely for reviewability and bisect-friendliness.

**Alternative considered:** one mechanical all-at-once PR. Rejected — a
~600-site diff is unreviewable as a unit, and a single failing assertion
would be hard to localize.

### Decision 2 — Shared-literal disambiguation: match the local declared type

Five values are members of **both** enums: `auth-revoked`,
`rate-limited`, `conflict`, `cancelled`, `invalid-datasource`. A bare
`"auth-revoked"` is therefore ambiguous between
`DatasourceErrorTag.AuthRevoked` and `FilesErrorTag.AuthRevoked`.

At each site, choose the const whose enum matches the **declared type of
the value being compared/constructed** (an engine `DatasourceError.tag`
→ `DatasourceErrorTag.*`; a `FilesErrorEnvelope.tag` →
`FilesErrorTag.*`).

**Critical caveat:** TypeScript will **NOT** catch a wrong-enum-but-same-
value substitution — `(x: DatasourceErrorTag) === FilesErrorTag.AuthRevoked`
compiles because both sides have type `"auth-revoked"`, and the runtime
value is identical so **tests stay green even if the wrong enum is
chosen**. Correctness on shared literals is therefore a *review-enforced*
invariant, not a compiler- or test-enforced one.

**Mitigation:** (a) per-site read of the surrounding declared type before
substituting; (b) mandatory code review on every package commit
specifically checking enum-correctness on the five shared values;
(c) unique-to-one-enum literals (`auth-expired`,
`unsupported`, `network-error`, `provider-error` →
`DatasourceErrorTag`; `disconnected`, `other`, `exhausted-retries` →
`FilesErrorTag`) carry no ambiguity and can be migrated mechanically.

**Third vocabulary — `ServiceErrorTag` (the `not-found` split).** A third
error vocabulary exists: `ServiceErrorTag` (`packages/ipc-contracts/src/sync-service/errors.ts`),
the tag union for `SyncCommandError` / the sync `ErrorShape` family
(`NotFoundErrorShape`, etc.). It is a plain `type` union with **no `as
const` object** — there is no `ServiceErrorTag.NotFound` to reference, so
it is **out of scope** (per Non-Goals: each vocabulary gets its own
change) and cannot be migrated even in principle. Of the 13
Datasource/Files values, the **only** value `ServiceErrorTag` also
carries is `not-found`. The split rule:

- `not-found` on a `DatasourceError` / engine site (e.g.
  `e instanceof DatasourceError && e.tag === "not-found"`, strategy
  `tag: "not-found"` throws) → migrate to `DatasourceErrorTag.NotFound`.
- `not-found` on a `SyncCommandError` / sync `ErrorShape` /
  `sync:*` handler site → **leave as a raw literal** (ServiceErrorTag
  vocabulary). These sites are recorded in the guard's
  `WIRE_LITERAL_ALLOWLIST` with the reason "ServiceErrorTag vocabulary,
  out of scope", so `not-found` stays enforced for engine misses while
  the out-of-scope sites are an auditable allowlist.

Note `FilesErrorTag` has **no** `not-found` member, so a `not-found`
literal in a `files:*`-adjacent file is never a `FilesErrorTag`
reference — it is either an engine `DatasourceError` passthrough
(migrate) or a service error (allowlist); resolve per site. Non-`tag`
collisions are inert to the guard: `JobStatus` (`"cancelled"`, …) uses
`status:`, not `tag:`/`case`, so it never matches.

### Decision 3 — Spec delta captures the const-reference convention as a load-bearing requirement

The migration changes no *runtime* contract — wire values, derived type
unions, and envelope shapes are byte-identical. But it makes a
previously-implicit invariant **load-bearing**: error-tag values are now
*required* to be referenced via the const objects. Per the audit-gate
trigger checklist ("previously-implicit invariant becoming load-bearing")
this warrants a spec delta, and it matches repo precedent — the
`migrate-engine-*` refactors all synced capability deltas.

Two `## ADDED Requirements` deltas land:

- `specs/fs-datasource-engine/spec.md` — `DatasourceErrorTag` values
  referenced via the const object (engine owns this taxonomy).
- `specs/fs-sync-service/spec.md` — `FilesErrorTag` values referenced via
  the const object (fs-sync owns the `files:*` envelope vocabulary).

Each requirement's scenario is backed by the grep-scan guard test
(Decision 5), mirroring the engine spec's existing static-analysis
scenarios ("No Electron imports", "Consumers program to the interface").
The capability specs continue to document the wire *values* as literals
(the protocol); those are off-limits to direct edits regardless.

### Decision 4 — Migrate test fixtures, but not protocol payloads

Per the proposal's Q2 recommendation, arrange/assert literals in
`*.test.ts(x)` files migrate to the const form (drift between test and
source is a real cost). The exception: a literal that represents a
**serialized wire payload** — JSON inside an MSW handler, a recorded
provider response body, a fixture that asserts the on-the-wire string —
stays a raw string, because that is the protocol, not a code reference.
The discriminator at apply time: is the literal a TypeScript value typed
as `DatasourceErrorTag` / `FilesErrorTag` (migrate), or a string inside a
JSON blob / `JSON.parse` / network-shaped fixture (leave)?

### Decision 5 — Ship the grep-scan guard test now (TDD anchor + regression guard); defer only the ESLint editor rule

The proposal's Acceptance Criteria mention "a new ESLint rule (or CI grep
step) enforces the convention," while its Out-of-scope says "no ESLint
rule added in this PR." **Resolution:** ship the **CI-grep half** as a
Vitest grep-scan guard test inside this change, and defer only the
**ESLint editor-integration rule** to a follow-up stub
(`add-error-tag-literal-lint`).

The guard test (`packages/ipc-contracts/src/__tests__/error-tag-const-convention.test.ts`)
is both:

- the **TDD anchor** — written first, it is RED with the ~600 literals
  present, and the per-package migration drives it GREEN (the migration's
  failing-test-first discipline for a no-new-behavior refactor); and
- the **permanent regression guard** — it stays in the suite, matching
  the repo's existing static-analysis scenarios ("No Electron imports").

**Why ship it (vs. defer all enforcement):** a one-off grep at
verification time cannot prevent reintroduction, and the guard test
doubles as the only RED signal available for an otherwise behavior-
preserving change. It is scoped to *forbid raw literals*, not to fail the
build on unrelated grounds, so it does not risk blocking the PR on
incidental matches once the sweep is complete. The ESLint rule (editor-
time DX, auto-fix) is genuinely additive and stays a follow-up.

### Decision 6 — Scope is tag-CONTEXT *references*; type-position declarations and assertion-only literals are exempt (refined during apply)

Two boundaries surfaced while migrating `packages/ipc-contracts` and were
folded into the guard:

- **Type-position declarations are DEFINITIONS, not references.** A
  `readonly tag: "not-found"` interface member, or an inline payload union
  like `readonly tag: "auth-revoked" | "disconnected" | …`
  (`DownloadFailedPayload`, `UploadFailedPayload`, the sync `ErrorShape`
  family, etc.) DECLARES a contract's allowed tag values — it is a peer of
  the const-object definition, not a value reference. These are exempt
  (the guard skips `readonly tag:` lines and string-literal unions —
  `readonly` is type-only syntax so it never hides a runtime value; `||`
  logical-or is unaffected since it has no string literal adjacent to the
  pipe). This is also why `ServiceErrorTag`'s `readonly tag: "not-found"`
  interface members need no allowlist entry — they are type-position.

- **Migration scope is tag-CONTEXT references only:** construction
  (`tag:` / `errorTag:` object property, incl. inside `toMatchObject({…})`
  / `toEqual({…})`), comparison (`tag` / `.tag === / !== / ==`), and
  `case` arms. OUT of scope (neither guarded nor migrated): assertion-only
  literals (`expect(x.tag).toBe("rate-limited")`), tag-value arrays
  (`["auth-expired", …] as const`), and bare function-arg literals.
  Guarding those would force matching bare strings (`"other"`, `"conflict"`,
  `"cancelled"`) in arbitrary positions, which collide with non-tag uses
  (`ConflictPolicy`, `JobStatus`, the English word "other"). Restricting
  to tag-context keeps the guard sound and the migration well-defined; a
  same-file mix (migrated `tag:` next to a literal `.toBe(...)`) is the
  accepted cost.

- **Deliberate literal-form back-compat tests stay literal** (allowlisted).
  `datasource-error-tag.test-d.ts` has a test whose POINT is that the raw
  literal form still type-checks (the derived type is unchanged); migrating
  it would defeat the test. One `WIRE_LITERAL_ALLOWLIST` entry records it.

## Risks / Trade-offs

- **Wrong-enum substitution on the 5 shared literals — type-safe and
  test-green but semantically misleading.** → Per-site type-match
  (Decision 2) + mandatory enum-correctness code review per package +
  lean on the unique-literal set where there is no ambiguity.
- **Missed sites leave the codebase half-migrated.** → Per-package grep
  discovery at apply; a final repo-wide grep gate in verification asserts
  zero non-excluded literals remain.
- **Accidentally migrating a protocol literal (fixture JSON / spec md).**
  → Exclusion checklist (Decision 4 + Non-Goals); spec markdown is never
  touched (hard rule).
- **Large diff churn races in-flight branches.** → Land promptly;
  per-package commits keep rebases mechanical; the change touches no
  behavior so conflicts resolve by re-applying the literal→const swap.

## Migration Plan

Per package (Decision 1 order): discover sites via scoped grep → migrate
source then tests → run that package's test suite + `tsc` (confirm still
green) → code review (enum-correctness focus) → commit. After all
packages: repo-wide grep gate (zero non-excluded literals) → full test
suite + typecheck + lint → `openspec validate --strict`.

**Rollback:** purely mechanical and behavior-preserving — revert the
per-package commit(s); no data, schema, or wire migration to unwind.

## Open Questions

None blocking. The proposal's Q1–Q5 are resolved by Decisions 1
(per-package), 4 (migrate fixtures, exclude protocol JSON), 5
(enforcement deferred), and the Non-Goals (comments untouched, dist
excluded).
