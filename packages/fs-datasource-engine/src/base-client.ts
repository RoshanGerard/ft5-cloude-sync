// BaseDatasourceClient — the Template base for every datasource strategy.
//
// Every public operation on a `DatasourceClient<T>` is implemented ONCE here.
// Concrete strategies (S3, OneDrive, Google Drive — landing in Phases 6-8)
// extend this class and implement only the `protected abstract doX(...)`
// primitives plus `refreshToken()` and `normalizeError()`.
//
// Crossing-cutting responsibilities centralised here:
//   1. Event emission (pre-op, post-op, failure) via the injected `EventBus`.
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
  FileEntry,
  FileMetadata,
  OAuthIntent,
  PayloadMap,
  ProviderDescriptor,
  Quota,
  StoredCredentials,
  Target,
} from "@ft5/ipc-contracts";
import { DatasourceError, serializeDatasourceError } from "@ft5/ipc-contracts";

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
 * The engine's public Strategy surface. Consumers program against this
 * interface — not against concrete client classes.
 */
export interface DatasourceClient<T extends DatasourceType> {
  readonly type: T;
  readonly datasourceId: string;
  status(): Promise<DatasourceStatus>;
  testConnection(): Promise<void>;
  authenticate(): Promise<AuthIntent>;
  listDirectory(target: Target): Promise<FileEntry<T>[]>;
  search(query: string, scope?: Target): Promise<FileEntry<T>[]>;
  getMetadata(target: Target): Promise<FileMetadata<T>>;
  createFile(
    parent: Target,
    name: string,
    content: { path: string },
  ): Promise<FileEntry<T>>;
  uploadFile(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
  ): Promise<FileEntry<T>>;
  deleteFile(target: Target): Promise<void>;
  deleteDirectory(target: Target): Promise<never>;
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
// Internal: emit helper carries the envelope wrapping for every method.
// ---------------------------------------------------------------------------

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
  ): Promise<FileEntry<T>[]>;
  protected abstract doSearchImpl(
    query: string,
    scope?: Target,
  ): Promise<FileEntry<T>[]>;
  protected abstract doGetMetadataImpl(
    target: Target,
  ): Promise<FileMetadata<T>>;
  protected abstract doCreateFileImpl(
    parent: Target,
    name: string,
    content: { path: string },
  ): Promise<FileEntry<T>>;
  /**
   * Primitive for `uploadFile()`. Base invokes this with an `onProgress`
   * callback; strategies that support streaming progress (e.g., S3 via
   * `@aws-sdk/lib-storage` `Upload.on("httpUploadProgress", ...)`) should
   * call `onProgress(loaded, total)` repeatedly during the upload. The base
   * converts those calls into `streaming: true` `uploading` events on the
   * bus sharing the original `transactionId` so the bus coalescer can
   * throttle them per Decision 5. Strategies without per-chunk progress
   * signals MAY omit the callback entirely — the base's pre-op `uploading`
   * event plus the terminal `file-created` event still fire.
   */
  protected abstract doUploadFileImpl(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<FileEntry<T>>;
  protected abstract doDeleteFileImpl(target: Target): Promise<void>;
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

  async listDirectory(target: Target): Promise<FileEntry<T>[]> {
    return this.runReadOp(() => this.doListDirectoryImpl(target));
  }

  async search(query: string, scope?: Target): Promise<FileEntry<T>[]> {
    return this.runReadOp(() => this.doSearchImpl(query, scope));
  }

  async getMetadata(target: Target): Promise<FileMetadata<T>> {
    return this.runReadOp(() => this.doGetMetadataImpl(target));
  }

  async createFile(
    parent: Target,
    name: string,
    content: { path: string },
  ): Promise<FileEntry<T>> {
    // `createFile` has no streaming pre-op but emits `file-created` on
    // success. Failure routes through `upload-failed` with `via: "createFile"`
    // because `CanonicalEventPayloads` does not (yet) carry a `create-failed`
    // name. Flagged as a Phase-3 concern; see report.
    try {
      const entry = await this.withRefresh(() =>
        this.doCreateFileImpl(parent, name, content),
      );
      this.emit("file-created", false, {
        path: entry.path,
        handle: entry.handle,
        via: "createFile",
      });
      return entry;
    } catch (err) {
      const normalized = this.ensureNormalized(err);
      if (normalized.tag !== "unsupported") {
        this.emit("upload-failed", false, {
          tag: normalized.tag,
          message: normalized.message,
          via: "createFile",
        });
      }
      throw normalized;
    }
  }

  async uploadFile(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
  ): Promise<FileEntry<T>> {
    const transactionId = this.newTransactionId();
    // Pre-op: streaming-flagged so the bus runs it through the coalescing
    // filter. Post-op and failure are terminal.
    this.emit("uploading", true, {
      transactionId,
      progress: 0,
      path: file.path,
    });
    // Progress callback handed to the strategy. Strategies that support
    // streaming progress (e.g., S3 via `@aws-sdk/lib-storage` `Upload`)
    // invoke this with (loaded, total) on each chunk tick; the base
    // translates it into a `streaming: true` `uploading` event carrying the
    // same `transactionId` so the bus coalescer at Decision 5 groups ticks
    // per-upload. `total === 0` (SDK emits progress before content-length
    // is known) is handled defensively — progress stays at 0 for that tick.
    const onProgress = (loaded: number, total: number): void => {
      const progress =
        total > 0 ? Math.max(0, Math.min(100, (loaded / total) * 100)) : 0;
      this.emit("uploading", true, {
        transactionId,
        progress,
        path: file.path,
      });
    };
    try {
      const entry = await this.withRefresh(() =>
        this.doUploadFileImpl(parent, file, onProgress),
      );
      this.emit("file-created", false, {
        transactionId,
        path: entry.path,
        handle: entry.handle,
      });
      return entry;
    } catch (err) {
      const normalized = this.ensureNormalized(err);
      if (normalized.tag !== "unsupported") {
        this.emit("upload-failed", false, {
          transactionId,
          tag: normalized.tag,
          message: normalized.message,
        });
      }
      throw normalized;
    }
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

  private newTransactionId(): string {
    // Sufficient for event coalescing; not a security token. Phase 6+ may
    // swap in a crypto-grade id if any consumer treats it as one.
    return `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
