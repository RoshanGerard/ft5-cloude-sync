# Tasks: add-download-resilience

## 1. Wire-level type extensions (`@ft5/ipc-contracts`)

- [x] 1.1 Added `ExhaustedRetries: "exhausted-retries"` to the `FilesErrorTag` const-object + type alias in `packages/ipc-contracts/src/files.ts`.
- [x] 1.2 Added `DownloadRetryingPayload { downloadJobId, datasourceId, attempt, limit, waitMs, engineCause }` to `packages/ipc-contracts/src/sync-service/events.ts` plus its `EventPayloadMap` and `EVENT_NAMES` registrations. `engineCause` typed `string` (engine `DatasourceErrorTag` is itself a string union; keeping the wire field as `string` avoids cross-package coupling). Also widened `DownloadFailedPayload.tag` to include `"exhausted-retries"`.
- [x] 1.3 Updated test-d files (`__tests__/files-error-tag.test-d.ts`, `sync-service/__tests__/files-commands.test-d.ts`, `sync-service/events.test-d.ts`) plus a downstream fix in `__tests__/files.test-d.ts` for hardcoded tag-union expectations. Asserts (a) `FilesErrorTag` includes the new value, (b) `DownloadRetryingPayload` shape, (c) `DownloadFailedPayload.tag` includes `"exhausted-retries"`.
- [x] 1.4 `pnpm --filter @ft5/ipc-contracts build` clean. `pnpm exec vitest run packages/ipc-contracts/` — 44 test files / 469 tests passed, no type errors. Full-repo `pnpm typecheck` clean.

## 2. Handler retry-loop helpers (`services/fs-sync/src/commands/files-download.ts`)

- [x] 2.1 Add `isEnvironmentallyRetryable(err: unknown): boolean` near the top of the file. Returns true iff `err instanceof DatasourceError && err.tag !== "auth-expired" && err.retryable === true && (err.tag === "network-error" || err.tag === "rate-limited" || err.tag === "provider-error")`. Otherwise false.
- [x] 2.2 Add `expBackoff(attempt: number): number` returning `Math.min(1000 * 2 ** (attempt - 1), 30000)`. Pure function; unit-tested in §6.
- [x] 2.3 Add `sleepCancellable(ms: number, signal: AbortSignal): Promise<void>` — wraps `setTimeout` + a `signal.addEventListener("abort", …)` pair so an abort resolves the sleep immediately and clears the timer (`clearTimeout`). Returns void on either resolution path; never rejects.
- [x] 2.4 Add the constants `CONSECUTIVE_FAIL_LIMIT = 5` and `WALLTIME_CEILING_MS = 30 * 60 * 1000` to the file's existing constant block alongside `MAX_AUTH_RETRIES_PER_CYCLE`.
- [x] 2.5 Rename internal sentinel `RangeNotSupportedError` to `RangeNotHonoredError` (class declaration + every reference in this file). The error message string stays the same so existing wire-shape compatibility holds.

## 3. Filesystem boundary extension (`services/fs-sync/src/commands/files-download.ts`)

- [x] 3.1 Add `unlink(path: string): Promise<void>` to the `FsBoundary` interface.
- [x] 3.2 Wire the default `FsBoundary` impl in `createDefaultFilesDownloadDeps` to call `node:fs/promises.unlink(path)` for the new method.
- [x] 3.3 Add a `DELETE_ON_TERMINAL` constant — a `Set<Function>` of `RangeNotHonoredError`, `RangeMismatchError`, `IntegrityFailedError` (NOT `ByteCountMismatchError`). Confirm by code review that no other sentinel error class is mis-included.

## 4. Handler retry-loop integration (`services/fs-sync/src/commands/files-download.ts`)

- [x] 4.1 Add two new state variables to the handler closure: `consecutiveFailureCount = 0` and `walltimeStartedAt = deps.now()` (captured BEFORE the outer cycle loop begins, so it covers the whole download lifetime).
- [x] 4.2 In the inner-loop catch (the existing `try { await deps.fs.pipeline(...) } catch` block), add a SECOND branch after the existing auth-expired branch and before the final `throw err`. The new branch tests `isEnvironmentallyRetryable(err)` — when true, it: (a) increments `consecutiveFailureCount`, (b) checks `consecutiveFailureCount > CONSECUTIVE_FAIL_LIMIT` → throw a new `ExhaustedRetriesError(err.tag)`, (c) checks `deps.now() - walltimeStartedAt > WALLTIME_CEILING_MS` → throw a new `WalltimeExceededError(err.tag)`, (d) computes `wait = max(err.retryAfterMs ?? 0, expBackoff(consecutiveFailureCount))`, (e) checks `wait > (WALLTIME_CEILING_MS - elapsed)` → throw `WalltimeExceededError`, (f) emits `download-retrying { downloadJobId, datasourceId, attempt: consecutiveFailureCount, limit: CONSECUTIVE_FAIL_LIMIT, waitMs: wait, engineCause: err.tag }`, (g) `await sleepCancellable(wait, abortController.signal)`, (h) re-stat `bytesWritten` from disk, (i) continue the inner loop.
- [x] 4.3 Add the byte-progress reset rule. After the pipe drains successfully (the existing `cycleSucceeded = true` block), insert a check: if `bytesWrittenAfter > bytesWrittenBefore` (compare the just-stat'd value against the value at the start of the iteration), then `consecutiveFailureCount = 0`. Capture `bytesWrittenBefore` before issuing `engine.downloadFile`, sample `bytesWrittenAfter` after the pipe drains.
- [x] 4.4 Define two new sentinel error classes: `ExhaustedRetriesError` (carries `engineCause: DatasourceErrorTag`) and `WalltimeExceededError` (carries `engineCause: DatasourceErrorTag`). Place alongside the existing sentinels at the bottom of the file.
- [x] 4.5 In the outer terminal-catch block (the existing branch at the end of the handler), add handling for both new sentinels. Both emit `download-failed { downloadJobId, datasourceId, tag: "exhausted-retries", message: <descriptive> }`. Use `"exhausted-retries: <engineCause>"` for `ExhaustedRetriesError` and `"walltime-exceeded: <engineCause>"` for `WalltimeExceededError`. Both return `{ ok: false, error: { tag: "exhausted-retries", message, retryable: true } }`.
- [x] 4.6 In the SAME outer terminal-catch block, add the disposition policy. Before any terminal `download-failed` emission, check whether `err.constructor` is in `DELETE_ON_TERMINAL`. If yes, `await deps.fs.unlink(params.toPath).catch((unlinkErr) => { /* log warning, don't escalate */ })`. The unlink runs BEFORE the `fsSyncBus.emit("download-failed", ...)` so a renderer that subscribes to `files:download-failed` and inspects the disk sees the consistent post-disposition state.

## 5. Engine bus / event subscription (`services/fs-sync/src/commands/files-download.ts`)

- [x] 5.1 Confirm the existing engine-bus subscription does NOT need to relay `download-retrying` (it does not — the event is fs-sync-domain, not engine-domain). No new subscription branches required. [Verified: `engineBus` is injected as a handler dependency for streaming-event correlation, not as a bootstrap-level translator. `download-retrying` is emitted by the handler (files-download.ts §4 lines 745-752); the engine has no "retrying" concept. No bootstrap subscription change.]
- [x] 5.2 Confirm the existing `downloads:list-active` snapshot logic is unchanged — retry state is event-stream-only, the registry stores no retry flags. No code change. [Verified: `DownloadJobEntry` has 8 fields, none retry-related; `DownloadJobUpdate` is type-locked to `bytesDownloaded | contentLength` only. §4's `consecutiveFailureCount` + `walltimeStartedAt` live in handler closure scope. `downloads-list-active.ts` is unchanged.]

## 6. Handler unit + integration tests (`services/fs-sync/src/commands/__tests__/files-download.test.ts`)

- [x] 6.1 Unit-test `isEnvironmentallyRetryable` against the full Cartesian: every `DatasourceErrorTag` value × `retryable: true | false`. Assert the truth table: only `network-error`, `rate-limited`, `provider-error` with `retryable: true` return true; auth-expired returns false even when retryable=true; non-`DatasourceError` instances return false.
- [x] 6.2 Unit-test `expBackoff` returns `1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000` for n ∈ {1..8}. Confirm cap.
- [x] 6.3 Unit-test `sleepCancellable`. Cases: (a) resolves on timer fire, (b) resolves immediately on pre-aborted signal, (c) resolves immediately when signal aborts mid-sleep, (d) clears the timer when aborted (no callback fires after).
- [x] 6.4 Integration test "Network drop mid-stream recovers transparently" per the spec scenario. Drive the engine fake to error mid-stream once with `tag: "network-error", retryable: true`; second call succeeds. Assert exactly one `download-retrying` event with `attempt: 1, waitMs: 1000, engineCause: "network-error"`. File downloads completely. Use `vi.useFakeTimers()` to fast-forward the sleep.
- [x] 6.5 Integration test "Five consecutive environmental failures exhaust the budget" per the spec scenario. Drive 5 errors in a row with no progress. Assert 5 `download-retrying` events (`attempt: 1..5`). Then assert exactly one `download-failed { tag: "exhausted-retries", message: "exhausted-retries: network-error" }`. Assert `deps.fs.unlink` was NOT called (partial kept).
- [x] 6.6 Integration test "Successful byte progress resets the consecutive counter" per the spec scenario. Sequence: error → success drains 50MB → error → success drains the rest. Assert the second `download-retrying` has `attempt: 1` (not 2). [Implementation note: handler's outer `while(true)` is single-cycle in v1 (always breaks on `bytesWritten === finalContentLength`). Actual test asserts byte-progress reset via the env-retry branch's own rule (mid-stream throw with partial progress) — exercises Decision 10 directly.]
- [x] 6.7 Integration test "Wall-time ceiling supersedes count budget" per the spec scenario. Stub `deps.now()` to advance past the ceiling between attempts. Assert `download-failed { tag: "exhausted-retries", message: "walltime-exceeded: <engineCause>" }`. Partial kept.
- [x] 6.8 Integration test "Rate-limited error honors `retryAfterMs`" per the spec scenario. Engine errors with `tag: "rate-limited", retryable: true, retryAfterMs: 5000` at a moment when expBackoff would be 1000. Assert `download-retrying.waitMs === 5000`. Sleep duration matches under fake timers.
- [x] 6.9 Integration test "Cancel during retry sleep terminates immediately" per the spec scenario. Trigger a `download-retrying` event, advance fake timers half-way through the sleep, fire abort. Assert `download-cancelled` emits, no further `download-retrying` follows, partial kept.
- [x] 6.10 Integration test "Non-retryable tag bypasses the environmental budget" per the spec scenario. Engine errors with `tag: "auth-revoked", retryable: false`. Assert immediate `download-failed { tag: "auth-revoked" }`, no `download-retrying`, no sleep, partial kept.
- [x] 6.11 Integration test "Range-not-honored deletes the partial" per the spec scenario. First cycle drains some bytes, second `engine.downloadFile` returns 200 OK without `contentRange`. Assert `deps.fs.unlink(params.toPath)` is called BEFORE the `download-failed` event fires. Verify event payload `tag: "other", message: "range not supported on this resource"`.
- [x] 6.12 Integration test "Range-mismatch deletes the partial" per the spec scenario. Mirrors 6.11 with `contentRange.start !== bytesWritten`. Assert unlink + correct event.
- [x] 6.13 Integration test "Integrity-failed deletes the partial" per the spec scenario. Drive successful pipe-drain, then provider-hash check returns mismatch. Assert unlink + `tag: "other", message: "integrity check failed"`.
- [x] 6.14 Integration test "Byte-count-mismatch keeps the partial" per the spec scenario. Drive `bytesWritten ≠ contentLength` post-pipe. Assert `download-failed { tag: "other", message: "byte count mismatch" }`. Assert `deps.fs.unlink` was NOT called.
- [x] 6.15 Integration test "`unlink` failure is non-fatal." Trigger a delete-disposition path with `deps.fs.unlink` rejecting `EACCES`. Assert the same `download-failed` event still emits. Optionally assert a warning is logged (depending on logging strategy).
- [x] 6.16 Integration test "Auth-expired co-exists with environmental retry." Sequence: network-error → recover → mid-stream auth-expired → recover via Layer 2 → success. Assert no double-budget-counting; auth-expired uses its existing slot, environmental count is independent.
- [x] 6.17 Run `pnpm --filter @ft5/sync-service test` (or the equivalent for the fs-sync test surface) and confirm all new tests pass alongside the pre-existing suite. [Result: 465 passed / 9 skipped (was 452 before §4); typecheck + lint clean.]

## 7. Renderer toast (`apps/desktop/src/renderer/src/features/file-explorer/download-job-toast.ts`)

- [ ] 7.1 Add a `retrying` state to the toast's internal state machine (alongside `idle`, `downloading`, `succeeded`, `failed`, `cancelled`). Hold optional `retryContext: { attempt, limit, waitMs, engineCause }` while in the state.
- [ ] 7.2 Wire a handler for the new `download-retrying` IPC event. On receipt, transition state to `retrying` with the payload's context. Title remains `Downloading <filename>`; subtext switches to `Reconnecting… (<attempt>/<limit>)`. Replace the percentage indicator with a spinner glyph. Progress bar position remains unchanged from the last-rendered `downloading` event.
- [ ] 7.3 On the next `downloading` event after entering `retrying` state, transition back to `downloading` state and resume normal progress rendering. No transition animation between the two.
- [ ] 7.4 Wire the toast tooltip text: `Last error: <engineCause>. Waiting <waitMs>ms before retry.` Visible only when in `retrying` state.
- [ ] 7.5 Confirm Cancel during `retrying` state still works — it dispatches `sync:cancel-download` exactly as it does in `downloading` state. The toast transitions to the existing cancellation appearance on the `download-cancelled` event.
- [ ] 7.6 Update the failure-toast handler to recognize `tag: "exhausted-retries"` from `download-failed`. Render the existing failed appearance with the message text shown.
- [ ] 7.7 Update file-explorer per-row inline progress indicator (if it consumes the same event stream) to reflect retry state with a subtle "reconnecting" glyph at the row level. Tooltip mirrors the toast tooltip text.

## 8. Renderer tests (`apps/desktop/src/renderer/src/features/file-explorer/__tests__/download-job-toast.test.ts`)

- [ ] 8.1 Test "Toast switches to Reconnecting sub-status on download-retrying" per the spec scenario. Render the toast at `62%`, dispatch the event, assert subtext + spinner glyph + progress bar position.
- [ ] 8.2 Test "Toast snaps back to progress on next downloading event" per the spec scenario. Dispatch retry then a `downloading` with `progress: 63`; assert subtext changes back, glyph reverts.
- [ ] 8.3 Test "Toast tooltip exposes diagnostic context" per the spec scenario. Hover during retrying state; assert tooltip content includes `engineCause` and `waitMs`.
- [ ] 8.4 Test "Toast does NOT change appearance for auth-expired retry" per the spec scenario. Dispatch a sequence of `downloading` events with no `download-retrying` between them (auth-expired is invisible to the renderer); assert the toast never enters `retrying` state.
- [ ] 8.5 Test "Cancel during retry sleep dismisses toast within 100ms" per the spec scenario. Drive a retry state, click Cancel, assert `sync:cancel-download` is dispatched immediately (no internal wait), toast transitions to cancelled when the event arrives.
- [ ] 8.6 Test "Hydration to retrying toast on next download-retrying event" per the spec scenario. Initial hydration via `downloads:list-active` (downloading state), then a `download-retrying` arrives; assert the toast transitions through `downloading` → `retrying`.
- [ ] 8.7 Test "Hydration to downloading toast on next downloading event" per the spec scenario. Hydration then a `downloading` event; assert no `retrying` state is entered.
- [ ] 8.8 Test failure-toast handles `tag: "exhausted-retries"`. Dispatch `download-failed { tag: "exhausted-retries", message: "exhausted-retries: network-error" }`; assert failed-state appearance + message displayed verbatim.
- [ ] 8.9 Run `pnpm --filter @ft5/desktop test` (or equivalent) and confirm all renderer tests pass.

## 9. Verification

- [ ] 9.1 Run the full repo test suite: `pnpm test` at the workspace root. All existing tests pass; new tests pass; no regressions.
- [ ] 9.2 Run `pnpm typecheck` and `pnpm lint`. No new errors introduced.
- [ ] 9.3 Run `openspec validate add-download-resilience`. Change passes validation.
- [ ] 9.4 Manual smoke test (single-machine): cold-start desktop app, log in to a datasource, start a 100MB+ download, mid-flight disable wifi for ~10s, re-enable. Verify the toast shows `Reconnecting… (1/5)` during the outage and resumes when wifi returns. The downloaded file's hash matches the provider-advertised hash.
- [ ] 9.5 Manual smoke test (range-not-honored): difficult to trigger reliably without a fault-injection layer. Document in the PR notes that this scenario is verified via integration test only at v1; the packaged-build E2E follow-up (`wire-packaged-build-download-resilience`) covers it with mitmproxy.
- [ ] 9.6 Confirm `pnpm --filter @ft5/sync-service test` shows no flake on the new integration tests across 5 consecutive runs.

## 10. Documentation and follow-up

- [ ] 10.1 Update `services/fs-sync/README.md` (if the file documents the download path) with a one-paragraph note on the three-layer retry architecture and link to `design.md`.
- [ ] 10.2 Cross-reference the two follow-up stubs (`wire-packaged-build-download-resilience`, `add-failed-download-cleanup-affordance`) in this change's `proposal.md` "Provenance" or end-of-file section so reviewers see the deferred scope.
- [ ] 10.3 If the smoke tests in §9.4 surface unexpected behavior (e.g., `downloading` events fire mid-retry, the toast flickers, etc.), capture in a `PENDING_TC.MD` or follow-up issue rather than block this change.
