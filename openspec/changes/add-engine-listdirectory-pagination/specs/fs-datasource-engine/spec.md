# Spec delta: `fs-datasource-engine`

## ADDED Requirements

### Requirement: `listDirectory` exposes opaque-cursor pagination

`DatasourceClient<T>.listDirectory` SHALL accept an optional
`{ cursor?: string; pageSize?: number }` options parameter and SHALL
return `{ entries: DatasourceFileEntry<T>[]; nextCursor: string | null }`.
The cursor SHALL be opaque to the engine port — every concrete
strategy SHALL own its own native-token translation inside
`doListDirectoryImpl`. The engine MUST NOT inspect, normalize, or
introspect the cursor value.

When `cursor` is omitted, the strategy SHALL fetch the first
provider page. When `cursor` is provided, the strategy SHALL fetch
the page identified by that cursor. When `pageSize` is omitted, the
strategy SHALL use its prior provider default. When `pageSize` is
provided, the strategy SHALL clamp it to the provider's
documented `[min, max]` range before issuing the call.

The returned `nextCursor` SHALL be `null` when the provider response
indicates no further pages, and SHALL be the provider's native
continuation token (forwarded unchanged) otherwise.

#### Scenario: First-page call returns entries plus a cursor

- **WHEN** a caller invokes `client.listDirectory({ kind: "path", path: "/big" })` against a folder of 1500 entries on Google Drive with no `cursor` and no `pageSize`
- **THEN** the strategy issues one `files.list` call with `pageSize: 1000` and the call's `nextPageToken` populated; the response's `entries.length` is 1000; the response's `nextCursor` is the provider's `nextPageToken` value (a non-empty string); no second provider call is issued

#### Scenario: Next-page call uses the prior cursor

- **WHEN** a caller invokes `client.listDirectory({ kind: "path", path: "/big" }, { cursor: priorNextCursor })` immediately after a first-page call that returned `nextCursor: priorNextCursor`
- **THEN** the strategy issues one `files.list` call carrying that token in the provider-native parameter (`pageToken` for Drive, the URL `@odata.nextLink` for OneDrive, `ContinuationToken` for S3); the response's `entries` are the second page; the response's `nextCursor` is null when the provider indicates no more pages, otherwise the next provider continuation

#### Scenario: pageSize is forwarded and clamped per provider

- **WHEN** a caller invokes `client.listDirectory(target, { pageSize: 5000 })` against Google Drive
- **THEN** the strategy clamps `pageSize` to 1000 (Drive's `[1, 1000]` ceiling) and issues `files.list({..., pageSize: 1000})`; the response's `entries.length` is at most 1000

#### Scenario: pageSize default per provider when omitted

- **WHEN** a caller invokes `client.listDirectory(target)` without `pageSize`
- **THEN** the strategy uses its prior provider default — Drive 1000, OneDrive 200 (Graph default), S3 1000 — and the response's `entries.length` is at most that default

#### Scenario: S3 strategy returns one provider page per call (not auto-looped)

- **WHEN** a caller invokes `client.listDirectory(target)` against an S3 prefix of 2500 keys with no `cursor`
- **THEN** the strategy issues exactly one `ListObjectsV2` call (NOT a `do/while` loop); the response's `entries.length` is at most 1000 (S3's `MaxKeys` ceiling); the response's `nextCursor` is the `NextContinuationToken` value when `IsTruncated` is true

#### Scenario: OneDrive strategy validates `@odata.nextLink` URL prefix before re-issue

- **WHEN** a caller invokes `client.listDirectory(target, { cursor })` against OneDrive where `cursor` does NOT start with `https://graph.microsoft.com/v1.0/`
- **THEN** the strategy throws `DatasourceError { tag: "other", message: "invalid cursor: not a graph.microsoft.com URL" }` without issuing a network call

#### Scenario: Stale cursor surfaces as `tag: "other"`

- **WHEN** a caller invokes `client.listDirectory(target, { cursor: staleToken })` and the provider rejects the token (Drive 400 / S3 InvalidArgument / OneDrive 400)
- **THEN** the call rejects with `DatasourceError { tag: "other", message: <provider message> }`; no `expired-cursor` tag is introduced (per design.md Decision 8)

## MODIFIED Requirements

### Requirement: IPC handlers call into the engine, preserving contract shapes

All main-process IPC handlers under `apps/desktop/src/main/ipc/files/` and `apps/desktop/src/main/ipc/datasources/` SHALL call into the engine for their authoritative behaviour. The handlers SHALL NOT contain hard-coded fixture arrays, SHALL NOT import provider SDKs directly, and SHALL translate between the engine's `DatasourceClient` surface and the IPC contract types owned by `ipc-contracts` (`DatasourcesListResponse`, `FilesListResponse`, etc.). Contract shapes defined by `datasources-ui` and `ui-file-explorer` SHALL remain unchanged by this requirement — only handler bodies change.

The `files:list` handler SHALL forward the request's optional `cursor` and `pageSize` fields to `client.listDirectory(target, { cursor, pageSize })`, and SHALL surface the engine's `nextCursor` on the response envelope. The `truncated: boolean` field on the response envelope SHALL be derived as `nextCursor !== null` and SHALL NOT be authoritative on its own.

#### Scenario: Handlers forward to the engine

- **WHEN** a Vitest test spies on `ClientFactory.create` and on a per-provider mock strategy, then invokes the `files:list` handler with a valid `datasourceId`, `path`, and an optional `{ cursor, pageSize }`
- **THEN** the factory is invoked exactly once for that datasource (or a cached instance is reused), the strategy's `listDirectory` is invoked exactly once with a `Target` of `{ kind: "path", path }` AND an options object whose `cursor` and `pageSize` match the request, and the handler's response conforms to `FilesListResponse` (including the new `nextCursor: string | null` field; `truncated === (nextCursor !== null)`)

#### Scenario: No provider SDK imports in IPC handlers

- **WHEN** a grep test scans every file under `apps/desktop/src/main/ipc/`
- **THEN** no file imports from `googleapis`, `@microsoft/microsoft-graph-client`, or `@aws-sdk/client-s3`; these specifiers only appear inside `packages/fs-datasource-engine`
