## MODIFIED Requirements

### Requirement: IPC command surface

The service SHALL accept and correctly respond to the following commands on its IPC channel: `sync:enqueue-upload`, `sync:enqueue-mirror`, `sync:list-jobs`, `sync:get-job`, `sync:cancel-job`, `sync:subscribe-events`, `sync:unsubscribe-events`, `sync:set-retry-policy`, `sync:get-retry-policy`, `sync:authenticate`, `sync:get-status`, `files:list`, `files:stat`, `files:search`, `files:remove`. Request and response types for every command SHALL be declared in `@ft5/ipc-contracts/sync-service` as discriminated unions, keyed by the `command` field. Any command frame whose `command` is not in this enumerated set SHALL receive a response with `ok: false, error.tag === 'unknown-command'`.

The four `files:*` commands SHALL each accept `{ datasourceId: string, … }` and resolve the engine client for that `datasourceId` via the service's existing `ClientFactory`. The response envelope SHALL be a discriminated union `{ ok: true, value: T } | { ok: false, error: { tag: "auth-revoked" | "disconnected" | "rate-limited" | "other", message: string, retryable: boolean, retryAfterMs?: number } }` where `T` is:
- `files:list` → `{ entries: FileEntry[]; truncated: boolean }` (`truncated: true` when the provider returned a page marker the engine could not follow in this change).
- `files:stat` → `{ entry: FileEntry }`.
- `files:search` → `{ entries: FileEntry[]; truncated: boolean }`.
- `files:remove` → `{ results: Array<{ path: string; handle: string; ok: true } | { path: string; handle: string; ok: false; error: { tag: …; message: string } }> }` — the outer `ok` is `true` whenever the command itself executes, per-target outcomes live in `results`. Each result echoes the caller-supplied `handle` so the renderer correlates by entry id (authoritative) rather than by `path` (ambiguous on providers that allow duplicate-name entries). The request SHALL be `{ datasourceId, targets: Array<{ path, handle, kind }> }`; the handler dispatches via `{ kind: "handle", handle }` for both `deleteFile` and `deleteDirectory`, skipping any `getMetadata` round-trip.

#### Scenario: Unknown command is rejected

- **WHEN** a client sends a request with `command: "sync:fly-to-mars"`
- **THEN** it receives a response with `ok: false` and `error.tag === 'unknown-command'`

#### Scenario: `sync:get-status` succeeds with no prior activity

- **WHEN** a client connects to a freshly started service and sends `sync:get-status` with empty params
- **THEN** the response carries `{ ok: true, result: { version, serviceUuid, runningJobs: 0, queuedJobs: 0, waitingNetworkJobs: 0, monitorConnected: false } }`

#### Scenario: `files:list` resolves the engine and returns a tagged envelope on auth failure

- **WHEN** a client sends `files:list` with `{ datasourceId, path: "/" }` and the datasource's credentials are revoked
- **THEN** the service resolves the engine client via `ClientFactory`, invokes `client.listDirectory({ kind: "path", path: "/" })` which throws a normalized engine error whose tag is `auth-revoked`; the service responds with `{ ok: false, error: { tag: "auth-revoked", message: <engine message>, retryable: false } }`

#### Scenario: `files:remove` processes N targets in parallel with per-target results keyed by handle

- **WHEN** a client sends `files:remove` with `{ datasourceId, targets: [{ path: "/a", handle: "ha", kind: "file" }, { path: "/b", handle: "hb", kind: "file" }, { path: "/c", handle: "hc", kind: "file" }] }` and `"hb"` rejects with a rate-limit
- **THEN** the service issues three concurrent calls to `client.deleteFile({ kind: "handle", handle })` using `Promise.allSettled` (directory kinds dispatch to `deleteDirectory` analogously); no `getMetadata` round-trip occurs; the response is `{ ok: true, value: { results: [{ path: "/a", handle: "ha", ok: true }, { path: "/b", handle: "hb", ok: false, error: { tag: "rate-limited", … } }, { path: "/c", handle: "hc", ok: true }] } }`

#### Scenario: `files:search` forwards scope to the engine

- **WHEN** a client sends `files:search` with `{ datasourceId, query: "notes", path: "/projects" }`
- **THEN** the service invokes `client.search("notes", { kind: "path", path: "/projects" })` and returns `{ ok: true, value: { entries, truncated } }`

#### Scenario: Unknown `files:*` command variant is rejected

- **WHEN** a client sends `command: "files:invalidate-cache"` (not in the declared surface)
- **THEN** the response is `{ ok: false, error: { tag: "unknown-command" } }`, identical to the behavior for any other non-enumerated command
