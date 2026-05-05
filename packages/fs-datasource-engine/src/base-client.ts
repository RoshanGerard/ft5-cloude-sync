// BaseDatasourceClient — the Template base for every datasource strategy.
//
// Every public operation on a `DatasourceClient<T>` is implemented ONCE here.
// Concrete strategies (S3, OneDrive, Google Drive) extend this class and
// implement only the `protected abstract doX(...)` primitives plus
// `refreshToken()` and `normalizeError()`.
//
// Crossing-cutting responsibilities centralised here:
//   1. Event emission for `deleteFile`, `rename`, `downloadFile` (pre-op,
//      post-op, failure) via the injected `EventBus`. `uploadFile` is
//      EXEMPT — per migrate-upload-orchestration-out-of-engine, the engine
//      bus does not carry upload lifecycle events; those are emitted by
//      the fs-sync service handler on `sync:event-stream`.
//   2. Single-flight token refresh on `auth-expired` per-instance: one refresh
//      serves all concurrent callers; refreshed credentials are persisted via
//      `CredentialStore.put` BEFORE the original operation is retried.
//   3. Error normalization: raw provider exceptions are converted into
//      `DatasourceError<T>` by the strategy's `normalizeError` before they
//      cross the base's boundary.
//
// Strategies MUST NOT emit events directly (a contract test enforces this).
// Strategies MUST NOT re-enter the base's retry logic from `refreshToken`
// (see Decision 7 / Risks in design.md — `refreshToken` is the critical
// section of the mutex).
//
// Note: If `CredentialStore.put` rejects inside the refresh cycle (e.g., disk
// full, keychain unavailable), the rejection is routed through the
// refresh-failed path — callers observe `DatasourceError.AuthExpired` plus
// `token-expired` / `authentication-failed` events, not a distinct storage
// error. Host implementations of `CredentialStore` SHOULD surface storage
// failures via their own logging / telemetry so the root cause is debuggable.
// A future phase may introduce a dedicated `storage-error` tag.

import type {
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  DatasourceEvent,
  DatasourceStatus,
  DatasourceType,
  DatasourceFileEntry,
  FileMetadata,
  OAuthIntent,
  PayloadMap,
  ProviderDescriptor,
  Quota,
  StoredCredentials,
  Target,
} from "@ft5/ipc-contracts";
import { DatasourceError, serializeDatasourceError } from "@ft5/ipc-contracts";

import type { Readable } from "node:stream";

import type { CredentialStore } from "./credential-store.js";
import type { EventBus } from "./event-bus.js";

// Re-export the port so callers that were already importing `CredentialStore`
// from "./base-client.js" keep compiling during the move. The canonical
// source of truth is `./credential-store.js` (Phase 4.1). The top-level
// package entrypoint `src/index.ts` exports `CredentialStore` directly from
// `./credential-store.js`, so public consumers are unaffected by the
// relocation.
export type { CredentialStore } from "./credential-store.js";

// ---------------------------------------------------------------------------
// Public port: DatasourceClient Strategy interface
// ---------------------------------------------------------------------------

/**
 * Rename conflict-resolution policy (per add-engine-rename-download
 * design.md Decision 1 + Decision 7). The wire-level rename request type
 * (`FilesRenameRequest.conflictPolicy`) inlines this same union — the
 * engine-local alias here gives the strategy interface a named,
 * documented surface and keeps the `rename` signature self-explanatory
 * at the call site. Distinct from sync-service's upload `ConflictPolicy`
 * (`"overwrite" | "duplicate" | "skip"`) — rename has different semantics
 * (`"fail"` surfaces a `tag: "conflict"` error so the renderer can
 * re-prompt; `"keep-both"` auto-suffixes; `"overwrite"` replaces the
 * colliding sibling on a file or refuses with `tag: "unsupported"` on a
 * directory).
 */
export type ConflictPolicy = "fail" | "overwrite" | "keep-both";

/**
 * Options accepted by `downloadFile` (per add-engine-rename-download
 * design.md Decision 3). Each call is a one-shot HTTP primitive — the
 * engine forwards these options unchanged to the strategy's
 * `doDownloadFileImpl` and does NOT carry per-download state across calls.
 *
 * - `rangeStart` (optional): when set, the strategy attaches
 *   `Range: bytes=<rangeStart>-` to the provider request. fs-sync uses
 *   this to resume after a mid-stream auth-expired or network error
 *   (per Decision 3's handler retry loop).
 * - `signal` (optional): consumer-supplied AbortSignal. The strategy
 *   threads it into the underlying SDK / fetch so an abort propagates
 *   to the in-flight provider request and the returned stream errors
 *   with AbortError. The base distinguishes AbortError / `tag:
 *   "cancelled"` from other failures and routes terminal emission to
 *   `download-cancelled` rather than `download-failed`.
 * - `onProgress` (optional): synchronous consumer callback fired from
 *   the strategy's byte-counting hook. Per design.md, the SAME hook
 *   that calls `onProgress` ALSO calls the base's
 *   `protected emitDownloading(...)` helper so the bus and the
 *   consumer callback observe the same byte-flow source.
 */
export interface DownloadOptions {
  rangeStart?: number;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number | null) => void;
}

/**
 * Result of `downloadFile`. The engine returns the raw stream and
 * metadata unchanged; consumers (fs-sync) own the pipe-to-disk step.
 *
 * - `stream`: the provider response body as a Node `Readable`.
 * - `contentLength`: total bytes the provider advertises in the response,
 *   or `null` when the provider does not advertise a length (rare on
 *   `GetObject` / `files.get`; possible on Graph chunked responses).
 * - `contentRange`: present iff the provider returned 206 Partial Content
 *   in response to a `Range:` request. fs-sync's retry loop validates
 *   `contentRange.start === rangeStart` before resuming the local pipe
 *   (Decision 3's range-not-honored safeguard).
 */
export interface DownloadResult {
  stream: Readable;
  contentLength: number | null;
  contentRange?: { start: number; end: number; total: number };
}

/**
 * The engine's public Strategy surface. Consumers program against this
 * interface — not against concrete client classes.
 */
export interface DatasourceClient<T extends DatasourceType> {
  readonly type: T;
  readonly datasourceId: string;
  status(): Promise<DatasourceStatus>;
  testConnection(): Promise<void>;
  authenticate(): Promise<AuthIntent>;
  listDirectory(target: Target): Promise<DatasourceFileEntry<T>[]>;
  search(query: string, scope?: Target): Promise<DatasourceFileEntry<T>[]>;
  getMetadata(target: Target): Promise<FileMetadata<T>>;
  /**
   * Upload a local file to the parent target as a one-shot stateless
   * primitive (per migrate-upload-orchestration-out-of-engine). The base
   * wraps `doUploadFileImpl` with `withRefresh` and returns the strategy's
   * resolved entry directly. The engine bus observes ZERO upload-related
   * events from this code path — `uploading`, `file-created`,
   * `upload-failed`, and `upload-cancelled` are emitted by the fs-sync
   * service handler on `sync:event-stream`, not on the engine bus.
   *
   * Cancellation is consumer-driven via `options.signal`: the strategy
   * forwards the signal into its underlying SDK / fetch call and runs
   * provider-native cleanup (DELETE session URL on Drive/OneDrive,
   * `upload.abort()` on S3) from an `'abort'` listener registered on the
   * signal. On abort, the strategy throws
   * `DatasourceError<T>{ tag: "cancelled", retryable: false }`.
   *
   * Progress is consumer-observed via `options.onProgress(loaded, total)`
   * — the strategy invokes the callback as bytes flow.
   */
  uploadFile(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    options?: {
      signal?: AbortSignal;
      onProgress?: (loaded: number, total: number) => void;
    },
  ): Promise<DatasourceFileEntry<T>>;
  deleteFile(target: Target): Promise<void>;
  deleteDirectory(target: Target): Promise<never>;
  /**
   * Rename `target` to `newName` per `conflictPolicy` (per
   * add-engine-rename-download spec). The base wraps the strategy's
   * `doRenameImpl` with the existing `withRefresh` machinery and emits
   * exactly one `entry-renamed { from, to }` event on success or one
   * `delete-failed { tag, message, via: "rename" }` on failure.
   * Per-policy orchestration (sibling-detection, suffix-retry,
   * directory-overwrite refusal) lives inside each strategy's
   * `doRenameImpl` since the introspection is provider-specific —
   * the base only delegates by passing `conflictPolicy` through
   * unchanged.
   */
  rename(
    target: Target,
    newName: string,
    conflictPolicy: ConflictPolicy,
  ): Promise<DatasourceFileEntry<T>>;
  /**
   * Download `target`'s contents (per add-engine-rename-download
   * design.md Decision 3). The engine is a one-shot HTTP primitive —
   * each call issues exactly ONE provider GET, wrapped in `withRefresh`
   * for the existing one-shot auth-expired refresh-and-retry on the
   * INITIAL request. The engine does NOT retry mid-stream, does NOT
   * mint a transaction id, does NOT track per-download state across
   * calls. Consumer-domain orchestration of resume (calling
   * `downloadFile` again with `rangeStart = bytesWritten`) lives in
   * fs-sync.
   *
   * The base emits `downloading` per progress tick (driven by the
   * strategy's byte-counting hook), `file-downloaded` on the
   * stream's `end` event, `download-failed` on stream error, and
   * `download-cancelled` on AbortSignal (or normalized
   * `tag: "cancelled"`).
   */
  downloadFile(
    target: Target,
    options?: DownloadOptions,
  ): Promise<DownloadResult>;
  getQuota(): Promise<Quota>;
}

// ---------------------------------------------------------------------------
// Construction context
// ---------------------------------------------------------------------------

export interface BaseClientContext {
  bus: EventBus;
  credentialStore: CredentialStore;
  providerDescriptor: ProviderDescriptor;
}

export interface BaseClientInit {
  datasourceId: string;
  ctx: BaseClientContext;
}

// ---------------------------------------------------------------------------
// Template base class
// ---------------------------------------------------------------------------

export abstract class BaseDatasourceClient<T extends DatasourceType>
  implements DatasourceClient<T>
{
  abstract readonly type: T;
  readonly datasourceId: string;

  protected readonly ctx: BaseClientContext;

  /** Single-flight refresh promise. `null` when no refresh is in flight. */
  private refreshPromise: Promise<AuthResult> | null = null;

  /** Last known status value; used so `status()` can emit `status-changed`
   * only when the value actually changes between calls. */
  private lastStatus: DatasourceStatus | null = null;

  constructor(init: BaseClientInit) {
    this.datasourceId = init.datasourceId;
    this.ctx = init.ctx;
  }

  // -------------------------------------------------------------------------
  // Abstract primitives (concrete strategies implement these)
  // -------------------------------------------------------------------------

  /** Primitive for `status()`. */
  protected abstract doStatusImpl(): Promise<DatasourceStatus>;
  /** Primitive for `testConnection()`. */
  protected abstract doTestConnectionImpl(): Promise<void>;
  /** Primitive for `authenticate()` — MUST return a pure intent; the base
   * decorates the intent's `completeWith`/`submit` to persist credentials
   * and emit the success/failure events. */
  protected abstract doAuthenticateImpl(): Promise<AuthIntent>;
  protected abstract doListDirectoryImpl(
    target: Target,
  ): Promise<DatasourceFileEntry<T>[]>;
  protected abstract doSearchImpl(
    query: string,
    scope?: Target,
  ): Promise<DatasourceFileEntry<T>[]>;
  protected abstract doGetMetadataImpl(
    target: Target,
  ): Promise<FileMetadata<T>>;
  /**
   * Primitive for `uploadFile()` (per migrate-upload-orchestration-out-of-engine).
   * The base wraps this with `withRefresh` and returns the resolved entry
   * unchanged — no bus emission, no tracker, no transaction id. Strategies:
   *
   *   - Forward `options.signal` (when provided) into the underlying
   *     SDK / fetch calls so consumer-aborted uploads unblock promptly.
   *     On abort, the strategy throws
   *     `DatasourceError<T>{ tag: "cancelled", retryable: false }`.
   *   - Register an `'abort'` listener on `options.signal` (when present
   *     and the upload allocates provider-side state) to issue
   *     provider-native cleanup against a FRESH `AbortController` with a
   *     5-second timeout — NOT the user's signal. Forwarding the user's
   *     signal into the cleanup HTTP call would abort cleanup itself,
   *     leaving an orphaned session URL on the provider.
   *   - Invoke `options.onProgress(loaded, total)` (when provided) with
   *     monotonic non-decreasing `loaded` byte counts as bytes flow.
   *   - Populate the strategy's path-handle LRU directly inside the
   *     success branch (`this.cachePathHandle(entry.path, entry.handle)`
   *     or equivalent) before returning the entry — LRU population is
   *     internal, not bus-driven.
   *
   * Strategies whose providers do not honor `AbortSignal` cleanly (e.g.,
   * OneDrive's small-file `PUT /content` via the Graph SDK) SHOULD
   * branch on `options.signal?.aborted` post-resolve and reject with
   * `tag: "cancelled"` to preserve cancellation semantics on that
   * code path.
   */
  protected abstract doUploadFileImpl(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    options: {
      signal?: AbortSignal;
      onProgress?: (loaded: number, total: number) => void;
    },
  ): Promise<DatasourceFileEntry<T>>;
  protected abstract doDeleteFileImpl(target: Target): Promise<void>;
  /**
   * Primitive for `rename()`. The base passes `conflictPolicy` through
   * unchanged (per design.md Decision 1 — sibling-detection, suffix-retry,
   * and kind-based refusal are provider-specific and live inside the
   * strategy). Strategies SHALL:
   *   - For `"fail"`: pre-check for a colliding sibling (provider-specific
   *     query) and throw `DatasourceError { tag: "conflict",
   *     raw: { existingPath } }` if one exists; otherwise rename.
   *   - For `"overwrite"` on a file: delete the colliding sibling
   *     (without emitting `deleted` — that primitive is part of the
   *     strategy's internal state, not the public bus) then rename.
   *   - For `"overwrite"` on a directory: throw `DatasourceError
   *     { tag: "unsupported", message: "directory rename with
   *     conflictPolicy 'overwrite' is not supported (would require
   *     recursive replacement)" }`.
   *   - For `"keep-both"`: append `-2` / `-3` / … suffix and retry until
   *     success or 99 attempts (then throw `DatasourceError { tag:
   *     "other", message: "exhausted keep-both attempts" }`).
   *
   * Abstract per the spec: every concrete strategy MUST implement this
   * primitive (mirroring `doDeleteFileImpl` etc.) so a future strategy
   * author cannot silently inherit a no-op default. §7/§8/§9 replace the
   * three current placeholder overrides (Drive / OneDrive / S3) with
   * provider-specific rename paths.
   */
  protected abstract doRenameImpl(
    target: Target,
    newName: string,
    conflictPolicy: ConflictPolicy,
  ): Promise<DatasourceFileEntry<T>>;
  /**
   * Primitive for `downloadFile()`. Per add-engine-rename-download
   * design.md Decision 3, each call issues exactly ONE provider GET
   * request — wrapped at the base layer in `withRefresh` for the
   * existing one-shot auth-expired retry. Strategies SHALL:
   *   - Pass `options.signal` (if any) into the underlying SDK / fetch
   *     so abort propagates to the in-flight provider request.
   *   - Attach `Range: bytes=<options.rangeStart>-` when
   *     `options.rangeStart > 0`; populate the returned `contentRange`
   *     from the response's `Content-Range` header so fs-sync can
   *     validate `range-not-honored` (provider returned 200 instead
   *     of 206) and `range-mismatch` cases.
   *   - Run a byte-counting hook against the provider stream that
   *     fires BOTH `options.onProgress(loaded, total)` AND
   *     `this.emitDownloading(path, loaded, total)` from the same
   *     source, so the consumer callback and the bus emission stay
   *     in lockstep (per spec.md Requirement: "downloadFile is a
   *     stateless one-shot HTTP primitive" + the four download
   *     lifecycle events).
   *
   * Per-strategy implementations land in §7 (Drive), §8 (OneDrive),
   * and §9 (S3). Section 5's strategy placeholders throw
   * `tag: "unsupported"` until those sections wire the real provider
   * paths.
   */
  protected abstract doDownloadFileImpl(
    target: Target,
    options: DownloadOptions,
  ): Promise<DownloadResult>;
  protected abstract doGetQuotaImpl(): Promise<Quota>;

  /**
   * Refresh credentials with the provider. This is the critical section of
   * the single-flight mutex — implementers MUST NOT re-enter the base's retry
   * logic from here (no self-calls to other `do*Impl` methods that could
   * loop through the base's `withRefresh`). A raw exception thrown from
   * here is caught by the base and surfaced as `token-expired` +
   * `authentication-failed` to subscribers.
   */
  protected abstract refreshTokenImpl(): Promise<AuthResult>;

  /** Convert a raw provider exception into the engine's normalized error.
   * Strategies MUST NOT throw raw provider exceptions from their `do*Impl`
   * methods; every rejection in the `do*Impl` path is piped through
   * `normalizeErrorImpl` before the base emits or rethrows.
   */
  protected abstract normalizeErrorImpl(raw: unknown): DatasourceError<T>;

  // -------------------------------------------------------------------------
  // Public wrappers — one per operation
  // -------------------------------------------------------------------------

  async status(): Promise<DatasourceStatus> {
    try {
      const value = await this.withRefresh(() => this.doStatusImpl());
      if (this.lastStatus !== value) {
        this.lastStatus = value;
        this.emit("status-changed", false, { status: value });
      }
      return value;
    } catch (err) {
      const normalized = this.ensureNormalized(err);
      // Per spec, status emits a status-changed event carrying the error
      // (Unsupported errors remain silent on the bus).
      if (normalized.tag !== "unsupported") {
        this.emit("status-changed", false, {
          status: "error" as DatasourceStatus,
          error: normalized.tag,
        });
      }
      throw normalized;
    }
  }

  async testConnection(): Promise<void> {
    try {
      await this.withRefresh(() => this.doTestConnectionImpl());
    } catch (err) {
      const normalized = this.ensureNormalized(err);
      if (normalized.tag !== "unsupported") {
        this.emit("status-changed", false, {
          status: "error" as DatasourceStatus,
          error: normalized.tag,
        });
      }
      throw normalized;
    }
  }

  async authenticate(): Promise<AuthIntent> {
    // The base does NOT wrap `doAuthenticateImpl` with `withRefresh` — there
    // is no useful retry for "failed to build an intent". But we do normalize
    // errors so the caller always sees a DatasourceError.
    let intent: AuthIntent;
    try {
      intent = await this.doAuthenticateImpl();
    } catch (err) {
      const normalized = this.ensureNormalized(err);
      if (normalized.tag !== "unsupported") {
        // Decision 12.4: emit the full serialized DatasourceError so
        // subscribers receive `retryable` / `retryAfterMs` / `raw`
        // (not a reason string). Structured-clone across IPC drops the
        // class identity, which is why we project to a plain shape here.
        // Cast note: TS does not distribute `PayloadMap[T]["authentication-failed"]`
        // to `SerializedDatasourceError<T>` when T is a generic parameter
        // (indexed-access-on-generic limitation). At every concrete
        // instantiation the types are equal — see the test-d assertions.
        this.emit(
          "authentication-failed",
          false,
          serializeDatasourceError(
            normalized,
          ) as PayloadMap[T]["authentication-failed"],
        );
      }
      throw normalized;
    }
    // Decorate the intent's completion closure so the base:
    //   1. awaits the strategy-provided token exchange,
    //   2. persists credentials via `credentialStore.put`,
    //   3. emits `authenticated` (or `authentication-failed` on reject).
    return this.decorateIntent(intent);
  }

  async listDirectory(target: Target): Promise<DatasourceFileEntry<T>[]> {
    return this.runReadOp(() => this.doListDirectoryImpl(target));
  }

  async search(query: string, scope?: Target): Promise<DatasourceFileEntry<T>[]> {
    return this.runReadOp(() => this.doSearchImpl(query, scope));
  }

  async getMetadata(target: Target): Promise<FileMetadata<T>> {
    return this.runReadOp(() => this.doGetMetadataImpl(target));
  }

  /**
   * One-shot stateless upload wrapper (per migrate-upload-orchestration-out-of-engine).
   * The base does NOT mint a transactionId, does NOT track in-flight state,
   * and does NOT emit any of `uploading`, `file-created`, `upload-failed`,
   * or `upload-cancelled` from this code path. Cancellation is consumer-
   * driven via `options.signal`; progress is consumer-observed via
   * `options.onProgress`.
   *
   * `withRefresh` is retained: a single auth-expired retry still applies.
   * The follow-up `migrate-engine-retry-policy-to-consumer` covers retry-
   * policy ownership; this change does not touch that wrapper.
   */
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

  async deleteFile(target: Target): Promise<void> {
    try {
      await this.withRefresh(() => this.doDeleteFileImpl(target));
      this.emit("deleted", false, { target });
    } catch (err) {
      const normalized = this.ensureNormalized(err);
      if (normalized.tag !== "unsupported") {
        this.emit("delete-failed", false, {
          tag: normalized.tag,
          message: normalized.message,
        });
      }
      throw normalized;
    }
  }

  /**
   * deleteDirectory is unconditionally `Unsupported` for product stability
   * (Decision 10). Per spec scenario, no `*-failed` event fires for
   * Unsupported errors.
   */
  async deleteDirectory(target: Target): Promise<never> {
    void target;
    throw new DatasourceError<T>({
      tag: "unsupported",
      datasourceType: this.type,
      datasourceId: this.datasourceId,
      retryable: false,
      raw: "disabled-for-product-stability",
      message: "deleteDirectory is disabled for product stability",
    });
  }

  /**
   * Rename wrapper. The base wraps `doRenameImpl` with `withRefresh`
   * (one-shot auth-expired retry per the engine's existing pattern),
   * emits `entry-renamed { from, to }` once on success, and routes
   * failures through the existing `delete-failed` taxonomy with
   * `via: "rename"`. Unsupported errors stay silent on the bus
   * per the engine-wide convention applied to every other op.
   *
   * Per design.md Decision 1, per-policy orchestration is strategy-side
   * — the base passes `conflictPolicy` through to `doRenameImpl`
   * unchanged and trusts the strategy to surface the right error tag
   * (`"conflict"` for fail-on-collision; `"unsupported"` for
   * directory-overwrite; `"other"` for exhausted keep-both retries).
   */
  async rename(
    target: Target,
    newName: string,
    conflictPolicy: ConflictPolicy,
  ): Promise<DatasourceFileEntry<T>> {
    try {
      const entry = await this.withRefresh(() =>
        this.doRenameImpl(target, newName, conflictPolicy),
      );
      // Cast note: TS does not distribute `PayloadMap[T]["entry-renamed"]`
      // to `{ from: Target; to: DatasourceFileEntry<T> }` when T is a
      // generic parameter (indexed-access-on-generic limitation, same as
      // `authentication-failed` below). At every concrete instantiation
      // the types are equal — see the test-d assertions in
      // datasources-engine.test-d.ts.
      this.emit(
        "entry-renamed",
        false,
        { from: target, to: entry } as PayloadMap[T]["entry-renamed"],
      );
      return entry;
    } catch (err) {
      const normalized = this.ensureNormalized(err);
      if (normalized.tag !== "unsupported") {
        this.emit("delete-failed", false, {
          tag: normalized.tag,
          message: normalized.message,
          via: "rename",
        });
      }
      throw normalized;
    }
  }

  /**
   * Per-call progress hooks for in-flight `downloadFile` calls, keyed
   * by `path`. Each entry is the closure-local `recordProgress`
   * callback that the call's own `lastLoaded` / `lastTotal` live
   * inside; `emitDownloading(path, …)` looks the entry up so a tick
   * threads through to the right call's closure when multiple
   * downloads run concurrently on the same client (different paths).
   *
   * The architecture allows concurrent downloads on the same client:
   * fs-sync enforces single-flight per `(datasourceId, path)` at the
   * service layer (§13.23), NOT per `(datasourceId)`. The same client
   * instance therefore legitimately serves multiple concurrent
   * downloads on different paths. Two simultaneous calls for the
   * SAME path on one client are a fs-sync invariant violation; if it
   * ever happens, the second `set` clobbers the first — the same
   * failure mode as the original single-slot design, which is
   * acceptable since fs-sync's reverse index already prevents it.
   */
  private readonly activeDownloads = new Map<
    string,
    (loaded: number, total: number | null) => void
  >();

  /**
   * Emit a `downloading` event on the bus AND notify the active
   * download's per-call progress hook (so `download-cancelled` /
   * `download-failed` can carry the last-reported byte counts from
   * the call's own closure, not a shared instance slot). Strategies
   * invoke this from the same byte-counting hook that fires the
   * consumer's `onProgress` callback, so the bus and the consumer
   * stay in lockstep on a single source of truth (per design.md /
   * tasks.md §5.7-§5.8).
   *
   * Cast note: TS does not distribute `PayloadMap[T]["downloading"]`
   * to the literal payload shape when T is a generic parameter
   * (indexed-access-on-generic limitation, same as `entry-renamed` and
   * `authentication-failed`). At every concrete instantiation the types
   * are equal — see the test-d assertions.
   */
  protected emitDownloading(
    path: string,
    loaded: number,
    total: number | null,
  ): void {
    const recordProgress = this.activeDownloads.get(path);
    if (recordProgress !== undefined) {
      recordProgress(loaded, total);
    }
    this.emit(
      "downloading",
      true,
      { path, loaded, total } as PayloadMap[T]["downloading"],
    );
  }

  /**
   * Download wrapper (per add-engine-rename-download design.md Decision 3).
   * The base wraps `doDownloadFileImpl` with `withRefresh` for the
   * existing one-shot auth-expired retry on the initial HTTP call,
   * attaches stream-end / stream-error listeners to drive
   * `file-downloaded` / `download-failed` / `download-cancelled`, and
   * keeps closure-local last-byte-counts so the cancel path's payload
   * is populated with real numbers.
   *
   * The shape returned to the consumer is the strategy's shape
   * unchanged — the base does NOT replace the stream, mutate
   * `contentLength`, or strip `contentRange`. fs-sync's retry loop
   * relies on those values to validate `range-not-honored` /
   * `range-mismatch` (Decision 3's safeguards).
   */
  async downloadFile(
    target: Target,
    options: DownloadOptions = {},
  ): Promise<DownloadResult> {
    const path = target.kind === "path" ? target.path : target.handle;
    // Per-call byte-tracking lives entirely in this method's closure. Each
    // concurrent invocation captures its OWN `lastLoaded` / `lastTotal` so
    // a cancel / failure on one call cannot read the byte counts of another
    // call running on the same client instance (different path). The
    // closure-local `recordProgress` is registered in `activeDownloads`
    // by path so `emitDownloading(path, …)` routes a tick to the right
    // call's closure; the cancel / failure-path emits below read from the
    // closure variables directly, never from the map.
    let lastLoaded = 0;
    let lastTotal: number | null = null;
    const recordProgress = (loaded: number, total: number | null): void => {
      lastLoaded = loaded;
      lastTotal = total;
    };
    this.activeDownloads.set(path, recordProgress);
    let result: DownloadResult;
    try {
      result = await this.withRefresh(() =>
        this.doDownloadFileImpl(target, options),
      );
    } catch (err) {
      // Initial-call failure (no stream returned). The strategy's
      // `withRefresh` already attempted the one-shot refresh; this is
      // terminal. Cancel takes precedence over failure when the
      // consumer's signal is already aborted (e.g., abort fired before
      // the SDK call settled).
      this.activeDownloads.delete(path);
      const normalized = this.ensureNormalized(err);
      if (
        options.signal?.aborted ||
        normalized.tag === "cancelled" ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        this.emit(
          "download-cancelled",
          false,
          {
            path,
            bytesDownloaded: lastLoaded,
            bytesTotal: lastTotal ?? 0,
          } as PayloadMap[T]["download-cancelled"],
        );
        throw new DatasourceError<T>({
          tag: "cancelled",
          datasourceType: this.type,
          datasourceId: this.datasourceId,
          retryable: false,
          message: "download cancelled",
        });
      }
      this.emit(
        "download-failed",
        false,
        serializeDatasourceError(
          normalized,
        ) as PayloadMap[T]["download-failed"],
      );
      throw normalized;
    }
    // Stream is open. Attach observational listeners so the bus's terminal
    // event fires when the consumer's pipe drains (or errors / aborts).
    // Capture `contentLength` for the cancel-path `bytesTotal` fallback.
    const contentLength = result.contentLength;
    let terminalEmitted = false;
    const emitTerminal = (kind: "end" | "error" | "abort", err?: unknown): void => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      this.activeDownloads.delete(path);
      if (kind === "end") {
        this.emit(
          "file-downloaded",
          false,
          {
            path,
            bytes: lastLoaded || (contentLength ?? 0),
          } as PayloadMap[T]["file-downloaded"],
        );
        return;
      }
      // Failure / cancel branch. Distinguish AbortError / `tag: "cancelled"`
      // / aborted-signal from other failures.
      const isAbortError =
        err instanceof Error && err.name === "AbortError";
      const isCancelTag =
        err instanceof DatasourceError && err.tag === "cancelled";
      if (kind === "abort" || isAbortError || isCancelTag || options.signal?.aborted) {
        this.emit(
          "download-cancelled",
          false,
          {
            path,
            bytesDownloaded: lastLoaded,
            bytesTotal: contentLength,
          } as PayloadMap[T]["download-cancelled"],
        );
        return;
      }
      const normalized = this.ensureNormalized(err);
      this.emit(
        "download-failed",
        false,
        serializeDatasourceError(
          normalized,
        ) as PayloadMap[T]["download-failed"],
      );
    };
    result.stream.on("end", () => emitTerminal("end"));
    result.stream.on("error", (err) => emitTerminal("error", err));
    // AbortSignal-driven cancel: the strategy's signal-listener typically
    // destroys the stream with AbortError, which fires our `error` listener
    // above. This redundant abort listener handles the edge case where the
    // strategy did not wire abort to a stream-error (e.g., the SDK simply
    // ends the stream without erroring) — the base still routes terminal
    // emission to `download-cancelled`.
    options.signal?.addEventListener("abort", () => emitTerminal("abort"), {
      once: true,
    });
    return result;
  }

  /**
   * getQuota is gated by the provider descriptor's `capabilities.quota` flag.
   * Unsupported emits no event; supported providers delegate to `doGetQuota`
   * under the refresh wrapper.
   */
  async getQuota(): Promise<Quota> {
    if (!this.ctx.providerDescriptor.capabilities.quota) {
      throw new DatasourceError<T>({
        tag: "unsupported",
        datasourceType: this.type,
        datasourceId: this.datasourceId,
        retryable: false,
        raw: "not-supported-by-provider",
        message: "getQuota is not supported by this provider",
      });
    }
    // Delegate to the shared read-op wrapper so a rate-limit failure emits
    // `rate-limited` (parity with listDirectory / search / getMetadata). The
    // capability-gate above short-circuits BEFORE runReadOp, so Unsupported
    // stays silent on the bus.
    return this.runReadOp(() => this.doGetQuotaImpl());
  }

  /**
   * Release any host-level resources the client holds. The base implementation
   * is a no-op — subclasses that subscribe to the bus, hold timers, or own
   * external handles override this and call their own teardown (MAY call
   * `super.dispose()` but it is not required).
   *
   * `dispose()` is idempotent by contract — callers (e.g., Phase 10's IPC
   * lifecycle owner) may invoke it more than once. Implementations MUST
   * guard with their own flag.
   */
  dispose(): void {
    // no-op on the base
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Read-op wrapper (list / search / getMetadata / getQuota): emits no
   * pre-event, no success-event; on failure emits a non-`*-failed` signal
   * via `status-changed` (or `rate-limited`) per task-text semantics, then
   * rethrows. Unsupported is silent.
   */
  private async runReadOp<R>(op: () => Promise<R>): Promise<R> {
    try {
      return await this.withRefresh(op);
    } catch (err) {
      const normalized = this.ensureNormalized(err);
      if (normalized.tag === "rate-limited") {
        this.emit("rate-limited", false, {
          tag: normalized.tag,
          retryAfterMs: normalized.retryAfterMs,
        });
      } else if (
        normalized.tag !== "unsupported" &&
        normalized.tag !== "auth-expired"
      ) {
        this.emit("status-changed", false, {
          status: "error" as DatasourceStatus,
          error: normalized.tag,
        });
      }
      throw normalized;
    }
  }

  /**
   * Wrap an operation with single-flight token refresh. On `auth-expired`:
   * - if no refresh in flight, start one, persist result, emit
   *   `token-refreshed`, retry once;
   * - if a refresh is already in flight, await it and retry once;
   * - the retry is NOT re-refreshed — if it throws `auth-expired` again, the
   *   error propagates as-is.
   * On refresh failure: emit `token-expired` + `authentication-failed`,
   * throw the original normalized `auth-expired` error.
   */
  private async withRefresh<R>(op: () => Promise<R>): Promise<R> {
    try {
      return await op();
    } catch (firstError) {
      const normalized = this.ensureNormalized(firstError);
      if (normalized.tag !== "auth-expired") {
        throw normalized;
      }
      // Attempt single-flight refresh. The shared promise encapsulates both
      // the `refreshToken()` call AND the subsequent credential persistence
      // + `token-refreshed` emission, so 5 concurrent callers see exactly one
      // refresh, one put, and one event.
      try {
        await this.singleFlightRefresh();
      } catch (refreshErr) {
        // Refresh failed: emit both events and throw the original.
        this.emit("token-expired", false, {});
        // Decision 12.4: emit the full serialized DatasourceError. The raw
        // refresh exception is preserved under `raw` so consumers can still
        // surface the underlying cause (replacing the old `cause: string`
        // shape). When refresh rejected with a DatasourceError we reuse it;
        // otherwise synthesize one tagged `auth-expired` carrying the raw.
        const refreshNormalized: DatasourceError<T> =
          refreshErr instanceof DatasourceError
            ? (refreshErr as DatasourceError<T>)
            : new DatasourceError<T>({
                tag: "auth-expired",
                datasourceType: this.type,
                datasourceId: this.datasourceId,
                retryable: false,
                raw: refreshErr,
                message:
                  refreshErr instanceof Error
                    ? refreshErr.message
                    : String(refreshErr),
              });
        // Cast note: see the comment at the first emit site — TS cannot
        // prove the indexed access reduces to `SerializedDatasourceError<T>`
        // through a generic `T`.
        this.emit(
          "authentication-failed",
          false,
          serializeDatasourceError(
            refreshNormalized,
          ) as PayloadMap[T]["authentication-failed"],
        );
        throw normalized;
      }
      // Retry once. Any error from the retry (including a second
      // auth-expired) propagates as-is — the base does NOT re-refresh.
      return await op();
    }
  }

  /**
   * Single-flight refresh. The shared promise covers `refreshTokenImpl()`,
   * persistence, and the `token-refreshed` emission, so concurrent callers
   * with auth-expired failures share one end-to-end refresh cycle (exactly
   * one refresh call, one persist, one event). The promise is cleared BEFORE
   * the emission so a subsequent failure can trigger a fresh cycle without
   * being blocked on stale state.
   */
  private singleFlightRefresh(): Promise<AuthResult> {
    if (this.refreshPromise !== null) return this.refreshPromise;
    // The stored promise covers refreshTokenImpl → persist → token-refreshed
    // emission as a single end-to-end cycle. The refreshPromise field is
    // cleared after the closure completes (success or failure) so a
    // subsequent failure can re-enter with a fresh cycle.
    const cycle = (async (): Promise<AuthResult> => {
      const result = await this.refreshTokenImpl();
      // Persist BEFORE retry so a crash mid-retry does not lose the token.
      await this.persistCredentials(result);
      // Emit exactly once per shared refresh cycle.
      this.emit("token-refreshed", false, { accessToken: "<redacted>" });
      return result;
    })();
    // Chain a clear-out that runs regardless of outcome. The returned
    // promise preserves the original resolution / rejection.
    const cleared = cycle.finally(() => {
      if (this.refreshPromise === cleared) {
        this.refreshPromise = null;
      }
    });
    this.refreshPromise = cleared;
    return cleared;
  }

  private async persistCredentials(authResult: AuthResult): Promise<void> {
    const stored: StoredCredentials = {
      providerId: this.type,
      authResult,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.ctx.credentialStore.put(this.datasourceId, stored);
  }

  private ensureNormalized(err: unknown): DatasourceError<T> {
    if (err instanceof DatasourceError) {
      return err as DatasourceError<T>;
    }
    return this.normalizeErrorImpl(err);
  }

  private decorateIntent(intent: AuthIntent): AuthIntent {
    if (intent.kind === "oauth") {
      const inner = intent.completeWith.bind(intent);
      const decorated: OAuthIntent = {
        kind: "oauth",
        authorizeUrl: intent.authorizeUrl,
        completeWith: async (code: string) => {
          return this.completeAuth(() => inner(code));
        },
      };
      return decorated;
    }
    // credentials-form
    const inner = intent.submit.bind(intent);
    const decorated: CredentialsFormIntent = {
      kind: "credentials-form",
      schema: intent.schema,
      submit: async (values) => this.completeAuth(() => inner(values)),
    };
    return decorated;
  }

  private async completeAuth(
    run: () => Promise<AuthResult>,
  ): Promise<AuthResult> {
    let result: AuthResult;
    try {
      result = await run();
    } catch (err) {
      const normalized =
        err instanceof DatasourceError
          ? (err as DatasourceError<T>)
          : this.normalizeErrorImpl(err);
      if (normalized.tag !== "unsupported") {
        // Decision 12.4: emit the full serialized DatasourceError so
        // host-side subscribers can reconstruct retry affordances from
        // `retryable` / `retryAfterMs` (not a bare reason string).
        // Cast note: see the comment at the first emit site — TS cannot
        // prove the indexed access reduces to `SerializedDatasourceError<T>`
        // through a generic `T`.
        this.emit(
          "authentication-failed",
          false,
          serializeDatasourceError(
            normalized,
          ) as PayloadMap[T]["authentication-failed"],
        );
      }
      throw normalized;
    }
    await this.persistCredentials(result);
    this.emit("authenticated", false, {});
    return result;
  }

  /**
   * Emit a typed envelope on the injected bus. Generic over `K` so payloads
   * narrow against `PayloadMap[T][K]` at the base's emission sites.
   */
  private emit<K extends keyof PayloadMap[T]>(
    event: K,
    streaming: boolean,
    payload: PayloadMap[T][K],
  ): void {
    const envelope: DatasourceEvent<T, K> = {
      event,
      datasourceType: this.type,
      datasourceId: this.datasourceId,
      ts: Date.now(),
      payload,
      ...(streaming ? { streaming: true as const } : {}),
    };
    this.ctx.bus.emit(envelope);
  }
}
