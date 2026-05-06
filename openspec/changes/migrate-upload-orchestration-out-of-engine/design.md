# Design: migrate-upload-orchestration-out-of-engine

## Context

`add-engine-rename-download` (archived 2026-04-28) established the engine
as a thin vendor-API translator. Download was redesigned around that
principle from day one: the engine exposes a stateless one-shot
`downloadFile`, and the fs-sync service handler owns the `DownloadRegistry`,
the `downloadJobId` keying, the retry loop, the consumer-domain events,
and the IPC stream. The renderer subscribes to `sync:event-stream`
filtered on `downloadJobId`.

Upload predates that principle and still carries the orchestration
pattern in `BaseDatasourceClient`:

- `activeUploads: Map<transactionId, UploadTracker>` with per-tracker
  bytes / abort / cancel / settled fields.
- `cancelUpload(transactionId, reason?)` method coordinating against
  the tracker.
- `uploading` / `file-created` / `upload-failed` / `upload-cancelled`
  bus event emission.
- `register(cancel: () => Promise<void>) => void` callback threaded
  through every strategy's `doUploadFileImpl`.

This change applies the orchestration migration to upload, paralleling
download's shape almost mechanically. A few divergences are real and are
captured in the Decisions below: cancel becomes signal-driven (not
register-callback), strategy LRU invalidation rewires to internal,
cleanup-on-abort uses a fresh AbortController, and `createFile` is
deleted entirely as YAGNI cleanup of unreachable engine surface.

The rename-download work shipped a complete reference template — file
paths, IPC commands, registry shape, hydrate-on-connect pattern, renderer
event-stream subscription — that this design follows almost verbatim. The
deltas worth thinking about are signal-driven cancel mechanics, the LRU
invalidation rewire, and the concurrent-upload guard's spec scenarios.

## Goals / Non-Goals

**Goals:**

- Make `BaseDatasourceClient.uploadFile` a one-shot stateless primitive.
  No tracker map. No transaction-id minting. No bus emission. No
  cancelUpload method. Strategies receive `signal` + `onProgress`;
  cancel is signal-driven; cleanup is strategy-internal.
- Move upload orchestration to the fs-sync service handler — new
  `files-upload.ts`, new `UploadRegistry` module, new `uploads:list-active`
  and `sync:cancel-upload` RPCs. Mirror `files-download.ts` and the
  `DownloadRegistry` precisely.
- Hard-reject concurrent uploads to `(datasourceId, targetPath)` at the
  service handler **before** invoking the engine — `tag: "conflict"`
  with `{ existingUploadJobId, targetPath }`.
- Migrate the wire contract from `transactionId`-keyed events on
  `datasources:upload:progress` to `uploadJobId`-keyed events on
  `sync:event-stream`. Renderer rewires its event source.
- Hydrate Sonner toasts for in-flight uploads on supervisor connect via
  `uploads:list-active`. Mirror download hydration.
- Delete `createFile` entirely: the abstract base method, all three
  strategies' `doCreateFileImpl`, related tests. createFile is unreachable
  from any UI/service code path; deletion is YAGNI cleanup.
- Keep `withRefresh` on the engine's new one-shot `uploadFile`. Removing
  engine-side retry policy is the next migration's job
  (`migrate-engine-retry-policy-to-consumer`); not bundled here.

**Non-Goals:**

- Resumable uploads across app restart or network drops. Out of scope
  per the same boundary as download — service is the durable owner;
  reliability follow-ups go in a future `add-upload-resilience` change.
- Removing `withRefresh` from `BaseDatasourceClient.uploadFile`. The
  retry-policy migration is its own change.
- Removing the engine bus entirely. The follow-up
  `migrate-engine-events-to-consumer` covers this.
- Adding directory creation, empty-file creation, or any new "create
  on remote datasource" feature. createFile is being deleted, not
  re-shaped — that direction is YAGNI cleanup.
- Changing the upload conflict-policy taxonomy or its UI flow.
- Bulk upload, folder upload, multi-file batch APIs.
- Changing how uploads stream from disk (still chunked, still
  `path: string` interface — only the orchestration around it moves).

## Decisions

### Decision 1 — `BaseDatasourceClient.uploadFile` becomes a one-shot primitive

**Context.** The engine's role is to translate vendor APIs. Carrying a
tracker map, transaction-id minting, and lifecycle event emission inside
the base couples consumer-domain concerns to a shared library. Two
consumers wanting different upload shapes is impossible today; tests
of upload semantics pin to engine bus internals.

**What.** The new shape is:

```typescript
async uploadFile(
  parent: Target,
  file: { path: string; name?: string; mimeType?: string },
  options?: {
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
  },
): Promise<DatasourceFileEntry<T>> {
  return this.withRefresh(() =>
    this.doUploadFileImpl(parent, file, options ?? {}),
  );
}
```

The `withRefresh` wrapper stays — retry policy is a separate migration
(`migrate-engine-retry-policy-to-consumer`). On a successful resolve,
the strategy returns the entry directly; on rejection, the wrapper
throws a normalized `DatasourceError`. NO bus emission from this layer
for upload.

**Why not split** retry removal into this change? The retry-policy
migration touches every read op (list, search, getMetadata, getQuota),
createFile, deleteFile, authenticate, status, testConnection — much
broader surface than upload alone. Bundling them makes review and
bisection harder. The next migration's stub explicitly sequences after
this one; respect the boundary.

**Risks.** Existing consumers (none in production code beyond tests)
relying on engine-bus upload events break. fs-sync handler subscribes
once at handler entry; renderer rewires to `sync:event-stream`. Both
bridges fall under this change's scope.

### Decision 2 — `doUploadFileImpl` signature: drop `register`, keep `signal`

**Context.** Today every strategy's `doUploadFileImpl` receives:

```typescript
(parent, file, onProgress, register: (cancel) => void, signal: AbortSignal)
```

The `register(cancel)` callback was the engine's way to ask the strategy
for a provider-native cancel closure (DELETE session URL, `upload.abort()`)
that the base could invoke from `cancelUpload`. With the base no longer
holding tracker state, there is nothing to register against.

**What.** New signature:

```typescript
protected abstract doUploadFileImpl(
  parent: Target,
  file: { path: string; name?: string; mimeType?: string },
  options: {
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
  },
): Promise<DatasourceFileEntry<T>>;
```

The strategy threads `options.signal` into its underlying SDK / fetch
calls. When the consumer aborts the controller, the SDK call rejects
with an `AbortError`. The strategy catches `AbortError` (or `signal.aborted`
post-await) and runs cleanup before re-throwing as
`DatasourceError { tag: "cancelled", retryable: false }`.

**Why not pass `register` and let the base ignore it?** Dead parameters
rot. The migration is a stronger statement that orchestration is gone:
the strategy's signature reflects the new contract.

**Risks.** Any provider whose SDK does not honor `AbortSignal` cleanly
(historically a concern for OneDrive's small-file `PUT /content`) needs
explicit handling. The mitigation: strategy code branches on
`signal?.aborted` post-resolve and rejects with `cancelled` if so —
matching the existing "non-cancellable upload path" scenario in
the current spec.

### Decision 3 — Cleanup-on-abort uses a **fresh** AbortController + 5s timeout

**Context.** When the user aborts an upload, the strategy needs to issue
a cleanup HTTP call to the provider — `DELETE <uploadSession>` for Drive
and OneDrive, `upload.abort()` for S3. If the strategy naively forwards
the user's signal into the cleanup HTTP request, the cleanup call itself
aborts before reaching the provider, leaving an orphaned session URL on
the provider side (Drive's session URL is GC'd within ~1 week; OneDrive
similar; S3 multipart uploads accumulate cost until cleanup-policy
deletes them).

**What.** Each strategy attaches `signal.addEventListener('abort', ...)`
to the user's signal. Inside the listener, the strategy creates a **new**
`AbortController` with a 5-second timeout (`AbortSignal.timeout(5000)`)
and uses that for the cleanup HTTP call. The cleanup is fire-and-forget
from the user's perspective — its result is logged but does not affect
the user-visible cancel.

```typescript
// Inside doUploadFileImpl, after session URL is acquired:
options.signal?.addEventListener('abort', () => {
  const cleanupController = AbortController.timeout(5000);
  fetch(sessionUrl, {
    method: 'DELETE',
    headers: { 'Content-Range': 'bytes */*' },
    signal: cleanupController,
  }).catch((err) => log.warn('upload-session cleanup failed', err));
}, { once: true });
```

**Why not omit cleanup entirely and rely on provider GC?** Drive's GC is
~1 week; OneDrive similar; S3 multipart cost accumulates. Worst-case
user impact: storage cost surprises on heavy upload-cancellation users
of S3. Cheap to do right.

**Risks.** A 5s timeout might be too short on a degraded network. On
timeout, the cleanup logs a warning and the session is left to provider
GC. Acceptable degradation — better than the user-signal-aborts-cleanup
bug.

### Decision 4 — Strategy LRU invalidation on upload completion is internal

**Context.** Drive's and OneDrive's strategies maintain a path-handle
LRU cache. Today the cache is invalidated by the strategy subscribing
to its own engine bus for `file-created` and `deleted` events. After
this migration, uploadFile no longer fires `file-created` on the engine
bus — but the LRU still needs to know the entry exists at the new path.

**What.** `doUploadFileImpl` invalidates its own LRU directly inside the
success path, before returning the entry to the base wrapper:

```typescript
// Inside doUploadFileImpl success branch:
this.pathHandleCache.set(entry.path, entry.handle);
return entry;
```

The constructor's bus subscription drops the `file-created` arm. It
keeps the `deleted` arm — `deleteFile` is NOT migrated by this change
and continues to emit `deleted` on the engine bus, so LRU invalidation
on deletion still flows through the bus subscription.

**Why not keep the bus subscription with an internal-only `file-created`
emission?** Defeats the migration's principle. The bus event would be a
purely internal coupling mechanism — the same coupling we're removing.
Direct method call is cleaner and less surprising.

**Risks.** Any subscriber to `file-created` on the engine bus that this
investigation missed becomes dead. The grep at design time found only
the two strategy LRU subscriptions in production code (Drive, OneDrive)
and the renderer's generic `datasources:event` channel relay. The
renderer subscriber rewires to `sync:event-stream` along with the rest
of the upload UX. Implementer sweep during `/opsx:apply` catches anything
else.

### Decision 5 — Service handler shape: mirror `files-download.ts`

**Context.** `add-engine-rename-download` shipped a complete handler
template with `DownloadRegistry`, signal-driven cancel, IPC event
emission, and integrity checks. Upload's handler should mirror this
shape so the codebase has one orchestration pattern, not two.

**What.** `services/fs-sync/src/commands/files-upload.ts`:

```
1. Validate request envelope (sourcePath absolute, targetPath syntactically valid).
2. registry.findByTarget(datasourceId, targetPath) — if hit, reject
   tag: "conflict" with { existingUploadJobId, targetPath }.
3. Mint uploadJobId via crypto.randomUUID().
4. Create AbortController.
5. registry.set(uploadJobId, { datasourceId, sourcePath, targetPath,
                               bytesUploaded: 0, contentLength: file.size,
                               startedAt: Date.now(), abortController }).
6. Resolve datasource client via DatasourceFactory.
7. emit sync:event-stream → "uploading" (initial 0%).
8. Try:
     entry = await client.uploadFile(target, file, {
       signal: abortController.signal,
       onProgress: (loaded, total) => {
         registry.update(uploadJobId, { bytesUploaded: loaded, contentLength: total });
         emit sync:event-stream → "uploading" with { uploadJobId, bytesUploaded, bytesTotal };
       },
     });
   Catch err:
     If err.tag === "cancelled":
       emit sync:event-stream → "upload-cancelled" with { uploadJobId, bytesUploaded, bytesTotal, reason: "user" };
     Else:
       emit sync:event-stream → "upload-failed" with { uploadJobId, tag, message };
     registry.delete(uploadJobId);
     throw err;
   Finally success:
     emit sync:event-stream → "file-created" with { uploadJobId, handle, datasourceId, targetPath };
     registry.delete(uploadJobId);
9. Reply { uploadJobId } to the renderer.
```

The progress throttle (1s OR 10% delta) lives at the handler's
`onProgress` boundary — the same throttle the engine used to apply,
now applied by the consumer. Mirrors download's pattern.

**Why not fold the progress throttle into the engine?** The engine no
longer has the bus emission infrastructure that did the throttling. The
throttle is a presentation concern (how often the renderer wants to
re-render); the consumer owns it.

**Risks.** Drift between `files-upload.ts` and `files-download.ts` over
time. Mitigation: consider extracting shared throttle / event-emission
helpers in a future cleanup once both handlers exist and the abstraction
is informed by reality.

### Decision 6 — `UploadRegistry` mirrors `DownloadRegistry` exactly

**Context.** Download has a working in-memory registry pattern with
forward map + reverse-index. Upload should reuse the shape.

**What.** `services/fs-sync/src/uploads/registry.ts`:

```typescript
export interface UploadJobEntry {
  uploadJobId: string;
  datasourceId: string;
  sourcePath: string;     // local file on disk
  targetPath: string;     // remote provider path
  bytesUploaded: number;
  contentLength: number | null;
  startedAt: number;
  abortController: AbortController;
}

export interface UploadRegistry {
  set(entry: UploadJobEntry): void;
  get(uploadJobId: string): UploadJobEntry | undefined;
  update(uploadJobId: string, patch: Partial<UploadJobEntry>): void;
  delete(uploadJobId: string): void;
  snapshot(): UploadJobEntry[];
  findByTarget(datasourceId: string, targetPath: string): string | undefined;
}
```

The reverse-index is keyed by `(datasourceId, targetPath)` — the
**target** slot, not the source. Different local files uploading to the
same remote slot are also rejected, not just exact `(sourcePath, targetPath)`
duplicates. This is stricter than the literal "same file to same location"
phrasing the user used during brainstorming, and matches their explicit
intent: prevent two writes to the same remote path regardless of which
local file is the source.

**Why not key on `(datasourceId, sourcePath, targetPath)` (laxer)?**
Two different files racing for the same remote name is undefined
behavior on the provider — last-write-wins, partial-write interleaving,
or a 409. Better to surface as a clear `tag: "conflict"` at the service
boundary than to let the providers see it.

**Risks.** A user genuinely wants to overwrite an in-flight upload
target — e.g., they hit Cancel-and-Replace on a hung upload. They'd
get a `conflict` rejection. Mitigation: the cancel-then-retry flow is
already supported (`sync:cancel-upload` then re-issue `files:upload`
once the cancel resolves). The renderer's UX for this happens in the
follow-up `add-upload-resilience` change if needed.

### Decision 7 — Wire-contract change: `transactionId` → `uploadJobId`, channel rename

**Context.** Today the renderer subscribes to upload progress on the
`datasources:upload:progress` IPC channel keyed by `transactionId`. The
`transactionId` is engine-minted and unrelated to any service-level
concept. After migration, the natural key is the service-minted
`uploadJobId` (parallel to `downloadJobId`), and the channel folds into
the existing `sync:event-stream`.

**What.**

| Surface | Before | After |
|---|---|---|
| Renderer progress key | `transactionId` (engine) | `uploadJobId` (service) |
| Renderer event channel | `datasources:upload:progress` | `sync:event-stream` filtered on uploadJobId |
| Service-IPC kickoff | `sync:enqueue-upload` (queue model) | `files:upload` (direct RPC) |
| Service-IPC cancel | engine `cancelUpload(transactionId)` via main bridge | `sync:cancel-upload { uploadJobId }` |
| Service-IPC list active | (none) | `uploads:list-active` |

**Why not preserve the old channel via a thin shim?** Single-tenant
monorepo deploy: renderer, main, service all ship from the same build.
A shim would cost time to build and tests to maintain for zero benefit.
Atomic deploy is the cleanest answer.

**Risks.** A live build mid-deploy where renderer is new but service is
old (or vice versa). Not realistic for this monorepo's deploy model
(single Electron app, single bundled service).

### Decision 8 — Desktop main is a thin bridge for upload

**Context.** The user explicitly directed "the upload just delegate by
desktop app to fs-sync service, desktop app only monitor the upload
progress." This codifies the boundary the rename-download change set
for download.

**What.** Desktop main's upload responsibilities post-migration:

- `apps/desktop/src/main/ipc/files/upload.ts` — forwards renderer's
  `files:upload` IPC to `SyncClient.request("files:upload", req)`.
- `apps/desktop/src/main/ipc/sync/cancel-upload.ts` — forwards renderer's
  `sync:cancel-upload` to `SyncClient.request("sync:cancel-upload", req)`.
- Forward `sync:event-stream` upload events from service to renderer
  via the existing event-relay infrastructure.
- `apps/desktop/src/main/sync/on-connect-hydrate-uploads.ts` — on
  supervisor connect, query `uploads:list-active` and forward the
  snapshot to the renderer for toast hydration.

Zero state. Zero orchestration. No business logic. Mirrors download's
shape.

**Why not collapse into the existing event-relay without a dedicated
hydrate handler?** The hydrate query is a one-shot request/response,
not a stream subscription. Keeping it as a separate handler is clearer
than overloading the event-relay. (Same shape download uses.)

**Risks.** None substantive — this is a thin bridge.

### Decision 9 — Delete `createFile` entirely (engine + strategies + tests)

**Context.** The user observed during brainstorming that creating a
directory or empty file on the remote datasource is not a planned UX
feature. A grep confirmed `createFile` has zero production callers
outside the engine's own tests. The engine surface exists speculatively.

**What.** Delete:

- `BaseDatasourceClient.createFile` (the public method).
- `protected abstract doCreateFileImpl` (the abstract primitive).
- `GoogleDriveClient.doCreateFileImpl`, `OneDriveClient.doCreateFileImpl`,
  `S3Client.doCreateFileImpl` (the three strategy implementations).
- `createFile` and `doCreateFileImpl` test cases across `base-client.test.ts`,
  `s3-client.test.ts`, `onedrive-client.test.ts`, `googledrive-client.test.ts`,
  `__tests__/strategy-contract.ts`.
- All comments referencing `createFile` (notably in `base-client.ts`,
  `packages/ipc-contracts/src/fs-datasource-engine.ts`, the strategy
  files' header comments, and inline notes).

The `file-created` event taxonomy itself stays (uploadFile completion
still fires it on `sync:event-stream`); only the createFile-emitting
path goes away.

**Why not just stop migrating createFile and leave it dormant?** YAGNI.
Every dormant code path is a maintenance tax — tests run, types compile,
contributors read it and wonder when to extend it. The follow-up
`migrate-engine-events-to-consumer` would have eaten its bus emission
anyway; deleting it now keeps the engine surface honest with what it
actually serves.

**Risks.** A future "create empty file" or "create directory" feature
re-introduces the surface. Acceptable — that future change owns its own
design and the surface returns shaped to its real consumer needs, not
to the historical guess it was before.

### Decision 10 — Concurrent-upload conflict is a hard, pre-engine guard

**Context.** The user explicitly reinforced: "uploading same file to
same location must prohibit from the service prior to upload to the
datasource." This is a HARD requirement, not a risk.

**What.** The service handler's reverse-index check happens at handler
entry, before the engine call:

```
if (registry.findByTarget(datasourceId, targetPath)) {
  reject({
    tag: "conflict",
    payload: { existingUploadJobId, targetPath },
    message: "An upload to this path is already in progress",
  });
}
```

The renderer surfaces this as a Sonner error toast bound to the duplicate
attempt; the in-flight upload's toast is unaffected.

**Why surface as `tag: "conflict"` rather than a new tag like
`upload-in-progress`?** The `conflict` tag was added by
`add-engine-rename-download` for rename-collision semantics. The shape
is a perfect fit (caller asked for an action whose target is already
in some incompatible state). Adding a new tag for upload-only would
fragment the error taxonomy.

**Risks.** A renderer dispatching upload twice in rapid succession (e.g.,
a user double-clicks an upload button) gets a `conflict` rejection on
the second dispatch even though the user's intent was "just one upload."
Mitigation: the renderer's button should be disabled while a dispatch
is in flight (standard form pattern). If a regression slips, the conflict
toast is acceptable degradation.

### Decision 11 — `JobKind = "upload"` value retained for backward-compat (chunk-F deviation)

**Context.** Chunk F's original tasks.md §11.3 instruction was to
"Remove the `'upload'` discriminator value from the `JobExecutor<...>`
union type and any factory that maps `kind → executor`." The chunk-F
subagent surfaced — and an inline advisor call confirmed — that
removing the value entirely would break recovery for **pre-migration
user databases**: a user who upgraded mid-upload would have rows in
`jobs` with `kind = 'upload'` and `state = 'running'` that the new
service would refuse to load (DB CHECK constraint failure → service
crash on startup).

**What.** Chunk F retained:

- `JobKind = "upload" | "sync"` in the type union.
- The `kind` CHECK constraint on the `jobs` table (allows
  `'upload'` rows to exist).
- The DB schema unchanged — no migration needed.

What chunk F removed:

- The `UploadJobExecutor` factory entry (no `executors: { upload:
  buildUploadExecutor(...) }` registration).
- The `UploadJobExecutor` body itself (`executors/upload.ts` deleted).
- The handler-side `'sync:enqueue-upload'` dispatcher entry — no new
  `kind: 'upload'` rows can be minted post-migration.

**Recovery path for stranded rows.** When the scheduler's startup-
recovery sweep encounters a `kind: 'upload'` row in `state: 'running'`
(carried over from a pre-migration crashed app), the existing branch
at `services/fs-sync/src/scheduler/scheduler.ts:152-167` transitions
it to `failed` with `errorTag: "unsupported"` and `errorMessage: "no
executor registered for kind=upload"`. Graceful degradation — the
user sees a "Sync failed" entry on the dashboard for that historical
row, no hang or crash. New `kind: 'upload'` rows cannot be minted.

**Why not migrate the data?** A migration that rewrites historical
upload rows would commit to a "what should they become?" answer
(failed? deleted? skipped?). The current scheduler-driven graceful-
degradation path is the same answer ("failed: unsupported") without
the migration's complexity or the risk of partial-rewrite leaving
the DB in a half-migrated state.

**Risks.** A user inspecting their `jobs` table sees `'upload'`
rows and may think the kind is still active. Documentation in the
service README would clarify (out of scope for this change). Worth
surfacing in the §17.6 smoke (app-restart-while-uploading).

### Decision 12 — Toast-owned `sync:event-stream` subscription (chunk-E §14.1 deviation)

**Context.** Chunk E's original tasks.md §14.1 instruction had
`use-upload-orchestrator.ts` itself swap from
`onUploadProgress(transactionId, ...)` to a `sync:event-stream`
subscription. During implementation, the chunk-E subagent observed
that the existing `download-job-toast.ts` (the chunk-D / `add-engine-
rename-download` template) does NOT have its orchestrator subscribe
to events — instead the **toaster** owns ONE global subscription,
filters to the relevant event names, and routes to per-job
trackers. The orchestrator's role is just to call
`toaster.onJobDispatched({ jobId, basename, retry })` at dispatch
time.

**What.** Chunk E mirrored the download pattern for uploads:

- The renderer's `upload-job-toast.ts` owns ONE global
  `sync:event-stream` subscription via injected
  `eventApi.onUploadEvent` — filters to the four upload event names
  AND `payload.uploadJobId === <tracked id>`.
- `use-upload-orchestrator.ts` carries near-zero change — it
  dispatches via `window.api.files.upload`, receives `uploadJobId`
  in the response, and calls `toaster.onJobDispatched(...)` to
  register the tracker. No event subscription in the orchestrator
  itself.
- Per-`uploadJobId` tracker holds toastId + basename + retry
  callback + terminal flag, mounted lazily on first event arrival
  for that id (or eagerly via `hydrateActiveUploads(jobs)` per
  Decision 13).

**Why?** Two reasons:

1. **Mirrors download.** Single subscription pattern across both
   features keeps the renderer surface uniform — fewer
   pattern-recognition burdens for future contributors.
2. **Decoupling.** The toaster is the lifecycle owner; the
   orchestrator is the dispatcher. Separating concerns means a
   future "list-of-active-uploads" UI surface (different from
   Sonner toasts) can subscribe to the same `sync:event-stream`
   without coordinating with the orchestrator's lifecycle.

**Risks.** A test harness that doesn't mount the toaster (or
doesn't stub `window.api.sync.onEvent`) gets no event flow during
the test. Mitigated by `resolveEventApi` returning a no-op
subscription fallback when the binding is absent — tests that
don't exercise event flow stay green; tests that do exercise it
pass an explicit `MockEventApi`.

### Decision 13 — One-way `files:hydrate-active-uploads` channel (chunk-E §15.1 deviation)

**Context.** Chunk E's original tasks.md §15.1 instruction had the
renderer call `window.api.uploads.listActive()` directly from the
app-init effect. During implementation, the chunk-E subagent
observed that the equivalent download surface uses a **one-way
main→renderer channel** (`files:hydrate-active-downloads`) where
the desktop main owns the `downloads:list-active` RPC call and
forwards the snapshot to the renderer. The renderer subscribes to
the channel via `window.api.files.onActiveDownloadsHydrate(callback)`.

**What.** Chunk E mirrored that pattern for uploads:

- New main-process module
  `apps/desktop/src/main/sync/on-connect-hydrate-uploads.ts`
  (mirrors `on-connect-hydrate-downloads.ts`).
- Channel: `files:hydrate-active-uploads` (matches the download
  channel-naming convention).
- Renderer binding:
  `window.api.files.onActiveUploadsHydrate(callback)`.
- The renderer-callable `window.api.uploads.listActive()` RPC is
  STILL exposed (added in chunk C) for future tab-focus refresh
  scenarios — but the app-init hydrate path uses the one-way
  channel, not a renderer-initiated RPC.

**Why?** Two reasons:

1. **Mirrors download.** Same as Decision 12 — uniform pattern
   across upload + download.
2. **Fire-once-per-session is structural at the call site.**
   `apps/desktop/src/main/index.ts`'s `did-finish-load` handler
   invokes the hydrate function exactly once and does NOT
   register it on `syncHandle.on("reconnect", ...)`. Renderer-
   initiated would have to coordinate the same fire-once
   invariant on the renderer side, which is more complex than
   "main fires once, renderer subscribes."

**Risks.** None substantive. The one-way channel is a thin send;
both bindings are typed via the existing IPC contract surface.

## Visual direction

N/A. This change has zero new UI surface and zero visual changes.
Renderer rewires its event source; toasts and orchestrator behave
identically. No Visual Companion engagement required.

## Risks / Trade-offs

**Wire-contract change is observable.** `transactionId` → `uploadJobId`,
`datasources:upload:progress` channel → `sync:event-stream`. Renderer,
main, and service must ship together. Mitigated by atomic monorepo
deploy. Test surface picks up wire-shape regressions via the IPC
contract type-tests and the renderer integration tests.

**Strategy resumable-session cleanup must use a fresh AbortController.**
Per Decision 3 — naively forwarding the user's signal into the cleanup
HTTP call aborts the cleanup. Locked into per-strategy cancel tests
that assert the cleanup HTTP request was issued (not aborted) after the
user's signal aborted. Visible test failure on regression.

**Strategy LRU invalidation rewire risk.** Per Decision 4 — the
constructor's bus subscription drops the `file-created` arm. Any
subscriber missed by the design-time grep becomes dead. The
implementer runs a sweep during `/opsx:apply` to catch anything else;
test surface picks up dead-subscription cases via the renderer's
event-stream tests.

**Concurrent-upload guard introduces visible new behavior.** Per
Decision 10 — same target with different local source, formerly UB
(last-write-wins or 409 from provider), now rejected with
`tag: "conflict"` at the service boundary. Visible behavior change
worth a release note. Renderer's standard double-dispatch debounce
mitigates the most likely accidental case.

**`withRefresh` retention coupled to next migration's timing.** This
change keeps `withRefresh` on the new one-shot `uploadFile`. The
follow-up `migrate-engine-retry-policy-to-consumer` removes it
entirely. If that follow-up stalls, upload retains engine-side retry
indefinitely — acceptable but worth noting in the merge commit.

**Engine bus deprecation visibility.** After this change merges, the
engine bus carries `deleted`, `delete-failed`, `entry-renamed`, `rename-failed`,
`downloading`, `file-downloaded`, `download-failed`, `download-cancelled`,
`status-changed`, `rate-limited`, `token-refreshed`, `token-expired`,
`authenticated`, `authentication-failed` — but no upload events and no
createFile emission. The follow-up `migrate-engine-events-to-consumer`
finishes the migration; this change explicitly does not scope that
work.

## Sequencing / blocking

- **No blocking prerequisites.** `add-engine-rename-download` (the
  template) merged 2026-04-29.
- **Unblocks** `migrate-engine-retry-policy-to-consumer` (its proposal
  sequences after this one).
- **Indirectly unblocks** `add-engine-listdirectory-pagination` once
  the retry-policy migration also lands (pagination's auto-retry
  wrapper coordinates with retry ownership, which moves in the next
  migration).

## Test surface impact

- Engine: `base-client.test.ts` upload tests rewrite for one-shot
  semantics; `cancelUpload` tests delete; `upload-cancelled` event
  assertions delete; createFile tests delete; per-strategy `register(cancel)`
  tests rewrite to signal-driven cleanup; per-strategy LRU invalidation
  tests rewire from bus-subscription-driven to internal-call-driven.
  `strategy-contract.ts` adjusts the shared scenario suite (upload
  becomes one-shot signal-driven; createFile scenarios delete).
- Service: new `files-upload.test.ts`, `uploads-list-active.test.ts`,
  `sync-cancel-upload.test.ts`. Mirror the download equivalents.
- Renderer: `use-upload-orchestrator.test.ts` and `upload-job-toast.test.ts`
  rewire to `sync:event-stream` and `uploadJobId` keying. Hydrate-on-connect
  tests added.
- IPC contracts: `datasources-engine.test-d.ts` updates for shrunk
  PayloadMap (upload events removed; `cancelled` tag retained for
  signal-aborted upload). New type-test file for `UploadsListActiveCommand`
  and `SyncCancelUploadCommand`.
- Smoke (manual, deferred per CLAUDE.md verification rules):
  - upload against real GCP / OneDrive / S3 datasources end-to-end;
  - concurrent-target rejection with `tag: "conflict"`;
  - mid-upload cancel including session-URL cleanup verification (manual
    inspection of provider state);
  - app-restart-while-uploading hydrate.
