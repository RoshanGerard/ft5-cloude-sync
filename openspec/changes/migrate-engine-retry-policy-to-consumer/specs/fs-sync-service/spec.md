# fs-sync-service spec delta — migrate-engine-retry-policy-to-consumer

## MODIFIED Requirements

### Requirement: System-level retry for network / rate-limit / auth-expired

When a job execution throws a `DatasourceError` from the engine, the scheduler SHALL inspect `error.tag` and react as follows:

- `network-error`: transition the job to `waiting-network`, increment `attempt`, and arm the network probe (see separate requirement). On `network-available`, transition back to `queued`. This loop SHALL be unlimited (no `maxAttempts` from a user retry policy applies).
- `rate-limited`: wait for `error.retryAfterMs` (or, if absent, 5000 ms), then re-enter the queue for ONE retry attempt per rate-limit hit. A second consecutive `rate-limited` on the same attempt-count restarts the wait-and-retry.
- `auth-expired`: the scheduler SHALL NOT intercept it with a retry. The engine no longer auto-refreshes on `auth-expired`; instead the `MirrorSyncJobExecutor` wraps each engine call (`uploadFile`, `deleteFile`) in the engine's `withAuthRefresh(client, op)` helper, which calls `client.refreshCredentials()` and retries once BEFORE any error escapes the executor. An `auth-expired` that still reaches the scheduler is therefore a post-refresh dead token; the scheduler propagates it as terminal (no scheduler-level retry), consistent with the prior contract.

These behaviours SHALL NOT be modifiable by any user-supplied retry policy.

#### Scenario: Network error moves job to waiting-network

- **WHEN** a fake client's `uploadFile` throws `new DatasourceError({ tag: 'network-error', retryable: true })` on its first attempt
- **THEN** the job's `status` becomes `waiting-network`, its `attempt` is incremented by 1, no `job-failed` event is emitted, and no user retry-policy is consulted

#### Scenario: Rate-limited waits and retries once

- **WHEN** a fake client throws `DatasourceError { tag: 'rate-limited', retryAfterMs: 200 }` on its first call and succeeds on its second
- **THEN** the scheduler waits at least 200 ms before the retry, exactly two executor calls are made, the job completes `completed`, and no user retry policy is consulted

#### Scenario: Mirror-sync refreshes once on auth-expired via withAuthRefresh

- **WHEN** a fake client's `uploadFile` inside a `MirrorSyncJobExecutor` throws `DatasourceError { tag: 'auth-expired' }` on its first call and succeeds on its second
- **THEN** `client.refreshCredentials()` is called exactly once, the upload retries and succeeds within the executor (via `withAuthRefresh`), the job completes `completed`, and the scheduler observes no error

#### Scenario: Mirror-sync surfaces auth-revoked when refresh does not clear auth-expired

- **WHEN** a fake client's `uploadFile` inside a `MirrorSyncJobExecutor` throws `auth-expired` on its first call and again on its retry (after `refreshCredentials()`)
- **THEN** `client.refreshCredentials()` is called exactly once, the `auth-expired` escapes the executor to the scheduler, and the scheduler transitions the job to `failed` with no further retry

### Requirement: `files:rename` and `files:download` RPC commands delegate to the engine

The service SHALL accept two new commands on its IPC channel:
`files:rename` and `files:download`. Both SHALL resolve the engine client
for the request's `datasourceId` via the existing `ClientFactory`
machinery (the same path used by `files:list`, `files:stat`,
`files:search`, `files:remove`).

`files:rename` accepts:

```typescript
{
  datasourceId: string;
  path: string;
  handle?: string;
  newName: string;
  conflictPolicy: "fail" | "overwrite" | "keep-both";
}
```

The handler forwards the call to `client.rename(target, newName,
conflictPolicy)`, wrapped in the engine's `withAuthRefresh(client, op)`
helper so a stale-but-refreshable token refreshes once and retries before
the error surfaces. The engine's strategy determines whether the target
is a file or directory within its own provider context (Drive/OneDrive
metadata, S3 `HeadObject` + `ListObjectsV2` introspection); the wire
contract carries no `kind` field. Response: `{ ok: true, value: {
entry: DatasourceFileEntry } } | { ok: false, error }`. Error tags
include the new `"conflict"` variant carrying `existingPath` per the
engine's new `DatasourceErrorTag.Conflict`.

`files:download` accepts:

```typescript
{
  datasourceId: string;
  path: string;
  handle?: string;
  toPath: string;  // required, absolute, validated at boundary
  conflictPolicy?: "fail" | "overwrite" | "keep-both";  // default "fail"
}
```

The handler MUST first validate `toPath` (see "toPath validation" requirement below). After validation, the handler SHALL run the destination-conflict gate (see "files:download handler gates on existing toPath via conflictPolicy" requirement below) BEFORE the concurrency guard, the engine client resolution, the registry insert, and the cycle loop. On success, the handler:

1. Mints a service-level `downloadJobId` (UUID) and creates an `AbortController` for the job. Inserts a registry entry. The registry's `targetPath` field carries the `effectiveTargetPath` — equal to `toPath` for `"fail"` and `"overwrite"` policies; equal to the suffix-resolved free filename for `"keep-both"`.
2. Enters a retry loop. Initial iteration: `rangeStart = 0`. Each iteration calls `engine.downloadFile(target, { rangeStart, signal: abortController.signal, onProgress: <fires service-level downloading event> })`.
3. Validates the response: if `rangeStart > 0` and `contentRange === undefined` (provider ignored the Range header), throws a terminal `range-not-supported` error.
4. Validates: if `rangeStart > 0` and `contentRange.start !== rangeStart`, throws a terminal `range-mismatch` error.
5. Pipes the returned stream to `fs.createWriteStream(effectiveTargetPath, { flags: rangeStart === 0 ? "w" : "r+", start: rangeStart })`.
6. After the pipeline resolves, reads `fs.stat(effectiveTargetPath).size` to determine `bytesWritten`. If `bytesWritten === contentLength`, breaks out of the loop (success).
7. If `engine.downloadFile` rejects with an `auth-expired` error — either the initial GET (before any bytes stream) or the pipeline mid-stream — AND the per-cycle auth-retry budget (`MAX_AUTH_RETRIES`, default 1) is not exhausted, the handler explicitly calls `client.refreshCredentials()` once, sets `rangeStart = bytesWritten` from the file size on disk (0 if nothing has been written yet), and re-issues `engine.downloadFile`. The engine NO LONGER auto-refreshes — the handler owns the refresh. If the re-issued call AGAIN returns `auth-expired` immediately after a successful `refreshCredentials()`, the refresh token is dead and the handler surfaces `auth-revoked` (no further retry).
8. If the pipeline rejects with `abortController.signal.aborted`, emits `download-cancelled` and returns the cancel response.
9. If the pipeline rejects with any other error, emits `download-failed` and returns the error response.
10. After successful loop exit, performs an integrity check (compare hash of `effectiveTargetPath` against the provider's hash if available) and emits `file-downloaded { downloadJobId, savedPath: effectiveTargetPath, bytes }`. Replies `{ ok: true, value: { savedPath: effectiveTargetPath, bytes } }`. Removes the registry entry.

The `downloadJobId` SHALL be the canonical job key for cancel and progress correlation; clients reference it in `downloads:list-active`, in cancel commands, and in event subscriptions.

#### Scenario: Successful download streams from engine to disk

- **WHEN** a client sends `files:download { datasourceId: "ds-1", path: "/welcome.pdf", toPath: "/Users/alice/Downloads/ft5/welcome.pdf", conflictPolicy: "fail" }` and no file exists at the destination
- **THEN** `toPath` validation passes; the conflict gate sees no file at the destination; the handler mints `downloadJobId`, creates the registry entry with `targetPath === toPath`, calls `engine.downloadFile(target, { rangeStart: 0, signal, onProgress })`; `engine.downloadFile` resolves with `{ stream, contentLength: N }`; the handler pipes the stream to `fs.createWriteStream(toPath, { flags: "w", start: 0 })`; on stream end the handler reads `fs.stat(toPath).size === N`; integrity check passes; the handler emits `file-downloaded { downloadJobId, savedPath: toPath, bytes: N }` and replies `{ ok: true, value: { savedPath: toPath, bytes: N } }`; the registry entry is removed

#### Scenario: Pre-stream auth-expired refreshes then retries

- **WHEN** a `files:download` is dispatched; the initial `engine.downloadFile(target, { rangeStart: 0, … })` GET rejects with `tag: "auth-expired"` before any bytes stream
- **THEN** the handler calls `client.refreshCredentials()` exactly once, then re-issues `engine.downloadFile(target, { rangeStart: 0, signal, onProgress })`; the post-refresh GET resolves with `{ stream, contentLength: N }`; the download proceeds to completion and replies `{ ok: true, value: { savedPath, bytes: N } }`

#### Scenario: Mid-stream auth-expired triggers handler-driven refresh and retry

- **WHEN** a `files:download` is in flight; after N bytes are written, the pipeline rejects with `tag: "auth-expired"`
- **THEN** the handler reads `fs.stat(effectiveTargetPath).size === N`; calls `client.refreshCredentials()` exactly once; sets `rangeStart = N`; re-issues `engine.downloadFile(target, { rangeStart: N, signal, onProgress })`; the post-refresh GET returns 206 Partial Content with `Content-Range: bytes N-M/T`; the handler validates `contentRange.start === N`; pipes from byte N (using `flags: "r+", start: N`); on stream end `fs.stat(effectiveTargetPath).size === contentLength`; the loop exits with success

#### Scenario: Refresh that does not clear auth-expired surfaces auth-revoked

- **WHEN** a `files:download` GET rejects with `auth-expired`, the handler calls `client.refreshCredentials()`, and the re-issued `engine.downloadFile` GET AGAIN rejects with `auth-expired`
- **THEN** the handler treats the refresh token as dead: it does NOT refresh a second time, emits `download-failed`, and replies `{ ok: false, error: { tag: "auth-revoked", … } }`

#### Scenario: Range-not-honored aborts with terminal error

- **WHEN** during a retry iteration, `engine.downloadFile(target, { rangeStart: N, … })` resolves with `contentRange === undefined` (provider ignored the Range header and returned 200 OK)
- **THEN** the handler does NOT pipe the stream; throws a terminal `range-not-supported` error; emits `download-failed { downloadJobId, tag: "other", message: "range not supported on this resource" }`; the partial file at `effectiveTargetPath` is left on disk; the registry entry is removed

#### Scenario: Cancel mid-stream

- **WHEN** the client invokes a cancel command (or the download orchestration emits a cancel) while the pipeline is in flight; the handler invokes `abortController.abort()`
- **THEN** the engine's downloaded stream rejects via the AbortSignal; the pipeline rejects with AbortError; the handler emits `download-cancelled { downloadJobId, bytesDownloaded, bytesTotal, reason: "user" }` exactly once; the partial file at `effectiveTargetPath` is NOT auto-deleted; the registry entry is removed; the response is `{ ok: false, error: { tag: "cancelled", message: "download cancelled" } }`

#### Scenario: Multi-cycle stable-network long download

- **WHEN** a `files:download` for a 5TB file is in flight against a provider with a 1-hour token lifetime; over 15 hours of streaming, the access token expires 15 distinct times
- **THEN** each token expiry surfaces as an auth-expired error to the handler; on each error the handler calls `client.refreshCredentials()` once, then re-issues `engine.downloadFile` with `rangeStart = <current bytes on disk>`; each post-refresh GET returns a 206 Partial Content response; the consumer's pipe-to-disk continues from the new `rangeStart`; the `MAX_AUTH_RETRIES` budget is per-cycle (one refresh-and-retry per auth-expired event), reset between cycles; total bytes written equals contentLength; the integrity check passes; the loop exits with success after the final cycle

#### Scenario: Rename file via the new RPC

- **WHEN** a client sends `files:rename { datasourceId: "ds-1", path: "/foo.pdf", newName: "bar.pdf", conflictPolicy: "fail" }`
- **THEN** the handler resolves the engine client for `ds-1`, calls `client.rename(target, "bar.pdf", "fail")`, the strategy determines via its provider context that the target is a file, performs the rename, and on success the handler replies `{ ok: true, value: { entry: { path: "/bar.pdf", name: "bar.pdf", … } } }`; the engine emits `entry-renamed` exactly once

#### Scenario: Rename directory on Drive

- **WHEN** a client sends `files:rename { datasourceId: "ds-drive", path: "/projects", newName: "archive", conflictPolicy: "fail" }` against a Drive folder
- **THEN** the handler calls `client.rename(target, "archive", "fail")`; the Drive strategy issues `files.update({fileId, requestBody: {name: "archive"}})` (uniform API for files and folders); on success the handler replies with the renamed entry

#### Scenario: Rename directory on S3 surfaces unsupported

- **WHEN** a client sends `files:rename { datasourceId: "ds-s3", path: "/backups", newName: "archive", conflictPolicy: "fail" }` against an S3 virtual folder
- **THEN** the handler calls `client.rename(target, "archive", "fail")`, the S3 strategy's introspection (`HeadObject` 404 + `ListObjectsV2` returns at least one key) determines the target is a folder, the strategy rejects with `DatasourceError { tag: "unsupported", message: "S3 folder rename is not supported in this version" }`, and the response is `{ ok: false, error: { tag: "other", message: "S3 folder rename is not supported in this version", retryable: false } }`
