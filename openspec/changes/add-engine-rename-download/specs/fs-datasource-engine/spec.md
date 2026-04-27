# fs-datasource-engine — Delta for `add-engine-rename-download`

## ADDED Requirements

### Requirement: `DatasourceClient<T>` exposes rename and download primitives

The engine SHALL extend the public `DatasourceClient<T>` interface with two new methods covering rename + download. The methods are:

```typescript
rename(target: Target, newName: string, conflictPolicy: ConflictPolicy):
  Promise<DatasourceFileEntry<T>>;

downloadFile(
  target: Target,
  options?: {
    rangeStart?: number;
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
  }
):
  Promise<{
    stream: Readable;
    contentLength: number | null;
    contentRange?: { start: number; end: number; total: number };
  }>;
```

`ConflictPolicy = "fail" | "overwrite" | "keep-both"`. Concrete strategies SHALL implement `protected abstract doRenameImpl` and `doDownloadFileImpl`, mirroring the existing pattern where the base class wraps each call with single-flight refresh and error normalization. The strategy is responsible for determining whether the target is a file or directory within its own provider context — the engine interface does NOT carry a `kind` parameter.

`downloadFile` is a one-shot HTTP primitive: each call issues exactly ONE provider GET request, wrapped in `withRefresh` (one-shot refresh-and-retry on auth-expired during the initial request only). The engine SHALL NOT carry per-download state across calls; it SHALL NOT mint a transaction ID; it SHALL NOT maintain a download tracker map; it SHALL NOT splice a new stream into a prior Readable; it SHALL NOT expose a `cancelDownload` method. The strategy SHALL forward `options.signal` (if provided) into the underlying provider request so consumer-side cancel propagates to the SDK / fetch.

When `options.rangeStart` is set, the strategy SHALL attach `Range: bytes=<rangeStart>-` to the provider request. The returned `contentRange` SHALL reflect the provider's response (parsed from the `Content-Range` header or SDK equivalent); when the response is 200 OK (full content rather than 206 Partial Content), `contentRange` SHALL be omitted so consumers can detect the range-not-honored case.

When `options.onProgress` is set, the strategy SHALL invoke it with `(loaded, total)` as bytes flow during the response stream's lifetime. The engine does NOT emit `downloading` events on its bus; consumer-domain progress events are the consumer's responsibility.

#### Scenario: Every concrete strategy implements the new methods

- **WHEN** the contract test in `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` enumerates every exported client class
- **THEN** each class is `assignable` to `DatasourceClient<its provider type>` including the two new methods (`rename` and `downloadFile`), and the shared scenario suite passes for each (rename a file, rename a directory or surface Unsupported per provider, download a small file end-to-end including AbortSignal-driven cancel, downloadFile with rangeStart issues a 206 Partial Content request)

#### Scenario: S3 rename of a folder surfaces `Unsupported` via strategy introspection

- **WHEN** an S3 client receives a `rename(target, newName, conflictPolicy)` call where `target` resolves to a virtual folder (the strategy's `HeadObject(key)` returns 404 and `ListObjectsV2(Prefix=key+"/", MaxKeys=1)` returns at least one key)
- **THEN** the call rejects with `DatasourceError { tag: "unsupported", retryable: false }` and message "S3 folder rename is not supported in this version"; no `CopyObject` or `DeleteObject` is issued; no events are emitted

#### Scenario: S3 rename of a file proceeds via copy + delete

- **WHEN** an S3 client receives `rename(target, newName, "fail")` where `target` resolves to an object (`HeadObject(key)` returns 200) and the target name does not already exist (a `HeadObject` for the new key returns 404)
- **THEN** the strategy issues `CopyObject` followed by `DeleteObject`; the bus emits exactly one `entry-renamed { from, to }`; the call resolves with the new entry

#### Scenario: Directory rename with `conflictPolicy: "overwrite"` is refused

- **WHEN** any client receives `rename(target, newName, "overwrite")` and the target resolves to a directory (Drive `mimeType: "application/vnd.google-apps.folder"`, OneDrive `folder` facet, or S3 virtual prefix)
- **THEN** the call rejects with `DatasourceError { tag: "unsupported", retryable: false }` and message "directory rename with conflictPolicy 'overwrite' is not supported (would require recursive replacement)"; no rename API call is issued

### Requirement: `entry-renamed` is the single normalized rename event

The engine bus SHALL emit exactly one `entry-renamed` event per successful
`rename` call, regardless of how many provider API calls the strategy
performed internally. The payload shape is:

```typescript
{ from: Target, to: DatasourceFileEntry<T> }
```

`from` carries the original `{datasourceId, path, handle}` so subscribers can
identify the pre-rename entry; `to` is the full new entry including the new
path, name, and any provider-side metadata changes. `*-failed` events on
rename SHALL be emitted via the existing `delete-failed` taxonomy with the
`via: "rename"` discriminator (matching `createFile`'s `via: "createFile"`
pattern on `upload-failed`).

#### Scenario: Drive rename emits `entry-renamed` once

- **WHEN** a Google Drive client successfully renames `welcome.pdf` to `welcome-v2.pdf`
- **THEN** the bus observes exactly one `entry-renamed { from: { path: "/welcome.pdf", … }, to: { path: "/welcome-v2.pdf", name: "welcome-v2.pdf", … } }`; no `file-created` or `deleted` events are emitted

#### Scenario: S3 rename emits `entry-renamed` once despite copy+delete internals

- **WHEN** an S3 client successfully renames `welcome.pdf` to `welcome-v2.pdf` via internal `CopyObject` + `DeleteObject`
- **THEN** the bus observes exactly one `entry-renamed { from: …, to: … }`; the strategy's two provider API calls are not visible on the bus; subscribers cannot distinguish the rename from a Drive/OneDrive rename

#### Scenario: Rename failure emits `delete-failed` with `via: "rename"`

- **WHEN** a rename fails with a provider conflict, `auth-revoked`, or other normalized error
- **THEN** the bus emits `delete-failed { tag, message, via: "rename" }` exactly once and the call rejects with the matching `DatasourceError`

### Requirement: `downloadFile` is a stateless one-shot HTTP primitive

Each `downloadFile(target, options?)` call SHALL issue exactly ONE underlying provider GET request, wrapped in the engine's existing `withRefresh` machinery (one-shot refresh-and-retry on auth-expired during the initial request only). The engine SHALL NOT track download progress, transaction IDs, or cancel state across calls. Mid-stream errors (auth-expired, network, 5xx, rate-limit) on the returned Readable SHALL surface to the consumer as normal stream errors with normalized `DatasourceError` tags; the engine SHALL NOT attempt to refresh and resume internally.

Consumer-domain orchestration of resume — calling `downloadFile` again with `rangeStart = <bytes already written>`, validating the returned `contentRange`, deciding whether to retry vs fail — lives entirely in the consumer (the fs-sync service handler).

#### Scenario: First call returns the initial stream

- **WHEN** the consumer invokes `engine.downloadFile(target)` (no `rangeStart`)
- **THEN** the strategy issues one provider GET (no Range header); the response Body becomes the returned `stream`; `contentLength` reflects the response's total size if the provider advertises it; `contentRange` is undefined; the call resolves with `{ stream, contentLength }` exactly once

#### Scenario: Resume call attaches the Range header

- **WHEN** the consumer invokes `engine.downloadFile(target, { rangeStart: 1048576 })` after a previous call's stream errored at byte 1048576
- **THEN** the strategy issues one provider GET with `Range: bytes=1048576-`; the provider's 206 Partial Content response Body becomes the returned `stream`; `contentRange` is `{ start: 1048576, end: <total - 1>, total: <total> }`; `contentLength` reflects the response's total size; the call resolves with that shape

#### Scenario: Range-not-honored response surfaces via undefined contentRange

- **WHEN** the consumer invokes `engine.downloadFile(target, { rangeStart: 1048576 })` and the provider returns 200 OK (full content from byte 0) instead of 206 Partial Content
- **THEN** `contentRange` is undefined on the returned shape; `contentLength` reflects the full response size; the consumer can detect the range-not-honored case by checking `contentRange === undefined && rangeStart > 0` and refuse to resume the local pipe

#### Scenario: AbortSignal cancels the in-flight provider request

- **WHEN** the consumer invokes `engine.downloadFile(target, { signal })` and aborts the signal mid-stream
- **THEN** the underlying provider request is aborted via the SDK's signal forwarding; the returned stream errors with an AbortError (or normalized `tag: "cancelled"`); no further bytes flow; the engine maintains no per-download state to clean up

#### Scenario: Mid-stream auth-expired surfaces to the consumer

- **WHEN** a `downloadFile` call returned a stream that successfully delivered N bytes, then the underlying provider request errored mid-stream with auth-expired (token expired during the response)
- **THEN** the stream errors with `DatasourceError { tag: "auth-expired" }` reaching the consumer's pipe-to-disk; the engine does NOT refresh or splice internally; the consumer is responsible for deciding whether to call `downloadFile` again with `rangeStart=N` (which goes through `withRefresh` afresh and refreshes the credential)

### Requirement: Rename conflict surfaces `DatasourceError { tag: "conflict" }` when policy is "fail"

The `DatasourceErrorTag` taxonomy SHALL include a new member `Conflict =
"conflict"`. When `rename` is called with `conflictPolicy: "fail"` and
the target name collides with an existing remote sibling at the same
parent path, the call SHALL reject with
`DatasourceError { tag: "conflict", retryable: false, raw:
{ existingPath: string } }`.

When `conflictPolicy: "overwrite"`, the engine SHALL delete the colliding
sibling (via the existing `deleteFile` path) before performing the rename;
the operation SHALL still emit a single `entry-renamed` (the deletion
event SHALL NOT be emitted to the bus to keep the user-visible rename
single-step).

When `conflictPolicy: "keep-both"`, the engine SHALL append `-2` / `-3` /
… suffix and retry until success or until 99 attempts (then fail with
`tag: "other", message: "exhausted keep-both attempts"`).

#### Scenario: Rename to existing sibling with policy "fail"

- **WHEN** the user renames `foo.pdf` to `bar.pdf` and `bar.pdf` already exists at the same parent path, with `conflictPolicy: "fail"`
- **THEN** the call rejects with `DatasourceError { tag: "conflict", raw: { existingPath: "/parent/bar.pdf" } }`; no provider mutation occurs; no `entry-renamed` event is emitted

#### Scenario: Rename with policy "overwrite" replaces the colliding sibling

- **WHEN** the user renames `foo.pdf` to `bar.pdf`, `bar.pdf` exists, and `conflictPolicy: "overwrite"`
- **THEN** the engine deletes the existing `bar.pdf` first, then performs the rename; the bus observes exactly one `entry-renamed { from: {…foo.pdf…}, to: {…bar.pdf…} }`; no `deleted` event is emitted

#### Scenario: Rename with policy "keep-both" auto-suffixes

- **WHEN** the user renames `foo.pdf` to `bar.pdf` and both `bar.pdf` and `bar-2.pdf` exist, with `conflictPolicy: "keep-both"`
- **THEN** the engine retries with `bar-2.pdf` (collides), then `bar-3.pdf` (succeeds); the bus emits one `entry-renamed { from: {…foo.pdf…}, to: {…bar-3.pdf…} }`

## MODIFIED Requirements

### Requirement: Public contract is the generic `DatasourceClient<T>` Strategy interface

The engine SHALL export a public interface `DatasourceClient<T extends
DatasourceType>` with the methods `status`, `testConnection`, `authenticate`,
`listDirectory`, `search`, `getMetadata`, `createFile`, `uploadFile`,
`cancelUpload`, `deleteFile`, `deleteDirectory`, `getQuota`, `rename`, and
`downloadFile`. The type parameter
`T` SHALL flow into every generic return payload (`FileEntry<T>`,
`FileMetadata<T>`, and event payloads). Concrete implementations
(`S3Client`, `OneDriveClient`, `GoogleDriveClient`) SHALL conform to this
interface and SHALL be constructible only via the engine's factory — not
via `new` directly by consumers.

#### Scenario: Every concrete client conforms to the shared interface

- **WHEN** a contract test in `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` enumerates every exported client class
- **THEN** each class is `assignable` to `DatasourceClient<its provider type>`, every method on the interface (including the two added in this change) is present with the correct signature, and a shared suite of scenarios (list, search, upload, delete, error, rename, download with rangeStart, AbortSignal-driven cancel) passes against each

#### Scenario: Consumers program to the interface, not the concrete class

- **WHEN** a Vitest test scans `apps/desktop/src/main/ipc/` and `services/fs-sync/src/commands/` for type annotations
- **THEN** handler call sites annotate the engine value as `DatasourceClient<DatasourceType>` (or a narrower union), not as `S3Client` / `OneDriveClient` / `GoogleDriveClient` directly
