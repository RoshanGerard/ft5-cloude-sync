## ADDED Requirements

### Requirement: Directory delete and unsupported `getQuota` throw `Unsupported`

`delete(target: Target, entryKind: EntryKind)` SHALL throw `DatasourceError` with `tag === "unsupported"` when `entryKind === "directory"`, for every provider in this change regardless of the target. `getQuota()` SHALL throw the same when called on a client whose `providerDescriptor.capabilities.quota === false`. The thrown error's `raw` field MAY carry a human-readable reason (e.g., `"disabled-for-product-stability"` vs `"not-supported-by-provider"`) but the `tag` SHALL be identical in both cases.

#### Scenario: delete with entryKind "directory" throws Unsupported

- **WHEN** any concrete client's `delete({ kind: "path", path: "/anything" }, "directory")` is invoked
- **THEN** the method throws a `DatasourceError` with `tag === "unsupported"` (the engine emits no event)

#### Scenario: getQuota throws Unsupported on S3

- **WHEN** `client.getQuota()` is invoked on an `S3Client`
- **THEN** the method throws a `DatasourceError` with `tag === "unsupported"` (the engine emits no event)

#### Scenario: getQuota succeeds on providers with quota

- **WHEN** `client.getQuota()` is invoked on a `GoogleDriveClient` with valid credentials
- **THEN** the method resolves with a `Quota` object carrying `used: number` and `quota: number`, both non-negative integers

## MODIFIED Requirements

### Requirement: Public contract is the generic `DatasourceClient<T>` Strategy interface

The engine SHALL export a public interface `DatasourceClient<T extends DatasourceType>` with the methods `status`, `testConnection`, `authenticate`, `listDirectory`, `search`, `getMetadata`, `uploadFile`, `delete`, `getQuota`, `rename`, and `downloadFile`. The delete surface is the single method `delete(target: Target, entryKind: EntryKind): Promise<void>`; the methods `createFile`, `cancelUpload`, `deleteFile`, and `deleteDirectory` are NOT present (`createFile`/`cancelUpload` deleted by prior changes; `deleteFile`/`deleteDirectory` collapsed into the unified `delete`). The type parameter `T` SHALL flow into every generic return payload (`FileEntry<T>`, `FileMetadata<T>`). Concrete implementations (`S3Client`, `OneDriveClient`, `GoogleDriveClient`) SHALL conform to this interface and SHALL be constructible only via the engine's factory — not via `new` directly by consumers.

#### Scenario: Every concrete client conforms to the shared interface

- **WHEN** a contract test in `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` enumerates every exported client class
- **THEN** each class is `assignable` to `DatasourceClient<its provider type>`, every method on the interface is present with the correct signature (no `createFile`, no `cancelUpload`, no `deleteFile`/`deleteDirectory` — replaced by `delete`), and a shared suite of scenarios (list, search, upload via signal-driven cancel, delete, error, rename, download with rangeStart, AbortSignal-driven download cancel) passes against each

#### Scenario: Consumers program to the interface, not the concrete class

- **WHEN** a Vitest test scans `apps/desktop/src/main/ipc/` and `services/fs-sync/src/commands/` for type annotations
- **THEN** handler call sites annotate the engine value as `DatasourceClient<DatasourceType>` (or a narrower union), not as `S3Client` / `OneDriveClient` / `GoogleDriveClient` directly

### Requirement: Hybrid `Target` type supports both path and handle addressing

The engine SHALL define `type Target = { kind: "path"; path: string } | { kind: "handle"; handle: string }` in `packages/ipc-contracts`. Every method that addresses a filesystem location (`listDirectory`, `getMetadata`, `uploadFile`, `delete`, `search` scope) SHALL accept `Target` as its location parameter. `FileEntry<T>` SHALL always carry both `path: string` and `handle: string` so any entry returned by a list call can be re-addressed by either mechanism. Internally, each concrete strategy SHALL maintain an LRU path↔handle cache. Cache invalidation SHALL be **internal to each mutating op** — the strategy evicts inline within the operation's success branch, before returning; invalidation is purely inline (the engine has no event bus):

- On successful `uploadFile`: `doUploadFileImpl` populates the LRU directly inside its success branch.
- On successful `delete` of a file (`entryKind === "file"`): `doDeleteFileImpl` evicts the deleted entry's path (path-form target) or handle (handle-form target) from the LRU inside its success branch.
- On successful `rename`: `doRenameImpl` evicts the old path from the LRU inside its success branch; for a directory rename it ALSO evicts every cached descendant under the old-path prefix. When an `overwrite` rename internally deletes a colliding sibling at the destination, that sibling's cached path is evicted too. Eviction is evict-only — the new path resolves fresh on next access.
- The `createFile` invalidation path is not relevant: `createFile` does not exist on the engine surface.

A strategy with no path cache (e.g., S3, whose keys are paths) satisfies this requirement vacuously: it has nothing to evict and a re-address always reaches the provider. Cache invalidation is performed inline by the mutating op; the engine has no event bus and no operation emits an event.

#### Scenario: listDirectory accepts a path target

- **WHEN** a caller invokes `client.listDirectory({ kind: "path", path: "/photos/2024" })` against a client whose datasource has that folder
- **THEN** the method resolves with a non-empty `FileEntry<T>[]` whose entries each carry both a `path` field starting with `/photos/2024/` and a non-empty `handle` string

#### Scenario: listDirectory accepts a handle target

- **WHEN** a caller obtains a `FileEntry<T>` from a prior `listDirectory` call, then invokes `client.listDirectory({ kind: "handle", handle: entry.handle })` where `entry.kind === "folder"`
- **THEN** the method resolves with the children of that folder, and no path-resolution round-trip is issued to the provider (observable in a spy-wrapped strategy test)

#### Scenario: Handle cache is populated by upload success internally

- **WHEN** a strategy's `doUploadFileImpl` resolves successfully with an entry whose `path` was not previously in the LRU
- **THEN** the LRU contains `entry.path → entry.handle` after the call resolves; no event is emitted (the engine has no event bus)

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
- **THEN** the displaced sibling's cached path entry is evicted; a subsequent address of that path re-resolves (eviction is inline; the engine has no event bus)

#### Scenario: Path-cache eviction is internal to the mutating op

- **WHEN** a strategy that maintains a path↔handle cache is constructed
- **THEN** it does NOT register any subscription to invalidate that cache (the engine has no event bus); eviction occurs only inline within the strategy's own successful mutating op

#### Scenario: Every cached strategy honors the invalidation invariant (shared contract)

- **WHEN** the shared strategy-contract suite runs against a concrete strategy whose fixture declares `hasPathHandleCache: true`
- **THEN** after a successful `delete` of a cached file path the cache no longer holds that path, and after a successful `rename` the old path is evicted — so every present and future cached strategy is held to the invariant (a strategy whose fixture declares `hasPathHandleCache: false` satisfies it vacuously)

#### Scenario: Path ambiguity surfaces via providerMetadata

- **WHEN** a provider permits duplicate sibling names (e.g., Google Drive) and a `{kind: "path"}` `Target` resolves to more than one provider-side item under the same (parent, name) filter
- **THEN** the strategy selects the oldest hit (e.g., Drive orders by `createdTime asc`), populates the returned `FileEntry<T>.providerMetadata` with `ambiguous: true` and an `ambiguousSiblings` list containing the other items' handles, and the ambiguity is carried only on the returned entry's `providerMetadata` — the engine emits no event

### Requirement: Strategy LRU path-handle invalidation on upload completion is internal

Drive and OneDrive strategies maintain a path-handle LRU cache. After this migration, LRU population on successful upload SHALL be performed internally inside `doUploadFileImpl` (calling `this.pathHandleCache.set(entry.path, entry.handle)` directly before returning), NOT via any event bus. Strategy constructors register NO bus subscriptions (the engine has no event bus); deletion/rename eviction is performed inline within `doDeleteFileImpl` / `doRenameImpl` (see Requirement: Hybrid `Target` type supports both path and handle addressing).

#### Scenario: Drive LRU is populated by uploadFile success

- **WHEN** an upload to Google Drive resolves successfully and returns an entry whose `path` was not previously in the strategy's LRU
- **THEN** the LRU contains `entry.path → entry.handle` after the call resolves; no event is emitted (the engine has no event bus)

#### Scenario: OneDrive LRU is populated by uploadFile success

- **WHEN** an upload to OneDrive resolves successfully and returns an entry whose `path` was not previously in the strategy's LRU
- **THEN** the LRU contains `entry.path → entry.handle` after the call resolves; no event is emitted (the engine has no event bus)

#### Scenario: Drive LRU is invalidated inline by delete of a file

- **WHEN** `delete` of a file (`entryKind === "file"`) succeeds for a path present in the strategy's LRU
- **THEN** the strategy evicts that path's LRU entry inline within `doDeleteFileImpl` (there is no bus subscription; the engine has no event bus)

## REMOVED Requirements

### Requirement: `deleteDirectory` and unsupported `getQuota` throw `Unsupported`

**Reason**: The dedicated `deleteDirectory` method is removed; its global directory-delete `Unsupported` refusal is preserved and relocated into the unified `delete(target, entryKind)` method (see the ADDED requirement "Directory delete and unsupported `getQuota` throw `Unsupported`", which carries the identical behavior plus the unchanged `getQuota` scenarios).

**Migration**: Callers that invoked `deleteDirectory(target)` now call `delete(target, "directory")` and catch the same `DatasourceError { tag: "unsupported" }`. No wire-level or error-tag change.
