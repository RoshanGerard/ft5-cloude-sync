// BaseDatasourceClient — the Template base for every datasource strategy.
//
// Every public operation on a `DatasourceClient<T>` is implemented ONCE here.
// Concrete strategies (S3, OneDrive, Google Drive) extend this class and
// implement only the `protected abstract doX(...)` primitives plus
// `refreshTokenImpl()` and `normalizeError()`.
//
// Crossing-cutting responsibilities centralised here:
//   1. Error normalization for every public operation (see item 3). Per
//      migrate-engine-events-to-consumer the engine no longer emits any
//      lifecycle events: public methods return their typed result on success
//      or throw a normalized `DatasourceError` on failure, with NO bus side
//      effects. Downstream consumers (fs-sync) own all event emission.
//   2. Public single-flight credential refresh via `refreshCredentials()`
//      (per migrate-engine-retry-policy-to-consumer Decisions 2 + 7). The
//      base does NOT auto-refresh around operations — a normalized
//      `auth-expired` surfaces to the caller RAW (no refresh, no retry), and
//      the caller invokes `refreshCredentials()` explicitly (typically via
//      the exported `withAuthRefresh` helper) before retrying. Concurrent
//      callers on the same instance share one refresh; refreshed credentials
//      are persisted via `CredentialStore.put` BEFORE the refresh promise
//      resolves.
//   3. Error normalization: raw provider exceptions are converted into
//      `DatasourceError<T>` by the strategy's `normalizeError` before they
//      cross the base's boundary.
//
// The engine emits no events (the event bus was removed in
// migrate-engine-events-to-consumer); strategies likewise emit nothing.
// Strategies MUST NOT re-enter the base's refresh path (`refreshCredentials`)
// from `refreshTokenImpl` (see Decision 7 / Risks in design.md —
// `refreshTokenImpl` is the critical section of the single-flight mutex).
//
// Note: If `CredentialStore.put` rejects inside the refresh cycle (e.g., disk
// full, keychain unavailable), the rejection is routed through the
// refresh-failed path — `refreshCredentials()` rejects with
// `DatasourceError.AuthExpired`, not a distinct storage error. Host
// implementations of `CredentialStore` SHOULD surface storage failures via
// their own logging / telemetry so the root cause is debuggable. A future
// phase may introduce a dedicated `storage-error` tag.

import type {
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  DatasourceStatus,
  DatasourceType,
  DatasourceFileEntry,
  FileMetadata,
  OAuthIntent,
  ProviderDescriptor,
  Quota,
  StoredCredentials,
  Target,
} from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

import type { Readable } from "node:stream";

import type { CredentialStore } from "./credential-store.js";

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
 *   with AbortError. The consumer (fs-sync) distinguishes AbortError /
 *   `tag: "cancelled"` from other failures and emits its own terminal
 *   event accordingly — the engine emits none.
 * - `onProgress` (optional): synchronous consumer callback fired from
 *   the strategy's byte-counting hook as bytes flow. This is the sole
 *   progress channel — the engine no longer emits any `downloading`
 *   events (the event bus was removed in
 *   migrate-engine-events-to-consumer); fs-sync's download handler owns
 *   progress throttling and terminal emission via this callback.
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
  /**
   * List one provider page of `target`'s children (per
   * add-engine-listdirectory-pagination Decisions 1, 2, 3). The engine returns
   * exactly ONE provider page plus an opaque `nextCursor` continuation token;
   * consumers ask for the next page on demand by re-issuing with
   * `options.cursor` set to the prior call's `nextCursor`.
   *
   * - `options.cursor` (opaque `string`): the prior page's `nextCursor`. The
   *   base treats it as opaque (Decision 2) — it never inspects or normalizes
   *   it; each strategy maps it to/from its provider-native token
   *   (`pageToken` on Drive, `@odata.nextLink` on OneDrive,
   *   `ContinuationToken` on S3).
   * - `options.pageSize` (optional): the desired entries-per-page. Each
   *   strategy clamps to its provider min/max and applies its own default when
   *   omitted (Decision 3). The base does NOT inject a default.
   * - `nextCursor`: the next page's opaque cursor, or `null` when the listing
   *   is exhausted.
   */
  listDirectory(
    target: Target,
    options?: { cursor?: string; pageSize?: number },
  ): Promise<{ entries: DatasourceFileEntry<T>[]; nextCursor: string | null }>;
  search(query: string, scope?: Target): Promise<DatasourceFileEntry<T>[]>;
  getMetadata(target: Target): Promise<FileMetadata<T>>;
  /**
   * Upload a local file to the parent target as a one-shot stateless
   * primitive (per migrate-upload-orchestration-out-of-engine). The base
   * calls `doUploadFileImpl` directly (per
   * migrate-engine-retry-policy-to-consumer Decision 1 — no auto-refresh; a
   * normalized `auth-expired` surfaces raw for the consumer's
   * `withAuthRefresh` to retry), applies error normalization only, and
   * returns the strategy's resolved entry directly. This code path emits NO
   * events (the engine has no event bus) — `uploading`, `file-created`,
   * `upload-failed`, and `upload-cancelled` are emitted by the fs-sync service
   * handler on `sync:event-stream`.
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
   * add-engine-rename-download spec). The base calls the strategy's
   * `doRenameImpl` directly (per migrate-engine-retry-policy-to-consumer
   * Decision 1 — no auto-refresh) and returns the renamed
   * `DatasourceFileEntry<T>` on success or throws a normalized
   * `DatasourceError` on failure (the engine emits no event; the wire
   * `delete-failed` / `via: "rename"` shaping is the consumer's concern).
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
   * each call issues exactly ONE provider GET. Per
   * migrate-engine-retry-policy-to-consumer Decision 1 the base does NOT
   * auto-refresh on `auth-expired`: a first `auth-expired` surfaces raw, and
   * the consumer's download handler refreshes via `refreshCredentials()` then
   * re-issues the GET (Decision 5). The engine does NOT retry mid-stream, does
   * NOT mint a transaction id, does NOT track per-download state across calls.
   * Consumer-domain orchestration of resume (calling `downloadFile` again with
   * `rangeStart = bytesWritten`) lives in fs-sync.
   *
   * Progress is reported via `options.onProgress` (driven by the
   * strategy's byte-counting hook); the engine emits NO events. The
   * terminal outcome is observed from the returned stream's lifecycle
   * (`end` / `error` / abort) plus the resolved/rejected promise —
   * fs-sync's download handler derives its own `downloading` /
   * `file-downloaded` / `download-failed` / `download-cancelled` from those.
   */
  downloadFile(
    target: Target,
    options?: DownloadOptions,
  ): Promise<DownloadResult>;
  getQuota(): Promise<Quota>;
  /**
   * Refresh the datasource's credentials with the provider as a public,
   * single-flight primitive (per migrate-engine-retry-policy-to-consumer
   * Decisions 2 + 7). The base does NOT auto-invoke this around operations —
   * an `auth-expired` error surfaces raw, and the caller invokes
   * `refreshCredentials()` explicitly (typically through the exported
   * `withAuthRefresh` helper) before retrying.
   *
   * Concurrent calls on the same client instance share one in-flight
   * `refreshTokenImpl()` call; the refreshed `AuthResult` is persisted via
   * `CredentialStore.put` BEFORE the returned promise resolves. The engine
   * emits no event. On failure it rejects with a `DatasourceError` (tagged
   * `auth-expired` when the underlying refresh did not itself throw a typed
   * `DatasourceError`).
   */
  refreshCredentials(): Promise<AuthResult>;
}

// ---------------------------------------------------------------------------
// Construction context
// ---------------------------------------------------------------------------

export interface BaseClientContext {
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
   * via `CredentialStore.put` (no event emitted). */
  protected abstract doAuthenticateImpl(): Promise<AuthIntent>;
  /**
   * Primitive for `listDirectory()` (per
   * add-engine-listdirectory-pagination). Returns exactly ONE provider page
   * plus an opaque `nextCursor`. Strategies:
   *   - Map `options.cursor` (when set) to their provider-native continuation
   *     token and read the provider's response token back into `nextCursor`
   *     (`null` when the listing is exhausted). The base passes the cursor
   *     through opaque (Decision 2).
   *   - Clamp `options.pageSize` to their provider min/max and apply their own
   *     default when it is omitted (Decision 3) — the base injects no default
   *     (it forwards an empty `{}` when the caller omits `options`).
   */
  protected abstract doListDirectoryImpl(
    target: Target,
    options: { cursor?: string; pageSize?: number },
  ): Promise<{ entries: DatasourceFileEntry<T>[]; nextCursor: string | null }>;
  protected abstract doSearchImpl(
    query: string,
    scope?: Target,
  ): Promise<DatasourceFileEntry<T>[]>;
  protected abstract doGetMetadataImpl(
    target: Target,
  ): Promise<FileMetadata<T>>;
  /**
   * Primitive for `uploadFile()` (per migrate-upload-orchestration-out-of-engine).
   * The base calls this directly (per migrate-engine-retry-policy-to-consumer
   * Decision 1 — no auto-refresh), applies error normalization only, and
   * returns the resolved entry unchanged — no bus emission, no tracker, no
   * transaction id. Strategies:
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
   * request. Per migrate-engine-retry-policy-to-consumer Decision 1 the base
   * calls this directly with no auto-refresh — a normalized `auth-expired`
   * surfaces raw to the consumer's download handler, which owns the
   * refresh-and-re-issue (Decision 5). Strategies SHALL:
   *   - Pass `options.signal` (if any) into the underlying SDK / fetch
   *     so abort propagates to the in-flight provider request.
   *   - Attach `Range: bytes=<options.rangeStart>-` when
   *     `options.rangeStart > 0`; populate the returned `contentRange`
   *     from the response's `Content-Range` header so fs-sync can
   *     validate `range-not-honored` (provider returned 200 instead
   *     of 206) and `range-mismatch` cases.
   *   - Run a byte-counting hook against the provider stream that
   *     fires `options.onProgress(loaded, total)` as bytes flow. This is
   *     the sole progress channel — the engine emits no `downloading`
   *     events (the event bus was removed in
   *     migrate-engine-events-to-consumer); fs-sync's download handler
   *     consumes `onProgress` and owns progress throttling + terminal
   *     emission off its own pipe-to-disk path.
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
   * Refresh credentials with the provider — the strategy primitive wrapped by
   * the public single-flight `refreshCredentials()`. This is the critical
   * section of the single-flight mutex — implementers MUST NOT re-enter the
   * base's refresh path from here (no self-calls to `refreshCredentials()` or
   * to other `do*Impl` methods, none of which auto-refresh any longer). A raw
   * exception thrown from here is caught by `refreshCredentials()` and
   * surfaced as `token-expired` + `authentication-failed` to subscribers, and
   * the call rejects.
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
      return await this.doStatusImpl();
    } catch (err) {
      // Normalize-only — the engine no longer emits `status-changed`
      // (migrate-engine-events-to-consumer Decision 1).
      throw this.ensureNormalized(err);
    }
  }

  async testConnection(): Promise<void> {
    try {
      await this.doTestConnectionImpl();
    } catch (err) {
      throw this.ensureNormalized(err);
    }
  }

  async authenticate(): Promise<AuthIntent> {
    // `authenticate()` builds an intent — there is no useful auth-expired
    // refresh-and-retry for "failed to build an intent" (and the base no
    // longer auto-refreshes any operation). But we do normalize errors so the
    // caller always sees a DatasourceError.
    let intent: AuthIntent;
    try {
      intent = await this.doAuthenticateImpl();
    } catch (err) {
      // Normalize-only — the engine no longer emits `authentication-failed`
      // (migrate-engine-events-to-consumer Decision 1).
      throw this.ensureNormalized(err);
    }
    // Decorate the intent's completion closure so the base:
    //   1. awaits the strategy-provided token exchange,
    //   2. persists credentials via `credentialStore.put`.
    return this.decorateIntent(intent);
  }

  async listDirectory(
    target: Target,
    options?: { cursor?: string; pageSize?: number },
  ): Promise<{ entries: DatasourceFileEntry<T>[]; nextCursor: string | null }> {
    return this.runReadOp(() => this.doListDirectoryImpl(target, options ?? {}));
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
   * Per migrate-engine-retry-policy-to-consumer Decision 1 the base no longer
   * auto-refreshes on `auth-expired` — `uploadFile` calls `doUploadFileImpl`
   * directly and a normalized `auth-expired` surfaces to the caller unchanged
   * (the caller retries via `withAuthRefresh`). uploadFile is bus-exempt, so
   * the ONLY base-layer wrapper retained here is error normalization: a
   * `normalizeError` pass converts any raw provider exception (or raw marker)
   * into a `DatasourceError` before it crosses the boundary, with NO bus
   * emission.
   */
  async uploadFile(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    options?: {
      signal?: AbortSignal;
      onProgress?: (loaded: number, total: number) => void;
    },
  ): Promise<DatasourceFileEntry<T>> {
    try {
      return await this.doUploadFileImpl(parent, file, options ?? {});
    } catch (err) {
      // Normalize-only (no bus emission — uploadFile is bus-exempt). A
      // normalized `auth-expired` propagates raw so the consumer's
      // `withAuthRefresh` wrap can detect it and refresh.
      throw this.ensureNormalized(err);
    }
  }

  async deleteFile(target: Target): Promise<void> {
    try {
      await this.doDeleteFileImpl(target);
    } catch (err) {
      // Normalize-only — the engine no longer emits `deleted` /
      // `delete-failed` (migrate-engine-events-to-consumer Decision 1).
      throw this.ensureNormalized(err);
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
   * Rename wrapper. The base calls `doRenameImpl` directly (per
   * migrate-engine-retry-policy-to-consumer Decision 1 — no auto-refresh; a
   * normalized `auth-expired` surfaces raw and the consumer retries via
   * `withAuthRefresh`) and returns the renamed entry on success. Failures are
   * normalized and rethrown — the engine no longer emits any event
   * (migrate-engine-events-to-consumer Decision 1).
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
      return await this.doRenameImpl(target, newName, conflictPolicy);
    } catch (err) {
      throw this.ensureNormalized(err);
    }
  }

  /**
   * Download wrapper (per add-engine-rename-download design.md Decision 3).
   * The base calls `doDownloadFileImpl` directly (per
   * migrate-engine-retry-policy-to-consumer Decision 1 — no auto-refresh on
   * `auth-expired`; the consumer's download handler refreshes via
   * `refreshCredentials()` and re-issues the GET with `rangeStart`) and
   * returns the strategy's `{ stream, contentLength, contentRange }`
   * unchanged. An initial-call failure (no stream returned) is normalized and
   * rethrown.
   *
   * The engine no longer emits any download lifecycle events nor attaches
   * stream listeners (migrate-engine-events-to-consumer Decision 1): progress
   * flows solely via `options.onProgress` (the strategy's byte-counting hook),
   * and fs-sync's download handler owns terminal handling
   * (`file-downloaded` / `download-failed` / `download-cancelled`) off its own
   * synchronous pipe-to-disk path.
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
    try {
      return await this.doDownloadFileImpl(target, options);
    } catch (err) {
      // Initial-call failure (no stream returned). The base does NOT refresh
      // here (Decision 1) — a normalized `auth-expired` surfaces raw to the
      // consumer's download handler, which owns the refresh-and-re-issue
      // (migrate-engine-retry-policy-to-consumer Decision 5). The strategy's
      // `normalizeErrorImpl` maps AbortError → `tag: "cancelled"`, so an
      // aborted initial call rejects with a `cancelled` DatasourceError; the
      // consumer classifies cancellation from its own AbortController state.
      throw this.ensureNormalized(err);
    }
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
    // Delegate to the shared read-op wrapper (normalize-only — parity with
    // listDirectory / search / getMetadata). The capability-gate above
    // short-circuits BEFORE runReadOp.
    return this.runReadOp(() => this.doGetQuotaImpl());
  }

  /**
   * Release any host-level resources the client holds. The base implementation
   * is a no-op — subclasses that hold timers or own external handles override
   * this and call their own teardown (MAY call `super.dispose()` but it is not
   * required). No strategy subscribes to any bus (the engine event bus was
   * removed in migrate-engine-events-to-consumer).
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
   * Read-op wrapper (list / search / getMetadata / getQuota): normalize-only.
   * Any raw provider exception is converted into a `DatasourceError<T>` and
   * rethrown — the engine no longer emits `rate-limited` / `status-changed`
   * (migrate-engine-events-to-consumer Decision 1).
   */
  private async runReadOp<R>(op: () => Promise<R>): Promise<R> {
    try {
      return await op();
    } catch (err) {
      throw this.ensureNormalized(err);
    }
  }

  /**
   * Public single-flight credential refresh (per
   * migrate-engine-retry-policy-to-consumer Decisions 2 + 7). The base does
   * NOT auto-invoke this around operations — callers invoke it explicitly
   * (typically via the exported `withAuthRefresh` helper) after observing an
   * `auth-expired` error.
   *
   * The shared promise covers `refreshTokenImpl()` + persistence as a single
   * end-to-end cycle, so concurrent callers on the same client instance share
   * exactly one refresh (one `refreshTokenImpl` call, one `put`). The
   * refreshed `AuthResult` is persisted via `CredentialStore.put` BEFORE the
   * returned promise resolves. The `refreshPromise` field is cleared after the
   * cycle completes (success or failure) so a subsequent failure can re-enter
   * with a fresh cycle.
   *
   * On refresh failure (the strategy's `refreshTokenImpl` rejects, OR the
   * subsequent `put` rejects) the cycle rejects. When the underlying refresh
   * itself threw a typed `DatasourceError` that error propagates unchanged;
   * otherwise the cycle synthesizes one tagged `auth-expired` carrying the raw
   * cause. The engine no longer emits `token-refreshed` / `token-expired` /
   * `authentication-failed` (migrate-engine-events-to-consumer Decision 1).
   */
  refreshCredentials(): Promise<AuthResult> {
    if (this.refreshPromise !== null) return this.refreshPromise;
    // The stored promise covers refreshTokenImpl → persist as a single
    // end-to-end cycle so concurrent callers share exactly one refresh.
    const cycle = (async (): Promise<AuthResult> => {
      try {
        const result = await this.refreshTokenImpl();
        // Persist BEFORE the promise resolves so a crash post-refresh does not
        // lose the token. A put rejection routes to the catch below.
        await this.persistCredentials(result);
        return result;
      } catch (refreshErr) {
        // Refresh (or persistence) failed: normalize and reject. When refresh
        // rejected with a DatasourceError we reuse it; otherwise synthesize
        // one tagged `auth-expired` carrying the raw cause.
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
        throw refreshNormalized;
      }
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
      // Normalize-only — the engine no longer emits `authentication-failed`
      // (migrate-engine-events-to-consumer Decision 1).
      throw err instanceof DatasourceError
        ? (err as DatasourceError<T>)
        : this.normalizeErrorImpl(err);
    }
    await this.persistCredentials(result);
    return result;
  }
}
