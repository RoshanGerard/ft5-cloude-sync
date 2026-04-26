## MODIFIED Requirements

### Requirement: IPC command surface

The service SHALL accept and correctly respond to the following commands on its IPC channel: `sync:enqueue-upload`, `sync:enqueue-mirror`, `sync:list-jobs`, `sync:get-job`, `sync:cancel-job`, `sync:subscribe-events`, `sync:unsubscribe-events`, `sync:set-retry-policy`, `sync:get-retry-policy`, `sync:authenticate`, `sync:get-status`, `files:list`, `files:stat`, `files:search`, `files:remove`. Request and response types for every command SHALL be declared in `@ft5/ipc-contracts/sync-service` as discriminated unions, keyed by the `command` field. Any command frame whose `command` is not in this enumerated set SHALL receive a response with `ok: false, error.tag === 'unknown-command'`.

The four `files:*` commands SHALL each accept `{ datasourceId: string, … }` and resolve the engine client for that `datasourceId` via the service's existing `ClientFactory`. The response envelope SHALL be a discriminated union `{ ok: true, value: T } | { ok: false, error: { tag: FilesErrorTag, message: string, retryable: boolean, retryAfterMs?: number } }` where `FilesErrorTag` is exposed as an `as const` object with a derived type (matching the codebase convention for `FILES_CHANNELS` / `DATASOURCES_CHANNELS`):

```typescript
export const FilesErrorTag = {
  AuthRevoked: "auth-revoked",
  Disconnected: "disconnected",
  RateLimited: "rate-limited",
  Other: "other",
  InvalidDatasource: "invalid-datasource",
} as const;
export type FilesErrorTag =
  (typeof FilesErrorTag)[keyof typeof FilesErrorTag];
```

`T` is:
- `files:list` → `{ entries: FileEntry[]; truncated: boolean }` (`truncated: true` when the provider returned a page marker the engine could not follow in this change).
- `files:stat` → `{ entry: FileEntry }`.
- `files:search` → `{ entries: FileEntry[]; truncated: boolean }`.
- `files:remove` → `{ results: Array<{ path: string; handle: string; ok: true } | { path: string; handle: string; ok: false; error: { tag: …; message: string } }> }` — the outer `ok` is `true` whenever the command itself executes, per-target outcomes live in `results`. Each result echoes the caller-supplied `handle` so the renderer correlates by entry id (authoritative) rather than by `path` (ambiguous on providers that allow duplicate-name entries). The request SHALL be `{ datasourceId, targets: Array<{ path, handle, kind }> }`; the handler dispatches via `{ kind: "handle", handle }` for both `deleteFile` and `deleteDirectory`, skipping any `getMetadata` round-trip.

The `normalizeFilesError` helper SHALL map engine `DatasourceError.tag` values to envelope `FilesErrorTag` values 1:1 for `auth-revoked` / `auth-expired` (→ `AuthRevoked`), `network-error` (→ `Disconnected`), `rate-limited` (→ `RateLimited`), and `invalid-datasource` (→ `InvalidDatasource`); all other engine tags (`not-found`, `conflict`, `unsupported`, `provider-error`, `cancelled`) SHALL map to `Other`. Any non-`DatasourceError` thrown value SHALL also map to `Other` with `retryable: false`.

#### Scenario: Unknown command is rejected

- **WHEN** a client sends a request with `command: "sync:fly-to-mars"`
- **THEN** it receives a response with `ok: false` and `error.tag === 'unknown-command'`

#### Scenario: `sync:get-status` succeeds with no prior activity

- **WHEN** a client connects to a freshly started service and sends `sync:get-status` with empty params
- **THEN** the response carries `{ ok: true, result: { version, serviceUuid, runningJobs: 0, queuedJobs: 0, waitingNetworkJobs: 0, monitorConnected: false } }`

#### Scenario: `files:list` resolves the engine and returns a tagged envelope on auth failure

- **WHEN** a client sends `files:list` with `{ datasourceId, path: "/" }` and the datasource's credentials are revoked
- **THEN** the service resolves the engine client via `ClientFactory`, invokes `client.listDirectory({ kind: "path", path: "/" })` which throws a normalized engine error whose tag is `auth-revoked`; the service responds with `{ ok: false, error: { tag: "auth-revoked", message: <engine message>, retryable: false } }`

#### Scenario: `files:list` returns invalid-datasource envelope when the credential is missing

- **WHEN** a client sends `files:list` with `{ datasourceId: "ds-orphan", path: "/" }` and `credentialStore.get("ds-orphan")` resolves to `null`
- **THEN** the service's `resolveClient` throws `DatasourceError({ tag: "invalid-datasource", datasourceId: "ds-orphan", retryable: false, message: "Credentials are missing — reconnect this datasource" })`; the per-command handler's existing `try/catch` invokes `normalizeFilesError`; the response is `{ ok: false, error: { tag: "invalid-datasource", message: "Credentials are missing — reconnect this datasource", retryable: false } }`

#### Scenario: `files:list` returns invalid-datasource envelope when the credential shape is wrong

- **WHEN** a client sends `files:list` for a datasource whose stored credential's `providerId` is `"google-drive"` but the credential payload has S3-shaped fields (`accessKeyId` / `secretAccessKey` and no `accessToken`), and `factory.create` rejects the credential shape
- **THEN** the response is `{ ok: false, error: { tag: "invalid-datasource", message: <engine factory message>, retryable: false } }` — same envelope shape as the missing-credential case; the renderer renders the same Pattern-A state regardless of which sub-condition triggered

#### Scenario: `files:remove` processes N targets in parallel with per-target results keyed by handle

- **WHEN** a client sends `files:remove` with `{ datasourceId, targets: [{ path: "/a", handle: "ha", kind: "file" }, { path: "/b", handle: "hb", kind: "file" }, { path: "/c", handle: "hc", kind: "file" }] }` and `"hb"` rejects with a rate-limit
- **THEN** the service issues three concurrent calls to `client.deleteFile({ kind: "handle", handle })` using `Promise.allSettled` (directory kinds dispatch to `deleteDirectory` analogously); no `getMetadata` round-trip occurs; the response is `{ ok: true, value: { results: [{ path: "/a", handle: "ha", ok: true }, { path: "/b", handle: "hb", ok: false, error: { tag: "rate-limited", … } }, { path: "/c", handle: "hc", ok: true }] } }`

#### Scenario: `files:search` forwards scope to the engine

- **WHEN** a client sends `files:search` with `{ datasourceId, query: "notes", path: "/projects" }`
- **THEN** the service invokes `client.search("notes", { kind: "path", path: "/projects" })` and returns `{ ok: true, value: { entries, truncated } }`

#### Scenario: Unknown `files:*` command variant is rejected

- **WHEN** a client sends `command: "files:invalidate-cache"` (not in the declared surface)
- **THEN** the response is `{ ok: false, error: { tag: "unknown-command" } }`, identical to the behavior for any other non-enumerated command

## ADDED Requirements

### Requirement: `resolveClient` throws typed `invalid-datasource` for missing credentials

The service's `resolveClient` adapter (constructed in `services/fs-sync/src/main/bootstrap.ts`) SHALL be the single choke point that detects credential-presence misconfiguration. When `credentialStore.get(datasourceId)` resolves to `null`, `resolveClient` SHALL throw `new DatasourceError({ tag: "invalid-datasource", datasourceId, retryable: false, message: "Credentials are missing — reconnect this datasource" })`. The previous untyped `throw new Error("no credentials registered for datasourceId=…")` SHALL be replaced. Per-command `files:*` handlers SHALL NOT perform their own credential-presence checks — the per-command flow remains `try { client = await deps.resolveClient(...) } catch (err) { return { ok: false, error: normalizeFilesError(err) } }`, so the new typed error flows through the existing mapping automatically.

Executors that consume `resolveClient` (the upload executor, the mirror-sync executor) SHALL also see the typed error; their existing failure handling SHALL be exercised against the new tag in tests.

#### Scenario: Missing credential surfaces as DatasourceError, not generic Error

- **WHEN** a unit test stubs `credentialStore.get("ds-missing")` to return `null` and invokes `resolveClient("ds-missing")`
- **THEN** the call rejects with a `DatasourceError` instance (verifiable via `err instanceof DatasourceError && err.tag === "invalid-datasource"`); the message reads "Credentials are missing — reconnect this datasource"; `retryable` is `false`

#### Scenario: Per-command handlers stay thin and propagate the new tag

- **WHEN** a unit test wires the `files:list` handler with a `resolveClient` that throws the new typed error and dispatches a `files:list` request
- **THEN** the handler's existing `try/catch` invokes `normalizeFilesError`; the response is `{ ok: false, error: { tag: "invalid-datasource", message, retryable: false } }`; the handler source contains NO additional credential-presence check beyond the existing `await deps.resolveClient(...)` call
