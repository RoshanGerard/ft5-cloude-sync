# Design: Download stream resilience for transient network / provider errors

## Context

`add-engine-rename-download` shipped a single-shot download path with a narrow
slice of mid-stream recovery: an `auth-expired` retry per cycle (the engine's
`withRefresh` re-runs the GET with refreshed credentials), and a re-attach of
the renderer-side toast on app reopen via `downloads:list-active`. Every other
mid-stream interruption — network drop, provider 5xx, rate-limit — terminates
the download with a `Retry` button that restarts from byte 0. Honest about
scope but wasteful on the S3 raw-footage seeds (400MB+) where any sustained
interruption costs real bandwidth.

The retry skeleton already exists in the handler:

- `services/fs-sync/src/commands/files-download.ts:494-617` runs an outer
  `cycle` / inner `attemptInCycle` loop; `MAX_AUTH_RETRIES_PER_CYCLE = 1`
  bounds the auth-expired path.
- The engine's `DatasourceError` taxonomy already exposes per-instance
  `retryable: boolean` and `retryAfterMs?: number` flags.
- All three strategies (`googledrive-client`, `onedrive-client`, `s3-client`)
  normalize raw `ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` to
  `tag: "network-error"`, retryable=true, in their `normalizeErrorImpl`.
  Provider 5xx and 429 normalize to `provider-error` / `rate-limited` with
  appropriate flags. Drive collapses transient 503 into `rate-limited`.
- The in-memory `DownloadRegistry` (`services/fs-sync/src/downloads/registry.ts`)
  tracks `bytesDownloaded` / `contentLength` per in-flight job and survives
  desktop-app close (the fs-sync service is detached).

This change widens the existing handler retry loop to cover environmental
classes — network / rate-limited / provider-error — without touching the
engine boundary. No new packages, no new persistence layer, no engine changes.

## Goals / Non-Goals

**Goals:**

1. Mid-stream environmental failures (network drop, 5xx, 429) recover
   transparently via a per-cycle consecutive-failure budget plus a wall-time
   ceiling. A 400MB download survives 50 short interruptions across hours;
   a hopelessly stuck connection terminates after 5 consecutive failures
   with no progress.
2. Partial-file disposition on terminal failure preserves the user's bandwidth
   investment when recovery is plausible. Large-file users do not lose
   progress to overcautious cleanup.
3. Renderer toast UX during retry is steady — no flicker between "downloading"
   and "retrying" for short blips. Sub-status `Reconnecting… (n/5)` carries
   the diagnostic.
4. Wire-level taxonomy extends precisely once: `FilesErrorTag` gains
   `exhausted-retries`. The `cause` discriminator lives in the new
   `download-retrying` event payload's `engineCause` field for telemetry.

**Non-Goals:**

- Service crash / kill recovery. Out of scope per the architectural boundary
  established in `add-engine-rename-download` ("service is the durable owner;
  reliability bugs live in the service, not behind a disk-shim layer").
- Resumable uploads. Separate change; uploads have a different upgrade path
  (Drive / OneDrive resumable session resume).
- User-initiated pause/resume UI. Cancel still terminates outright; retry is
  automatic.
- Background-download throttling / bandwidth caps.
- Any change to the engine's `withRefresh` mechanism. Auth-expired keeps its
  existing 1-shot-per-cycle slot in the handler (Layer 2) plus the engine's
  internal refresh-and-retry (Layer 1). The new environmental retry (Layer 3)
  is additive.
- New persistence. The in-memory `DownloadRegistry` is sufficient; durable
  history is the separate `migrate-download-registry-to-sqlite` follow-up.

## Decisions

### Decision 1: Retry budget — per-cycle consecutive count + wall-time ceiling

**What:** The handler's environmental retry budget is two-dimensional:

- `consecutiveFailureCount: int` — increments per failed attempt that wrote
  no new bytes; resets to zero whenever the next attempt makes byte progress.
  Hard cap: `CONSECUTIVE_FAIL_LIMIT = 5`. Sixth consecutive failure → terminal
  `exhausted-retries`.
- `walltimeStartedAt: epoch ms` — captured at the first `engine.downloadFile`
  call. Hard cap: `WALLTIME_CEILING_MS = 30 * 60 * 1000` (30 min). Any retry
  decision that would sleep past the ceiling → terminal `exhausted-retries`
  with `walltime-exceeded` flavor.

Reset rule: `consecutiveFailureCount = 0` iff `bytesWrittenAfter > bytesWrittenBefore`
across an attempt. NOT `engine.downloadFile` resolving (an opening 200 OK that
errors on the first byte gives a clean resolve with zero progress — must not
reset).

**Why over alternatives:**

- Pure count (B from brainstorming Q1): no defense against a sticky-failure
  pattern where each cycle briefly succeeds then fails — the count stays
  resettable but the wall-clock balloons.
- Pure wall-time (C): simpler but doesn't differentiate "1 long interruption"
  from "20 short interruptions" — both look the same at 30 min wall time.
- Per-cycle count plus wall-time models the real failure modes: short
  outages reset the count (good), persistent stuck-state exhausts the count
  (good), pathological infinite-flap caps via wall-time (good).

### Decision 2: Error classification — trust engine `retryable` flag with allowlist guard

**What:** A pure function `isEnvironmentallyRetryable(err)` returns true iff:

```
err instanceof DatasourceError
AND err.tag !== "auth-expired"          // separate slot, never folded in
AND err.retryable === true              // engine's per-instance signal
AND err.tag in {network-error, rate-limited, provider-error}  // allowlist
```

The allowlist defends against future taxonomy expansion that adds a new
retryable=true tag without considering whether environmental retry semantics
fit. A strategy bug (marking a non-retryable tag as retryable) is logged
and treated as terminal.

**Auth-expired exclusion is structural.** Layer 2 (handler's existing
auth-expired branch) and Layer 3 (the new environmental branch) handle disjoint
classes. Folding auth-expired into Layer 3 would either bypass the engine's
`withRefresh` (the next sleep-and-retry uses the same dead access token) or
duplicate refresh logic.

**Wait formula on retry:** `wait = max(err.retryAfterMs ?? 0, expBackoff(consecutiveFailureCount))`
where `expBackoff(n) = min(1000 * 2^(n-1), 30000)`. Rate-limited responses
honor the provider's `Retry-After` header when longer than the exponential
floor. Wall-time ceiling caps the upper.

### Decision 3: Range-not-honored is hard-fail, NOT retry-budget-burn

**What:** When a resume attempt (`bytesWritten > 0`) returns 200 OK without
`contentRange`, the handler raises `RangeNotHonoredError` immediately. No
retry within the cycle's environmental budget. Repeated requests with the
same `Range: bytes=N-` against a resource that returned 200 are unlikely to
flip behavior; burning 5 attempts is wasted bandwidth and provider quota.

The user's existing toast Retry affordance is the recovery path: clicking
Retry restarts the download from byte 0 (a fresh `files:download` call with
no `rangeStart`). The decision to discard the partial bytes belongs to the
user, never the handler.

**Class rename:** `RangeNotSupportedError` → `RangeNotHonoredError` in the
handler internals — more accurate (the resource may support Range generally,
just didn't on this request).

### Decision 4: Range-mismatch is hard-fail

**What:** When a resume attempt returns 206 Partial Content with
`contentRange.start !== bytesWritten`, the handler raises
`RangeMismatchError` immediately. Splicing the wrong bytes corrupts the
file; rewinding to byte 0 silently is hostile to a user who has half a
gigabyte on disk; surfacing the provider misbehavior is the right call.

### Decision 5: Renderer toast stays steady; new `download-retrying` event drives sub-status

**What:** The toast title remains `Downloading <filename>` throughout. During a
retry sleep, the subtext switches `62% · 240 MB / 380 MB` → `Reconnecting…
(2/5)` and the progress bar **pauses at the last known byte position** — does
not rewind, does not animate. A small spinner glyph replaces the percentage
text in the subtext during the wait. Tooltip on hover exposes the cause and
wait duration for diagnostic users.

**New IPC event:** The fs-sync IPC bus gains one event (uncoalesced — fs-sync's bus does not throttle; the engine-bus coalescer that handles `downloading` is upstream of this layer):

```
{
  event: "download-retrying",
  payload: {
    downloadJobId: string,
    datasourceId: string,
    attempt: number,             // consecutiveFailureCount, 1-indexed
    limit: number,               // CONSECUTIVE_FAIL_LIMIT (5)
    waitMs: number,              // chosen sleep duration
    engineCause: string,             // verbatim engine tag; typed `string` (not `DatasourceErrorTag`) so the renderer cannot branch on its value (see Decision 9). Telemetry consumers may still aggregate on it.
  }
}
```

Emitted at the START of the sleep (after budget/walltime checks pass, before
`sleepCancellable`). NOT emitted for the auth-expired Layer 2 branch — that
retry is fast (no sleep), the user doesn't need a separate "refreshing token"
indicator.

The `engineCause` field is a deliberate engine-taxonomy leak, scoped to
diagnostic decoration only. The renderer SHALL NOT branch behavior on its
value; the wire-level identity for "we're retrying" is the event itself, not
the cause string. Telemetry consumers may aggregate on `engineCause` for
cause analysis.

**Cancel during retry sleep** — the existing AbortController plumbing wires
`sync:cancel-download` straight through. `sleepCancellable(ms, signal)`
resolves immediately on abort, the inner loop exits with `CancelledError`,
the handler emits `download-cancelled` with last known byte counts. No new
cancel path needed.

### Decision 6: Partial-file disposition follows a corrupt-AND-not-recoverable rule

**What:** A terminal failure deletes the partial file iff the bytes are
clearly corrupt AND recovery is impossible. Otherwise, the partial stays on
disk so the user's bandwidth investment is preserved.

| Terminal cause | Bytes corrupt? | Recovery possible? | Disposition |
|---|---|---|---|
| Environmental budget exhausted | No | Yes (resume) | **Keep** |
| Wall-time ceiling | No | Yes (resume) | **Keep** |
| `auth-revoked` (Layer 2 dead refresh) | No | Yes (re-auth + resume) | **Keep** |
| User cancellation | No | Yes (resume) | **Keep** |
| Byte-count-mismatch | Maybe (could be valid prefix) | Yes (optimistic resume from byte N may work) | **Keep** |
| Range-not-honored | No (bytes valid) | No (provider rejects Range) | **Delete** |
| Range-mismatch | No (bytes valid) | No (provider misbehaves on Range) | **Delete** |
| Integrity-failed (provider hash mismatch) | Yes (hash proves wrong) | No (corrupt prefix) | **Delete** |

**Rationale:** The policy optimizes for preserving the user's bandwidth
investment, accepting a small risk that a kept byte-count-mismatch partial
may need re-pipe on the user's next attempt. The alternative (delete
unconditionally) is hostile to large-file users — re-downloading 240MB
because of a Content-Length disagreement that may not even reflect real
corruption is worse than the rare cost of a wasted re-pipe.

**Implementation:** the handler's outer catch maintains a sentinel-class set:

```
DELETE_ON_TERMINAL = { RangeNotHonoredError, RangeMismatchError, IntegrityFailedError }
```

`ByteCountMismatchError` is **not** in the set (flipped from earlier
exploration during brainstorming after the disposition principle was
articulated). The handler `unlink`s `params.toPath` before emitting
`download-failed` when the caught error is in the set; `unlink` failure is
non-fatal (logs a warning, the user can clean up manually).

### Decision 7: New `exhausted-retries` tag in `FilesErrorTag`

**What:** The wire-level `FilesErrorTag` enum (in `@ft5/ipc-contracts`)
gains one new value: `"exhausted-retries"`. Both count-exhaustion and
walltime-exhaustion emit `tag: "exhausted-retries"`. The discriminator
("which budget exhausted") lives in the message field, not in the tag.

The renderer's existing `download-failed → Retry button` allowlist widens
to include the new tag. This is a minor breaking change for the only
current consumer (the renderer's failure-toast handler).

**Why over collapse-to-other (A1 from brainstorming):** Existing
collapse-to-other tags (`range-not-honored`, `range-mismatch`,
`byte-count-mismatch`, `integrity-failed`) fire on rare provider contract
violations. Exhausted-retries is the **most common** terminal failure mode
this feature introduces — every flaky-network user hits it. Routing the
common case through "other" with a message-substring match inverts how a
wire taxonomy should distribute precision. Type-checkable renderer branching
and message-format-stable telemetry justify the dedicated tag.

### Decision 8: Three-layer retry architecture, no engine changes

**What:** Mid-stream errors are handled by three disjoint layers, ordered
by which layer fires first:

| Layer | Owner | Catches | When | Budget |
|---|---|---|---|---|
| 1 | Engine `withRefresh` | `auth-expired` on initial GET | Stale token, no bytes flowed | 1 refresh per call (single-flight) |
| 2 | Handler auth-expired branch | `auth-expired` mid-stream | Token expired during stream | `MAX_AUTH_RETRIES_PER_CYCLE = 1` |
| 3 | Handler environmental branch (NEW) | `network-error` / `rate-limited` / `provider-error` | Mid-stream | 5 consecutive + 30-min wall-time |

The layers don't cascade: each handles a different error class. Layer 2's
`continue` re-invokes `engine.downloadFile`, which transparently triggers
Layer 1 inside it. Layer 3 sleeps then re-invokes — the next call's Layer 1
will not fire (token already valid), Layer 3 just retries the GET.

No changes to the engine package. `add-engine-rename-download`'s
`DownloadOptions { rangeStart, signal, onProgress }` and
`DownloadResult { stream, contentLength, contentRange }` are sufficient.

### Decision 9: `download-retrying.engineCause` is diagnostic-only

**What:** The new event's `engineCause: DatasourceErrorTag` field carries
the engine-side error tag verbatim. This is a deliberate violation of the
"every IPC payload uses `FilesErrorTag`" convention.

The convention exists to keep the renderer free of engine-package coupling.
For `engineCause`, the field is documented and code-reviewed as
**diagnostic-only** — the renderer SHALL NOT branch behavior on its value,
SHALL NOT show it directly to users, MAY include it in the toast tooltip
for debugging-minded users.

The alternative (translate to `FilesErrorTag` at the handler boundary)
loses precision useful for telemetry — `network-error` vs `rate-limited`
vs `provider-error` are exactly the distinctions a resilience dashboard
wants. The translation would have to choose between collapsing to one
shared `FilesErrorTag` (information loss) or growing `FilesErrorTag` with
internal-only values (worse coupling).

### Decision 10: Counter-reset is byte-progress-strict

**What:** `consecutiveFailureCount = 0` only when `bytesWrittenAfter >
bytesWrittenBefore` across an attempt. The reset hooks AFTER a successful
pipe-drain or AFTER a partial-pipe that drained at least one byte before
the failure.

**Why precise:** A naive "reset on `engine.downloadFile` resolving" lets
a cycle that opens 200/206, errors on the first byte, retries, opens again,
errors on the first byte again — etc — never trigger the cap. Strict
byte-progress reset preserves the budget's intent: "we made forward
progress" is the only signal that earns budget reset.

### Decision 11: The unused `cycle` counter folds away

**What:** The existing handler has an outer `cycle` loop (line ~505) whose
counter is unused beyond the `cycle > 1` gate that re-stats `bytesWritten`.
With the new structure, the outer cycle is folded into the cycleSucceeded
gate's break — there is exactly one outer iteration per download in
practice. The variable is retained or removed at implementation discretion;
its semantic meaning ("split into split-and-rejoin cycles") is reserved
for a future `add-multi-cycle-download` change that does not exist today.

## Risks / Trade-offs

- **[Risk] Strategy bug marks non-retryable error as retryable=true** →
  Mitigation: handler's allowlist guard + log line; the strategy unit tests
  that lock down the classification (e.g., `ECONNRESET → network-error
  retryable=true`) are pre-existing per-strategy contracts.
- **[Risk] Provider returns 200 OK to Range repeatedly on a long download
  whose Range was honored once** (CDN edge variability) → Mitigation:
  hard-fail on the first occurrence (Decision 3). The user's manual Retry
  starts a fresh download. Trade-off: we lose the optimistic case where
  attempt 2 hits a different edge that honors Range. The user explicitly
  preferred this stance: "the choice of restart is up to the user only."
- **[Risk] Kept byte-count-mismatch partial corrupts the user's next
  download attempt if they retry and the on-disk prefix is actually wrong**
  → Mitigation: the user's Retry restarts from byte 0 with `flags: "w"`
  (truncates the partial). Resuming from the partial requires a different
  affordance that does not exist in v1; the disposition decision is purely
  about whether the user has the file on disk to inspect / use manually.
- **[Risk] 30-min wall-time ceiling is too aggressive for 4GB+ downloads on
  marginal connections** → Mitigation: the ceiling is a constant; future
  changes can tune per-file-size. Telemetry on `walltime-exceeded` rates
  will surface whether tuning is needed.
- **[Trade-off] `engineCause` couples the renderer to engine taxonomy
  semantically (not via type imports — the field is a string)** → Acceptable
  per Decision 9; the field is diagnostic-only and the type stays
  `DatasourceErrorTag` only inside the wire contract definition.
- **[Risk] `FilesErrorTag` widening breaks any consumer that does an
  exhaustive switch** → Mitigation: only consumer today is the renderer's
  failure-toast handler. The widening is a single-line change; included in
  this same change rather than landed separately.
- **[Trade-off] No telemetry pipe in v1** → Acceptable; `engineCause` field
  is wire-ready for telemetry whenever the desktop app's telemetry surface
  arrives. The `add-failed-download-cleanup-affordance` follow-up adds a
  click-through counter that establishes the telemetry pattern.

## Migration Plan

This change is a wire-format extension — it adds a new `FilesErrorTag` value
and a new IPC event, but does not break existing event shapes. Rollout:

1. Land the change. New tag and event flow through the IPC bus; renderer
   handles them. Older renderers (none in production today) would treat
   `tag: "exhausted-retries"` as an unknown tag — render the message field
   without a styled icon. Acceptable degradation.
2. No data migration. The in-memory registry has no schema. Existing
   in-flight downloads at deploy time terminate via the old code path
   (whatever the previous build did) and the user clicks Retry to engage
   the new code. No upgrade-window special handling needed.
3. Rollback: revert the change. The handler reverts to the previous
   single-attempt-per-environmental-error behavior. Any in-flight downloads
   started under the new code that hit a retry mid-stream will see the new
   code complete them; downloads started after rollback see the old
   behavior. No corruption risk.

## Open Questions

None — all five proposal questions resolved during brainstorming on
2026-04-30; advisor flagged two contract-surface decisions resolved in the
same session. Three follow-ups already stubbed:

- `wire-packaged-build-download-resilience` — packaged-build E2E with
  fault injection.
- `add-failed-download-cleanup-affordance` — UI button to delete kept
  partials on terminal failure.
- (Phase 2 of the cleanup affordance — settings panel for aggregate cleanup
  — depends on `migrate-download-registry-to-sqlite` and is deferred.)
