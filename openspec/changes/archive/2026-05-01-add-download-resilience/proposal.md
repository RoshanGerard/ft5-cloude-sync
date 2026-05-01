# Proposal: Download stream resilience for transient network / provider errors

**Status**: Stub. Spawned by Out-of-scope items in
`add-engine-rename-download`'s `design.md` on 2026-04-27.

## Why

`add-engine-rename-download` ships single-shot file downloads with two
narrow forms of mid-stream recovery:

1. **Auth-expired during stream** — the engine refreshes the token and
   re-issues a `Range: bytes=N-` GET, splicing the new source into the
   same `Readable`. Consumer sees one continuous stream.
2. **Desktop app close while service alive** — the fs-sync service is
   detached and survives app close. On app reopen, the renderer queries
   `downloads:list-active`, hydrates a Sonner toast per in-flight job,
   and re-subscribes to its progress feed. The download itself never
   pauses.

Every other interruption mode in v1 surfaces as a `download-failed`
toast with a `Retry` action that restarts from byte 0. Honest about
scope but wasteful on the S3 raw-footage seeds (400MB+ files) where
any sustained interruption costs real bandwidth.

This change extends the partial-resume mechanism to cover the
**environmental** interruption classes — failures the service cannot
prevent regardless of code quality:

- Network disconnect mid-stream (WiFi off / cable unplugged)
- Provider 5xx mid-stream (transient backend hiccup)
- Provider rate-limit mid-stream (rare but possible on long downloads)

Service crashes are intentionally NOT in scope. Per the architectural
boundary established in `add-engine-rename-download` (service owns the
work, desktop is the indicator), service crashes are reliability bugs
to fix in the service, not feature-flag away with disk-persisted
state. The fs-sync service is detached and long-lived; if it dies,
the in-flight download dies with it and the user retries.

Mechanically, this change builds entirely on the in-memory registry +
Range-resume engine that `add-engine-rename-download` already adds —
no new persistence layer.

## What Changes

- Add wire tag `exhausted-retries` to `FilesErrorTag` and a new
  `download-retrying` IPC event with payload `{ downloadJobId,
  datasourceId, attempt, limit, waitMs, engineCause }`. (`engineCause`
  is typed `string` so the renderer cannot branch on its value — see
  Decision 9.)
- Extend the `files:download` handler retry loop in
  `services/fs-sync/src/commands/files-download.ts` with an
  environmental-retry branch (Layer 3): five-attempt-per-cycle
  consecutive-failure budget plus a 30-min wall-time ceiling, with
  exponential backoff `min(1000 * 2^(n-1), 30000) ms` and `Retry-After`
  honor when the engine emits one. Layer 1 (engine `withRefresh`) and
  Layer 2 (handler auth-expired single-shot retry) are unchanged.
- Add `fsBoundary.unlink` to the filesystem boundary and a
  `DELETE_ON_TERMINAL` set keying disposition by error-class identity.
  Range-not-honored, range-mismatch, and integrity-failed delete the
  partial before the `download-failed` emit; byte-count-mismatch keeps
  the partial.
- Renderer toast (`apps/desktop/src/renderer/src/features/file-explorer/download-job-toast.ts`)
  gains a `retrying` state that swaps the loading-template chrome to a
  custom render with `Reconnecting… (n/5)` subtext + spinner glyph +
  diagnostic tooltip. Same toast id is reused so the progress bar
  position is preserved through the swap (Decision 5). On the next
  `downloading` event, the toast reverts to the loading template.
- Failure handler accepts the new `tag: "exhausted-retries"` through
  the existing tag-agnostic toast.error branch.
- No engine changes (Decision 8). No new persistence layer. No
  schema migration. The in-memory `DownloadRegistry` carries no retry
  fields — retry state lives in handler closure scope.

## Out of scope

- Service crash / kill recovery. The service is the durable owner;
  reliability lives there, not behind a disk-persisted shim.
- Resumable uploads. This change is download-only; uploads have a
  separate upgrade path (Drive / OneDrive resumable session resume).
- User-initiated pause/resume UI. Retry is automatic; cancel still
  terminates outright.
- Background-download throttling / bandwidth caps.

## Open questions (resolve during `/opsx:propose`)

1. **Retry budget for non-auth interruptions.** Hard cap (5 retries
   per download), time budget (max 30 min total wall time), or
   exponential backoff with no cap? Recommend: 5 retries with
   exponential backoff (1s, 2s, 4s, 8s, 16s), AND a 30-min wall-time
   ceiling, whichever first. Emit `download-failed { tag:
   "exhausted-retries" }` on either limit.
2. **Per-class retry classification.** Network errors (ECONNRESET,
   ETIMEDOUT) → unconditional retry. Provider 5xx → retry. Provider
   429 (rate-limit) → honor `Retry-After` then resume. 4xx other than
   429 → fail (it's a real client-side problem). Recommend matching
   the engine's existing `normalizeErrorImpl` taxonomy and not
   inventing a new one.
3. **Resume eligibility check.** When resuming with `Range:
   bytes=N-`, providers occasionally return the full content (200 OK
   instead of 206 Partial Content) if they don't support range on
   that resource. The engine MUST detect this case and either
   discard already-written bytes (rewrite from 0) or fail with
   `tag: "range-not-supported"`. Recommend: rewrite from 0; emit
   one `downloading { progress: 0 }` event so the UI rewinds.
4. **Renderer UX during retry**. Does the toast flicker between
   `downloading (60%)` → `retrying (attempt 2/5)` → back to
   `downloading (61%)`? Or stays as steady "downloading" with a
   quieter sub-status like "reconnecting…"? Recommend: the latter.
   Minimize visual noise; expose retry count via toast tooltip.
5. **Partial file disposition on terminal failure.** Browser convention
   leaves the partial file on disk after a download fails (Chrome
   `.crdownload`); the user can delete it manually or the next
   download attempt with the same target path triggers the conflict
   dialog. Recommend matching browser behavior. The engine emits
   `download-failed { partialPath }` so a UI affordance "Delete
   partial file" is wireable as a follow-up if telemetry shows users
   want it.

## Acceptance criteria (once promoted)

- Engine's downloadFile-Readable wrapper resumes transparently across
  network / 5xx / rate-limit interruptions per the chosen retry
  policy. Per-strategy contract tests exercise each error class with
  fault-injection.
- The wrapper detects "range not supported" on resume (200 OK to a
  Range request) and recovers correctly per Q3.
- Retry budget exhausted → `download-failed { tag:
  "exhausted-retries", cause: <original-error-tag> }`.
- `downloading` events do not regress to "0%" mid-resume on a
  successful 206 (T1 of `add-engine-rename-download`'s event taxonomy
  remains untouched).
- No new persistence layer. The in-memory registry from
  `add-engine-rename-download` is sufficient.

## Provenance

- Spawned by `add-engine-rename-download` design.md
  Out-of-scope on 2026-04-27.
- Builds on the Range-resume engine and in-memory download registry
  added by `add-engine-rename-download` (auth-resume only). This
  change generalizes the resume mechanism to all environmental
  interruption classes.
- Architectural boundary set during brainstorming: "service owns the
  work, desktop is the indicator." Service-crash recovery is
  intentionally excluded — it would push state out of the durable
  owner and into a disk-shim layer that violates the boundary.

## Deferred scope (follow-up changes)

Two follow-ups carry forward work intentionally not in scope here.
Reviewers should look at these alongside this change to see the
full envelope:

- **`wire-packaged-build-download-resilience`** — exercises the §6.4-
  §6.16 retry scenarios against a packaged build with a fault-injection
  layer (mitmproxy or similar). v1 verifies range-not-honored /
  range-mismatch / integrity-failed at the integration-test layer only
  because a deterministic provider fault that returns 200 OK to a
  Range request is hard to reproduce against real-world endpoints.
  This follow-up closes the gap between unit-level coverage and
  end-to-end packaged behavior.
- **`add-failed-download-cleanup-affordance`** — surfaces a UI
  affordance to delete or move kept-partial files. v1 follows browser
  convention (Chrome `.crdownload`): on terminal failure where the
  partial is corrupt-but-recoverable (env-budget-exhausted, walltime,
  byte-count-mismatch, auth-revoked, user-cancellation) the file is
  preserved on disk so the user can choose what to do with it. Today
  the only affordances are "the next download to the same target
  triggers the conflict dialog" or manual file-system cleanup. The
  follow-up adds an explicit "Delete partial" / "Move to trash" path.

§9.4 (manual wifi-drop smoke) remains pending and is the user-driven
gate before archive: cold-start desktop, log into a datasource, start
a 100MB+ download, mid-flight disable wifi for ~10s, re-enable.
Verify the toast shows `Reconnecting… (1/5)` during the outage and
resumes when wifi returns.
