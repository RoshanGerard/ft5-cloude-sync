# Design: add-engine-rename-download

## Context

`wire-file-explorer-to-service` (archived 2026-04-24) routed four of the
six `files:*` operations through the live engine and explicitly deferred
the remaining two. Its `proposal.md` named this change as the chartered
follow-up, and the renderer's `context-menu.tsx` literally references
`add-engine-rename-download` in its disabled-affordance tooltip copy.

Beyond the trivially-named obligation, three architecture choices the
brainstorm forced into the open shape this design:

1. The fs-sync service is **detached** (`spawn(... { detached: true })`
   + `unref()`), so it survives desktop app close. Downloads in flight
   keep streaming bytes to disk while the app is closed; on next app
   launch the renderer reconnects via the existing supervisor and queries
   the service for active jobs. This is durable-by-construction without
   adding a disk-persisted layer — the in-memory registry on the
   service is sufficient because the service is the durable owner.

2. The engine package is shared between desktop main and the fs-sync
   service. The renderer never imports it directly; the service
   constructs all live engine instances. This change adds new
   `DatasourceClient<T>` methods that both packages consume the types
   for, but the implementation is exercised only inside the service
   process at runtime.

3. Long-running downloads exceed the access-token lifetime on every
   provider (~1 hour). The S3 raw-footage seed datasource ships
   400MB-class files; an honest design must answer "what happens when
   the token expires at minute 15 of a 30-minute download?" The user's
   directive during brainstorming was unambiguous: the engine resumes
   transparently from the byte we left off; the user does not pay
   bandwidth for our token-management complexity.

The visual surface is small but real: rename has a working inline UX
(`entry-name-cell.tsx` already wired); download has none today. The
brainstorming pass with the Visual Companion produced four locked
variants (V1–V4 below).

## Goals / Non-Goals

**Goals:**

- Add `rename`, `downloadFile`, and `cancelDownload` to the public
  `DatasourceClient<T>` interface, with per-strategy implementations
  for Drive, OneDrive, and S3.
- Add `entry-renamed`, `downloading`, `file-downloaded`,
  `download-cancelled`, `download-failed` to the engine bus event
  taxonomy. The base class normalizes provider differences — S3's
  copy+delete file rename emits a single `entry-renamed`, not a
  `file-created`+`deleted` pair.
- Add `files:rename` and `files:download` RPC commands to the fs-sync
  service. Service maintains an in-memory `DownloadRegistry`; service
  exposes `downloads:list-active` for app-launch hydration.
- Auto-resume across one mid-stream `auth-expired` per cycle inside the
  engine's downloadFile Readable wrapper. Consumer (the service's
  pipe-to-disk) sees one continuous stream.
- Flip the renderer's `isEngineBacked` Rename + Download disabled gate
  to enabled. Folder rename is provider-conditional (Drive/OneDrive
  enabled; S3 disabled with a provider-specific tooltip).
- Land the four locked visual decisions: Hybrid save flow with first-run
  modal (V1), success toast with Open primary CTA + Show in folder
  secondary link (V2), first-run prompt as a blocking modal (V3),
  Downloads section in Settings with default-folder + always-ask
  toggle (V4).
- Migrate `files/rename.ts` and `files/download.ts` IPC handlers off
  `mock-fs.ts`; mock-fs.ts retains its other exports (TDD fixtures).

**Non-Goals (deferred to `add-download-resilience`):**

- Resume across network disconnect, provider 5xx, or rate-limit
  mid-stream. v1 surfaces these as `download-failed` with a Retry
  affordance that restarts from byte 0.
- Disk-persisted download registry. Service-crash recovery is out of
  scope per the boundary "service is the durable owner; fix
  reliability bugs in the service, not via a disk-shim layer."

**Non-Goals (other deferrals):**

- Bulk rename / bulk download.
- S3 folder rename via iterate-and-rewrite-keys.
- Resumable downloads from network drops.
- Downloads tray panel UI.
- Folder download.
- A `<ConfirmRenameDialog>` component. Inline rename via `EntryNameCell`
  is sufficient for v1.

## Decisions

### Decision 1 — Two new methods on the common `DatasourceClient<T>` interface

**Context.** The engine's public Strategy surface is the discipline
device that keeps provider differences from leaking into consumers.
The engine's role is to **translate vendor APIs** — it does not
carry consumer-domain orchestration like retry loops, byte-tracking
across stream lifetimes, or transaction-ID maps for cancel. Those
are policy decisions owned by the consumer (the fs-sync service
handler), per the architectural principle confirmed during
brainstorming: "the engine only facilitates vendor datasource
functionality."

**What.** `DatasourceClient<T>` gains two new methods:

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

`ConflictPolicy = "fail" | "overwrite" | "keep-both"`, default `"fail"`,
mirrored from the upload orchestrator's existing tri-state.

The download primitive is intentionally minimal: one HTTP call per
invocation, no internal state, no transaction ID. The consumer
calls it repeatedly with `rangeStart` advancing on each retry to
implement resume. AbortSignal propagation gives the consumer cancel
control without needing a separate engine cancel API.

`contentRange` is populated only when `rangeStart` is set; the
strategy reads it from the provider's `Content-Range` response
header (or SDK equivalent). The consumer SHALL validate that
`contentRange.start === rangeStart` before resuming the local file
pipe — defense against providers that ignore Range and stream from
byte 0.

**Why this over modeling rename as a fetch-and-rewrite via getMetadata
+ uploadFile.** Drive and OneDrive expose rename as a metadata-only
update (`name` field PATCH). Fetch-and-rewrite would lose fileId,
version history, and sharing state — a regression in correctness, not
just performance. The "common interface" framing the user asserted
during brainstorming explicitly rules out per-provider shortcuts at
the consumer layer.

**Why one `rename` method, not separate `renameFile` / `renameDirectory`.**
The strategy pattern's purpose is to isolate provider-specific logic
inside each strategy's own context. Forcing the interface to surface
file-vs-directory distinctions would leak S3's needs onto Drive and
OneDrive, both of which treat folders and files uniformly via the
same provider API. Within the strategies:

- **Drive** calls `files.update({fileId, requestBody: { name }})` —
  the API works identically for files and folders. No introspection.
- **OneDrive** calls `PATCH /me/drive/items/{id}` body `{ name }` —
  same; the Graph API is uniform across `file` and `folder` facets.
- **S3** introspects within its own context: `HeadObject(key)` first
  (200 → file, proceed with `CopyObject` + `DeleteObject`; 404 →
  check via `ListObjectsV2(Prefix=key+"/", MaxKeys=1)` for a virtual
  folder; if any keys → folder, throw `DatasourceError { tag:
  "unsupported" }`; if neither → not-found). The 1-2 introspection
  round-trips on S3 are amortized against the rename work S3 was
  already going to do.

This keeps the public interface small and matches the strategy
pattern's encapsulation principle: each strategy owns its
provider-specific dispatching. (The existing `deleteFile` /
`deleteDirectory` split predates this principle; a follow-up stub
`unify-engine-delete-method` covers that consolidation.)

**Directory-rename conflict-policy guard.** For directory rename with
`conflictPolicy: "overwrite"`, the engine SHALL refuse with
`DatasourceError { tag: "unsupported" }` even on Drive and OneDrive.
Recursive directory replacement is out of scope for this change —
"overwrite" semantics on a directory would mean recursively deleting
the colliding tree, which is too destructive for v1. Strategies
detect kind during their normal rename flow (Drive/OneDrive via the
`mimeType` / `folder` facet on the post-rename response or a quick
pre-check; S3 via the introspection above) and refuse `"overwrite"`
explicitly when kind resolves to directory.

**Why `downloadFile` returns `{ stream, contentLength, contentRange? }`
without a transaction ID.** The transaction-id-and-tracker pattern
(used by the existing `uploadFile`) carries consumer-domain state in
the engine — the engine doesn't need to know which user-facing
"download job" this stream belongs to; that's the consumer's
concern. Cancel is handled by the AbortSignal the consumer passes
in via options. Each call to `downloadFile` is a one-shot stream;
multiple calls (e.g., during a retry-after-auth-expired loop)
return independent streams.

`contentLength` is `null` when the provider does not advertise it
upfront (Drive's `files.get` always carries it; OneDrive carries
`@odata.size` on the metadata; S3 returns `ContentLength` on
`GetObject`). When `null`, the consumer's progress event emission
shows indeterminate.

(The existing `uploadFile` retains its transaction-id-and-tracker
pattern in this change — moving it out is parallel architectural
debt tracked in the follow-up
`migrate-upload-orchestration-out-of-engine`.)

### Decision 2 — `entry-renamed` is a single normalized event

**Context.** Drive and OneDrive rename is one API call; S3 rename of a
file is `CopyObject` + `DeleteObject`. The natural event stream from
the S3 strategy is `file-created` + `deleted`, but the natural consumer
ask is "did the rename happen, and where is the entry now?"

**What.** The base class emits exactly one `entry-renamed { from:
Target, to: DatasourceFileEntry<T> }` event per successful `rename`
call, regardless of how many provider API calls the strategy made
internally. The `from` carries the original
`{datasourceId, path, handle}` so subscribers can identify the
pre-rename entry; the `to` is the full new entry shape.

**Why this over composing from `file-created` + `deleted`.** The
provider-difference normalization is exactly the engine's job. A
renderer that wants to react to "rename happened" should not have to
dedupe a created+deleted pair, track a "pending rename" set, or
distinguish renames from delete+upload sequences. S3's internal
copy+delete is an implementation detail that should not leak.

**Failure mode.** If S3's `CopyObject` succeeds but `DeleteObject`
fails, the strategy emits `entry-renamed` (the rename did succeed
from the user's perspective: the new path exists with the renamed
content) but logs the orphan-old-key failure for the operator. A
follow-up cleanup task can sweep orphans; the user-visible state is
correct.

### Decision 3 — Engine exposes Range-supporting download primitive; service handler orchestrates retry

**Context.** Token-expiry-mid-stream is real: a 1-hour-token
provider during a 30-minute download manifests as a stream error
after roughly 60% of bytes are piped. The user-directive answer is
"resume from where we left off, not restart from byte 0." But where
does that retry-and-resume orchestration live?

The earlier design draft put a `RefreshAwareReadable` wrapper
inside the engine that intercepted auth-expired errors, refreshed
the token, re-issued with `Range: bytes=N-`, and spliced the new
source into the same Readable so the consumer never saw the error.
That bundles consumer-domain orchestration (byte tracking across
multiple HTTP calls, splice-and-continue stream coordination) into
the shared engine library.

**What.** Move that orchestration to the service handler. The engine
exposes a Range-supporting primitive only:

1. `downloadFile(target, { rangeStart?, signal?, onProgress? })`
   issues exactly ONE HTTP call. If `rangeStart` is set, the
   strategy attaches `Range: bytes=<rangeStart>-` to the provider
   request (Drive `files.get`, OneDrive `GET /content`, S3
   `GetObjectCommand({ Range })`).
2. Auth-expired on the initial HTTP call is handled by the existing
   `withRefresh` wrapper around `doDownloadFileImpl` — refresh once,
   retry once, return the stream (or fail).
3. Auth-expired AFTER the stream opens (mid-stream) surfaces to the
   consumer as a normal stream error tagged `auth-expired`. The
   engine does NOT splice or retry the stream itself.
4. The service handler catches mid-stream errors, decides whether
   to retry, and calls `downloadFile` again with
   `rangeStart = <bytes already written to disk>`. The next call
   goes through `withRefresh` and refreshes the token if needed.

The handler's retry loop:

```typescript
let bytesWritten = 0;
let attempt = 0;
const MAX_AUTH_RETRIES = 1;
while (true) {
  const { stream, contentLength, contentRange } = await engine.downloadFile(
    target,
    { rangeStart: bytesWritten, signal: abortController.signal,
      onProgress: (loaded, total) => emitDownloadingEvent(...) }
  );
  if (bytesWritten > 0) {
    if (!contentRange || contentRange.start !== bytesWritten) {
      throw new RangeNotSupportedError();
    }
  }
  try {
    await pipeline(stream, fs.createWriteStream(toPath, {
      flags: bytesWritten === 0 ? "w" : "r+",
      start: bytesWritten,
    }));
    bytesWritten = await fs.promises.stat(toPath).then(s => s.size);
    if (bytesWritten === contentLength) break;     // success
    throw new ByteCountMismatchError();
  } catch (err) {
    if (abortController.signal.aborted) {
      emit("download-cancelled", ...);
      throw new CancelledError();
    }
    if (isAuthExpired(err) && attempt < MAX_AUTH_RETRIES) {
      attempt++;
      continue;  // engine.withRefresh on the next call refreshes
    }
    emit("download-failed", { tag: normalize(err).tag, ... });
    throw err;
  }
}
emit("file-downloaded", { savedPath: toPath, bytes: bytesWritten });
// Optional integrity check: hash the file, compare against
// provider's hash if available.
```

**Cycles are independent over the download lifetime.** Each call to
`engine.downloadFile` is a one-shot HTTP request wrapped in
`withRefresh`. A multi-hour download against a 1-hour-token provider
goes through N independent cycles, each preceded by a refresh in the
engine's `withRefresh` wrapper. The handler's loop counter
(`MAX_AUTH_RETRIES`) limits **consecutive** auth retries inside a
single cycle (refresh-then-immediate-fail = dead refresh token);
distinct expiries across the download's lifetime are unbounded.

**Why this over the engine-side wrapper.** The engine is a shared
library — keeping it as a thin vendor-API translator reduces blast
radius, simplifies testing, and lets the consumer own retry policy.
A test consumer might want zero retries; a production consumer might
want N retries with backoff. Encoding one policy in the engine forces
that choice on every consumer. Stream programming with mid-flight
splicing (AbortSignal threading, backpressure preservation, EOF/error
race guards) is also notoriously bug-prone; concentrating the
orchestration in ONE place (the service handler) where the file size
on disk is the source of truth for "where to resume from" is more
robust than threading byte counts through a Readable wrapper.

**Range-not-supported safeguard.** When the handler retries with
`rangeStart > 0`, the strategy attaches `Range: bytes=<N>-` to the
provider request. Providers may respond with 200 OK (full content
from byte 0) instead of 206 Partial Content if the resource is not
range-able or the header was ignored. The engine reports the actual
`Content-Range` header value on the returned shape. The handler
validates `contentRange.start === rangeStart` BEFORE resuming the
local pipe; mismatch → `RangeNotSupportedError` → terminal failure
(no silent re-download from byte 0 with corrupted prefix).

**Why this over (a) "document as known v1 limitation" or (b)
"signed URLs".** The user's directive during brainstorming was
unambiguous: making the user pay bandwidth for a 5-second token
swap is a bad product experience. Signed URLs bypass auth entirely
but the URLs themselves expire (~hours), so the fundamental problem
doesn't disappear, just gets pushed out — and the per-strategy
plumbing (~300 LoC) is more than the handler-side retry loop.

### Decision 4 — Service maintains an in-memory `DownloadRegistry`; app-restart hydration via `downloads:list-active`

**Context.** The fs-sync service is detached and survives desktop app
close. A download in flight when the app closes keeps streaming bytes
to disk while the app is closed. On app reopen, the supervisor
reconnects via the existing named pipe; the renderer needs to know
"which downloads are still in flight so I can re-create their toasts."

The registry lives in the **service handler** (`services/fs-sync`),
NOT in the engine. The engine's `downloadFile` is stateless across
calls; the service handler mints the download-job ID, tracks
progress, and emits domain events.

**What.** `services/fs-sync/src/downloads/registry.ts` holds
`Map<downloadJobId, DownloadJob>` where:

```typescript
interface DownloadJob {
  downloadJobId: string;     // service-minted UUID
  datasourceId: string;
  sourcePath: string;
  targetPath: string;
  bytesDownloaded: number;
  contentLength: number | null;
  startedAt: number;         // ms epoch
  abortController: AbortController;  // for cancel
}
```

The `files:download` handler creates an entry on download start,
updates `bytesDownloaded` on each `onProgress` callback from the
engine (throttled per the same coalescing approach as upload), and
removes the entry on terminal success / failure / cancellation. The
handler also emits the consumer-domain events (`downloading`,
`file-downloaded`, `download-failed`, `download-cancelled`) on the
service's IPC event stream.

A new RPC `downloads:list-active` returns a snapshot of the registry.
On supervisor connect (specifically, on the desktop main process's
first connect of a session), the desktop main queries this and
forwards the snapshot to the renderer via a new
`window.api.files.listActiveDownloads()` exposure. The renderer's
app-init effect spawns one Sonner toast per entry, subscribes to the
progress feed for each `transactionId`, and resumes UI continuity.

**Why in-memory only, not disk-persisted.** Per the architectural
boundary the user established during brainstorming: "service is the
durable owner; desktop is the indicator." Service crashes are
reliability bugs to fix in the service, not papered over with
disk-shim state. The registry is correct as long as the service is
running. If the service dies, the partial file is orphaned and the
toast disappears — the user's next download attempt with the same
target path will hit the existing conflict-policy round-trip.
Service-crash recovery is the explicit scope of follow-up
`add-download-resilience`.

**Why on-supervisor-connect hydration, not periodic polling.** The
named-pipe transport already signals connect/disconnect; the
hydration is a one-shot handshake on session start. Periodic polling
would burn IPC for a state that only changes via service-side events
the renderer is already subscribed to.

### Decision 5 — Service-side `pipe-to-disk` (engine returns stream, service writes)

**Context.** `downloadFile` returns a Readable. Streams cannot
traverse the named-pipe IPC boundary as Readable instances. The
service and main desktop both run on the user's machine; either
could write the file.

**What.** The fs-sync service's `files-download.ts` handler calls
`engine.downloadFile(target)`, then immediately pipes the resulting
Readable to `fs.createWriteStream(req.toPath)`. On stream end,
replies `{ savedPath: req.toPath, bytes }`. On stream error, replies
with the engine's normalized `DatasourceError` shape via the existing
`files:` error envelope. The desktop main process never sees the
stream — it dispatches the request, awaits the response.

**Why service-side write, not main-side.** The service has no
separation-of-concerns reason to avoid disk I/O — it already manages
credential files at `~/ft5/sync_app/`. Putting the write in the
service collapses the engine's `downloadFile` flow into one process;
the consumer (which is also the registry owner) is the one writing
bytes, so progress accounting + registry updates + disk writes are
all colocated. A main-side write would add an extra IPC stream
protocol with no value.

**Validation at the service boundary.** `req.toPath` is a
renderer-supplied string that crosses into a process that will write
to it. The handler validates: (a) absolute path, (b) no `..` segments
after `path.normalize`, (c) parent directory exists and is writable.
Validation failure → `tag: "other"` with a clear message; no write
attempt. Recorded under Risks §2.

### Decision 6 — Cancel via AbortSignal at the consumer level; no engine-side cancel API

**Context.** Upload today exposes `cancelUpload(transactionId)` on
the engine — the engine maintains a tracker map and routes cancels
to the strategy's register'd closure. That's an example of consumer
orchestration baked into the engine; addressing the parallel for
upload is tracked as a follow-up
(`migrate-upload-orchestration-out-of-engine`). For download, this
change establishes the pattern from day one: cancel is a consumer
concern, surfaced via the AbortSignal the consumer passes into
`engine.downloadFile(target, { signal })`.

**What.** No `cancelDownload` method on `DatasourceClient<T>`. The
service handler:

1. Mints its own `downloadJobId` and creates an `AbortController`
   for that job.
2. Passes `abortController.signal` into `engine.downloadFile(...)`.
3. Strategies forward the signal to the underlying SDK call (Drive
   via the SDK's request signal; OneDrive via fetch's
   `AbortController`; S3 via `GetObjectCommand`'s `abortSignal`).
4. On user cancel, the handler calls `abortController.abort()`. The
   in-flight provider request errors with AbortError; the stream
   pipeline rejects.
5. The handler's catch path emits `download-cancelled
   { downloadJobId, bytesWritten, bytesTotal, reason }` on the IPC
   event stream and removes the registry entry.

Idempotency is trivial — `AbortController.abort()` is idempotent at
the standard-library level. The handler's "have we already emitted
download-cancelled for this job?" guard is one extra boolean.

**Why this over engine-side cancel parity with upload.** The engine
should not carry a transaction-id map, register-hook, or tracker
state for download. Cancel via AbortSignal is the standard Node
stream pattern and fully sufficient: the strategy passes the signal
into the SDK call; abort propagates through the stack naturally.
The handler's cancel UX (toast X button, terminal event with byte
counts) is consumer-domain logic that belongs in the consumer.

### Decision 7 — `conflictPolicy` mirrors upload verbatim

**Context.** The drag-drop-upload flow already carries
`conflictPolicy: "fail" | "overwrite" | "keep-both"` per file, with a
ConflictResolutionDialog that re-prompts on `tag: "conflict"`. Rename
has the same shape of conflict — user types a name that collides with
an existing remote sibling.

**What.** `FilesRenameRequest.conflictPolicy` is the same tri-state
union as upload's. Default `"fail"`. Engine surfaces
`DatasourceError { tag: "conflict", existingPath: string }` when the
policy is `"fail"` and a sibling collides. Renderer catches in the
inline-rename store path → opens the existing
`ConflictResolutionDialog` (already imported by the upload
orchestrator) → user picks → re-dispatch with the chosen policy.
For `"overwrite"`: engine deletes the colliding sibling first, then
performs the rename atomically per provider. For `"keep-both"`:
engine appends `-2` / `-3` / … suffix and retries until success.

**Why not invent a new conflict shape.** Two parallel conflict shapes
across rename and upload would force the renderer to maintain two
dialog flows, two retry paths, and two error-tag taxonomies. The
upload pattern has shipped and is exercised by drag-drop; reusing
the same surface keeps the test matrix small.

**Why `"fail"` is the default.** Predictability. A rename from the
inline UX should not silently overwrite a sibling without explicit
user consent. The renderer always re-prompts with the dialog.

## Visual direction

These four decisions came out of the Visual Companion brainstorming
pass on 2026-04-27. Each one was rendered in the browser at variant
A / B / C; the user picked the variant recorded below.

### V1 — Save-dialog flow: Path C (Hybrid)

The first-ever download in the user's lifetime triggers a blocking
modal asking where downloads should go. The chosen folder becomes the
default. Subsequent downloads save silently to that default. Modifier
keys (Shift+Click on the Download button or context-menu item) force
a one-time `dialog.showSaveDialog` for that single download. The
"Always ask where to save" toggle in Settings (V4) makes Shift+Click
the implicit default for every download.

**Why over (A) always-prompt or (B) silent-default-from-first-run.** A
introduces friction for every download (an OS dialog + 2-second user
attention per file); B hides the destination from the user
(browser-style, but missing the affordance to change the default).
C front-loads the choice once and gets out of the way after.

### V2 — Success toast layout: variant C (Primary CTA + secondary link)

Sonner success toast layout:

```
┌──────────────────────────────────────────────┐
│ ✓ Downloaded welcome.pdf                     │
│                                              │
│       Show in folder       [    Open    ]    │
└──────────────────────────────────────────────┘
```

`Open` is a filled blue primary button (the most common action — the
user just downloaded the file, they probably want to open it).
`Show in folder` is a quieter dotted-underline text link below the
filename. Auto-dismiss timer matches the upload toast's success
duration.

`Open` invokes `shell.openPath(savedPath)` (one-line Electron API).
`Show in folder` invokes `shell.showItemInFolder(savedPath)`.

**Why over (A) inline-twin or (B) stacked-equal-weight.** A treats
both actions as equal-weight chips, which tells the user "we don't
know which you want." B is identical in interaction but consumes
more vertical space per toast — meaningful when multiple downloads
stack. C signals primary intent without losing the secondary
affordance.

### V3 — First-run prompt: variant A (full modal blocks the download)

```
┌──────────────────────────────────────────────┐
│            Where should downloads go?        │
│                                              │
│  Choose a default folder. You can change     │
│  this later in Settings or use "Save as…"    │
│  to pick per file.                           │
│                                              │
│  📁 ~/Downloads/ft5         [ Browse… ]      │
│                                              │
│                       [ Use this folder ]    │
└──────────────────────────────────────────────┘
```

Full-page-dim modal. The download cannot start until the user
commits. Single CTA "Use this folder" (default value pre-filled to
`~/Downloads/ft5`). Browse opens `dialog.showOpenDialog` with
`properties: ['openDirectory', 'createDirectory']`. No Skip — the
v1 contract is that the default folder is set explicitly before the
first download fires.

**Why over (B) inline info-toast or (C) anchored popover with Skip.**
B lets the download proceed to a sane default but the prompt is
easy to miss; the user later wonders "where did it go?" C lets the
user defer the choice but the popover pattern adds an interaction
state that has no other use in the app. A is the most explicit:
choose-now, choose-once, and the default is editable from settings.

### V4 — Settings entry: variant C (multi-row Downloads section)

```
DOWNLOADS

Default folder                              [ Open ] [ Change… ]
  ~/Downloads/ft5

────────────────────────────────────────────────────────────────
Always ask where to save                                    [ ⊙ ]
  Show the Save-as dialog for every download.
```

Dedicated "DOWNLOADS" section in `SettingsDialog` (the existing
modal that today only contains a Motion section). Two rows:

- Default folder. Path display (truncated with ellipsis on long
  paths). `Open` button reveals the folder via
  `shell.showItemInFolder(folder)`. `Change…` opens
  `showOpenDialog` to update.
- "Always ask where to save" Switch. When on, every download
  triggers `dialog.showSaveDialog` — replaces the Shift+Click
  one-off with a persistent setting.

**Why over (A) minimal-row or (B) row-with-description-and-reset.**
A is cleanest visually but commits to a single setting; the
"always-ask" affordance lives elsewhere (or doesn't exist). B adds
inline description and a Reset link but stays single-purpose. C
makes Downloads a real section with related controls, mirroring how
other apps (Chrome, VS Code) treat downloads.

The renderer-side persistence uses `localStorage` per the existing
`motion-store.ts` pattern. Keys: `ft5.downloads.defaultFolder` (path
string) and `ft5.downloads.alwaysAsk` (`"yes" | "no"`). The renderer
computes per-download `toPath` from these preferences plus the
Shift+Click modifier and forwards to the IPC; the main process
trusts the renderer's chosen path (after validation in Decision 5).

## Risks / Trade-offs

### Risk 1 — Service handler retry-loop correctness (Decision 3)

The handler's retry loop is small but has correctness invariants
that need to hold absolutely:

- **Content-Range validation.** Provider may respond to a Range
  request with 200 OK (full content from byte 0) instead of 206
  Partial Content. The handler MUST validate
  `contentRange.start === rangeStart` BEFORE resuming the local
  pipe; mismatch → terminal failure. Without this, a non-range-able
  resource would silently re-download bytes 0..N on top of the
  existing local file, corrupting the prefix.
- **Byte-count assertion on success.** When the stream's `end` event
  fires, `bytesWritten === contentLength` MUST hold. If not, the
  stream lied about completeness and the file is incomplete.
  Mitigation: the handler reads `fs.stat(toPath).size` after
  pipeline resolves and asserts the count.
- **Post-download integrity check.** Each provider exposes a hash on
  the source object: Drive `md5Checksum`, OneDrive
  `quickXorHash`/`sha1Hash`/`sha256Hash`, S3 `ETag` (for non-multipart
  uploads). The handler computes the local file's matching hash
  after download and compares. Mismatch → fail with `tag: "other",
  message: "integrity check failed"`. Cost: one full file read per
  download; bounded by the local disk's read speed (~GB/s for SSD).
- **AbortSignal threading.** Each call to `engine.downloadFile`
  receives the SAME `AbortController.signal` from the handler's
  `DownloadJob`. A user cancel during the refresh-and-retry gap
  aborts the next call's fetch before bytes flow.
- **Test surface.** Per-strategy: simulate a 401-after-N-bytes by
  intercepting at the SDK level. Assert: handler catches the error,
  retries with `rangeStart=N`, the engine refreshes via withRefresh,
  the next stream returns 206 with `Content-Range: bytes N-M/T`,
  and the handler resumes piping. Total bytes equal contentLength,
  hash matches.

These invariants live in the **service handler**, not in the engine.
The engine just translates vendor APIs and surfaces errors. The
handler is the one place where retry policy + integrity invariants
exist, making the trickiest code testable in one place.

### Risk 2 — Path traversal at the service boundary (Decision 5)

`req.toPath` crosses from the renderer (untrusted in theory; in
practice trusted-but-buggy) into the service process which writes
files. Mitigation: the service-boundary validator checks (a) the
path is absolute (`path.isAbsolute`); (b) `path.normalize(toPath)`
contains no `..` segments and equals the input; (c) the parent
directory exists and is writable (`fs.access(parent, W_OK)`); (d)
the path does not write into the service's own data directory
(`~/ft5/sync_app/`) — that directory is service-private. Failure →
`tag: "other"` with the failing-validator name in the message.

The renderer-side flow forces the path through either
`dialog.showSaveDialog` (returns an absolute, user-chosen path) or
`<defaultFolder>/<basename>` constructed from a settings-stored
default folder. Both produce well-formed paths under normal
conditions; the service-boundary check is defense-in-depth.

### Risk 3 — Service-process death mid-download

Out of scope this change (per Decision 4 and the architectural
boundary the user established). Symptoms: in-flight downloads die,
their partial files orphan on disk, toasts disappear. The data the
recovery would need (transaction id → bytes_downloaded → target_path)
lives in the in-memory `DownloadRegistry` which dies with the
service.

User-visible footprint: a service crash during a 30-min download
wastes the bytes downloaded so far. Frequency depends on service
reliability; if telemetry shows real frequency, the follow-ups
described below become higher-priority.

**Two structural follow-ups make recovery possible later.**
`add-download-resilience` adds the resume-from-byte-N machinery for
non-auth interruption classes. `migrate-download-registry-to-sqlite`
replaces the in-memory registry with a SQLite-backed table, giving
the service durable state across crashes. With both in place, replay
on service launch (read SQLite, find in-flight rows, resume each via
the `add-download-resilience` retry policy) becomes a small additional
step. This change ships neither — the architectural boundary holds
for v1 — but the surface area is small and bounded.

### Risk 4 — Concurrent rename of the same entry

Two app instances could each issue a rename on the same entry
concurrently. The engine has no cross-process locking. Race: window
A renames `foo.pdf` → `bar.pdf` (succeeds), window B renames
`foo.pdf` → `baz.pdf` (provider returns "not found" or similar).
v1 behavior: window B's IPC sees a `tag: "other"` with the
provider's not-found message; the renderer surfaces it via the
existing rename-failure UX (revert optimistic update + sonner
toast). Acceptable for v1; matches behavior on every other op
(delete, upload).

**Structural fix deferred to follow-up `add-service-instance-lock`.**
The cleaner architectural answer is to prevent the race at its
source: enforce at most one active desktop client at the service
level. A second instance attempting to connect receives an
`another-instance-active` error and the renderer surfaces a
blocking overlay with an Exit button. Reconnect window strategy
β (30-second silence timeout) supports the supervisor's transient-
disconnect reconnect path. Tracked in
`openspec/changes/add-service-instance-lock/`.

### Risk 5 — Mock-fs partial deletion may break test fixtures

`mock-fs.ts` has rename + download exports plus the rest of the
fixture (list/stat/search/remove + seed trees). Deleting only the
rename + download exports leaves dangling test imports if any test
pulled them in. Mitigation: the change includes a sweep over
`apps/desktop/src/main/ipc/files/__tests__/` to identify and either
delete (rename/download arms) or migrate (any test that imported
the deleted helpers for a different purpose). Verified during
typecheck.

## Non-Goals (recap from Goals/Non-Goals)

The follow-up changes named in this design:

1. `add-download-resilience` — environmental interruption resume
   (network / 5xx / rate-limit). Stub.
2. `unify-engine-delete-method` — consolidate `deleteFile` +
   `deleteDirectory` into a single `delete` method (parallel to
   the `rename` collapse in Decision 1). Stub.
3. `add-service-instance-lock` — service-level enforcement of at
   most one active desktop client connection (Risk 4 structural
   fix). Stub.
4. `migrate-download-registry-to-sqlite` — replace the in-memory
   `DownloadRegistry` with a SQLite-backed table in `sync.db`.
   Foundation for future service-crash recovery. Stub.
5. `migrate-upload-orchestration-out-of-engine` — apply the same
   "engine = vendor primitive; consumer = orchestration" pattern
   to upload that this change applies to download. The engine's
   `uploadFile` tracker map, `cancelUpload` method, and bus event
   emission all move to the service handler. Stub.
6. `migrate-engine-events-to-consumer` — finish the bus-removal
   job after upload + download events have moved out: remove
   the engine's `EventBus` entirely; consumers emit their own
   domain events on their own pub/sub mechanisms. Stub.
7. `migrate-engine-retry-policy-to-consumer` — remove
   `BaseDatasourceClient.withRefresh`'s "exactly one retry"
   policy; expose `refreshCredentials()` as a public engine
   primitive; consumers wrap calls in their own retry policy.
   Stub.
8. S3 folder rename (iterate-and-rewrite-keys). No stub yet.
9. Bulk rename / bulk download. No stub yet.
10. Folder download. No stub yet.
