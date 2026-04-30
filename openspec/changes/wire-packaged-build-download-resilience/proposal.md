# Proposal: Packaged-build E2E for download resilience with fault injection

**Status**: Stub. Spawned during `add-download-resilience` brainstorming
on 2026-04-30.

## Why

`add-download-resilience` ships environmental retry (network / 5xx /
rate-limited) layered on the existing auth-resume mechanism in the
fs-sync service handler. Verification ships at the unit + integration
layer:

- Unit tests against `isEnvironmentallyRetryable`, `expBackoff`,
  `sleepCancellable`, the disposition predicate.
- Integration tests against `makeFilesDownloadHandler` with a fake
  `DatasourceClient` driving the engine layer and `vi.useFakeTimers`
  fast-forwarding the backoff sleeps.

These cover the handler's contract under all the retry / disposition
scenarios. They do NOT cover:

1. The packaged Electron build behaving the same way as `vitest run`.
   Build-time bundling, Electron's Node version vs. the test runner's,
   the supervisor's IPC framing, OS-level file locking on the partial
   file during cleanup — none of these are exercised by the unit
   suite. `wire-fs-sync-service`'s 13.4 packaged-build E2E was
   deferred for the same reason; this follow-up is the parallel for
   resilience.
2. Real provider fault injection. Drive / OneDrive / S3 each respond
   to mid-stream connection drops differently. The strategies'
   `normalizeErrorImpl` is unit-tested with synthesized exceptions,
   but the actual end-to-end path under a real CDN cold-failover or
   a real 503 has not been observed.
3. The renderer's `download-retrying` event flow under an actual IPC
   transport (the renderer tests use a fake bus). Coalescing,
   ordering, and timing under `electron-better-ipc` could differ.

This change is the live-environment smoke pass.

## Out of scope

- Replacing the unit + integration coverage. Those stay; this layer
  adds confidence at the integration boundary, not duplicate coverage.
- Production telemetry / dashboards for retry rates. Different change
  (`add-download-telemetry` if it ever exists).
- Provider-specific retry tuning. The 5/30min budget is wired in
  `add-download-resilience`; this change verifies behavior, doesn't
  re-decide policy.

## Open questions (resolve during `/opsx:propose`)

1. **Fault-injection mechanism.** Three options:
   (a) **Network-level mitm** (mitmproxy / Charles) intercepting the
       packaged build's outbound TCP and injecting drops / 503s /
       slow responses. Most realistic; hardest to wire into CI.
   (b) **In-app interceptor** that wraps the strategy's HTTP client
       and synthesizes failures based on a test-only flag. Faster,
       more deterministic; less faithful to "real packaged build."
   (c) **Provider-side fault injection** (e.g., S3's chaos-monkey
       endpoints, Drive's rate-limit headers via test fixtures).
       Most authoritative; only works for providers that expose it.
   Recommend (a) for the smoke pass — one CI job runs the packaged
   build behind a mitmproxy that drops 30% of TCP packets randomly
   for a 60-second window during a 200MB download. Asserts the
   download completes within wall-time and the partial file matches
   the provider hash.

2. **Test surface scope.** Which scenarios run as packaged-build E2E?
   Recommend the 5 highest-leverage:
   - Network drop mid-stream → retry → recover.
   - Rate-limited (synthetic 429 with `Retry-After: 5`) → wait → recover.
   - Cancel during retry sleep → terminate immediately.
   - Range-not-honored → terminal, partial deleted.
   - 5 consecutive failures → terminal `exhausted-retries`, partial kept.
   Skip range-mismatch (provider misbehavior is hard to synthesize),
   integrity-failed (provider hash isn't easily corruptible), and
   walltime-exceeded (would take 30 minutes per run).

3. **CI execution.** Packaged-build E2E is slow (build + launch +
   network setup). Run on PR-touching-download paths only, or every
   PR? Recommend the former — `paths-filter` action gates this job
   on changes under `services/fs-sync/src/commands/files-download.ts`,
   `apps/desktop/src/renderer/src/features/file-explorer/`, and the
   relevant strategies.

4. **Partial-file cleanup verification.** When the test asserts the
   "delete on range-not-honored" disposition, how does it observe the
   filesystem state from outside the packaged process? Recommend a
   per-test temp directory (`os.tmpdir()/ft5-test-<uuid>`) the test
   probes after the download terminal event fires. Per-test cleanup
   removes the directory regardless of test outcome.

5. **Renderer assertions.** Use Playwright (precedent in
   `add-file-explorer-drag-drop-upload`'s wire-up) to drive the
   renderer and assert toast text transitions ("Reconnecting…
   (2/5)" appears, then disappears when bytes flow). Headed Electron
   in CI is slower but verifies the human-visible UX, not just the
   wire events.

## Acceptance criteria (once promoted)

- A `tests/packaged-build/download-resilience.spec.ts` Playwright
  suite that drives the packaged Electron build through the 5
  highest-leverage scenarios from Q2.
- The suite runs behind a mitmproxy (or chosen mechanism per Q1)
  that synthesizes network-level faults during otherwise-successful
  downloads of a fixture file (≥ 100MB to trigger meaningful resume
  behavior).
- For each scenario, the suite asserts (a) the right toast text
  appears at the right moment, (b) the right IPC events fire in the
  right order with correct payloads, (c) the on-disk state matches
  the disposition policy (kept vs deleted).
- The suite gates only on PRs touching the download path (Q3).
- A README in `tests/packaged-build/` documents how to run the suite
  locally + the mitmproxy fixture setup.

## Provenance

- Spawned during `add-download-resilience` brainstorming on 2026-04-30
  when the user approved the testing-strategy section. The unit +
  integration layer is in scope for `add-download-resilience`; this
  change carries the integration-boundary verification forward.
- Mirrors the deferral pattern from `wire-fs-sync-service` 13.4
  (packaged-build E2E was carried forward to a follow-up rather than
  block the core change on a slow CI pipeline).
- Should land within a sprint of `add-download-resilience` reaching
  master so the live-environment smoke catches integration drift
  early.
