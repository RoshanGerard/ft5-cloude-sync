## MODIFIED Requirements

### Requirement: Hybrid `Target` type supports both path and handle addressing

The engine SHALL define `type Target = { kind: "path"; path: string } | { kind: "handle"; handle: string }` in `packages/ipc-contracts`. Every method that addresses a filesystem location (`listDirectory`, `getMetadata`, `uploadFile`, `deleteFile`, `deleteDirectory`, `search` scope) SHALL accept `Target` as its location parameter. `FileEntry<T>` SHALL always carry both `path: string` and `handle: string` so any entry returned by a list call can be re-addressed by either mechanism. Internally, each concrete strategy SHALL maintain an LRU path↔handle cache. Cache invalidation SHALL be **internal to each mutating op** — the strategy evicts inline within the operation's success branch, before returning; NO bus event drives invalidation:

- On successful `uploadFile`: `doUploadFileImpl` populates the LRU directly inside its success branch.
- On successful `deleteFile`: `doDeleteFileImpl` evicts the deleted entry's path (path-form target) or handle (handle-form target) from the LRU inside its success branch.
- On successful `rename`: `doRenameImpl` evicts the old path from the LRU inside its success branch; for a directory rename it ALSO evicts every cached descendant under the old-path prefix. When an `overwrite` rename internally deletes a colliding sibling at the destination, that sibling's cached path is evicted too. Eviction is evict-only — the new path resolves fresh on next access.
- The `createFile` invalidation path is not relevant: `createFile` does not exist on the engine surface.

A strategy with no path cache (e.g., S3, whose keys are paths) satisfies this requirement vacuously: it has nothing to evict and a re-address always reaches the provider. Strategy constructors SHALL NOT subscribe to the engine bus to drive cache invalidation; eviction is performed inline by the mutating op, independent of the bus. The engine bus's `deleted` / `entry-renamed` emissions remain for consumer notification only.

#### Scenario: listDirectory accepts a path target

- **WHEN** a caller invokes `client.listDirectory({ kind: "path", path: "/photos/2024" })` against a client whose datasource has that folder
- **THEN** the method resolves with a non-empty `FileEntry<T>[]` whose entries each carry both a `path` field starting with `/photos/2024/` and a non-empty `handle` string

#### Scenario: listDirectory accepts a handle target

- **WHEN** a caller obtains a `FileEntry<T>` from a prior `listDirectory` call, then invokes `client.listDirectory({ kind: "handle", handle: entry.handle })` where `entry.kind === "folder"`
- **THEN** the method resolves with the children of that folder, and no path-resolution round-trip is issued to the provider (observable in a spy-wrapped strategy test)

#### Scenario: Handle cache is populated by upload success internally

- **WHEN** a strategy's `doUploadFileImpl` resolves successfully with an entry whose `path` was not previously in the LRU
- **THEN** the LRU contains `entry.path → entry.handle` after the call resolves; the engine bus observes ZERO `file-created` events for the upload

#### Scenario: Handle cache is invalidated by deletion

- **WHEN** a strategy successfully deletes an entry at a known cached path, then another operation addresses the same path
- **THEN** the strategy does NOT return the cached handle; the second operation re-resolves the path (observable by a spy on the provider's name-resolution API)

#### Scenario: Handle cache is invalidated by rename

- **WHEN** a strategy successfully renames a file from a known cached path `/old` to `/new`, then another operation addresses `/old`
- **THEN** the strategy does NOT return the stale cached handle for `/old` — the operation re-resolves (the provider reports `/old` no longer exists) — and addressing `/new` resolves to the renamed entry

#### Scenario: Directory rename invalidates cached descendants

- **WHEN** a strategy successfully renames a directory from `/foo` to `/bar` while descendants such as `/foo/a.txt` were cached in the LRU
- **THEN** subsequent addresses of `/foo` and of any cached `/foo/...` descendant do NOT return cached handles; each re-resolves against the provider

#### Scenario: Overwrite rename evicts the displaced sibling's cached path

- **WHEN** a strategy performs a `rename` with `conflictPolicy: "overwrite"` that internally deletes a colliding sibling at the destination path, and that sibling's path was cached
- **THEN** the displaced sibling's cached path entry is evicted; a subsequent address of that path re-resolves (no `deleted` bus event is required to drive this eviction)

#### Scenario: Path-cache eviction is internal, not bus-driven

- **WHEN** a strategy that maintains a path↔handle cache is constructed
- **THEN** it does NOT register a bus subscription to invalidate that cache; a `deleted` event delivered on the engine bus from an unrelated source does not, by itself, evict the strategy's cache — eviction occurs only inline within the strategy's own successful mutating op

#### Scenario: Every cached strategy honors the invalidation invariant (shared contract)

- **WHEN** the shared strategy-contract suite runs against a concrete strategy whose fixture declares `hasPathHandleCache: true`
- **THEN** after a successful `deleteFile` of a cached path the cache no longer holds that path, and after a successful `rename` the old path is evicted — so every present and future cached strategy is held to the invariant (a strategy whose fixture declares `hasPathHandleCache: false` satisfies it vacuously)

#### Scenario: Path ambiguity surfaces via providerMetadata, not a status-changed event

- **WHEN** a provider permits duplicate sibling names (e.g., Google Drive) and a `{kind: "path"}` `Target` resolves to more than one provider-side item under the same (parent, name) filter
- **THEN** the strategy selects the oldest hit (e.g., Drive orders by `createdTime asc`), populates the returned `FileEntry<T>.providerMetadata` with `ambiguous: true` and an `ambiguousSiblings` list containing the other items' handles, and emits NO `status-changed` (or any other) event for the ambiguity
