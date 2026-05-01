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

### Decision 3: Range-not-honored triggers one-shot rewrite-from-0, gated by env-retry budget

> **Note (post-§11.19 smoke, 2026-05-01)** — the §11.19 re-smoke
> falsified the original deferral assumption (see "Decision 3 history"
> at the bottom of this section). Drive's `?alt=media` endpoint did
> NOT honor `Range: bytes=N-` on a native 400MB MP4 after wifi-drop /
> reconnect — a real common-case file, NOT a Doc-export edge case.
> Hard-failing every wifi blip is unshippable: it makes the resilience
> change net-zero for the very scenario it was supposed to fix. This
> rewrite of Decision 3 adopts strategy **(b) one-shot rewrite-from-0
> + skip Range for rest of download**, locking in the user's choice
> when offered (a) "transient — keep retrying with Range each attempt"
> vs (b) "definitive — restart from 0 once, never send Range again
> for this download." Strategy (a) was rejected because once a server
> answers `200` to a Range request, retrying the same Range against
> the same URL is wasted bandwidth and provider quota; the server has
> declared its position.

**What:** When a resume attempt (`bytesWritten > 0` AND `Range: bytes=N-`
was sent) returns 200 OK without `contentRange`, the handler treats this
as a recoverable failure on the first occurrence within a single
`files:download` call. Mechanics:

1. Increment `consecutiveFailureCount` (consumes one env-retry budget slot).
2. Apply the env-retry budget guards (`> CONSECUTIVE_FAIL_LIMIT` → throw
   `ExhaustedRetriesError("range-not-honored")`; `now() - walltimeStartedAt
   > WALLTIME_CEILING_MS` → throw `WalltimeExceededError("range-not-honored")`).
3. Destroy the open response stream (it carries the full body the handler
   is about to discard — leaving it draining wastes provider bandwidth).
4. Emit `download-retrying { downloadJobId, datasourceId, attempt:
   consecutiveFailureCount, limit: CONSECUTIVE_FAIL_LIMIT, waitMs: 0,
   engineCause: "range-not-honored" }`. Wait is zero — no sleep before
   the rewrite — because the failure is deterministic-provider-behavior,
   not a transient network blip; backing off doesn't change the outcome.
5. `await deps.fs.unlink(params.toPath).catch(() => {})` — drop the partial
   on disk (its bytes are valid, but the rewrite-from-0 path will re-pipe
   them, and leaving the file with `flags: "w"` re-truncating is cleaner
   than positioning).
6. Set the closure-scoped `rangeUnsupported = true` flag.
7. Reset `bytesWritten = 0`.
8. `continue` the inner loop. The next iteration's `effectiveRangeStart`
   is forced to `0` (see point 9), so no Range header goes out, and the
   strategy gets a fresh GET that the server treats as the original
   request — guaranteed to behave the same way it did when the user
   first started the download (which we know works since bytes flowed
   before).
9. **Range-header gate.** A new derived `effectiveRangeStart` value is
   computed for every `engine.downloadFile` call:
   ```ts
   const effectiveRangeStart = rangeUnsupported ? 0 : bytesWritten;
   ```
   Once `rangeUnsupported = true`, the flag stays sticky for the lifetime
   of THIS `files:download` call. The strategy's `Range` header conditional
   (`if (rangeStart > 0)`) automatically skips the header when
   `effectiveRangeStart === 0`, so the engine package needs zero changes.

**Disposition on rewrite trigger:** the partial is `unlink`'d at step 5.
This is a non-terminal `unlink` (no `download-failed` emit yet), so it
deviates from Decision 6's `DELETE_ON_TERMINAL` set membership. The set
remains scoped to TERMINAL deletes; the rewrite-from-0 unlink is a
separate, in-flight cleanup that fires regardless of whether the download
ultimately succeeds or terminally fails later. Documented here, not added
to `DELETE_ON_TERMINAL`.

**Disposition on terminal failure during rewrite-from-0:** if the
rewrite-from-0 attempt itself ultimately fails (env-retry budget exhausted,
walltime ceiling, byte-count-mismatch, integrity-failed, etc.), terminal
disposition follows Decision 6 — keep partial for env-exhausted /
walltime / byte-count-mismatch / cancel; delete partial for range-mismatch /
integrity-failed. Range-not-honored is no longer in `DELETE_ON_TERMINAL`
because it can no longer be a terminal cause: the only paths to terminal
post-rewrite are the same env-retry-exhaustion paths used for any other
recoverable failure class.

**Idempotency on repeat range-not-honored within the same call.** If for
some reason the response comes back without `contentRange` again AFTER
`rangeUnsupported = true` has been set (which shouldn't happen — the gate
forces `rangeStart = 0`, and `bytesWritten > 0` is the only path into the
range-not-honored branch — but defensively): the gate at point 9 means
`bytesWritten === 0` on every post-rewrite attempt, so the
range-not-honored branch (gated on `bytesWritten > 0`) is unreachable.
Regression-pinned by a unit test in §12.

**`engineCause` value.** `"range-not-honored"` is a handler-side sentinel
identifier, NOT an engine `DatasourceErrorTag`. The wire field is typed
`string` (Decision 9) so this is contract-compatible. The renderer SHALL
NOT branch on its value (Decision 9); it surfaces as the diagnostic
description text, e.g. "Last error: range-not-honored. Restarting download."
For the special case `waitMs === 0`, the renderer's
`formatRetryingDescription` SHALL omit the "Waiting Xms" clause (since
"Waiting 0ms before retry" reads weirdly).

**Renderer UI on rewrite-from-0.** The toast remains in `Reconnecting…`
chrome with the diagnostic description through the rewrite. On the next
`downloading { progress: 0 }` event for the same `downloadJobId`, the
title's progress reverts to `0%` automatically — the user sees the
download "rewind" to zero with the description text explaining why.

**Why one-shot, not multi-shot.** Once a provider responds 200 to a Range
request on a specific URL, retrying with the same Range header against
the same URL is unlikely to flip behavior. Hence `rangeUnsupported`
sticky-flag-once. If a future provider proves this assumption wrong (Range
support varies across CDN edges within the same response), revisit at the
boundary of `wire-packaged-build-download-resilience`.

**Class name kept:** `RangeNotHonoredError` is no longer a terminal
sentinel for normal range-not-honored — that path now goes through
the env-retry branch's continue-loop. The class still exists and is
imported, but is unreachable in normal flow with this Decision's gate.
We keep it as a defensive sentinel for the (currently-unreachable) repeat
range-not-honored case described above. Removing it would be premature
cleanup; tests in §12 pin its unreachability.

**Class rename retained from v1:** `RangeNotSupportedError` →
`RangeNotHonoredError` from earlier iter — accurate naming preserved.

#### Decision 3 history

The v1 stance ("hard-fail on first range-not-honored, no retry within env
budget") was chosen for simplicity, with the note that the proposal's Open
Question 3 had recommended the opposite. The §11.19 smoke (real Drive
endpoint, real wifi drop, real 400MB MP4) demonstrated that v1's stance
makes the resilience change net-zero: every wifi blip on a long Drive
download terminates with an unrecoverable "range not supported" failure.
The user's options at that point are (a) re-click Retry → restart from 0
manually (which works, but is hostile UX during a flaky-network session)
or (b) abandon the download. Either way the resilience guarantee is broken.
This rewrite of Decision 3 adopts the (b) strategy from the iter-4 design
question: "definitive — restart from 0 once, skip Range for rest of
download." The advisor (2026-04-30 transcript) concurred that Decision 3
was empirically falsified on first smoke and shipping without addressing
it would fail to deliver the change's stated goal.

### Decision 4: Range-mismatch is hard-fail

**What:** When a resume attempt returns 206 Partial Content with
`contentRange.start !== bytesWritten`, the handler raises
`RangeMismatchError` immediately. Splicing the wrong bytes corrupts the
file; rewinding to byte 0 silently is hostile to a user who has half a
gigabyte on disk; surfacing the provider misbehavior is the right call.

### Decision 5: Renderer toast stays steady; new `download-retrying` event drives sub-status

> **Render contract (iter-3, §11.16):** `toast.loading(message, { id, description })`
> for both downloading AND retrying states (same render mode, in-place
> message + description swap). Failure uses `toast.error` (Sonner built-in
> type swap from loading→error works correctly). NO `toast.custom` for
> the retrying state — that path was abandoned in iter-3.

**What:** The toast title remains `Downloading <filename>` throughout. During a
retry sleep, the subtext switches `62% · 240 MB / 380 MB` → `Reconnecting…
(2/5)` and the progress bar **pauses at the last known byte position** — does
not rewind, does not animate. A small spinner glyph replaces the percentage
text in the subtext during the wait. Diagnostic context (`engineCause`,
`waitMs`) renders as Sonner's `description` field — always visible below
the title rather than hover-only. The original "tooltip on hover" design
(Decision 5 v1) was abandoned in iter-3 of the §9.4 fix-cycle:
`toast.custom` with hand-rolled tooltip-via-`title`-attribute conflicted
with Sonner's built-in render-type lifecycle (the prior `type: 'loading'`
carried the spinner-chrome overlay onto the custom render, plus same-id
custom replacement was unreliable). Always-visible description trades
hover-discoverability for reliable in-place chrome swap; the diagnostic
info is still surfaced, just not hidden by default.

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

### Decision 12: Per-attempt request timeout (handler-level)

**What:** Each retry-cycle's `engine.downloadFile()` call is wrapped with a
per-attempt timeout AbortSignal at the handler boundary. The signal is
composed with the existing user-cancel signal so either firing aborts the
attempt; if the timeout fires, the handler synthesizes a
`DatasourceError({ tag: "network-error", retryable: true })` and feeds it
to the same Layer 3 catch branch as a "real" network error.

**Why:** §9.4 manual smoke (run on commit `02de096`) reproduced a stuck-
forever Reconnecting state when wifi dropped and reconnected mid-download.
After `sleepCancellable(1000)` returned, the next `engine.downloadFile()`
inherited a dead OS-level socket and hung indefinitely (Windows TCP
timeout >5 minutes), blocking the retry loop. v1 had no per-request
timeout; the only AbortController plumbed was the user-cancel signal.

**Mechanics:**

```ts
const PER_ATTEMPT_TIMEOUT_MS = 60_000;

const attemptCtrl = new AbortController();
const attemptTimeoutHandle = setTimeout(
  () => attemptCtrl.abort(),
  PER_ATTEMPT_TIMEOUT_MS,
);
const composed = AbortSignal.any([
  abortController.signal, // user-cancel
  attemptCtrl.signal,     // per-attempt timeout
]);
try {
  await engine.downloadFile({ rangeStart, signal: composed, ... });
} finally {
  clearTimeout(attemptTimeoutHandle);
}
```

In the catch, the handler distinguishes user-cancel from timeout by
reading `abortController.signal.aborted` FIRST: if true → terminal
`download-cancelled` (existing path); otherwise the timeout fired and
the handler synthesizes the network-error and re-enters Layer 3 via
the existing env-retry branch.

**Concrete values:**

- `PER_ATTEMPT_TIMEOUT_MS = 60_000` (60s). Long enough for legitimate
  slow responses (provider hiccup); short enough that a hung socket
  fails fast and the retry loop progresses.
- Timeout-synthesized error: `tag: "network-error"`, `retryable: true`,
  `message: "per-attempt timeout (60000ms)"`. `isEnvironmentallyRetryable`
  catches it identically to an upstream `network-error`.
- Same `expBackoff(n)` schedule on retry — no separate curve for the
  timeout sub-class.
- Counts against the consecutive-failure budget — increments
  `consecutiveFailureCount`. A hung GET IS an environmental failure;
  treating it specially adds complexity for no contract benefit.
- Same byte-progress-strict reset (Decision 10) applies. If the timeout
  fired AFTER some bytes drained to disk (`bytesWrittenAfter >
  bytesWrittenBefore`), the counter resets to 0 on next attempt.

**No engine changes** — Decision 8 is preserved. The timeout lives at
the handler boundary because the handler already owns the retry loop's
budget + walltime tracking; centralizing all timing concerns there
keeps Layer 3 self-contained.

**Risk:** a 60s timeout is conservative. If a real provider takes >60s
for the GET response under heavy load, we'll falsely classify and retry.
Mitigation: `Retry-After` honor still works (server-side rate-limit
responses arrive before 60s in practice), and the 5-attempt budget
gives 5×60s = 5min of patience before terminal.

**Layer 3 routing also covers the pre-stream catch site.** Implementation
of §11.2 surfaced an inconsistency in the pre-fix handler: the inner-loop
mid-stream catch had Layer 3 (env-retry) as a documented branch, but the
PRE-STREAM catch (the GET itself rejecting before any bytes flow) had only
`throw err` — a real `network-error retryable=true` rejecting before the
stream opened went straight to terminal, contradicting Decision 8's
"Layer 3 catches network/rate-limit/provider-error and retries with
budget." The §11.2 fix routes the synthesized timeout error through
Layer 3 from BOTH catch sites; for symmetry and to honor Decision 8's
intent, real env-retryable errors at the pre-stream site take the same
Layer 3 path. Side effect: an immediate `ECONNREFUSED` (or any pre-stream
`network-error retryable=true`) now retries up to budget instead of
failing immediately. This is the intended behavior under Decision 8 +
Decision 12; the prior pre-stream-only-throw behavior was a latent gap
that the §9.4 hang exposed (the request never even rejected, so the
hang was the symptom, but the underlying handler was inconsistent
across catch sites). Pinned by §11.7-§11.9 integration tests + the
pre-existing §6.5 budget-exhaustion test (which exercises the same
counter+budget path the pre-stream branch now uses).

### Decision 13: Active download toast surfaces a Cancel action button

**What:** Both the `downloading` and `download-retrying` toast states
render a Cancel action button via Sonner's built-in `action: { label,
onClick }` option on `toast.loading`. Clicking the button calls
`window.api.sync.cancelJob({ downloadJobId })` (the existing IPC handler
plumbed through `add-fs-engine-cancellation`); the handler aborts the
in-flight `AbortController`; `sleepCancellable` resolves immediately if
the click landed during a retry sleep; the inner loop exits with
`CancelledError`; the handler emits `download-cancelled` with the last
known byte counts; the toaster's `download-cancelled` handler dismisses
the toast (existing path).

**Why:** `add-engine-rename-download` §7.5 noted "the toast carries no
Cancel UI button today" — an aspirational gap that has stood in two
specs (this change's `file-explorer/spec.md` "Cancel during retry sleep
terminates the download immediately" requirement, and the §11.19 user
smoke's expectation). Iter-4 closes the gap. Without it, the only way
to abort a long-running download is to wait for terminal failure or
quit the desktop app.

**Mechanics:**

- `DownloadToasterDeps` gains `syncApi?: SyncActionsApi` collaborator.
  `SyncActionsApi.cancelJob({ downloadJobId }): Promise<void>`. Production
  fallback resolves `window.api.sync.cancelJob` lazily, mirroring the
  existing `filesApi` resolution pattern.
- Both `toast.loading(...)` calls in the toaster (downloading-state path
  AND retrying-state path) pass `action: { label: "Cancel", onClick: () =>
  void syncApi.cancelJob({ downloadJobId }) }`. Same id, same chrome —
  Sonner's loading template renders the action button on the right side
  of the toast (line 812-824 of `node_modules/sonner/dist/index.mjs`
  pinned).
- The Cancel button is REMOVED on terminal-render swaps:
  - `download-cancelled` → `toast.dismiss` (existing) — no new render.
  - `file-downloaded` → `toast.custom` for V2 success (existing) — its
    own dual-action layout (Show in folder + Open).
  - `download-failed` → `toast.error` (existing) — Sonner's built-in
    error template; the existing Retry action is the failure-state
    affordance.
- Click handler is `void syncApi.cancelJob(...)` — fire-and-forget. The
  IPC's response is observable via the subsequent `download-cancelled`
  event; the click's promise return is unused. Errors thrown by the IPC
  call surface as console errors only — the user-visible signal is the
  toast staying live until the cancel succeeds (rare path; the IPC is
  idempotent and never rejects in normal flow).

**No spec.md change to "Cancel during retry sleep" requirement** — the
existing requirement (file-explorer spec.md "Cancel during retry sleep
terminates the download immediately") already presumes the toast HAS a
Cancel affordance. Iter-4 makes that requirement actually implementable.
The requirement copy is unchanged; tests now exercise it for real.

### Decision 14: Bytes-only progress fallback when contentLength is unknown

**What:** The `downloading` IPC event payload extends with two new
optional fields: `bytesLoaded: number` (always present when the engine's
byte-counting Transform is wired — i.e., always for the three current
strategies) and `bytesTotal: number | null` (the value of `contentLength`
on the engine response, surfacing the raw header presence/absence). The
renderer's `formatProgressMessage` switches behavior based on `bytesTotal`:

- `bytesTotal !== null && bytesTotal > 0` → existing percentage format:
  `Downloading <basename> — <pct>%` where pct = `floor(loaded/total *
  100)`.
- `bytesTotal === null || bytesTotal === 0` → new bytes-only format:
  `Downloading <basename> — <X> MB` where X = `(bytesLoaded /
  1_048_576).toFixed(1)`.

Once `bytesLoaded` exceeds 1 GB, the format scales to `<X> GB` for
readability.

**Why:** The §11.19 smoke surfaced that Drive's `?alt=media` endpoint
on a 400MB MP4 returned no `Content-Length` header — `transformDownloading
Event` mapped this to `progress: 0` and the toast got stuck at `0%`
forever. The user has no signal that bytes are flowing; they assume the
download is dead. Bytes-only progress preserves the activity signal even
when total is unknown; the eventual byte count converges on the file's
actual size, just without the percentage.

**Wire change scope:**

- `DownloadingPayload` in `@ft5/ipc-contracts/sync-service/events.ts`:
  ADD `bytesLoaded: number` (required; engines always know loaded byte
  count from the byte-counting Transform). ADD `bytesTotal: number | null`
  (required; mirrors the engine's `contentLength` literally — null means
  the response had no usable Content-Length header).
- `transformDownloadingEvent` in `files-download.ts` passes both fields
  through verbatim from `DownloadingEnginePayload.{loaded, total}`.
- The renderer toast's `DownloadEvent.downloading` mirror type adds the
  same fields.
- Existing `progress: number` field is retained for backward compat AND
  to keep the percentage path simple — the renderer can use `progress`
  directly when `bytesTotal !== null`.

**Backward compat:** the IPC contracts test surface (test-d files) updates
to assert the new fields. No existing wire-shape consumer breaks (the
renderer toaster is the only consumer and is updated in lockstep).

**Renderer formatting helper:**

```ts
function formatProgressMessage(
  basename: string,
  progressPct: number,        // 0 when bytesTotal is null
  bytesLoaded: number,
  bytesTotal: number | null,
): string {
  if (bytesTotal !== null && bytesTotal > 0) {
    const clamped = Math.max(0, Math.min(100, Math.round(progressPct)));
    return `Downloading ${basename} — ${clamped}%`;
  }
  if (bytesLoaded >= 1_073_741_824) {
    return `Downloading ${basename} — ${(bytesLoaded / 1_073_741_824).toFixed(2)} GB`;
  }
  return `Downloading ${basename} — ${(bytesLoaded / 1_048_576).toFixed(1)} MB`;
}
```

Format choice notes:
- 1 decimal place for MB (rolls over often, doesn't need precision).
- 2 decimal places for GB (rolls over rarely, more precision is useful).
- No commas / locale formatting in v1 (toString-default English-style is
  consistent with the rest of the app's number rendering).

**Hydration path.** `DownloadJobSummary.contentLength` and `bytesDownloaded`
already exist on the registry shape; `formatSeededRatio` is replaced /
extended to compute the same conditional formatting on initial seed.

### Decision 15: Single failure-toast emission — toaster owns event-driven failure UX

**What:** The orchestrator dispatch caller in `file-explorer.tsx` removes
the redundant `.then((response) => { if (!response.ok) toast.error(...); })`
block. The `.catch((err) => toast.error(...))` block stays — it covers
the genuinely-different case where the IPC itself rejects before any
event flows through the bus.

**Why:** The §11.19 smoke surfaced TWO failure toasts visible
simultaneously when a download terminally fails — one with Retry button
(from the toaster's `download-failed` handler) and one without (from the
file-explorer dispatch caller's `.then(toast.error)`). Both fire on the
same logical failure: the toaster gets the event-driven path, the dispatch
caller gets the synchronous-response path. Pre-iter-4, the toaster only
handled SUCCESS; the dispatch caller's `.then(toast.error)` was the only
failure UX. Iter-3 of this change extended the toaster to handle FAILURES
too, creating the duplicate.

**Trade-off:** removing the `.then` block means pre-job validation
failures (toPath rejected, concurrent-rejection, resolveClient failure —
the three paths in `files-download.ts:494-525` that return `{ ok: false,
error }` BEFORE registering a job, BEFORE emitting `download-failed`)
no longer surface a user-visible toast. v1 accepted this — pre-job
validation paths are rare (toPath validation is path-traversal
defense-in-depth; concurrent-rejection is double-click guard; resolveClient
fails on unknown datasourceId).

**Why acceptable for iter-4:**

- toPath validation: should never fire in practice — the validator's
  path-traversal regex is anchored on user-controlled paths the orchestrator
  composes via `joinFolderAndName` from a settings-resolved folder + a
  vendor-supplied basename, both of which the orchestrator sanitizes.
  Hitting this is a bug-level defect, surfaced via console error.
- Concurrent-rejection: the orchestrator's spawn path is gated by the file
  explorer's per-row click handler, which is typically guarded against
  double-clicks in the UI layer. Hitting this is a genuine race; user
  sees their second click do nothing visible. Acceptable temporarily.
- resolveClient: fires on a stale `datasourceId` (the datasource was
  removed between the user's click and the dispatch). Edge case.

**Future tightening:** if any of the three paths above become user-visible
(e.g. a future feature exposes raw datasource ids to the user), spawn a
follow-up change `add-pre-dispatch-validation-toast` that extends the
`FilesDownloadResponse` envelope with a `downloadJobId?: string` discriminator
on the failure case (set when the failure was post-job-creation; undefined
when pre-job). Renderer would re-introduce the `.then` toast guarded on
`downloadJobId === undefined`. v1 doesn't need this — the toaster covers
the common case and users see console errors for the edge cases.

**Single-source invariant.** With the `.then(toast.error)` block removed,
the toaster is the SOLE source of `Download failed: …` toast emissions in
the renderer codebase. The `.catch(toast.error)` for IPC-reject
exceptions is the one exception, scoped to a categorically different
failure mode (the IPC layer itself fails — disconnected service, malformed
request, etc.) where no `download-failed` event ever reaches the toaster.

### Decision 16: cancel-download IPC bridge — close the renderer↔service wiring miss

**What:** Wire a new `sync:cancel-download` end-to-end across the desktop
main↔preload IPC boundary. The fs-sync service has registered a
`makeSyncCancelDownloadHandler` for the `sync:cancel-download` command since
`add-engine-rename-download` (`services/fs-sync/src/commands/handlers.ts`),
and the wire contract documents the command at
`packages/ipc-contracts/src/sync-service/commands.ts:587` — but the desktop
main↔preload layer that the renderer talks to has no bridge for that
command. Iter-4 Decision 13 wired the toaster's Cancel button to
`window.api.sync.cancelJob({ downloadJobId })`, which name-collides with
the existing UPLOAD-job cancel (`window.api.sync.cancelJob({ jobId })`).
The toaster's call routed to `SYNC_CHANNELS.cancelJob = "sync:cancel-job"`
(upload-job cancel) carrying `{ downloadJobId: "..." }` — a shape with no
`jobId` field. The service-side `sync:cancel-job` handler ignored the
unknown shape and the actual download abort never happened.

**Why:** §12.5.5 smoke (2026-05-02) confirmed the bug user-side: clicking
the Cancel button on an active download toast does nothing. The toast
stays live, the download keeps running.

**Mechanics:**

- New channel constant in
  `packages/ipc-contracts/src/sync-service-desktop/channels.ts`:
  `cancelDownload: "sync:cancel-download"` slotted next to `cancelJob`.
  The string literal matches the wire-side command name verbatim so the
  desktop bridge proxies straight through.
- New renderer-facing request / response types in
  `packages/ipc-contracts/src/sync-service-desktop/requests.ts`:

  ```ts
  export interface SyncCancelDownloadRequest {
    readonly downloadJobId: string;
  }
  export interface SyncCancelDownloadResponse {
    readonly cancelled: boolean;
  }
  ```

  Flat-result (NOT the fallible `{ cancelled } | { error }` union of
  `cancelJob`): the service handler is idempotent — unknown `downloadJobId`
  resolves with `{ cancelled: false }`, never errors. Mirrors the
  `enqueueUpload` flat-result style.
- New `SyncClient.cancelDownload(params)` typed method in
  `apps/desktop/src/main/sync/client.ts` calling
  `this.request("sync:cancel-download", params, opts)`. Mirrors
  `cancelJob` / `enqueueUpload` typed-method shape.
- New main-process IPC handler at
  `apps/desktop/src/main/ipc/sync/cancel-download.ts` proxying the
  renderer request to `client.cancelDownload(...)`. Registered in
  `apps/desktop/src/main/ipc/index.ts` alongside the existing
  `SYNC_CHANNELS.cancelJob` registration. No `try/catch` on the
  `not-cancelable` shape needed (cancel-download never returns that;
  the only outcomes are `cancelled: true` and `cancelled: false`).
- New preload exposure at
  `apps/desktop/src/preload/index.ts`:
  `window.api.sync.cancelDownload(req)` invoking
  `SYNC_CHANNELS.cancelDownload`. Type added to
  `apps/desktop/src/preload/window-api.d.ts`.
- Renderer toaster rename: `SyncActionsApi.cancelJob` →
  `SyncActionsApi.cancelDownload` in
  `apps/desktop/src/renderer/src/features/file-explorer/download-job-toast.ts`.
  The production resolver `resolveSyncApi` looks up
  `window.api.sync.cancelDownload` (lazy, like `resolveFilesApi`).
  `buildCancelAction(downloadJobId)`'s onClick now invokes
  `syncApi.cancelDownload({ downloadJobId })`.
- **No aliasing.** `SyncActionsApi.cancelJob` is removed, NOT kept
  alongside `cancelDownload`. The name collision is the bug; aliasing
  would invite the next renderer caller to make the same mistake. Tests
  and the production resolver lock the new name.

**Spec correction:** the file-explorer spec delta added by iter-4
referenced `window.api.sync.cancelJob({ downloadJobId })` in the
"Active download toast renders a Cancel action button" requirement (4
verbatim references) plus a misattribution to `add-fs-engine-cancellation`
(the `sync:cancel-download` command was actually added by
`add-engine-rename-download` §13.15-§13.16 — the desktop bridge was never
wired). Iter-5 corrects all references to `cancelDownload` and replaces
the misattribution with an accurate parenthetical pointing at the
desktop bridge added by THIS iter-5.

**Click-side dismiss invariant retained.** The Cancel button onClick
still fires `void syncApi.cancelDownload({ downloadJobId })` and the
visible toast dismiss remains event-driven — the subsequent
`download-cancelled` IPC event arriving on the bus is what triggers
`toast.dismiss(...)` in the toaster's existing handler. Tests pin this
to prevent a future "optimistically dismiss in the click handler" change
from racing the event-driven dismiss (the click promise is intentionally
discarded; the user-visible signal is the round-trip).

**Why this surfaced only at iter-5:** `cancelJob` is a real exposed method
on `window.api.sync` (its purpose is upload-job cancel). The toaster's
call typechecks against the existing `SyncCancelJobRequest`-shaped surface
because `{ downloadJobId: "..." }` happens to be assignable to no field of
`SyncCancelJobRequest` — but JS at runtime ignores the property mismatch.
TypeScript caught nothing because the toaster's `SyncActionsApi.cancelJob`
was newly defined with `{ downloadJobId }` shape, decoupled from the
window-api type. The mocked test harness assertions verified the wired
function received the right argument; they did not verify the wired
function was actually `window.api.sync.cancelDownload`. Iter-5 closes
the gap by collapsing the toaster's collaborator name to match the
canonical preload method name (`cancelDownload`) and by adding the
preload-layer test that asserts `window.api.sync.cancelDownload(req)`
invokes `SYNC_CHANNELS.cancelDownload` — mirroring the existing
`cancelJob(req) → SYNC_CHANNELS.cancelJob` test.

## Risks / Trade-offs

- **[Risk] Strategy bug marks non-retryable error as retryable=true** →
  Mitigation: handler's allowlist guard + log line; the strategy unit tests
  that lock down the classification (e.g., `ECONNRESET → network-error
  retryable=true`) are pre-existing per-strategy contracts.
- **[Risk] Provider returns 200 OK to Range repeatedly on a long download
  whose Range was honored once** (CDN edge variability) → Mitigation:
  one-shot rewrite-from-0 on first occurrence (Decision 3). The handler
  consumes one env-retry budget slot, drops the partial, and restarts
  from byte 0 with `rangeUnsupported = true` sticky for the rest of this
  download. Trade-off: bandwidth waste — every wifi blip on a Drive
  resource that doesn't honor Range costs a full re-download (vs. v1's
  Decision 3 which surfaced terminal failure and let the user choose).
  Mitigated by the env-retry budget cap (5 consecutive failures still
  caps out — a flaky network won't loop infinitely) and by the wall-time
  ceiling (30 min). Real-world impact: a 400MB MP4 from Drive that hit
  range-not-honored after partial download now restarts from 0
  automatically; the user gets a brief `Reconnecting…` blip and then
  watches progress count up from 0% / 0 MB again. Acceptable for v1;
  variance across CDN edges (where attempt 2 might honor Range) is left
  to `wire-packaged-build-download-resilience` to investigate.
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
- **[Risk] `DownloadingPayload` wire extension (Decision 14) breaks any
  consumer doing exhaustive shape validation** → Mitigation: the only
  current consumer is the renderer toaster (`download-job-toast.ts`),
  which is updated in lockstep. Test-d files (`packages/ipc-contracts/
  src/sync-service/__tests__/events.test-d.ts`) pin the new shape;
  hard-coded shape assertions elsewhere in the workspace are flushed by
  the typecheck pass.
- **[Trade-off] Decision 15 silences pre-job validation failures
  (toPath-rejected / concurrent-rejected / resolveClient-failed) at the
  toast layer** → Acceptable; the three pre-job paths are edge cases
  (path-traversal defense-in-depth, double-click guard, stale
  datasourceId). Console errors persist; if any path becomes
  user-visible, follow-up `add-pre-dispatch-validation-toast` would
  re-introduce a guarded toast via a `downloadJobId?: string` discriminator
  on the response error envelope (see Decision 15 "Future tightening").
- **[Risk] Decision 13's Cancel action button rendering depends on
  Sonner's loading-template laying out the action button cleanly within
  its width budget** → Mitigation: pinned by §12 unit tests on the
  toaster-side action wiring + a manual-smoke step against a live
  Sonner render. Sonner's index.mjs source confirms `toast.action` is
  rendered for built-in templates (line 812-824); the runtime risk is
  cosmetic (button below the message vs. inline) rather than functional.

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
