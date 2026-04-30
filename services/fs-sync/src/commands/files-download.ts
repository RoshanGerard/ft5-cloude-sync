// `files:download` command handler — fs-sync's business-logic orchestration
// for the engine's `downloadFile` primitive (per add-engine-rename-download
// §13 + design.md Decision 3 + spec.md "files:rename and files:download
// RPC commands delegate to the engine"). The handler:
//
// 1. Validates `toPath` (security boundary — see `util/path-validator.ts`).
// 2. Rejects a second download for the same `(datasourceId, sourcePath)`
//    BEFORE minting a job id (concurrent-rejection guard, §13.23).
// 3. Mints a `downloadJobId` UUID + creates an AbortController.
// 4. Inserts a registry entry (the registry's reverse-index is updated
//    in lockstep so `findByKey` resolves immediately).
// 5. Subscribes to the engine bus's four download lifecycle events for
//    the lifetime of the call (per-handler-call subscription — the
//    file-touch constraint resolves the §13.21-§13.22 spec ambiguity in
//    favour of handler-local; the bus subscription is also the canonical
//    source for the `derived-not-relayed` IPC event emission per
//    §13.25-§13.26).
// 6. Runs the retry loop calling `engine.downloadFile(target,
//    { rangeStart, signal, onProgress })` repeatedly. The `onProgress`
//    callback is the low-overhead inline path; the bus subscription is
//    the cross-cutting observation path. Both converge on the same
//    registry state.
// 7. Validates `contentRange.start === rangeStart` (range-not-honored /
//    range-mismatch detection — Decision 3 safeguards).
// 8. On stream end, asserts `fs.stat(toPath).size === contentLength`.
// 9. Runs the post-download integrity check (provider's hash via
//    `client.getMetadata` if not on the strategy's response shape).
// 10. On success, replies `{ ok: true, result: { savedPath, bytes } }`.
//     On failure / cancel, replies the appropriate error envelope.
//
// Error-tag taxonomy (see ipc-contracts `FilesErrorTag`):
//   - User-driven cancel  → tag: "cancelled"  (spec line 78)
//   - Auth-revoked        → tag: "auth-revoked"
//   - Network-error       → tag: "disconnected"
//   - Rate-limited        → tag: "rate-limited" (carries retryAfterMs)
//   - Invalid-datasource  → tag: "invalid-datasource"
//   - Range-not-honored, range-mismatch, byte-count-mismatch,
//     integrity-failed → tag: "other" with descriptive message (spec
//     lines 73, 115, design.md collapse-to-other rule).
//
// Retry-loop contract (per design.md Decision 3):
//   - `MAX_AUTH_RETRIES = 1` per cycle (one cycle = one underlying HTTP
//     call). Consecutive auth-expired in the same cycle = dead refresh
//     token; surface as `auth-revoked`. Distinct cycles each carry
//     their own retry budget — multi-cycle long downloads are
//     unbounded.
//   - On auth-expired, read `fs.stat(toPath).size` to determine
//     `rangeStart`; the next `engine.downloadFile` call's withRefresh
//     wrapper refreshes the credential before issuing the new GET.
//
// Subscription scope. The reconciliation: tasks.md §13.22 says
// "service-bootstrap level"; user brief says "handler-local". The
// file-touch constraint forbids touching `bootstrap.ts`. The
// per-handler-call form satisfies the spec's invariant ("fs-sync
// subscribes to the engine bus for download lifecycle observation") —
// the subscription is taken when the handler runs, released in a
// `finally` when it completes. Multiple concurrent downloads each take
// their own subscription; the engine bus does its own
// 1-second-or-10-percentage-points coalescing.

import { randomUUID as nodeRandomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import * as nodeOs from "node:os";
import { pipeline as nodePipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

import type {
  DatasourceClient,
  DownloadOptions,
  DownloadResult,
  Target,
} from "@ft5/fs-datasource-engine";
import type {
  DatasourceFileEntry,
  DatasourceType,
} from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

import type { CommandHandler } from "../ipc/server.js";
import type { EventBus } from "../events/event-bus.js";
import type {
  DownloadRegistry,
  DownloadJobEntry,
} from "../downloads/registry.js";

import { normalizeFilesError } from "./files-error-mapping.js";
import {
  validateToPath,
  type PathValidatorDeps,
} from "../util/path-validator.js";

// ---------------------------------------------------------------------------
// Engine bus — minimal interface fs-sync subscribes to. The real engine
// bus comes from `@ft5/fs-datasource-engine`; the handler accepts the
// minimal subscribe surface so tests can drive a fake without wiring the
// full coalescer.
// ---------------------------------------------------------------------------

export interface EngineBusEvent {
  readonly event: string;
  readonly datasourceId: string;
  readonly streaming?: boolean;
  readonly payload: unknown;
}

export interface EngineBusSubscriber {
  subscribe(handler: (event: EngineBusEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Filesystem boundary — the handler injects these so tests do not have to
// touch the real disk. The default impl wraps `node:fs` / `node:fs/promises`.
// ---------------------------------------------------------------------------

export interface FsBoundary {
  /** Reject when not writable. Resolves on success. */
  access(path: string, mode: number): Promise<void>;
  /** Synchronous read of file size — used inside the auth-expired retry
   * branch to determine `rangeStart` from "what's already on disk". */
  statSize(path: string): Promise<number>;
  /** Open a write stream for the pipe. The handler picks `flags`
   * ("w" for fresh, "r+" for resume) per Decision 3 step 5. */
  createWriteStream(
    path: string,
    options: { flags: "w" | "r+"; start: number },
  ): NodeJS.WritableStream;
  /** Run a Node `pipeline` from the engine's Readable into the write
   * stream, with the AbortSignal threaded through. Returns when the
   * pipeline drains; rejects with AbortError if the signal fires. */
  pipeline(
    source: Readable,
    sink: NodeJS.WritableStream,
    signal: AbortSignal,
  ): Promise<void>;
  /** Remove the file at `path`. Used by the handler's outer terminal
   * catch (per add-download-resilience §4.6) to enforce the "Delete"
   * disposition for `DELETE_ON_TERMINAL` errors (range-not-honored,
   * range-mismatch, integrity-failed). Rejects if the path does not
   * exist or is not removable; the caller swallows that rejection
   * (delete-failure is non-fatal — the user can clean up manually). */
  unlink(path: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Hash computer — used for the post-download integrity check.
// ---------------------------------------------------------------------------

/**
 * Compute the named hash over the bytes at `path`. `algo` is the
 * provider-specific algorithm advertised in the strategy's metadata
 * (`md5` for Drive, `sha1` / `sha256` for OneDrive's
 * `sha1Hash` / `sha256Hash`, `etag-md5` for S3 single-part objects).
 * The handler emits `tag: "other", message: "integrity check failed"`
 * on mismatch (per spec.md collapse-to-other rule).
 *
 * Returns the digest as a lowercase hex string for direct comparison
 * with provider metadata (Drive's `md5Checksum`, S3's bare `ETag`).
 */
export type IntegrityAlgo = "md5" | "sha1" | "sha256";

export interface HashComputer {
  hashFile(path: string, algo: IntegrityAlgo): Promise<string>;
}

// ---------------------------------------------------------------------------
// Provider hash extractor — turns the strategy's `providerMetadata` into
// the hash comparison the handler runs. Returns `null` when the provider
// did not advertise a hash; the handler then skips the integrity check
// and emits a debug log (per §13.14).
// ---------------------------------------------------------------------------

export interface ProviderHash {
  readonly algo: IntegrityAlgo;
  readonly digest: string;
}

/**
 * Extract a comparable hash from `providerMetadata`. Pure function — no
 * side effects, no SDK calls. Returns `null` if no comparable hash is
 * present (skip-integrity path).
 *
 * - Drive: `md5Checksum` (advertised on the metadata `files.get` returns).
 * - OneDrive: `sha256Hash` is preferred when present, else `sha1Hash`.
 *   `quickXorHash` is OneDrive's bespoke algorithm and is NOT
 *   implementable in `node:crypto`; we treat it as "not advertised" and
 *   skip the check. See §13.14.
 * - S3: `ETag` is `md5` for single-part uploads (no dash). Multipart
 *   ETags include a `-N` part-count suffix (e.g. `"abc123-2"`); for
 *   those we cannot recompute md5 of the assembled object cheaply, so
 *   skip the check (§13.14).
 */
export function readProviderHash(
  providerMetadata: Readonly<Record<string, unknown>>,
): ProviderHash | null {
  const md5 = providerMetadata.md5Checksum;
  if (typeof md5 === "string" && md5.length > 0) {
    return { algo: "md5", digest: md5.toLowerCase() };
  }
  const sha256 = providerMetadata.sha256Hash;
  if (typeof sha256 === "string" && sha256.length > 0) {
    return { algo: "sha256", digest: sha256.toLowerCase() };
  }
  const sha1 = providerMetadata.sha1Hash;
  if (typeof sha1 === "string" && sha1.length > 0) {
    return { algo: "sha1", digest: sha1.toLowerCase() };
  }
  const etagRaw = providerMetadata.ETag ?? providerMetadata.etag;
  if (typeof etagRaw === "string") {
    // Strip surrounding quotes that S3 sometimes leaves on the value.
    const stripped = etagRaw.replace(/^"+|"+$/g, "");
    if (stripped.length > 0 && !stripped.includes("-")) {
      return { algo: "md5", digest: stripped.toLowerCase() };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Engine event → fs-sync IPC event transformer (per §13.25-§13.26)
// ---------------------------------------------------------------------------

/**
 * Transform an engine bus event payload into the fs-sync IPC event
 * payload. The two are NOT the same shape — engine events are
 * `(datasourceId, path)`-keyed and carry raw vendor facts; fs-sync
 * events are `downloadJobId`-keyed and carry business decoration.
 *
 * Pure — caller injects `downloadJobId` (resolved via the registry's
 * reverse index) and `savedPath` (the handler's pipe target). Used by
 * the bus subscription callback to drive `bus.emit(...)` AND testable
 * independently for the §13.25 "derived not relayed" assertion.
 */
export interface DownloadingEnginePayload {
  readonly path: string;
  readonly loaded: number;
  readonly total: number | null;
}
export interface FileDownloadedEnginePayload {
  readonly path: string;
  readonly bytes: number;
}
export interface DownloadCancelledEnginePayload {
  readonly path: string;
  readonly bytesDownloaded: number;
  readonly bytesTotal: number | null;
}

export function transformDownloadingEvent(
  enginePayload: DownloadingEnginePayload,
  ctx: { downloadJobId: string; datasourceId: string },
): {
  downloadJobId: string;
  datasourceId: string;
  progress: number;
  path: string;
} {
  const total = enginePayload.total;
  const progress =
    total !== null && total > 0
      ? Math.min(
          100,
          Math.max(0, Math.floor((enginePayload.loaded / total) * 100)),
        )
      : 0;
  return {
    downloadJobId: ctx.downloadJobId,
    datasourceId: ctx.datasourceId,
    progress,
    path: enginePayload.path,
  };
}

export function transformFileDownloadedEvent(
  enginePayload: FileDownloadedEnginePayload,
  ctx: {
    downloadJobId: string;
    datasourceId: string;
    savedPath: string;
    bytes: number;
  },
): {
  downloadJobId: string;
  datasourceId: string;
  savedPath: string;
  bytes: number;
} {
  return {
    downloadJobId: ctx.downloadJobId,
    datasourceId: ctx.datasourceId,
    savedPath: ctx.savedPath,
    bytes: ctx.bytes,
  };
}

export function transformDownloadCancelledEvent(
  enginePayload: DownloadCancelledEnginePayload,
  ctx: { downloadJobId: string; datasourceId: string },
): {
  downloadJobId: string;
  datasourceId: string;
  bytesDownloaded: number;
  bytesTotal: number | null;
  reason: "user";
} {
  return {
    downloadJobId: ctx.downloadJobId,
    datasourceId: ctx.datasourceId,
    bytesDownloaded: enginePayload.bytesDownloaded,
    bytesTotal: enginePayload.bytesTotal,
    reason: "user",
  };
}

// ---------------------------------------------------------------------------
// Handler dependency surface
// ---------------------------------------------------------------------------

export interface FilesDownloadDeps {
  readonly resolveClient: (
    datasourceId: string,
  ) => Promise<DatasourceClient<DatasourceType>>;
  readonly registry: DownloadRegistry;
  readonly fsSyncBus: EventBus;
  readonly engineBus: EngineBusSubscriber;
  readonly fs: FsBoundary;
  readonly hash: HashComputer;
  readonly randomUUID: () => string;
  readonly now: () => number;
  readonly homedir: () => string;
}

const MAX_AUTH_RETRIES_PER_CYCLE = 1;
const CONSECUTIVE_FAIL_LIMIT = 5;
const WALLTIME_CEILING_MS = 30 * 60 * 1000;

/**
 * Per-attempt request timeout (add-download-resilience §11.1, design.md
 * Decision 12). Each retry-cycle's `engine.downloadFile()` call is wrapped
 * with an `AbortController` whose `setTimeout(...).abort()` fires at this
 * deadline; the controller's signal is composed with the user-cancel
 * signal via `AbortSignal.any` and passed to the engine.
 *
 * On abort, the handler distinguishes user-cancel
 * (`abortController.signal.aborted === true`) from timeout
 * (`attemptCtrl.signal.aborted === true`) and, for timeouts, synthesizes
 * `DatasourceError({ tag: "network-error", retryable: true, message:
 * \`per-attempt timeout (${PER_ATTEMPT_TIMEOUT_MS}ms)\` })` so the existing
 * Layer 3 env-retry branch handles it identically to a real
 * `network-error`. Same `expBackoff(n)` schedule, same 5-attempt budget,
 * same byte-progress-strict reset (Decision 10).
 *
 * 60s is conservative — long enough for legitimate slow GETs (provider
 * hiccup); short enough to break a hung OS-level socket fast (the §9.4
 * smoke reproduced a Windows TCP timeout >5 minutes blocking the loop).
 */
const PER_ATTEMPT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Retry-loop helpers (add-download-resilience §2)
// ---------------------------------------------------------------------------

/**
 * Predicate gating the environmental retry layer (Layer 3 per design.md
 * Decision 8). Returns true iff the error is a `DatasourceError` whose
 * tag is in the strict allowlist `{network-error, rate-limited,
 * provider-error}`, the strategy marked it `retryable: true`, AND the
 * tag is not `auth-expired` (Layer 2's slot — never folded in).
 *
 * The four-clause AND is intentional. The `tag !== "auth-expired"` clause
 * is structurally redundant against the allowlist today, but it is a
 * defensive double-guard against future taxonomy expansion: if a strategy
 * ever marked an `auth-expired` instance retryable=true and a future
 * mapping accidentally added it to the allowlist, this guard still
 * routes it to Layer 2. See design.md Decision 2.
 *
 * Strategy bugs (a non-retryable tag marked retryable=true) flow through
 * to terminal because the allowlist excludes them. No extra logging in §2.
 */
export function isEnvironmentallyRetryable(
  err: unknown,
): err is DatasourceError {
  return (
    err instanceof DatasourceError &&
    err.tag !== "auth-expired" &&
    err.retryable === true &&
    (err.tag === "network-error" ||
      err.tag === "rate-limited" ||
      err.tag === "provider-error")
  );
}

/**
 * Exponential backoff schedule capped at 30 seconds. `attempt` is
 * 1-indexed (the first retry uses attempt=1 → 1000ms). Schedule:
 * 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... See design.md Decision 2.
 */
export function expBackoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

/**
 * Cancellable sleep. Resolves either when the timer fires or when
 * `signal` aborts — never rejects. On abort, clears the timer with
 * `clearTimeout` so no callback runs after. Safe to call with an
 * already-aborted signal (resolves on the next microtask without
 * scheduling a timer).
 *
 * Used by the handler's environmental-retry branch as the cancel-driven
 * sleep — `sync:cancel-download` aborts the controller, this resolves,
 * the inner loop exits with `CancelledError`. See design.md Decision 5.
 */
export function sleepCancellable(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      // Resolve on next microtask — no timer to schedule, nothing to clear.
      resolve();
      return;
    }
    let settled = false;
    const onDone = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => onDone();
    const timer: ReturnType<typeof setTimeout> = setTimeout(onDone, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Default dependency bundle — wraps `node:` modules. Tests build their
 * own deps from in-memory fakes, never reaching the host filesystem.
 */
export function createDefaultFilesDownloadDeps(deps: {
  resolveClient: FilesDownloadDeps["resolveClient"];
  registry: DownloadRegistry;
  fsSyncBus: EventBus;
  engineBus: EngineBusSubscriber;
  hash: HashComputer;
}): FilesDownloadDeps {
  const fsBoundary: FsBoundary = {
    access: (path, mode) => nodeFsPromises.access(path, mode),
    statSize: async (path) => (await nodeFsPromises.stat(path)).size,
    createWriteStream: (path, options) =>
      nodeFs.createWriteStream(path, options),
    pipeline: (source, sink, signal) => nodePipeline(source, sink, { signal }),
    unlink: (path) => nodeFsPromises.unlink(path),
  };
  return {
    ...deps,
    fs: fsBoundary,
    randomUUID: () => nodeRandomUUID(),
    now: () => Date.now(),
    homedir: () => nodeOs.homedir(),
  };
}

// ---------------------------------------------------------------------------
// Path-validator binding — the validator's `canWrite` boundary lives
// here so tests inject a fake `fs.access`-equivalent.
// ---------------------------------------------------------------------------

function makeValidatorDeps(deps: FilesDownloadDeps): PathValidatorDeps {
  return {
    canWrite: async (path) => {
      try {
        await deps.fs.access(path, nodeFs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    homedir: deps.homedir,
  };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function makeFilesDownloadHandler(
  deps: FilesDownloadDeps,
): CommandHandler<"files:download"> {
  return async (params) => {
    // 1. toPath validation — synchronous + one async access probe; on
    // failure, short-circuit with the exact-message tag-other envelope
    // that the spec scenarios assert on (lines 117 / 122 / 127 / 132).
    const validation = await validateToPath(
      params.toPath,
      makeValidatorDeps(deps),
    );
    if (!validation.ok) {
      return {
        ok: false,
        error: {
          tag: "other",
          message: `toPath validation: ${validation.reason}`,
          retryable: false,
        },
      };
    }

    // 2. Concurrent-rejection guard. Spec line 248 — reject the SECOND
    // request for an in-flight `(datasourceId, sourcePath)` BEFORE
    // resolving the engine client / minting a job id / opening any
    // provider request.
    if (
      deps.registry.findByKey(params.datasourceId, params.path) !== undefined
    ) {
      return {
        ok: false,
        error: {
          tag: "other",
          message: "download already in progress for this entry",
          retryable: false,
        },
      };
    }

    // 3. Resolve client. Failure (e.g. unknown datasourceId) maps via
    // the existing normalizeFilesError convention.
    let client: DatasourceClient<DatasourceType>;
    try {
      client = await deps.resolveClient(params.datasourceId);
    } catch (err) {
      return { ok: false, error: normalizeFilesError(err) };
    }

    // 4. Mint job + create AbortController + insert registry entry.
    const downloadJobId = deps.randomUUID();
    const abortController = new AbortController();
    const startedAt = deps.now();
    const initialEntry: DownloadJobEntry = {
      downloadJobId,
      datasourceId: params.datasourceId,
      sourcePath: params.path,
      targetPath: params.toPath,
      bytesDownloaded: 0,
      contentLength: null,
      startedAt,
      abortController,
    };
    deps.registry.set(initialEntry);

    // 5. Engine-bus subscription — handler-local lifetime. Drives the
    // §13.25-§13.26 derived-not-relayed IPC event emission for the four
    // download lifecycle events. Reverse-index lookup correlates engine
    // `(datasourceId, path)` to fs-sync's `downloadJobId`.
    //
    // `inflightId.current` lets the callback distinguish events for THIS
    // download from a re-claimed (datasourceId, path) after the entry
    // was removed. Declared as a ref so the closure observes its mutation
    // when the handler clears it on terminal.
    const inflightId: { current: string | null } = { current: downloadJobId };
    const unsubscribe = deps.engineBus.subscribe((event) => {
      if (event.datasourceId !== params.datasourceId) return;
      const payload = event.payload as { path?: string };
      if (payload.path !== params.path) return;
      const id = deps.registry.findByKey(
        params.datasourceId,
        params.path,
      );
      if (id !== inflightId.current) return;
      switch (event.event) {
        case "downloading": {
          const ep = event.payload as DownloadingEnginePayload;
          // Update registry from the bus stream too — it is throttled by
          // the engine bus's 1s/10pct coalescer, so writes are bounded.
          deps.registry.update(id, {
            bytesDownloaded: ep.loaded,
            contentLength: ep.total,
          });
          deps.fsSyncBus.emit(
            "downloading",
            transformDownloadingEvent(ep, {
              downloadJobId: id,
              datasourceId: params.datasourceId,
            }),
          );
          break;
        }
        // file-downloaded / download-failed / download-cancelled are
        // emitted from the synchronous code path below — the bus
        // subscription's role for terminals is observation. Emitting
        // from both would double-emit; the synchronous path is
        // authoritative because it has access to the post-pipe
        // savedPath / bytes / integrity-check decision the engine bus
        // does not.
        default:
          break;
      }
    });

    // 6. Retry loop (per design.md Decision 3 pseudocode + add-download-
    // resilience §4 environmental-retry layer). Each outer iteration runs
    // one HTTP cycle; auth-expired retries within a cycle are bounded by
    // `MAX_AUTH_RETRIES_PER_CYCLE` (Layer 2). Environmental retries
    // (network / rate-limited / provider-error) are bounded across the
    // whole download lifetime by `consecutiveFailureCount` (Layer 3).
    let bytesWritten = 0;
    let cycle = 0;
    let providerHash: ProviderHash | null = null;
    let finalContentLength: number | null = null;
    let finalEntryForHash: DatasourceFileEntry<DatasourceType> | null = null;

    // §4.1 — closure-scoped state for Layer 3 (environmental retry).
    // `consecutiveFailureCount` resets on byte-progress (Decision 10);
    // `walltimeStartedAt` is captured BEFORE the outer cycle loop so it
    // covers the entire download lifetime (Decision 1).
    let consecutiveFailureCount = 0;
    const walltimeStartedAt = deps.now();

    const target: Target = { kind: "path", path: params.path };

    try {
      // Outer loop: each iteration runs one HTTP cycle. The handler
      // breaks when the pipe drains AND `bytesWritten === contentLength`.
      while (true) {
        cycle++;
        let attemptInCycle = 0;
        let cycleSucceeded = false;
        while (!cycleSucceeded) {
          // Pre-cycle sync-up of bytesWritten from disk after the first
          // cycle so a partial-write disk state stays the source of
          // truth for resume.
          if (cycle > 1) {
            bytesWritten = await deps.fs.statSize(params.toPath);
          }
          // §4.3 — capture bytesWrittenBefore so the post-pipe check
          // can compare against it for the byte-progress reset rule.
          // Captured here (per attempt) so it covers BOTH:
          //   1. The successful-pipe reset after the inner try block.
          //   2. The env-retry branch's reset on partial mid-stream
          //      progress (the disk grew vs. before, mid-stream throw).
          const bytesWrittenBefore = bytesWritten;
          // §11.2 (Decision 12) — per-attempt request timeout. The
          // controller's setTimeout fires at PER_ATTEMPT_TIMEOUT_MS; the
          // composed signal is `(user-cancel) OR (per-attempt timeout)`.
          // Engines accept the composed signal at their AbortSignal
          // boundary (Decision 8 — no engine changes). The timer is
          // cleared on every exit path via `finally`.
          const attemptCtrl = new AbortController();
          const attemptTimeoutHandle = setTimeout(
            () => attemptCtrl.abort(),
            PER_ATTEMPT_TIMEOUT_MS,
          );
          const composedSignal = AbortSignal.any([
            abortController.signal,
            attemptCtrl.signal,
          ]);
          const options: DownloadOptions = {
            rangeStart: bytesWritten,
            signal: composedSignal,
            onProgress: (loaded, total) => {
              // Inline, low-overhead path: update registry every tick.
              // The engine-bus subscription path also updates the
              // registry but is throttled; both converge so the latest
              // wins regardless of arrival order.
              deps.registry.update(downloadJobId, {
                bytesDownloaded: bytesWritten + loaded,
                contentLength: total !== null ? total : null,
              });
            },
          };
          let result: DownloadResult;
          try {
            try {
              result = await client.downloadFile(target, options);
            } finally {
              // §11.2 — clear on success, error, AND cancel exit paths.
              clearTimeout(attemptTimeoutHandle);
            }
          } catch (err) {
            // Pre-stream failure (the GET itself rejected, after
            // withRefresh's one-shot retry inside the engine).
            //
            // §11.3 — distinguish three cases:
            //   1. User-cancel — `abortController.signal.aborted` is
            //      checked FIRST so it always wins over a coincident
            //      timeout. Existing CancelledError → terminal cancel.
            //   2. Per-attempt timeout — `attemptCtrl.signal.aborted` is
            //      true and user-cancel is not. Synthesize a
            //      DatasourceError({ tag: "network-error", retryable:
            //      true }) and route into Layer 3 env-retry below — a
            //      hung GET IS an environmental failure (Decision 12).
            //   3. Otherwise — re-throw untouched (auth-expired /
            //      auth-revoked / strategy-mapped tags propagate to the
            //      outer terminal catch via normalizeFilesError).
            if (
              abortController.signal.aborted ||
              (err instanceof DatasourceError && err.tag === "cancelled")
            ) {
              throw new CancelledError();
            }
            let routedErr: unknown = err;
            if (
              attemptCtrl.signal.aborted ||
              (err instanceof Error && err.name === "AbortError")
            ) {
              // Timeout (or an AbortError when neither user-cancel nor
              // attempt-timeout is the cause — defensive: treat as
              // timeout since something the handler owns aborted the
              // call). Synthesize so Layer 3 env-retry handles it.
              routedErr = new DatasourceError({
                tag: "network-error",
                datasourceType: client.type,
                datasourceId: params.datasourceId,
                retryable: true,
                message: `per-attempt timeout (${PER_ATTEMPT_TIMEOUT_MS}ms)`,
              });
            }
            // §11.3 — route an env-retryable pre-stream error (real or
            // synthesized) into the same Layer 3 logic as the mid-stream
            // catch. Without this branch, a synthesized timeout would
            // flow to the outer terminal catch and emit
            // download-failed { tag: "network-error" } instead of
            // download-retrying — defeating the fix.
            if (isEnvironmentallyRetryable(routedErr)) {
              const bytesWrittenAfter = await deps.fs.statSize(
                params.toPath,
              ).catch(() => bytesWrittenBefore);
              if (bytesWrittenAfter > bytesWrittenBefore) {
                consecutiveFailureCount = 0;
              }
              consecutiveFailureCount++;
              const engineCause = routedErr.tag;
              if (consecutiveFailureCount > CONSECUTIVE_FAIL_LIMIT) {
                throw new ExhaustedRetriesError(engineCause);
              }
              const elapsed = deps.now() - walltimeStartedAt;
              if (elapsed > WALLTIME_CEILING_MS) {
                throw new WalltimeExceededError(engineCause);
              }
              const retryAfter = routedErr.retryAfterMs ?? 0;
              const wait = Math.max(
                retryAfter,
                expBackoff(consecutiveFailureCount),
              );
              if (wait > WALLTIME_CEILING_MS - elapsed) {
                throw new WalltimeExceededError(engineCause);
              }
              deps.fsSyncBus.emit("download-retrying", {
                downloadJobId,
                datasourceId: params.datasourceId,
                attempt: consecutiveFailureCount,
                limit: CONSECUTIVE_FAIL_LIMIT,
                waitMs: wait,
                engineCause,
              });
              await sleepCancellable(wait, abortController.signal);
              if (abortController.signal.aborted) {
                throw new CancelledError();
              }
              bytesWritten = await deps.fs
                .statSize(params.toPath)
                .catch(() => bytesWritten);
              continue;
            }
            // Anything else (auth-expired / auth-revoked / non-retryable
            // strategy-mapped tags) propagates to the outer catch;
            // `normalizeFilesError` collapses both auth tags onto wire
            // `tag: "auth-revoked"` (see files-error-mapping.ts).
            // Auth-expired here means the engine's withRefresh tried
            // and the post-refresh GET still came back auth-expired —
            // the refresh token is dead.
            throw routedErr;
          }

          // Validate the response against `rangeStart` (Decision 3
          // safeguards). Skip on cycle 1 (rangeStart === 0) — the
          // engine returns 200 OK without contentRange.
          if (bytesWritten > 0) {
            if (result.contentRange === undefined) {
              // Range-not-honored: provider ignored the Range header.
              throw new RangeNotHonoredError();
            }
            if (result.contentRange.start !== bytesWritten) {
              throw new RangeMismatchError();
            }
          }
          finalContentLength = result.contentLength;

          // Pipe the stream to disk. `flags: "r+"` requires the file
          // to already exist (it does — cycle 1 created it with "w").
          const flags: "w" | "r+" = bytesWritten === 0 ? "w" : "r+";
          const sink = deps.fs.createWriteStream(params.toPath, {
            flags,
            start: bytesWritten,
          });
          try {
            await deps.fs.pipeline(
              result.stream,
              sink,
              abortController.signal,
            );
          } catch (err) {
            if (abortController.signal.aborted) {
              throw new CancelledError();
            }
            // Mid-stream failure. Decide: auth-expired retry within
            // this cycle's budget (Layer 2), environmental retry
            // (Layer 3), OR escalate.
            if (
              err instanceof DatasourceError &&
              err.tag === "auth-expired" &&
              attemptInCycle < MAX_AUTH_RETRIES_PER_CYCLE
            ) {
              attemptInCycle++;
              // Update bytesWritten from disk before the retry.
              bytesWritten = await deps.fs.statSize(params.toPath);
              // Stay inside the inner loop — issue a fresh
              // engine.downloadFile with rangeStart = bytesWritten.
              continue;
            }
            // §4.2 — Layer 3 (environmental retry). Disjoint from
            // Layer 2 (auth-expired) per Decision 8: this branch is
            // reached only when isEnvironmentallyRetryable returns
            // true, which excludes auth-expired by construction.
            if (isEnvironmentallyRetryable(err)) {
              // Re-stat the disk so byte-progress check sees current
              // state (a mid-stream partial write counts as progress).
              const bytesWrittenAfter = await deps.fs.statSize(
                params.toPath,
              );
              // Decision 10: reset env count ONLY on byte progress
              // strictly greater than the iteration's start.
              if (bytesWrittenAfter > bytesWrittenBefore) {
                consecutiveFailureCount = 0;
              }
              consecutiveFailureCount++;
              const engineCause = err.tag;
              // (b) Count-budget exhaustion.
              if (consecutiveFailureCount > CONSECUTIVE_FAIL_LIMIT) {
                throw new ExhaustedRetriesError(engineCause);
              }
              // (c) Walltime ceiling already exceeded.
              const elapsed = deps.now() - walltimeStartedAt;
              if (elapsed > WALLTIME_CEILING_MS) {
                throw new WalltimeExceededError(engineCause);
              }
              // (d) Wait formula: max(retryAfterMs, expBackoff(n)).
              const retryAfter = err.retryAfterMs ?? 0;
              const wait = Math.max(
                retryAfter,
                expBackoff(consecutiveFailureCount),
              );
              // (e) The chosen sleep would overshoot the ceiling.
              if (wait > WALLTIME_CEILING_MS - elapsed) {
                throw new WalltimeExceededError(engineCause);
              }
              // (f) Emit `download-retrying` BEFORE the sleep so the
              // renderer's toast switches to "Reconnecting…" subtext
              // synchronously (Decision 5).
              deps.fsSyncBus.emit("download-retrying", {
                downloadJobId,
                datasourceId: params.datasourceId,
                attempt: consecutiveFailureCount,
                limit: CONSECUTIVE_FAIL_LIMIT,
                waitMs: wait,
                engineCause,
              });
              // (g) Cancellable sleep — `sync:cancel-download` aborts
              // the controller, the sleep resolves, the next-iteration
              // top of inner loop re-checks aborted state.
              await sleepCancellable(wait, abortController.signal);
              if (abortController.signal.aborted) {
                throw new CancelledError();
              }
              // (h) Re-stat bytesWritten from disk (a slow partial
              // write that arrived during the sleep would shift this).
              bytesWritten = await deps.fs.statSize(params.toPath);
              // (i) continue the inner loop.
              continue;
            }
            // Unrecoverable: re-throw to the outer catch which emits
            // download-failed.
            throw err;
          }

          // Pipe drained cleanly. Re-stat so the byte-count assertion
          // sees on-disk reality (not the in-memory counter).
          bytesWritten = await deps.fs.statSize(params.toPath);
          if (
            finalContentLength !== null &&
            bytesWritten !== finalContentLength
          ) {
            // Provider promised N bytes; we wrote M ≠ N. Terminal
            // failure (spec line 178). Don't retry — fresh re-pipe
            // would not change the outcome.
            throw new ByteCountMismatchError();
          }
          // §4.3 — byte-progress-strict counter reset (Decision 10).
          // After a successful pipe drain, if the disk grew vs. the
          // start of the iteration, reset the env-retry budget. The
          // env-retry branch above does its own reset on mid-stream
          // partial progress — this covers the all-good-no-error path.
          if (bytesWritten > bytesWrittenBefore) {
            consecutiveFailureCount = 0;
          }
          cycleSucceeded = true;
        }
        // Cycle done. Either we have all bytes (success) or this was a
        // cycle with no contentLength advertised — in that case we
        // trust the stream-end signal and exit.
        if (
          finalContentLength === null ||
          bytesWritten === finalContentLength
        ) {
          break;
        }
        // Partial — start a fresh cycle. (Should not happen with the
        // current strategies; placeholder for future split-into-cycles.)
      }

      // 7. Post-download integrity check. Pull provider metadata if the
      // strategy did not include the hash on the download response. (No
      // current strategy does; metadata is the canonical source.)
      try {
        finalEntryForHash = await client.getMetadata(target);
        providerHash = readProviderHash(finalEntryForHash.providerMetadata);
      } catch {
        // Metadata fetch failure post-pipe is treated as integrity-
        // unverifiable — proceed without the check (spec.md "Skip the
        // integrity check when the provider does not advertise a hash").
        providerHash = null;
      }
      if (providerHash !== null) {
        const localDigest = await deps.hash.hashFile(
          params.toPath,
          providerHash.algo,
        );
        if (localDigest.toLowerCase() !== providerHash.digest) {
          throw new IntegrityFailedError();
        }
      }
    } catch (err) {
      // Terminal — figure out which event to emit.
      const datasourceId = params.datasourceId;
      try {
        if (err instanceof CancelledError || abortController.signal.aborted) {
          // Read final byte count from the registry (the onProgress
          // callback's last value is more accurate than the engine
          // bus's throttled value).
          const last = deps.registry.get(downloadJobId);
          const bytesDownloaded = last?.bytesDownloaded ?? bytesWritten;
          const bytesTotal = last?.contentLength ?? finalContentLength;
          deps.fsSyncBus.emit("download-cancelled", {
            downloadJobId,
            datasourceId,
            bytesDownloaded,
            bytesTotal,
            reason: "user",
          });
          return {
            ok: false,
            error: {
              tag: "cancelled",
              message: "download cancelled",
              retryable: false,
            },
          };
        }
        // §4.6 — Disposition policy (Decision 6). Before any terminal
        // `download-failed` emission, delete the partial on disk if the
        // error class is in `DELETE_ON_TERMINAL`. The unlink runs
        // BEFORE the bus emit so a renderer subscribing to
        // `download-failed` and inspecting disk sees the consistent
        // post-disposition state. Failure is non-fatal — logged-warn
        // and the user may clean up manually.
        if (
          err !== null &&
          typeof err === "object" &&
          DELETE_ON_TERMINAL.has(
            (err as { constructor: ErrorConstructor }).constructor,
          )
        ) {
          await deps.fs.unlink(params.toPath).catch((unlinkErr) => {
            console.warn(
              `[files-download] unlink(${params.toPath}) failed after terminal ${(err as Error).name}:`,
              unlinkErr,
            );
          });
        }
        if (err instanceof RangeNotHonoredError) {
          deps.fsSyncBus.emit("download-failed", {
            downloadJobId,
            datasourceId,
            tag: "other",
            message: "range not supported on this resource",
          });
          return {
            ok: false,
            error: {
              tag: "other",
              message: "range not supported on this resource",
              retryable: false,
            },
          };
        }
        if (err instanceof RangeMismatchError) {
          deps.fsSyncBus.emit("download-failed", {
            downloadJobId,
            datasourceId,
            tag: "other",
            message: "range mismatch on this resource",
          });
          return {
            ok: false,
            error: {
              tag: "other",
              message: "range mismatch on this resource",
              retryable: false,
            },
          };
        }
        if (err instanceof ByteCountMismatchError) {
          deps.fsSyncBus.emit("download-failed", {
            downloadJobId,
            datasourceId,
            tag: "other",
            message: "byte count mismatch",
          });
          return {
            ok: false,
            error: {
              tag: "other",
              message: "byte count mismatch",
              retryable: false,
            },
          };
        }
        if (err instanceof IntegrityFailedError) {
          deps.fsSyncBus.emit("download-failed", {
            downloadJobId,
            datasourceId,
            tag: "other",
            message: "integrity check failed",
          });
          return {
            ok: false,
            error: {
              tag: "other",
              message: "integrity check failed",
              retryable: false,
            },
          };
        }
        // §4.5 — Environmental-retry budget exhaustion. Both
        // `ExhaustedRetriesError` and `WalltimeExceededError` collapse
        // to wire `tag: "exhausted-retries"` (Decision 7); the
        // discriminator lives in the message.
        if (err instanceof ExhaustedRetriesError) {
          const message = `exhausted-retries: ${err.engineCause}`;
          deps.fsSyncBus.emit("download-failed", {
            downloadJobId,
            datasourceId,
            tag: "exhausted-retries",
            message,
          });
          return {
            ok: false,
            error: {
              tag: "exhausted-retries",
              message,
              retryable: true,
            },
          };
        }
        if (err instanceof WalltimeExceededError) {
          const message = `walltime-exceeded: ${err.engineCause}`;
          deps.fsSyncBus.emit("download-failed", {
            downloadJobId,
            datasourceId,
            tag: "exhausted-retries",
            message,
          });
          return {
            ok: false,
            error: {
              tag: "exhausted-retries",
              message,
              retryable: true,
            },
          };
        }
        // Generic engine error.
        const norm = normalizeFilesError(err);
        deps.fsSyncBus.emit("download-failed", {
          downloadJobId,
          datasourceId,
          tag: norm.tag === "conflict" || norm.tag === "cancelled"
            ? "other"
            : norm.tag,
          message: norm.message,
        });
        return { ok: false, error: norm };
      } finally {
        deps.registry.delete(downloadJobId);
        inflightId.current = null;
        unsubscribe();
      }
    }

    // Success path. Emit terminal `file-downloaded` event with the
    // post-pipe savedPath + verified byte count. Per §13.25-§13.26 this
    // is fs-sync's downloadJobId-keyed shape (not a relay of the engine
    // bus's `(datasourceId, path)` shape).
    deps.fsSyncBus.emit("file-downloaded", {
      downloadJobId,
      datasourceId: params.datasourceId,
      savedPath: params.toPath,
      bytes: bytesWritten,
    });
    deps.registry.delete(downloadJobId);
    inflightId.current = null;
    unsubscribe();
    return {
      ok: true,
      result: { savedPath: params.toPath, bytes: bytesWritten },
    };
  };
}

// ---------------------------------------------------------------------------
// Cancel handler — `sync:cancel-download`. Idempotent: cancel of an
// unknown / already-terminal job resolves with `cancelled: false`.
// ---------------------------------------------------------------------------

export interface SyncCancelDownloadDeps {
  readonly registry: DownloadRegistry;
}

export function makeSyncCancelDownloadHandler(
  deps: SyncCancelDownloadDeps,
): CommandHandler<"sync:cancel-download"> {
  return async (params) => {
    const entry = deps.registry.get(params.downloadJobId);
    if (entry === undefined) {
      return { ok: true, result: { cancelled: false } };
    }
    entry.abortController.abort();
    return { ok: true, result: { cancelled: true } };
  };
}

// ---------------------------------------------------------------------------
// Sentinel error classes — used inside this module to disambiguate the
// four collapse-to-other branches. Exported so tests can pin disposition
// membership (`DELETE_ON_TERMINAL`) and so future §4 integration work in
// the outer terminal catch can match `err.constructor` without
// stringly-typed name comparisons.
// ---------------------------------------------------------------------------

class CancelledError extends Error {
  constructor() {
    super("download cancelled");
    this.name = "CancelledError";
  }
}
export class RangeNotHonoredError extends Error {
  constructor() {
    super("range not supported on this resource");
    this.name = "RangeNotHonoredError";
  }
}
export class RangeMismatchError extends Error {
  constructor() {
    super("range mismatch on this resource");
    this.name = "RangeMismatchError";
  }
}
export class ByteCountMismatchError extends Error {
  constructor() {
    super("byte count mismatch");
    this.name = "ByteCountMismatchError";
  }
}
export class IntegrityFailedError extends Error {
  constructor() {
    super("integrity check failed");
    this.name = "IntegrityFailedError";
  }
}

/**
 * Terminal sentinel for the environmental-retry budget being exhausted by
 * `consecutiveFailureCount > CONSECUTIVE_FAIL_LIMIT` (per design.md
 * Decision 1). Outer terminal catch maps to the wire `download-failed`
 * with `tag: "exhausted-retries"` and message
 * `"exhausted-retries: <engineCause>"`.
 */
export class ExhaustedRetriesError extends Error {
  /** Engine-side error tag of the last failed attempt — diagnostic-only
   * (per Decision 9), surfaced through the message and the
   * `download-retrying.engineCause` payload. */
  public readonly engineCause: string;
  constructor(engineCause: string) {
    super(`exhausted retries: ${engineCause}`);
    this.name = "ExhaustedRetriesError";
    this.engineCause = engineCause;
  }
}

/**
 * Terminal sentinel for the wall-time ceiling being exceeded — either at
 * the pre-sleep check (`now() - walltimeStartedAt > WALLTIME_CEILING_MS`)
 * or because the chosen wait would overshoot the remaining ceiling
 * budget. Outer terminal catch maps to wire `download-failed` with
 * `tag: "exhausted-retries"` and message `"walltime-exceeded: <engineCause>"`.
 *
 * Both `ExhaustedRetriesError` and `WalltimeExceededError` collapse to
 * the same wire tag (per Decision 7) — the message field carries the
 * discriminator.
 */
export class WalltimeExceededError extends Error {
  public readonly engineCause: string;
  constructor(engineCause: string) {
    super(`walltime exceeded: ${engineCause}`);
    this.name = "WalltimeExceededError";
    this.engineCause = engineCause;
  }
}

// ---------------------------------------------------------------------------
// Disposition policy — terminal causes that delete the on-disk partial
// (per add-download-resilience design.md Decision 6).
//
// | Terminal cause          | Disposition |
// |-------------------------|-------------|
// | Environmental exhausted | Keep        |
// | Wall-time ceiling       | Keep        |
// | auth-revoked            | Keep        |
// | User cancellation       | Keep        |
// | Byte-count-mismatch     | Keep        |  ← preserve bandwidth investment
// | Range-not-honored       | DELETE      |
// | Range-mismatch          | DELETE      |
// | Integrity-failed        | DELETE      |
//
// The handler's outer terminal catch (§4.6) tests `err.constructor` against
// this set before emitting `download-failed`; matches trigger
// `deps.fs.unlink(toPath)` (failure swallowed). Membership invariants are
// pinned by the §3.3 unit test — three classes, ByteCountMismatchError
// explicitly excluded.
// ---------------------------------------------------------------------------

type ErrorConstructor = new (...args: never[]) => Error;

export const DELETE_ON_TERMINAL: ReadonlySet<ErrorConstructor> =
  new Set<ErrorConstructor>([
    RangeNotHonoredError,
    RangeMismatchError,
    IntegrityFailedError,
  ]);
