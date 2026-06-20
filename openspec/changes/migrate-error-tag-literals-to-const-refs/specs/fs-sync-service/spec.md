## ADDED Requirements

### Requirement: `FilesErrorTag` values are referenced via the const object, not raw string literals

Every TypeScript source and test file SHALL reference `FilesErrorTag`
values through the `FilesErrorTag` const object exported from
`@ft5/ipc-contracts` (e.g. `FilesErrorTag.Disconnected`) — across the
workspace (`packages/`, `services/`, `apps/`, `scripts/`) — rather than
the equivalent raw string literal (e.g. `"disconnected"`) in any
error-tag context: construction (`tag: ...`), comparison (`tag === ...` /
`tag !== ...`), or `switch`/`case` arm. This is a behavior-preserving convention:
the const's value IS the same string, so the `files:*` envelope wire
shape and the derived `FilesErrorTag` union are unchanged.

The following are explicitly EXEMPT and MAY remain raw strings:

- The const-object definition itself in
  `packages/ipc-contracts/src/files.ts`.
- Serialized protocol payloads — JSON inside MSW handlers, recorded
  provider-response fixtures, or any string asserted as the on-the-wire
  value rather than a typed `FilesErrorTag` value.
- `openspec/specs/**/*.md` (documents wire values; off-limits to direct
  edits) and code comments.
- `dist/` build outputs and `node_modules/`.

Because the five values shared with `DatasourceErrorTag` (`auth-revoked`,
`rate-limited`, `conflict`, `cancelled`, `invalid-datasource`) are
type-identical across both enums, each site SHALL use the const whose
enum matches the declared type of the value at that site; the compiler
does not distinguish them, so enum-correctness is review-enforced.

#### Scenario: No raw `FilesErrorTag` literals remain outside exemptions

- **WHEN** the const-convention guard test (`packages/ipc-contracts/src/__tests__/error-tag-const-convention.test.ts`) grep-scans every `.ts` / `.tsx` file under `packages/`, `services/`, `apps/`, and `scripts/` for raw error-tag string literals in an error-tag context (`tag`/`errorTag`/`.tag` construction or comparison, and `case` arms)
- **THEN** it finds zero occurrences of any `FilesErrorTag` value as a raw literal, excluding the const definition, serialized-payload fixtures, comments, `dist/`, and `node_modules/`

#### Scenario: `files:*` envelope vocabulary is unchanged

- **WHEN** the migration replaces a literal such as `tag: "exhausted-retries"` on a `FilesErrorEnvelope` with `tag: FilesErrorTag.ExhaustedRetries`
- **THEN** the runtime value, the `files:*` envelope wire shape, and the `FilesErrorTag` derived union are byte-identical, and the existing fs-sync + renderer test suites pass unchanged
