# fs-sync-service — Delta for `migrate-upload-orchestration-out-of-engine`

## ADDED Requirements

### Requirement: `files:upload` direct RPC handler

The service SHALL expose a `files:upload` command on its IPC channel that performs a single renderer-initiated upload as a direct RPC (NOT a queued job). The handler at `services/fs-sync/src/commands/files-upload.ts` SHALL:

1. Accept the request envelope `{ datasourceId: string; sourcePath: string; targetPath: string; conflictPolicy: ConflictPolicy }`.
2. Validate that `sourcePath` is an absolute local filesystem path and `targetPath` is a syntactically valid remote path. Reject with `tag: "other"` and a clear message on validation failure.
3. Check the `UploadRegistry`'s reverse-index for an in-flight upload to `(datasourceId, targetPath)`. If found, reject with `tag: "conflict"` and payload `{ existingUploadJobId, targetPath }` BEFORE any engine call. (See Requirement: Concurrent-target upload conflict guard.)
4. Mint a service-level `uploadJobId` via `crypto.randomUUID()`.
5. Construct an `AbortController` and insert a new `UploadJobEntry` into the `UploadRegistry`.
6. Resolve the `DatasourceClient<T>` via the engine's `ClientFactory` (the same factory used by the other `files:*` handlers).
7. Call `await client.uploadFile(target, file, { signal: abortController.signal, onProgress: <emit-uploading-on-stream> })`.
8. On `onProgress` invocation: update the registry entry's `bytesUploaded` and `contentLength`; emit `uploading` on `sync:event-stream` with `{ uploadJobId, bytesUploaded, bytesTotal, datasourceId, sourcePath, targetPath }`. Emission rate SHALL be throttled at the handler level (the engine no longer applies the throttle for uploads).
9. On engine resolve: emit `file-created` on `sync:event-stream` with `{ uploadJobId, handle, datasourceId, targetPath }`. Delete the registry entry. Reply `{ uploadJobId }` to the caller.
10. On engine reject with `tag === "cancelled"`: emit `upload-cancelled` on `sync:event-stream` with `{ uploadJobId, bytesUploaded, bytesTotal, reason: "user", datasourceId, targetPath }`. Delete the registry entry. The handler's reply MAY resolve with `{ uploadJobId }` or reject with the cancelled error — pick the same shape as the existing `files:download` handler.
11. On engine reject with any other tag: emit `upload-failed` on `sync:event-stream` with `{ uploadJobId, tag, message, datasourceId, targetPath }`. Delete the registry entry. The handler's reply rejects with the normalized error.

The handler SHALL NOT use the scheduler, SHALL NOT enqueue a row in the `jobs` table, and SHALL NOT depend on `MirrorSyncJobExecutor` or any executor abstraction. This is a thin orchestration over the engine call, mirroring `files:download`.

#### Scenario: files:upload completes happy path with single file-created event

- **WHEN** a renderer dispatches `files:upload` for a file that resolves successfully against a `FakeDatasourceClient`
- **THEN** the response is `{ ok: true, value: { uploadJobId } }`; the service emits one or more `uploading` events followed by exactly one `file-created` event on `sync:event-stream`, all keyed by `uploadJobId`; the `UploadRegistry` is empty after completion

#### Scenario: files:upload propagates upload-failed on engine error

- **WHEN** a renderer dispatches `files:upload` and the fake client throws `DatasourceError { tag: "network-error" }`
- **THEN** the service emits exactly one `upload-failed` event on `sync:event-stream` with `{ uploadJobId, tag: "network-error", message }`; the response is `{ ok: false, error: { tag: "network-error", … } }`; the registry entry for `uploadJobId` is deleted

#### Scenario: files:upload does not enqueue a jobs row

- **WHEN** a renderer dispatches `files:upload` and the fake client resolves
- **THEN** `SELECT COUNT(*) FROM jobs WHERE kind = 'upload'` returns 0 (the queue is bypassed entirely)

### Requirement: `UploadRegistry` tracks in-flight uploads in memory

The service SHALL implement an in-memory `UploadRegistry` module at `services/fs-sync/src/uploads/registry.ts`. The module SHALL export an interface with operations `set(entry)`, `get(uploadJobId)`, `update(uploadJobId, patch)`, `delete(uploadJobId)`, `snapshot()`, and `findByTarget(datasourceId, targetPath)`. The entry shape:

```typescript
interface UploadJobEntry {
  uploadJobId: string;
  datasourceId: string;
  sourcePath: string;
  targetPath: string;
  bytesUploaded: number;
  contentLength: number | null;
  startedAt: number;
  abortController: AbortController;
}
```

The registry SHALL maintain a forward `Map<uploadJobId, UploadJobEntry>` plus a reverse-index `Map<string, string>` keyed on `${datasourceId}::${targetPath}` resolving to `uploadJobId`. Both indexes update atomically on `set` and `delete`. The registry is service-process-local in-memory state — service crash drops all in-flight upload tracking, paralleling `DownloadRegistry`.

#### Scenario: UploadRegistry.findByTarget returns existing uploadJobId for in-flight target

- **WHEN** an `UploadJobEntry` is inserted for `(datasourceId: "ds-1", targetPath: "/photos/x.jpg")` and `findByTarget("ds-1", "/photos/x.jpg")` is called
- **THEN** the returned value is the inserted entry's `uploadJobId`

#### Scenario: UploadRegistry.findByTarget returns undefined after delete

- **WHEN** an entry is inserted then deleted, and `findByTarget` is called with the same `(datasourceId, targetPath)` pair
- **THEN** the returned value is `undefined`

#### Scenario: UploadRegistry.snapshot returns immutable array

- **WHEN** two entries are inserted and `snapshot()` is called
- **THEN** the returned array length is 2; mutating the returned array does NOT affect subsequent `snapshot()` returns

### Requirement: Concurrent-target upload conflict guard

The `files:upload` handler SHALL reject any request whose `(datasourceId, targetPath)` matches an in-flight upload. The check SHALL happen at handler entry, BEFORE the engine call. The rejection envelope SHALL be `{ ok: false, error: { tag: "conflict", message: <human-readable>, retryable: false, existingUploadJobId: string, targetPath: string } }`. Different local source paths uploading to the same remote slot are also rejected — the rejection key is `(datasourceId, targetPath)` only, not `(datasourceId, sourcePath, targetPath)`.

This guard is an explicit user-stated hard requirement: uploading the same remote slot concurrently is prohibited at the service boundary, regardless of which local source initiates it.

#### Scenario: Second files:upload to same target is rejected with conflict

- **WHEN** a first `files:upload { datasourceId: "ds-1", sourcePath: "/a.jpg", targetPath: "/photos/x.jpg" }` is in flight (registry entry exists, engine call pending), and a second `files:upload { datasourceId: "ds-1", sourcePath: "/a.jpg", targetPath: "/photos/x.jpg" }` arrives
- **THEN** the second response is `{ ok: false, error: { tag: "conflict", existingUploadJobId: <first id>, targetPath: "/photos/x.jpg" } }`; the second request did NOT invoke `client.uploadFile` (a spy on the engine factory's client observes only one upload call); the first upload's progress is unaffected

#### Scenario: Different local source to same target is also rejected

- **WHEN** a first `files:upload { sourcePath: "/a.jpg", targetPath: "/photos/x.jpg" }` is in flight and a second `files:upload { sourcePath: "/b.jpg", targetPath: "/photos/x.jpg" }` (different source, same target) arrives
- **THEN** the second response is `{ ok: false, error: { tag: "conflict", existingUploadJobId: <first id>, targetPath: "/photos/x.jpg" } }`; the rejection key is the target slot, not the source

#### Scenario: Same target on different datasourceId is allowed

- **WHEN** a first `files:upload { datasourceId: "ds-1", targetPath: "/x.jpg" }` is in flight and a second `files:upload { datasourceId: "ds-2", targetPath: "/x.jpg" }` arrives
- **THEN** both succeed (different `datasourceId` namespaces); two distinct `uploadJobId`s are minted; two engine calls are issued

### Requirement: `uploads:list-active` RPC for hydrate-on-connect

The service SHALL expose `uploads:list-active` on its IPC channel. The handler SHALL return a snapshot of the current `UploadRegistry`. The response shape is `{ ok: true, value: UploadJobEntry[] }` (with `abortController` field omitted from the wire representation since it is process-local state). This command exists to hydrate the renderer's Sonner toast UI on supervisor connect — paralleling `downloads:list-active`.

#### Scenario: uploads:list-active returns empty array when no uploads in flight

- **WHEN** the service has zero entries in `UploadRegistry` and a `uploads:list-active` request arrives
- **THEN** the response is `{ ok: true, value: [] }`

#### Scenario: uploads:list-active returns snapshot of in-flight uploads

- **WHEN** two `files:upload` calls are in flight (both registry entries present), and a `uploads:list-active` request arrives
- **THEN** the response is `{ ok: true, value: [<entry1>, <entry2>] }` with both `uploadJobId`s present; the `abortController` field is absent from each entry on the wire

### Requirement: `sync:cancel-upload` RPC

The service SHALL expose `sync:cancel-upload` on its IPC channel. The handler SHALL accept `{ uploadJobId: string }`, look up the entry in `UploadRegistry`, call `entry.abortController.abort()` if present, and reply `{ ok: true, value: { cancelled: boolean } }`. `cancelled: true` if the entry existed; `cancelled: false` if the `uploadJobId` was unknown (idempotent on unknown ids).

The cancel SHALL NOT directly delete the registry entry; the entry deletion happens in the `files:upload` handler's catch path when the engine call rejects with `tag: "cancelled"`. The handler is responsible for emitting the terminal `upload-cancelled` event.

#### Scenario: sync:cancel-upload aborts an in-flight upload

- **WHEN** a `files:upload` is in flight (registry entry has an active `AbortController`), and `sync:cancel-upload { uploadJobId }` is invoked
- **THEN** the response is `{ ok: true, value: { cancelled: true } }`; the `AbortController.signal.aborted` becomes `true`; the engine call rejects with `DatasourceError { tag: "cancelled" }` shortly thereafter; the `files:upload` handler emits `upload-cancelled` on `sync:event-stream` and deletes the registry entry

#### Scenario: sync:cancel-upload on unknown uploadJobId resolves silently

- **WHEN** `sync:cancel-upload { uploadJobId: "tx-does-not-exist" }` is invoked
- **THEN** the response is `{ ok: true, value: { cancelled: false } }`; no event is emitted

#### Scenario: sync:cancel-upload is idempotent

- **WHEN** `sync:cancel-upload { uploadJobId }` is invoked twice in rapid succession against an in-flight upload
- **THEN** the first response is `{ cancelled: true }`; the second response is `{ cancelled: true }` if the entry is still present (handler's catch hasn't run yet) or `{ cancelled: false }` if it has been deleted; in either case, only one `upload-cancelled` event fires

### Requirement: Upload lifecycle events fire on `sync:event-stream` keyed by `uploadJobId`

The service SHALL emit four upload lifecycle events on its `sync:event-stream` IPC channel:

- `uploading` — streaming. Payload: `{ uploadJobId, bytesUploaded: number, bytesTotal: number, datasourceId, sourcePath, targetPath }`. Throttled at the handler level (1 second OR 10% delta — same coalescing as the engine bus historically applied to upload, now applied by the consumer per Decision 5 in design.md).
- `file-created` — terminal success. Payload: `{ uploadJobId, handle: string, datasourceId, targetPath }`.
- `upload-failed` — terminal failure (non-cancellation). Payload: `{ uploadJobId, tag: DatasourceErrorTag, message: string, datasourceId, targetPath }`.
- `upload-cancelled` — terminal cancellation. Payload: `{ uploadJobId, bytesUploaded, bytesTotal, reason: "user" | "shutdown", datasourceId, targetPath }`.

These events SHALL NOT be emitted on the engine bus — the engine layer has been migrated out of upload event emission per the parallel `fs-datasource-engine` spec delta.

#### Scenario: uploading event payload is keyed by uploadJobId

- **WHEN** a `files:upload` runs and bytes flow
- **THEN** subscribers to `sync:event-stream` filtered on `event === "uploading"` observe events with `uploadJobId` matching the dispatched call's response `uploadJobId`; no `transactionId` field is present

#### Scenario: file-created terminal event fires exactly once per successful upload

- **WHEN** a `files:upload` resolves successfully
- **THEN** subscribers observe exactly one `file-created` event with `{ uploadJobId, handle, datasourceId, targetPath }`; no second `file-created` is emitted for the same `uploadJobId`

#### Scenario: upload-failed and upload-cancelled are mutually exclusive

- **WHEN** a `files:upload` rejects
- **THEN** subscribers observe exactly one of `upload-failed` or `upload-cancelled` for the `uploadJobId` — never both, regardless of how the engine call ultimately rejected

### Requirement: On-connect hydrate forwards in-flight uploads to renderer

The desktop main process's supervisor-connect handler SHALL query `uploads:list-active` after connection establishment and forward the resulting snapshot to the renderer over the existing `datasources:event` relay (or an equivalent main-to-renderer channel). The renderer subscribes to this hydrate event and re-creates Sonner toasts for in-flight uploads. Mirror behavior to `downloads:list-active` hydration.

#### Scenario: Renderer hydrates toasts from uploads:list-active on first connect

- **WHEN** the renderer attaches to the desktop main process and the service has two in-flight uploads in its registry
- **THEN** the renderer receives a hydrate payload containing two upload-job snapshots; two Sonner toasts are mounted with the corresponding `uploadJobId`s; each toast subsequently receives progress updates from the live `sync:event-stream` subscription

## REMOVED Requirements

### Requirement: `UploadJobExecutor` performs a single-file upload via the engine

**Reason**: The `sync:enqueue-upload` command is removed by this change. Direct renderer-initiated single-file uploads now flow through the new `files:upload` direct RPC, NOT through the scheduler queue. The `UploadJobExecutor` abstraction served only the queue-based path; without callers, it becomes dead code and is removed.

**Migration**:
- Renderer call sites that previously dispatched `sync:enqueue-upload` migrate to `files:upload`.
- The `UploadJobExecutor` module is deleted along with its tests (`services/fs-sync/src/scheduler/executors/upload-job-executor.ts` and adjacent test files).
- The `'upload'` `kind` value in the `JobExecutor<...>` discriminator is removed; the `jobs` table no longer has rows with `kind = 'upload'`.
- `MirrorSyncJobExecutor`'s inner per-file upload calls (which call `client.uploadFile` directly, NOT via `UploadJobExecutor`) are unaffected and continue to work with the engine's new one-shot `uploadFile` signature (per the parallel `fs-datasource-engine` spec delta).

### Requirement: Upload jobs do not dedup

**Reason**: The "upload jobs do not dedup" scenario was scoped to `sync:enqueue-upload`-queued jobs, which no longer exist. Dedup behavior for direct uploads (`files:upload`) is now governed by the explicit concurrent-target conflict guard (see ADDED Requirement: Concurrent-target upload conflict guard), which actively REJECTS duplicate-target uploads — the polar opposite of the removed "do not dedup" semantics.

**Migration**: The dedup-vs-no-dedup distinction collapses: mirror-sync still dedups (per the existing Sync dedup rule, MODIFIED below), and direct uploads reject duplicates of `(datasourceId, targetPath)`. The renderer's UX for the new conflict-rejection (a duplicate-attempt error toast) is part of the renderer's wire-up scope.

## MODIFIED Requirements

### Requirement: IPC command surface

The service SHALL accept and correctly respond to the following commands on its IPC channel: `sync:enqueue-mirror`, `sync:list-jobs`, `sync:get-job`, `sync:cancel-job`, `sync:cancel-upload`, `sync:cancel-download`, `sync:subscribe-events`, `sync:unsubscribe-events`, `sync:set-retry-policy`, `sync:get-retry-policy`, `sync:authenticate-start`, `sync:authenticate-complete`, `sync:authenticate-cancel`, `sync:get-config`, `sync:set-config`, `sync:delete-credentials`, `sync:get-status`, `files:list`, `files:stat`, `files:search`, `files:remove`, `files:rename`, `files:download`, `files:upload`, `downloads:list-active`, `uploads:list-active`. The previous `sync:enqueue-upload` command SHALL NOT be present (replaced by `files:upload` per this change). Request and response types for every command SHALL be declared in `@ft5/ipc-contracts/sync-service` as discriminated unions, keyed by the `command` field. Any command frame whose `command` is not in this enumerated set SHALL receive a response with `ok: false, error.tag === 'unknown-command'`.

The new `files:upload` command SHALL accept `{ datasourceId, sourcePath, targetPath, conflictPolicy }` and resolve the engine client for that `datasourceId` via the service's existing `ClientFactory`. The response envelope is the standard discriminated union with `value: { uploadJobId: string }` on success. Error tags include the existing taxonomy plus `"conflict"` (carrying `existingUploadJobId` and `targetPath` for the concurrent-target case).

#### Scenario: Service rejects unknown-command for sync:enqueue-upload

- **WHEN** a frame `{ command: "sync:enqueue-upload", … }` arrives over the IPC channel after this change is applied
- **THEN** the response is `{ ok: false, error: { tag: "unknown-command", message } }`

#### Scenario: files:upload command is registered

- **WHEN** a frame `{ command: "files:upload", params: { datasourceId, sourcePath, targetPath, conflictPolicy: "fail" } }` arrives
- **THEN** the dispatcher routes it to the new `files-upload.ts` handler; the response shape is `{ ok: true, value: { uploadJobId } }` on success

#### Scenario: uploads:list-active and sync:cancel-upload commands are registered

- **WHEN** the dispatcher's command-name set is enumerated
- **THEN** the set includes `"uploads:list-active"`, `"sync:cancel-upload"`, and `"files:upload"`; it does NOT include `"sync:enqueue-upload"`

### Requirement: Sync dedup rule rejects duplicate enqueues

On receiving a `sync:enqueue-mirror` request, the service SHALL execute within a single `BEGIN IMMEDIATE` SQLite transaction a query for any existing row in `jobs` with `kind = 'sync'`, the same `datasourceId`, the same `sourcePath`, AND `status IN ('queued', 'running', 'waiting-network')`. If a row exists, the service SHALL NOT INSERT a new job and SHALL return a response `{ ok: false, error: { tag: 'sync-already-running', existingJobId, datasourceId, sourcePath } }`. If no row exists, the service SHALL INSERT the new job within the same transaction and return `{ ok: true, result: { jobId } }`.

(The previous clause "This dedup rule SHALL NOT apply to `sync:enqueue-upload`" is removed — `sync:enqueue-upload` no longer exists. Direct upload concurrency is governed instead by the concurrent-target conflict guard on `files:upload`, see ADDED Requirement: Concurrent-target upload conflict guard.)

#### Scenario: Second concurrent mirror enqueue is rejected

- **WHEN** a first `sync:enqueue-mirror` for `(datasourceId: "ds-1", sourcePath: "/home/u/pics")` has been accepted and the resulting job is in `queued` status, and a second identical request arrives
- **THEN** the second request's response has `ok: false, error.tag === 'sync-already-running', error.existingJobId === <first job id>`, and `SELECT COUNT(*) FROM jobs WHERE kind='sync' AND status NOT IN ('completed','failed','cancelled')` returns `1`

#### Scenario: Duplicate is allowed on a different sourcePath

- **WHEN** a first sync job for `(ds-1, /a)` is in `queued` and a second sync job for `(ds-1, /b)` is enqueued
- **THEN** both requests succeed, two distinct job ids are returned, and both rows coexist in `jobs`

### Requirement: Per-job `conflictPolicy` is set at enqueue and the service never prompts

Every upload performed by the service — whether from a direct `files:upload` RPC or from a mirror-sync's inner `upload-new` / `upload-changed` operation — SHALL respect a `conflictPolicy: 'overwrite' | 'duplicate' | 'skip'` value attached to its operation. For direct uploads, the policy comes from the `files:upload` request's `conflictPolicy` field; for mirror-sync inner operations, the policy comes from the parent sync job's `conflictPolicy` (which defaults to `'overwrite'` in a `sync:enqueue-mirror` request). The service SHALL NOT issue any IPC event asking the client for a mid-operation conflict decision. When a conflict arises and policy is `'skip'`, the inner operation SHALL be a no-op, its per-file summary counted as `skipped`.

#### Scenario: Overwrite policy replaces the remote file

- **WHEN** a `files:upload` with `conflictPolicy: 'overwrite'` targets an existing remote file
- **THEN** `client.uploadFile` is called with semantics that replace the remote contents (per the engine's contract), the response resolves `{ ok: true, value: { uploadJobId } }`, the service emits `file-created` on `sync:event-stream`, and no "conflict-prompt" event is emitted anywhere

#### Scenario: Skip policy leaves remote intact for direct upload

- **WHEN** a `files:upload` with `conflictPolicy: 'skip'` targets an existing remote file and the engine reports the target already exists
- **THEN** no remote write occurs; the response resolves with a result reflecting the skip (e.g., `{ ok: true, value: { uploadJobId, skipped: true } }`); no `file-created` event fires; the registry entry is deleted

### Requirement: Full re-upload on network retry

When a mirror-sync job transitions `waiting-network → queued` and is subsequently executed, the `MirrorSyncJobExecutor`'s inner upload operations SHALL call `client.uploadFile` starting from byte 0 of the source file. The service SHALL NOT attempt to resume a partial upload via provider session APIs. The `attempt` counter on the `jobs` row SHALL be incremented exactly once per transition from `waiting-network` back to a terminal status (success or failure). This requirement applies ONLY to mirror-sync; direct uploads via `files:upload` do not use the scheduler retry pattern (a direct upload's failure is surfaced to the renderer immediately and the user retries manually if desired).

#### Scenario: Retry after network restoration restarts the mirror-sync upload

- **WHEN** a fake client's first `uploadFile` invocation inside a `MirrorSyncJobExecutor` fails with `network-error` at 50% progress, the job moves to `waiting-network`, the probe succeeds, and the retry invocation is observed
- **THEN** the retry invocation receives `{ path: sourcePath }` with no `startOffset` or `uploadId` parameter, the fake client observes a full byte-range read from 0 to EOF, and the job eventually completes with total `attempt === 2`

#### Scenario: Direct upload network failure surfaces to renderer immediately

- **WHEN** a `files:upload` invocation throws `DatasourceError { tag: "network-error" }`
- **THEN** the response is `{ ok: false, error: { tag: "network-error", … } }`; the service emits `upload-failed` on `sync:event-stream`; NO retry is scheduled, NO `waiting-network` state, NO automatic re-upload — the renderer surfaces the failure and the user re-issues `files:upload` manually if desired
