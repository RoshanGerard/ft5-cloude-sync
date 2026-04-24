## MODIFIED Requirements

### Requirement: IPC command surface

The service SHALL accept and correctly respond to the following commands on its IPC channel: `sync:enqueue-upload`, `sync:enqueue-mirror`, `sync:list-jobs`, `sync:get-job`, `sync:cancel-job`, `sync:subscribe-events`, `sync:unsubscribe-events`, `sync:set-retry-policy`, `sync:get-retry-policy`, `sync:authenticate`, `sync:get-status`, `files:list`, `files:stat`, `files:search`, `files:remove`. Request and response types for every command SHALL be declared in `@ft5/ipc-contracts/sync-service` as discriminated unions, keyed by the `command` field. Any command frame whose `command` is not in this enumerated set SHALL receive a response with `ok: false, error.tag === 'unknown-command'`.

The four `files:*` commands SHALL each accept `{ datasourceId: string, … }` and resolve the engine client for that `datasourceId` via the service's existing `ClientFactory`. The response envelope SHALL be a discriminated union `{ ok: true, value: T } | { ok: false, error: { tag: "auth-revoked" | "disconnected" | "rate-limited" | "other", message: string, retryable: boolean, retryAfterMs?: number } }` where `T` is:
- `files:list` → `{ entries: FileEntry[]; truncated: boolean }` (`truncated: true` when the provider returned a page marker the engine could not follow in this change).
- `files:stat` → `{ entry: FileEntry }`.
- `files:search` → `{ entries: FileEntry[]; truncated: boolean }`.
- `files:remove` → `{ results: Array<{ path: string; ok: true } | { path: string; ok: false; error: { tag: …; message: string } }> }` — the outer `ok` is `true` whenever the command itself executes, per-path outcomes live in `results`.

#### Scenario: Unknown command is rejected

- **WHEN** a client sends a request with `command: "sync:fly-to-mars"`
- **THEN** it receives a response with `ok: false` and `error.tag === 'unknown-command'`

#### Scenario: `sync:get-status` succeeds with no prior activity

- **WHEN** a client connects to a freshly started service and sends `sync:get-status` with empty params
- **THEN** the response carries `{ ok: true, result: { version, serviceUuid, runningJobs: 0, queuedJobs: 0, waitingNetworkJobs: 0, monitorConnected: false } }`

#### Scenario: `files:list` resolves the engine and returns a tagged envelope on auth failure

- **WHEN** a client sends `files:list` with `{ datasourceId, path: "/" }` and the datasource's credentials are revoked
- **THEN** the service resolves the engine client via `ClientFactory`, invokes `client.listDirectory({ kind: "path", path: "/" })` which throws a normalized engine error whose tag is `auth-revoked`; the service responds with `{ ok: false, error: { tag: "auth-revoked", message: <engine message>, retryable: false } }`

#### Scenario: `files:remove` processes N paths in parallel with per-path results

- **WHEN** a client sends `files:remove` with `{ datasourceId, paths: ["/a", "/b", "/c"] }` and `/b` rejects with a rate-limit
- **THEN** the service issues three concurrent calls to `client.deleteFile` (or `deleteDirectory` for directory entries, kind resolved via `getMetadata`) using `Promise.allSettled`, and responds with `{ ok: true, value: { results: [{ path: "/a", ok: true }, { path: "/b", ok: false, error: { tag: "rate-limited", … } }, { path: "/c", ok: true }] } }`

#### Scenario: `files:search` forwards scope to the engine

- **WHEN** a client sends `files:search` with `{ datasourceId, query: "notes", path: "/projects" }`
- **THEN** the service invokes `client.search("notes", { kind: "path", path: "/projects" })` and returns `{ ok: true, value: { entries, truncated } }`

#### Scenario: Unknown `files:*` command variant is rejected

- **WHEN** a client sends `command: "files:invalidate-cache"` (not in the declared surface)
- **THEN** the response is `{ ok: false, error: { tag: "unknown-command" } }`, identical to the behavior for any other non-enumerated command
