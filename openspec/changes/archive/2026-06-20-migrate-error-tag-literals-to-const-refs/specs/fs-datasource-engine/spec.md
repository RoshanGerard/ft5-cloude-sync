## ADDED Requirements

### Requirement: `DatasourceErrorTag` values are referenced via the const object, not raw string literals

Every TypeScript source and test file SHALL reference `DatasourceErrorTag`
values through the `DatasourceErrorTag` const object exported from
`@ft5/ipc-contracts` (e.g. `DatasourceErrorTag.AuthRevoked`) — across the
workspace (`packages/`, `services/`, `apps/`, `scripts/`) — rather than
the equivalent raw string literal (e.g. `"auth-revoked"`) in any
error-tag context: construction (`tag: ...`), comparison (`tag === ...` /
`tag !== ...`), or `switch`/`case` arm. This is a behavior-preserving
convention: the const's value IS the same string, so wire payloads and
the derived `DatasourceErrorTag` union are unchanged.

The following are explicitly EXEMPT and MAY remain raw strings:

- The const-object definition itself in
  `packages/ipc-contracts/src/fs-datasource-engine.ts`.
- Serialized protocol payloads — JSON inside MSW handlers, recorded
  provider-response fixtures, or any string asserted as the on-the-wire
  value rather than a typed `DatasourceErrorTag` value.
- `openspec/specs/**/*.md` (documents wire values; off-limits to direct
  edits) and code comments.
- `dist/` build outputs and `node_modules/`.
- Type-position declarations — `readonly tag:` interface members and
  string-literal union types — which DECLARE a contract's allowed tag
  values (definitions, peers of the const object), not value references.
- Literals belonging to a DIFFERENT error vocabulary that happens to
  share the string. `ServiceErrorTag` (the `SyncCommandError` / sync
  `ErrorShape` family) is a plain type union with no const object and is
  out of scope; its only value shared with `DatasourceErrorTag` is
  `not-found`. A `not-found` literal on a `SyncCommandError` / `sync:*`
  site stays raw and is recorded in the guard allowlist, while
  `not-found` on a `DatasourceError` site MUST migrate.

Because the five values shared with `FilesErrorTag` (`auth-revoked`,
`rate-limited`, `conflict`, `cancelled`, `invalid-datasource`) are
type-identical across both enums, each site SHALL use the const whose
enum matches the declared type of the value at that site; the compiler
does not distinguish them, so enum-correctness is review-enforced.

#### Scenario: No raw `DatasourceErrorTag` literals remain outside exemptions

- **WHEN** the const-convention guard test (`packages/ipc-contracts/src/__tests__/error-tag-const-convention.test.ts`) grep-scans every `.ts` / `.tsx` file under `packages/`, `services/`, `apps/`, and `scripts/` for raw error-tag string literals in an error-tag context (`tag`/`errorTag`/`.tag` construction or comparison, and `case` arms)
- **THEN** it finds zero occurrences of any `DatasourceErrorTag` value as a raw literal, excluding the const definition, serialized-payload fixtures, comments, `dist/`, and `node_modules/`

#### Scenario: Engine error taxonomy values are unchanged

- **WHEN** the migration replaces a literal such as `tag === "auth-revoked"` on a `DatasourceError` with `tag === DatasourceErrorTag.AuthRevoked`
- **THEN** the runtime value, the emitted/thrown `DatasourceError` shape, and the `DatasourceErrorTag` derived union are byte-identical, and the existing engine test suite passes unchanged
