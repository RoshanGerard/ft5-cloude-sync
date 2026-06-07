## MODIFIED Requirements

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
conflictPolicy)`. The engine's strategy determines whether the target
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
7. If the pipeline rejects with an auth-expired error mid-stream AND the loop attempt count is below `MAX_AUTH_RETRIES` (default 1), updates `rangeStart = bytesWritten` from the file size on disk and continues the loop. The next `engine.downloadFile` call goes through `withRefresh` afresh.
8. If the pipeline rejects with `abortController.signal.aborted`, emits `download-cancelled` and returns the cancel response.
9. If the pipeline rejects with any other error, emits `download-failed` and returns the error response.
10. After successful loop exit, performs an integrity check (compare hash of `effectiveTargetPath` against the provider's hash if available) and emits `file-downloaded { downloadJobId, savedPath: effectiveTargetPath, bytes }`. Replies `{ ok: true, value: { savedPath: effectiveTargetPath, bytes } }`. Removes the registry entry.

The `downloadJobId` SHALL be the canonical job key for cancel and progress correlation; clients reference it in `downloads:list-active`, in cancel commands, and in event subscriptions.

#### Scenario: Successful download streams from engine to disk

- **WHEN** a client sends `files:download { datasourceId: "ds-1", path: "/welcome.pdf", toPath: "/Users/alice/Downloads/ft5/welcome.pdf", conflictPolicy: "fail" }` and no file exists at the destination
- **THEN** `toPath` validation passes; the conflict gate sees no file at the destination; the handler mints `downloadJobId`, creates the registry entry with `targetPath === toPath`, calls `engine.downloadFile(target, { rangeStart: 0, signal, onProgress })`; `engine.downloadFile` resolves with `{ stream, contentLength: N }`; the handler pipes the stream to `fs.createWriteStream(toPath, { flags: "w", start: 0 })`; on stream end the handler reads `fs.stat(toPath).size === N`; integrity check passes; the handler emits `file-downloaded { downloadJobId, savedPath: toPath, bytes: N }` and replies `{ ok: true, value: { savedPath: toPath, bytes: N } }`; the registry entry is removed

#### Scenario: Mid-stream auth-expired triggers handler-driven retry

- **WHEN** a `files:download` is in flight; after N bytes are written, the pipeline rejects with `tag: "auth-expired"`
- **THEN** the handler reads `fs.stat(effectiveTargetPath).size === N`; sets `rangeStart = N`; calls `engine.downloadFile(target, { rangeStart: N, signal, onProgress })` again; the engine's `withRefresh` wrapper detects the auth-expired credential and refreshes once before issuing the new GET; the GET returns 206 Partial Content with `Content-Range: bytes N-M/T`; the handler validates `contentRange.start === N`; pipes from byte N (using `flags: "r+", start: N`); on stream end `fs.stat(effectiveTargetPath).size === contentLength`; the loop exits with success

#### Scenario: Range-not-honored aborts with terminal error

- **WHEN** during a retry iteration, `engine.downloadFile(target, { rangeStart: N, … })` resolves with `contentRange === undefined` (provider ignored the Range header and returned 200 OK)
- **THEN** the handler does NOT pipe the stream; throws a terminal `range-not-supported` error; emits `download-failed { downloadJobId, tag: "other", message: "range not supported on this resource" }`; the partial file at `effectiveTargetPath` is left on disk; the registry entry is removed

#### Scenario: Cancel mid-stream

- **WHEN** the client invokes a cancel command (or the download orchestration emits a cancel) while the pipeline is in flight; the handler invokes `abortController.abort()`
- **THEN** the engine's downloaded stream rejects via the AbortSignal; the pipeline rejects with AbortError; the handler emits `download-cancelled { downloadJobId, bytesDownloaded, bytesTotal, reason: "user" }` exactly once; the partial file at `effectiveTargetPath` is NOT auto-deleted; the registry entry is removed; the response is `{ ok: false, error: { tag: "cancelled", message: "download cancelled" } }`

#### Scenario: Multi-cycle stable-network long download

- **WHEN** a `files:download` for a 5TB file is in flight against a provider with a 1-hour token lifetime; over 15 hours of streaming, the access token expires 15 distinct times
- **THEN** each token expiry surfaces as a mid-stream auth-expired error to the handler; on each error the handler retries with `rangeStart = <current bytes on disk>`; each retry call to `engine.downloadFile` goes through `withRefresh` which refreshes the credential once and issues a 206 Partial Content GET; the consumer's pipe-to-disk continues from the new `rangeStart`; the `MAX_AUTH_RETRIES` budget is per-cycle (one retry per auth-expired event), reset between cycles; total bytes written equals contentLength; the integrity check passes; the loop exits with success after the final cycle

#### Scenario: Rename file via the new RPC

- **WHEN** a client sends `files:rename { datasourceId: "ds-1", path: "/foo.pdf", newName: "bar.pdf", conflictPolicy: "fail" }`
- **THEN** the handler resolves the engine client for `ds-1`, calls `client.rename(target, "bar.pdf", "fail")`, the strategy determines via its provider context that the target is a file, performs the rename, and on success the handler replies `{ ok: true, value: { entry: { path: "/bar.pdf", name: "bar.pdf", … } } }`; the engine emits `entry-renamed` exactly once

#### Scenario: Rename directory on Drive

- **WHEN** a client sends `files:rename { datasourceId: "ds-drive", path: "/projects", newName: "archive", conflictPolicy: "fail" }` against a Drive folder
- **THEN** the handler calls `client.rename(target, "archive", "fail")`; the Drive strategy issues `files.update({fileId, requestBody: {name: "archive"}})` (uniform API for files and folders); on success the handler replies with the renamed entry

#### Scenario: Rename directory on S3 surfaces unsupported

- **WHEN** a client sends `files:rename { datasourceId: "ds-s3", path: "/backups", newName: "archive", conflictPolicy: "fail" }` against an S3 virtual folder
- **THEN** the handler calls `client.rename(target, "archive", "fail")`, the S3 strategy's introspection (`HeadObject` 404 + `ListObjectsV2` returns at least one key) determines the target is a folder, the strategy rejects with `DatasourceError { tag: "unsupported", message: "S3 folder rename is not supported in this version" }`, and the response is `{ ok: false, error: { tag: "other", message: "S3 folder rename is not supported in this version", retryable: false } }`

## ADDED Requirements

### Requirement: `files:download` handler gates on existing `toPath` via `conflictPolicy`

The `files:download` handler SHALL probe the local filesystem for an existing file at `toPath` BEFORE the concurrency guard, the engine client resolution, the registry insert, and the cycle loop. The probe SHALL run AFTER `validateToPath`. The gate's behavior is determined by the request's `conflictPolicy` field (default `"fail"` when omitted):

- `"fail"` + file exists at `toPath` + no resume-of-self carve-out applies → handler returns `{ ok: false, error: { tag: "conflict", message: "destination already exists at <path>", retryable: false, existingPath: <toPath>, existingSize: <stat.size>, existingModifiedAt: <stat.mtime.toISOString()> } }`. The handler SHALL NOT mint a `downloadJobId`, SHALL NOT insert a registry entry, and SHALL NOT call `engine.downloadFile`.
- `"fail"` + no file exists at `toPath` → handler proceeds with `effectiveTargetPath = toPath` and the cycle loop opens with `flags: "w"` per the existing requirement.
- `"overwrite"` + file exists at `toPath` → handler proceeds with `effectiveTargetPath = toPath`; the cycle loop's first iteration opens with `flags: "w"` and truncates the existing file.
- `"overwrite"` + no file exists at `toPath` → handler proceeds identically to `"fail"` + no file (the `"overwrite"` policy is a no-op when no conflict exists).
- `"keep-both"` + file exists at `toPath` → handler computes `effectiveTargetPath` via the suffix loop (see scenarios below). The registry entry's `targetPath` field is `effectiveTargetPath`; the cycle loop opens against `effectiveTargetPath`; the response's `savedPath` is `effectiveTargetPath`.
- `"keep-both"` + no file exists at `toPath` → handler proceeds with `effectiveTargetPath = toPath` (no suffix needed).

The probe SHALL use `fs.stat(toPath)` (or equivalent); ENOENT → no file exists; any other stat error → propagate as a `tag: "other"` error per existing handler semantics.

The conflict envelope's `existingSize` and `existingModifiedAt` fields SHALL be populated from the same `fs.stat` call that detects existence — no additional syscall. `existingModifiedAt` is the ISO 8601 string of `stats.mtime`.

The resume-of-self carve-out: when `DownloadRegistry.findByKey(datasourceId, path)` returns an entry whose `targetPath === toPath` AND `bytesDownloaded > 0`, the gate is skipped entirely (the partial file at `toPath` belongs to the registry's own aborted download — re-dispatching is a resume, not a new download). The concurrency guard at the next step still rejects this case as a duplicate dispatch (the registry entry already exists), so the carve-out's reachability today is bounded by registry mutations between the gate probe and the guard. After `migrate-download-registry-to-sqlite` lands, the guard's logic adapts to permit resume of a dormant registry entry, at which point the carve-out becomes load-bearing for restart-after-pause flows.

The `"keep-both"` suffix loop SHALL:

- Parse `toPath` into `(dir, basename, ext)` where `basename` is the filename without its trailing extension and `ext` includes the leading dot (e.g., `welcome.pdf` → `(dir, "welcome", ".pdf")`; `Makefile` → `(dir, "Makefile", "")`).
- Iterate `n = 1, 2, 3, …` constructing `candidate = path.join(dir, basename + " (" + n + ")" + ext)`.
- For each candidate, attempt `fs.open(candidate, "wx")` (the Node equivalent of `O_CREAT|O_EXCL`). On `EEXIST`, increment `n` and retry. On success, close the handle (the cycle loop will re-open with `flags: "w", start: 0`); `effectiveTargetPath = candidate`.
- On any non-EEXIST error from `fs.open`, propagate as a `tag: "other"` error per existing handler semantics.

#### Scenario: Default policy is `"fail"` when omitted

- **WHEN** a client sends `files:download { datasourceId, path, toPath }` with no `conflictPolicy` field
- **THEN** the handler treats the request as `conflictPolicy: "fail"`; if a file exists at `toPath` and no resume-of-self entry applies, the handler returns the `tag: "conflict"` envelope

#### Scenario: `"fail"` policy with existing file returns conflict envelope with hint metadata

- **WHEN** a client sends `files:download { datasourceId: "ds-1", path: "/welcome.pdf", toPath: "/home/alice/Downloads/welcome.pdf", conflictPolicy: "fail" }` and a 4194304-byte file modified at 2026-05-05T12:30:00Z exists at the destination; no DownloadRegistry entry matches `(datasourceId, path)`
- **THEN** the handler probes `fs.stat(toPath)` and observes the existing file; returns `{ ok: false, error: { tag: "conflict", message: "destination already exists at /home/alice/Downloads/welcome.pdf", retryable: false, existingPath: "/home/alice/Downloads/welcome.pdf", existingSize: 4194304, existingModifiedAt: "2026-05-05T12:30:00.000Z" } }`; no `downloadJobId` is minted; no registry entry is inserted; `engine.downloadFile` is never called

#### Scenario: `"fail"` policy with no existing file proceeds normally

- **WHEN** a client sends `files:download { …, conflictPolicy: "fail" }` and `fs.stat(toPath)` rejects with ENOENT
- **THEN** the gate passes; the handler proceeds to the concurrency guard, registry insert, and cycle loop per the existing requirement; the first cycle opens `fs.createWriteStream(toPath, { flags: "w", start: 0 })`

#### Scenario: `"overwrite"` policy truncates the existing file

- **WHEN** a client sends `files:download { …, conflictPolicy: "overwrite" }` and a file exists at `toPath`
- **THEN** the gate observes the file but does not return a conflict envelope; the handler proceeds with `effectiveTargetPath = toPath`; the first cycle opens `fs.createWriteStream(toPath, { flags: "w", start: 0 })` and truncates the existing file; on success the response carries `savedPath === toPath`

#### Scenario: `"keep-both"` policy with `(1)` suffix free

- **WHEN** a client sends `files:download { …, toPath: "/home/alice/Downloads/welcome.pdf", conflictPolicy: "keep-both" }` and `welcome.pdf` exists at the destination but `welcome (1).pdf` does not
- **THEN** the suffix loop tries `fs.open("/home/alice/Downloads/welcome (1).pdf", "wx")` and succeeds; closes the handle; sets `effectiveTargetPath = "/home/alice/Downloads/welcome (1).pdf"`; the registry entry's `targetPath === effectiveTargetPath`; the cycle loop opens against `effectiveTargetPath`; on success the response carries `savedPath === "/home/alice/Downloads/welcome (1).pdf"`

#### Scenario: `"keep-both"` policy iterates past `(1)` collision

- **WHEN** a client sends `files:download { …, toPath: "/home/alice/Downloads/welcome.pdf", conflictPolicy: "keep-both" }` and `welcome.pdf`, `welcome (1).pdf`, `welcome (2).pdf` all exist
- **THEN** the suffix loop tries `welcome (1).pdf` (EEXIST), `welcome (2).pdf` (EEXIST), `welcome (3).pdf` (success); closes the handle; `effectiveTargetPath = ".../welcome (3).pdf"`; the response's `savedPath` reflects the final path

#### Scenario: `"keep-both"` policy with no extension

- **WHEN** a client sends `files:download { …, toPath: "/home/alice/Documents/Makefile", conflictPolicy: "keep-both" }` and `Makefile` exists
- **THEN** the suffix loop tries `Makefile (1)` (no extension dot); on success the response carries `savedPath === "/home/alice/Documents/Makefile (1)"`

#### Scenario: `"keep-both"` policy with no existing file is a no-op

- **WHEN** a client sends `files:download { …, conflictPolicy: "keep-both" }` and no file exists at `toPath`
- **THEN** the suffix loop is not entered; `effectiveTargetPath = toPath`; the handler proceeds identically to the `"fail"` + no-file path

#### Scenario: Resume-of-self carve-out skips the gate

- **WHEN** the DownloadRegistry holds an entry with `(datasourceId, sourcePath, targetPath) = (ds-1, /welcome.pdf, /home/alice/Downloads/welcome.pdf)` and `bytesDownloaded === 1024`; a partial file of 1024 bytes exists at the registry's `targetPath`; a client sends a fresh `files:download { datasourceId: "ds-1", path: "/welcome.pdf", toPath: "/home/alice/Downloads/welcome.pdf", conflictPolicy: "fail" }`
- **THEN** the gate observes the existing entry via `findByKey`, confirms `targetPath === toPath` AND `bytesDownloaded > 0`, and skips the conflict probe; the request flows to the concurrency guard, which rejects it as a duplicate (the registry entry already exists). The carve-out exists for forward-compatibility with `migrate-download-registry-to-sqlite`; today's in-memory registry makes this scenario reachable only mid-session

#### Scenario: Conflict gate runs after `validateToPath` and before concurrency guard

- **WHEN** a client sends `files:download` with an invalid `toPath` (e.g., `../../../etc/passwd`)
- **THEN** `validateToPath` rejects with the existing `tag: "other"` envelope BEFORE the conflict gate runs; the gate's `fs.stat` call is never made for invalid paths
- **AND WHEN** a client sends `files:download` with a valid but conflicting `toPath`
- **THEN** the gate returns the `tag: "conflict"` envelope BEFORE the concurrency guard runs; the handler does NOT mint a `downloadJobId` and does NOT insert a registry entry, so a subsequent `files:download` for the same `(datasourceId, sourcePath)` is NOT rejected by the concurrency guard on a phantom registry entry

#### Scenario: Conflict envelope conforms to the extended `FilesCommandError` shape

- **WHEN** the gate returns a conflict envelope
- **THEN** the envelope conforms to the extended `FilesCommandError` type defined in `packages/ipc-contracts/src/files.ts`: `tag: "conflict"`, `message: string`, `retryable: false`, `existingPath: string`, `existingSize: number`, `existingModifiedAt: string` (ISO 8601). The envelope MAY omit `retryAfterMs`. The `existingSize` and `existingModifiedAt` fields are required for the download conflict gate even though they are optional on the type (rename callers are not required to populate them)
