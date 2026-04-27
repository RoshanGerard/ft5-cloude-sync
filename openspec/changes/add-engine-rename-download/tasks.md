# Tasks: add-engine-rename-download

Each task lands behind a failing test first per the Superpowers
`test-driven-development` skill. Long-running commands (test suites,
builds) MUST be dispatched via subagent with `run_in_background: true`
per CLAUDE.md. Subagent dispatch per task per CLAUDE.md
`subagent-driven-development`.

Three layers, in order: engine → service → main IPC + renderer. No
layer-skip allowed (per design.md Decision 5 / project layering rules).

## 1. Pre-flight & worktree

- [ ] 1.1 Confirm with user where to put the worktree: in-place vs sibling (per CLAUDE.md `using-git-worktrees`); default to `.worktrees/add-engine-rename-download/` if no answer
- [ ] 1.2 Create the worktree + branch via the `using-git-worktrees` skill (worktree at chosen path, branch `feature/add-engine-rename-download` off master HEAD; pnpm install in the worktree)
- [ ] 1.3 Verify a clean baseline: run `pnpm typecheck` and the full vitest suite once in the worktree to confirm green-before-changes; capture any pre-existing flaky failures (e.g., the `scripts/preload-bundle.test.ts` flake noted in prior changes)

## 2. Contracts — `FilesRenameRequest` extension + `Conflict` error tag

- [ ] 2.1 Write a typed test asserting `FilesRenameRequest` carries `conflictPolicy: "fail" | "overwrite" | "keep-both"` (the wire type is non-optional; default `"fail"` is enforced at the consumer layer); test fails until shape lands
- [ ] 2.2 Add the field to `packages/ipc-contracts/src/files.ts`'s `FilesRenameRequest`; rerun typed test → green
- [ ] 2.3 Write a typed test asserting `FilesErrorTag` includes `Conflict: "conflict"`; test fails
- [ ] 2.4 Extend `FilesErrorTag` in the contracts package + update the `FilesErrorTag` `as const` object; rerun typed test → green
- [ ] 2.5 Write a typed test asserting `FilesRenameResponse` error envelope's optional fields include `existingPath: string` carried alongside `tag: "conflict"`; test fails
- [ ] 2.6 Update the response envelope type to optionally carry `existingPath`; rerun → green
- [ ] 2.7 Write a typed test asserting `FilesDownloadRequest.toPath` is non-optional `string` (was optional in the mock-fs era); test fails
- [ ] 2.8 Update the type; rerun → green

## 3. Contracts — `downloads:list-active` command + `downloading` event + cancel command

- [ ] 3.1 Write a typed test asserting `DownloadsListActiveRequest` and `DownloadsListActiveResponse` are present in `@ft5/ipc-contracts/sync-service`; the response carries `{ ok: true, value: { jobs: DownloadJob[] } }` with `DownloadJob = { transactionId, datasourceId, sourcePath, targetPath, bytesDownloaded, contentLength, startedAt }`; test fails
- [ ] 3.2 Add the request/response types + `DownloadJob` shape to the sync-service contracts; add `"downloads:list-active"` to `COMMAND_NAMES`; rerun typed test → green
- [ ] 3.3 Write a typed test asserting `DownloadingEvent`, `FileDownloadedEvent`, `DownloadCancelledEvent`, `DownloadFailedEvent` payload shapes are present in the engine event taxonomy; test fails (these are new bus events)
- [ ] 3.4 Extend the event payload union types in `packages/ipc-contracts/src/events.ts` (or wherever the engine's `PayloadMap` lives); rerun → green
- [ ] 3.5 Write a typed test asserting a new `EntryRenamedEvent { from: Target, to: DatasourceFileEntry<T> }` is present
- [ ] 3.6 Add the event type; rerun → green
- [ ] 3.7 Run the full ipc-contracts vitest suite; verify no regressions

## 4. Engine — `rename` base-class primitive

- [ ] 4.1 Write a unit test for `BaseDatasourceClient.rename`: a minimal subclass implements `doRenameImpl` (returns a renamed entry); calling `rename` emits exactly one `entry-renamed { from, to }` event; resolves with the entry. Test fails — `rename` doesn't exist yet
- [ ] 4.2 Add `rename(target, newName, conflictPolicy): Promise<DatasourceFileEntry<T>>` + `protected abstract doRenameImpl(...)` to base-client.ts; wrap with `withRefresh` + emit `entry-renamed` on success + emit `delete-failed { via: "rename" }` on failure; rerun test → green
- [ ] 4.3 Write a unit test for `rename` with `conflictPolicy: "fail"` rejecting with `tag: "conflict"` when the strategy throws a conflict-shaped error; test fails
- [ ] 4.4 Implement the conflict-error normalization in the base wrapper; the base detects strategy-thrown `ConflictError` (or a normalized shape) and routes to `DatasourceError { tag: "conflict", raw: { existingPath } }`; rerun test → green
- [ ] 4.5 Write a unit test for `rename` with `conflictPolicy: "overwrite"` on a file: strategy detects existing sibling, deletes it via `doDeleteFileImpl`, then performs the rename; test fails
- [ ] 4.6 Implement the overwrite-then-rename branch (lives in each strategy since the sibling-detection is provider-specific); the deletion does NOT emit a `deleted` event (single-step rename UX per design.md Decision 7); rerun test → green
- [ ] 4.7 Write a unit test for `rename` with `conflictPolicy: "overwrite"` on a **directory**: SHALL refuse with `tag: "unsupported"` per design.md Decision 1 (recursive directory replacement is out of scope); test fails
- [ ] 4.8 Implement the directory-overwrite refusal in each strategy's rename branch; rerun → green
- [ ] 4.9 Write a unit test for `rename` with `conflictPolicy: "keep-both"` retrying with `-2`/`-3`/… suffix until success or 99 attempts; test fails
- [ ] 4.10 Implement the keep-both branch (lives in each strategy alongside its rename API call); cap at 99 attempts then fail with `tag: "other"`; rerun test → green

## 5. Engine — `downloadFile` primitive

- [ ] 5.1 Write a unit test for `BaseDatasourceClient.downloadFile`: a minimal subclass implements `doDownloadFileImpl` (returns `{ stream, contentLength, contentRange? }`); calling `downloadFile(target)` returns the same shape unchanged via `withRefresh`; no transaction ID minted; no engine bus events emitted for download. Test fails
- [ ] 5.2 Add `downloadFile(target, options?: { rangeStart?, signal?, onProgress? })` returning `{ stream, contentLength, contentRange? }` + `doDownloadFileImpl(target, options)` abstract to base-client.ts. Wrap with `withRefresh` for one-shot auth-expired retry on the initial call. Forward `options` directly to the strategy; do NOT track per-download state in the base class. Rerun test → green
- [ ] 5.3 Write a unit test for `rangeStart` propagation: a downstream call with `{ rangeStart: 1024 }` causes the strategy's `doDownloadFileImpl` to receive that value; the strategy responds with `contentRange: { start: 1024, end, total }`; the base passes it through unchanged. Test fails
- [ ] 5.4 Implement; rerun → green
- [ ] 5.5 Write a unit test for `signal` propagation: aborting the passed AbortSignal causes the strategy's underlying SDK call to error with AbortError (or normalized cancelled). Test fails
- [ ] 5.6 Implement; rerun → green
- [ ] 5.7 Write a unit test for `onProgress` propagation: as the strategy emits progress callbacks, the consumer's `onProgress` is invoked with `(loaded, total)`. The engine does NOT emit `downloading` events on its bus. Test fails
- [ ] 5.8 Implement; rerun → green

## 7. Engine — Drive strategy

- [ ] 7.1 Write a unit test for `GoogleDriveClient.doRenameImpl` calling `files.update({ fileId, requestBody: { name } })` for both files and folders (Drive's API is uniform); the strategy reads the post-rename response's `mimeType` to populate the new entry's `kind`; test fails
- [ ] 7.2 Implement `doRenameImpl`; rerun → green
- [ ] 7.3 Write a unit test for sibling-collision pre-check on `conflictPolicy: "fail"`: strategy issues a `files.list({q: "name = 'newName' and '<parentId>' in parents and trashed = false"})` before the rename; if any results, throws conflict with `existingPath`. Test fails
- [ ] 7.4 Implement; rerun → green
- [ ] 7.5 Write a unit test for the directory-overwrite refusal: when the target's `mimeType` is the folder mime AND `conflictPolicy === "overwrite"`, throw `DatasourceError { tag: "unsupported", message: "directory rename with conflictPolicy 'overwrite' is not supported (would require recursive replacement)" }`. Test fails
- [ ] 7.6 Implement; rerun → green
- [ ] 7.7 Write a unit test for `doDownloadFileImpl(target, options?)` issuing `files.get({ fileId, alt: "media" }, { responseType: "stream", headers: rangeStart > 0 ? { Range: \`bytes=${rangeStart}-\` } : {}, signal: options?.signal })`. Returns `{ stream: response.data, contentLength: parseInt(headers['content-length']), contentRange: parseContentRangeHeader(headers['content-range']) }`. The strategy hooks the stream's `data` events into `options.onProgress(loaded, total)` if provided. Test fails
- [ ] 7.8 Implement; rerun → green
- [ ] 7.9 Write a unit test for AbortSignal forwarding: aborting the passed signal aborts the underlying `googleapis` request, the returned stream errors with AbortError; the strategy's `normalizeErrorImpl` maps it to `tag: "cancelled"`. Test fails
- [ ] 7.10 Implement; rerun → green
- [ ] 7.11 Write a unit test for mid-stream auth-expired surfacing: an in-flight Drive stream errors with 401 mid-response; the strategy's `normalizeErrorImpl` maps it to `tag: "auth-expired"`; the consumer's pipeline rejects with that normalized error (no internal retry by the engine). Test fails
- [ ] 7.12 Implement; rerun → green

## 8. Engine — OneDrive strategy

- [ ] 8.1 Write/implement `doRenameImpl` calling `PATCH /me/drive/items/{id}` with body `{ name }` for both files and folders (Graph API is uniform; populate the new entry's `kind` from the response's `folder` vs `file` facet)
- [ ] 8.2 Write/implement sibling-collision pre-check on `conflictPolicy: "fail"`: query `GET /me/drive/items/{parentId}/children?$filter=name eq 'newName'` before the rename; if any results, throw conflict
- [ ] 8.3 Write/implement directory-overwrite refusal (parallel to Drive's 7.5/7.6)
- [ ] 8.4 Write/implement conflict detection in `normalizeErrorImpl` for Graph 409 errors (in case a race made the pre-check pass but the actual PATCH collided)
- [ ] 8.5 Write/implement `doDownloadFileImpl(target, options?)` calling `fetch('/me/drive/items/{id}/content', { headers: rangeStart > 0 ? { Range: \`bytes=${rangeStart}-\` } : {}, signal: options?.signal })`. Read `Content-Length` and `Content-Range` from response headers; convert response.body Web ReadableStream to a Node Readable (or use the Microsoft Graph SDK's stream API if it returns Node streams natively). Hook progress callbacks into `options.onProgress` if provided.
- [ ] 8.6 Write/implement AbortSignal forwarding (parallel to Drive's 7.9-7.10)
- [ ] 8.7 Write/implement mid-stream auth-expired surfacing (parallel to Drive's 7.11-7.12)

## 9. Engine — S3 strategy

- [ ] 9.1 Write a unit test for `S3Client.doRenameImpl` introspection: `HeadObject(key)` returns 200 → file path; `HeadObject(key)` returns 404 then `ListObjectsV2(Prefix=key+"/", MaxKeys=1)` returns at least one key → folder path; both 404 → not-found. Test fails — `doRenameImpl` doesn't exist yet
- [ ] 9.2 Implement the introspection helper; rerun → green
- [ ] 9.3 Write a unit test for the file-rename branch: `CopyObjectCommand` (with `CopySource`/`Bucket`/`Key`) followed by `DeleteObjectCommand` (with the original `Key`); resolves with the new entry. Test fails
- [ ] 9.4 Implement the file-rename branch; rerun → green
- [ ] 9.5 Write a unit test for `CopyObject` succeeds + `DeleteObject` fails: the strategy logs the orphan-old-key but still resolves with the renamed entry (rename succeeded from user perspective per design.md Decision 2); test fails
- [ ] 9.6 Implement the failure-tolerant branch; rerun → green
- [ ] 9.7 Write a unit test for the folder-rename branch: when the introspection identifies the target as a folder, throw `DatasourceError { tag: "unsupported", message: "S3 folder rename is not supported in this version" }`; test fails
- [ ] 9.8 Implement (one-line throw inside the branch); rerun → green
- [ ] 9.9 Write a unit test for sibling-collision pre-check on `conflictPolicy: "fail"`: before `CopyObject`, the strategy issues a `HeadObject` for the target key. If 200, throw conflict with `existingPath`. Test fails
- [ ] 9.10 Implement the pre-check; rerun → green
- [ ] 9.11 Write a unit test for `conflictPolicy: "overwrite"` on a file: `HeadObject` for target may return 200 (existing); the strategy proceeds with `CopyObject` (S3 default overwrite) + `DeleteObject` for the original; resolves with the new entry. Test fails
- [ ] 9.12 Implement the overwrite branch; rerun → green
- [ ] 9.13 Write a unit test for the directory-overwrite refusal (matches Drive 7.5/7.6 — but kicks in at the introspection-resolves-folder + overwrite combination)
- [ ] 9.14 Implement; rerun → green
- [ ] 9.15 Write a unit test for `doDownloadFileImpl(target, options?)` calling `GetObjectCommand({ Bucket, Key, Range: rangeStart > 0 ? \`bytes=${rangeStart}-\` : undefined })` with `{ abortSignal: options?.signal }` on the client invocation. Returns `{ stream: response.Body, contentLength: response.ContentLength, contentRange: parseContentRangeFromS3(response.ContentRange) }`. Hook S3 SDK progress events into `options.onProgress` if available, or count bytes manually on the stream.
- [ ] 9.16 Implement; rerun → green
- [ ] 9.17 Write/implement AbortSignal forwarding (parallel to Drive's 7.9-7.10) — S3 SDK's `abortSignal` parameter on the client invocation.
- [ ] 9.18 Write/implement mid-stream auth-expired surfacing — S3's auth-expired manifests as an SDK error with a specific shape (e.g., `ExpiredToken`); the strategy's `normalizeErrorImpl` maps it to `tag: "auth-expired"`.

## 10. Engine — strategy-contract test sweep

- [ ] 10.1 Update `packages/fs-datasource-engine/src/__tests__/strategy-contract.ts` to add the four new methods to the contract suite: rename file, rename directory or assert Unsupported, download a small fixture file end-to-end, cancel download mid-flight
- [ ] 10.2 Run the full engine vitest suite; all green; capture the test count delta
- [ ] 10.3 Run engine package's typecheck; all green

## 11. Service — `DownloadRegistry` module

- [ ] 11.1 Write unit tests for `DownloadRegistry` at `services/fs-sync/src/downloads/__tests__/registry.test.ts`: `set` adds an entry; `update(transactionId, partial)` merges; `delete` removes; `snapshot()` returns the values ordered by `startedAt`; concurrent updates do not lose data
- [ ] 11.2 Implement `services/fs-sync/src/downloads/registry.ts` to pass the tests
- [ ] 11.3 Add a tiny lifecycle integration test: registry events emitted by a fake engine update the registry exactly as the design specifies (start → bytesDownloaded updates → terminal removes)

## 12. Service — `files-rename` RPC handler

- [ ] 12.1 Write unit tests for `services/fs-sync/src/commands/files-rename.ts`: forwards `(target, newName, conflictPolicy)` to `client.rename`; the handler does NOT inspect or carry kind. Maps `tag: "conflict"` → response `{ ok: false, error: { tag: "conflict", existingPath } }`; maps `tag: "unsupported"` → `{ ok: false, error: { tag: "other", message: <strategy's message> } }`
- [ ] 12.2 Implement the handler; thread through `commands/handlers.ts`; rerun → green

## 13. Service — `files-download` RPC handler (orchestration layer)

- [ ] 13.1 Write unit tests for `services/fs-sync/src/commands/files-download.ts` happy path: handler validates `toPath`, mints a `downloadJobId`, creates an `AbortController`, calls `engine.downloadFile(target, { rangeStart: 0, signal, onProgress })`, pipes the stream to `fs.createWriteStream(toPath, { flags: "w", start: 0 })`, on stream end reads `fs.stat(toPath).size === contentLength`, runs the integrity check, emits `file-downloaded`, replies `{ ok: true, value: { savedPath, bytes } }`. Test fails
- [ ] 13.2 Implement the happy path; rerun → green
- [ ] 13.3 Write unit tests for `toPath` validation: absolute path required; no `..` after normalization; parent dir writable; not inside service data dir. On any validation failure, reply `{ ok: false, error: { tag: "other", message: "toPath validation: …" } }` without invoking the engine. Test fails
- [ ] 13.4 Implement `toPath` validation utility at `services/fs-sync/src/util/path-validator.ts`; thread into the handler's pre-flight check; rerun → green
- [ ] 13.5 Write unit tests for the **mid-stream auth-expired retry loop**: pipeline rejects with `tag: "auth-expired"` after N bytes written; handler reads `fs.stat(toPath).size === N`; retries `engine.downloadFile(target, { rangeStart: N, signal, onProgress })`; the retry call's `withRefresh` wrapper refreshes the credential; the new GET returns 206 with `contentRange: { start: N, … }`; handler validates `contentRange.start === N`, pipes from byte N (`flags: "r+", start: N`); on completion `bytesWritten === contentLength`; integrity passes; success reply. Test fails
- [ ] 13.6 Implement the retry loop with `MAX_AUTH_RETRIES = 1` per cycle (consecutive auth-expired = dead refresh token, surface as auth-revoked). Distinct expiries across the download lifetime are unbounded (each is a new cycle with its own retry budget). Rerun → green
- [ ] 13.7 Write unit tests for **range-not-honored** detection: retry call's `engine.downloadFile` returns `contentRange === undefined` (provider ignored the Range header); handler does NOT pipe; throws terminal `range-not-supported`; emits `download-failed { tag: "other", message: "range not supported on this resource" }`; partial file left on disk. Test fails
- [ ] 13.8 Implement; rerun → green
- [ ] 13.9 Write unit tests for **range-mismatch** detection: retry call returns `contentRange.start === M ≠ rangeStart`; handler refuses to pipe; emits terminal `range-mismatch`. Test fails
- [ ] 13.10 Implement; rerun → green
- [ ] 13.11 Write unit tests for **byte-count assertion**: after pipeline resolves successfully, `fs.stat(toPath).size !== contentLength`; handler treats as terminal failure, emits `download-failed { tag: "other", message: "byte count mismatch" }`. Test fails
- [ ] 13.12 Implement; rerun → green
- [ ] 13.13 Write unit tests for **post-download integrity check**: provider's hash (Drive `md5Checksum`, OneDrive `quickXorHash`/`sha1Hash`/`sha256Hash`, S3 `ETag` for non-multipart) is fetched (via the engine's `getMetadata` if not already on the strategy's response); handler computes the local file's matching hash; mismatch → terminal `integrity-failed`. Test fails
- [ ] 13.14 Implement an integrity-check utility per provider hash type; thread into the handler; rerun → green. (Skip the integrity check when the provider does not advertise a hash; emit a debug log noting integrity was not verifiable.)
- [ ] 13.15 Write unit tests for **cancel mid-pipe**: client invokes a service-level cancel (mechanism TBD — sync:cancel-download or a parallel command); handler invokes `abortController.abort()`; pipeline rejects with AbortError; handler emits `download-cancelled { downloadJobId, bytesDownloaded, bytesTotal, reason: "user" }` exactly once; partial file NOT auto-deleted; reply `{ ok: false, error: { tag: "cancelled" } }`. Test fails
- [ ] 13.16 Implement the cancel path including the cancel command surface; thread through `commands/handlers.ts`. Rerun → green
- [ ] 13.17 Write unit tests for **registry update throttling**: rapid `onProgress` callbacks (e.g., 100 per second) result in registry-state writes throttled per the same coalescing approach as upload (every N bytes or every N ms, whichever first). Verify the test client's progress events match the throttle. Test fails
- [ ] 13.18 Implement the throttle (reuse the upload bus coalescer if possible); rerun → green
- [ ] 13.19 Write unit tests for **registry release on terminal events**: on file-downloaded / download-failed / download-cancelled, the registry entry is deleted. Test fails (probably already handled by the retry loop's finally block — verify)
- [ ] 13.20 Implement / verify; rerun → green

## 14. Service — `downloads:list-active` RPC handler

- [ ] 14.1 Write unit tests for `services/fs-sync/src/commands/downloads-list-active.ts`: returns the registry snapshot ordered by `startedAt` ascending; empty registry returns `{ jobs: [] }`
- [ ] 14.2 Implement; thread through `commands/handlers.ts`; rerun → green
- [ ] 14.3 Write a small integration test: with two concurrent `files:download` jobs in flight (one started 1s before the other), `downloads:list-active` returns both in startedAt order, with their current `bytesDownloaded` values

## 15. Service — `downloading` event forwarding

- [ ] 15.1 Write a unit test for the existing event-stream subscription path delivering `downloading` events to a `sync:subscribe-events` client; assert throttling matches the upload coalescer
- [ ] 15.2 If the path already covers events automatically (the engine bus is forwarded wholesale), this task is just a verification + documentation step; otherwise extend the bridge

## 16. Service — full vitest suite

- [ ] 16.1 Run the full `services/fs-sync` vitest suite; all green
- [ ] 16.2 Run service typecheck; all green

## 17. Main IPC — `files/rename.ts` + `files/download.ts` swap

- [ ] 17.1 Write a unit test for the new `apps/desktop/src/main/ipc/files/rename.ts`: forwards the request to `SyncClient.request("files:rename", req)`; returns the response unchanged; on error envelope returns the error envelope; test fails because the file still imports from `mock-fs.js`
- [ ] 17.2 Rewrite `rename.ts` to call `SyncClient.request(...)` (matching the existing `list.ts` pattern); rerun → green
- [ ] 17.3 Write a unit test for the new `apps/desktop/src/main/ipc/files/download.ts`: forwards the request including `toPath` to the service; returns the response; test fails
- [ ] 17.4 Rewrite `download.ts` similarly; rerun → green
- [ ] 17.5 Write a regression test: the existing main-process IPC tests for rename/download (if any) are updated or deleted; the test suite remains green
- [ ] 17.6 Delete the `rename` and `download` exports from `apps/desktop/src/main/ipc/files/mock-fs.ts` (preserve the rest); delete the corresponding arms in `__tests__/mock-fs.test.ts`; verify the file still passes typecheck and its remaining tests
- [ ] 17.7 Add a lint/grep regression test asserting no source file under `apps/desktop/src/main/` (other than the mock-fs file itself) imports `rename` or `download` from mock-fs

## 18. Main IPC — `dialog.showSaveDialog` + first-run modal trigger + on-launch hydrate

- [ ] 18.1 Write a unit test for a new preload exposure `window.api.preferences.setDefaultDownloadsFolder(folder)` and `getDefaultDownloadsFolder()`; test fails
- [ ] 18.2 Implement the preload exposure + main-process IPC handlers (the storage is renderer-side localStorage, but the preload routes through to keep the surface uniform); rerun → green
- [ ] 18.3 Write a unit test for `window.api.files.openSavedPath(savedPath)` calling `shell.openPath(savedPath)`
- [ ] 18.4 Implement the IPC + preload exposure; rerun → green
- [ ] 18.5 Write a unit test for `window.api.files.showSavedInFolder(savedPath)` calling `shell.showItemInFolder(savedPath)`
- [ ] 18.6 Implement; rerun → green
- [ ] 18.7 Write a unit test for `window.api.dialog.showSaveDialog(opts)` (a thin pass-through to Electron's `dialog.showSaveDialog`); test fails
- [ ] 18.8 Implement; rerun → green
- [ ] 18.9 Write a unit test for the on-supervisor-connect `downloads:list-active` query firing exactly once on first connect, and the response being forwarded to the renderer via `window.api.files.onActiveDownloadsHydrate`
- [ ] 18.10 Implement `apps/desktop/src/main/sync/on-connect-hydrate-downloads.ts`; rerun → green

## 19. Renderer — context-menu gate flip + S3 folder-rename branch

- [ ] 19.1 Write a unit test for `context-menu.tsx` rendering Rename/Download as enabled (no `aria-disabled`) for a Google Drive file entry; test fails (the existing implementation disables them)
- [ ] 19.2 Update `context-menu.tsx`: remove the broad `engineBacked || entry.kind === "directory"` disabled rule for Rename/Download; replace with a narrower rule (S3 directory only for rename; directories for download); update the tooltip strings
- [ ] 19.3 Rerun the engine-backed-disable existing test (`__tests__/context-menu-engine-backed-disable.test.tsx`); update the assertions to the new expected behavior; or delete the file if its scenarios are entirely about the removed rule (replaced by the new rule's tests)
- [ ] 19.4 Write tests for the new rule: Rename enabled for files everywhere; Rename enabled for Drive/OneDrive directories; Rename disabled for S3 directories with the new tooltip; Rename disabled for mock directories with the existing "v1" tooltip; Download enabled for files everywhere; Download disabled for directories with the "Folder download is not supported" tooltip
- [ ] 19.5 All tests green

## 20. Renderer — `downloads-store` (preferences)

- [ ] 20.1 Write unit tests for `apps/desktop/src/renderer/src/features/settings/__tests__/downloads-store.test.ts`: `getDefaultFolder` returns `null` when localStorage key is absent; `setDefaultFolder(path)` writes the key; `getAlwaysAsk` returns `false` by default, `true` when the key is `"yes"`; `useDefaultFolder()` and `useAlwaysAsk()` hooks subscribe via `useSyncExternalStore`
- [ ] 20.2 Implement `apps/desktop/src/renderer/src/features/settings/downloads-store.ts` modeled on `motion-store.ts`; rerun → green

## 21. Renderer — first-run downloads modal

- [ ] 21.1 Write unit tests for `first-download-modal.tsx`: renders the title, body, pre-filled OS-default path, Browse button, single CTA; cannot be dismissed via Escape or backdrop click; on commit, persists the chosen folder via `setDefaultFolder` and invokes the `onCommit` callback; on Browse click, invokes `window.api.dialog.showOpenDialog` with `properties: ['openDirectory', 'createDirectory']` and updates the path on selection
- [ ] 21.2 Implement; rerun → green
- [ ] 21.3 Write integration tests for the modal-trigger flow: a Download click with `getDefaultFolder() === null` opens the modal; on commit, the deferred download dispatches against the now-set folder

## 22. Renderer — settings dialog Downloads section

- [ ] 22.1 Write unit tests for the new section in `settings-dialog.tsx`: renders DOWNLOADS heading, Default folder row (path display, Open + Change buttons), Always-ask Switch row; Open invokes `showSavedInFolder`; Change opens the OS picker and updates the store; Switch toggles the Always-ask key
- [ ] 22.2 Implement; rerun → green
- [ ] 22.3 Verify focus-trap continues to work across the new section (Tab from Motion's Switch reaches the Downloads section's Open button, etc.); update the existing settings-dialog test if it asserted on tab order

## 23. Renderer — download orchestrator

- [ ] 23.1 Write unit tests for `apps/desktop/src/renderer/src/features/file-explorer/__tests__/use-download-orchestrator.test.ts`: dispatches `files.download` with a `toPath` resolved per the store + modifier rules; on shiftKey opens `showSaveDialog` with the default-folder + filename pre-filled; on Always-ask similarly; on neither, computes `<defaultFolder>/<fileName>` directly; if the user cancels the save dialog, no IPC dispatch; on dispatch returns the `transactionId`
- [ ] 23.2 Implement `use-download-orchestrator.ts` mirroring `use-upload-orchestrator.ts`; rerun → green
- [ ] 23.3 Write unit tests for the orchestrator's first-download-modal integration: when `getDefaultFolder()` is null, opens the modal and queues the download; on modal commit, dispatches
- [ ] 23.4 Implement the queueing; rerun → green

## 24. Renderer — download Sonner toaster

- [ ] 24.1 Write unit tests for `apps/desktop/src/renderer/src/features/file-explorer/__tests__/download-job-toast.test.ts`: each dispatched download produces one toast bound to its `transactionId`; in-flight: progress bar updates from `downloading` events; on terminal `file-downloaded`: toast flips to the success variant with [Show in folder] + [Open] actions; on `download-failed`: red toast with Retry; on `download-cancelled`: silent dismiss
- [ ] 24.2 Implement `download-job-toast.ts` mirroring `upload-job-toast.ts` (use `toast.custom()` for the dual-action success layout); rerun → green
- [ ] 24.3 Write a unit test for app-init hydration: on `onActiveDownloadsHydrate(jobs)`, spawn one toast per job with the current `bytesDownloaded` / `contentLength` ratio as initial progress; subscribe each to its txId's progress feed; the existing toaster pattern handles subsequent updates
- [ ] 24.4 Implement the hydration entry point in the file-explorer init effect; rerun → green

## 25. Renderer — rename store path + ConflictResolutionDialog wiring

- [ ] 25.1 Write a unit test for `store.rename(entryId, newName)` dispatching `files.rename({ kind, conflictPolicy: "fail" })`; on `tag: "conflict"`, the store opens the existing `ConflictResolutionDialog` with the `existingPath`; on user choice, re-dispatches with the chosen `conflictPolicy`; the optimistic `pendingOp` reflects each attempt
- [ ] 25.2 Update the rename store path to read from `files.rename` (the actual store implementation may already exist in some form for mock-fs — verify against the codebase and adapt); rerun → green
- [ ] 25.3 Write a regression test for the existing rename happy-path tests (under `apps/desktop/src/renderer/src/features/file-explorer/__tests__/`); update assertions if they hit mock-fs directly

## 26. Renderer — full vitest suite + typecheck

- [ ] 26.1 Run `pnpm -F @ft5/desktop` vitest; all green
- [ ] 26.2 Run `pnpm typecheck`; all green
- [ ] 26.3 Run `pnpm lint`; all green
- [ ] 26.4 Run the full repo vitest suite; capture the test count delta vs baseline

## 27. End-to-end smoke (manual, deferred to PENDING_TC.MD per CLAUDE.md verification rules)

- [ ] 27.1 Boot the dev build with a real Drive datasource; rename a file; download a file; confirm the file lands at the configured default folder; click Open and Show in folder
- [ ] 27.2 Same with a real OneDrive datasource
- [ ] 27.3 Same with a real S3 datasource (file rename uses copy+delete; folder rename surfaces the disabled tooltip)
- [ ] 27.4 Boot the dev build, start a download against a large fixture, close the app mid-download; reopen the app; verify the toast hydrates and the download completes
- [ ] 27.5 Boot the dev build, start a download that will exceed 1 hour (or simulate via a token-expiry mock); verify the auth-resume splice happens transparently and the download completes
- [ ] 27.6 Boot the dev build, toggle "Always ask where to save"; verify every Download click opens the save dialog
- [ ] 27.7 Boot the dev build with `localStorage.removeItem("ft5.downloads.defaultFolder")`; click Download; verify the first-run modal appears and blocks dismiss
- [ ] 27.8 Trigger a rename conflict on Drive; verify ConflictResolutionDialog appears and re-dispatch with each policy works

If 27.x can be exercised against real datasources during the implementation
loop, mark them done. Otherwise — per CLAUDE.md — record them in
`PENDING_TC.MD` with the change name and the unit-test coverage that
proves the code path is correct in isolation.

## 28. Pre-archive

- [ ] 28.1 Run `openspec validate add-engine-rename-download`; fix any errors in the worktree branch
- [ ] 28.2 Confirm every checkbox in this `tasks.md` is checked or moved to `PENDING_TC.MD` with rationale
- [ ] 28.3 Confirm full repo vitest + typecheck + lint all green in the worktree
- [ ] 28.4 Update `MEMORY.md` with the change-state pointer for this change
- [ ] 28.5 Archive via the `openspec` CLI in the worktree branch BEFORE merging (per CLAUDE.md hard rule); verify the spec deltas land cleanly into `openspec/specs/`
- [ ] 28.6 Merge to master via the `finishing-a-development-branch` skill
- [ ] 28.7 Worktree cleanup
