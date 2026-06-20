import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import type {
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  DatasourceStatus,
  DatasourceFileEntry,
  FileMetadata,
  ProviderDescriptor,
  Quota,
  StoredCredentials,
  Target,
} from "@ft5/ipc-contracts";
import { DatasourceError, DatasourceErrorTag } from "@ft5/ipc-contracts";

import {
  BaseDatasourceClient,
  type BaseClientContext,
  type CredentialStore,
} from "./base-client.js";

// ---------------------------------------------------------------------------
// Test fixture: FakeDatasourceClient extends BaseDatasourceClient<"amazon-s3">.
// The fake wires its abstract doX methods to `vi.fn()` spies whose behaviour
// each test configures. `"amazon-s3"` is chosen as the test type because it is
// an existing valid DatasourceType with a full CanonicalEventPayloads entry.
// ---------------------------------------------------------------------------

type FakeType = "amazon-s3";

interface FakeConfig {
  doStatus?: () => Promise<DatasourceStatus>;
  doTestConnection?: () => Promise<void>;
  doAuthenticate?: () => Promise<AuthIntent>;
  doListDirectory?: (
    target: Target,
    options: { cursor?: string; pageSize?: number },
  ) => Promise<{ entries: DatasourceFileEntry<FakeType>[]; nextCursor: string | null }>;
  doSearch?: (query: string, scope?: Target) => Promise<DatasourceFileEntry<FakeType>[]>;
  doGetMetadata?: (target: Target) => Promise<FileMetadata<FakeType>>;
  doUploadFile?: (
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    options: {
      signal?: AbortSignal;
      onProgress?: (loaded: number, total: number) => void;
    },
  ) => Promise<DatasourceFileEntry<FakeType>>;
  doDeleteFile?: (target: Target) => Promise<void>;
  doRename?: (
    target: Target,
    newName: string,
    conflictPolicy: "fail" | "overwrite" | "keep-both",
  ) => Promise<DatasourceFileEntry<FakeType>>;
  doDownloadFile?: (
    target: Target,
    options: DownloadOptions,
  ) => Promise<DownloadResult>;
  doGetQuota?: () => Promise<Quota>;
  refreshToken?: () => Promise<AuthResult>;
  normalizeError?: (raw: unknown) => DatasourceError<FakeType>;
}

interface DownloadOptions {
  rangeStart?: number;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number | null) => void;
}

interface DownloadResult {
  stream: Readable;
  contentLength: number | null;
  contentRange?: { start: number; end: number; total: number };
}

function makeEntry(path = "/demo.txt"): DatasourceFileEntry<FakeType> {
  return {
    path,
    handle: `handle:${path}`,
    name: path.split("/").pop() ?? path,
    kind: "file",
    modifiedAt: 0,
    mimeFamily: "document",
    // Phase 6 tightened `ProviderMetadata<"amazon-s3">` to the S3-native
    // field set — the fake must populate a valid shape so this file's
    // type-level tests don't regress when the contract is tightened.
    providerMetadata: {
      bucket: "fake-bucket",
      key: path.replace(/^\//, ""),
    },
  };
}

class FakeDatasourceClient extends BaseDatasourceClient<FakeType> {
  readonly type: FakeType = "amazon-s3";

  readonly doStatus = vi.fn<() => Promise<DatasourceStatus>>();
  readonly doTestConnection = vi.fn<() => Promise<void>>();
  readonly doAuthenticate = vi.fn<() => Promise<AuthIntent>>();
  readonly doListDirectory = vi.fn<
    (
      target: Target,
      options: { cursor?: string; pageSize?: number },
    ) => Promise<{ entries: DatasourceFileEntry<FakeType>[]; nextCursor: string | null }>
  >();
  readonly doSearch = vi.fn<
    (query: string, scope?: Target) => Promise<DatasourceFileEntry<FakeType>[]>
  >();
  readonly doGetMetadata = vi.fn<
    (target: Target) => Promise<FileMetadata<FakeType>>
  >();
  readonly doUploadFile = vi.fn<
    (
      parent: Target,
      file: { path: string; name?: string; mimeType?: string },
      options: {
        signal?: AbortSignal;
        onProgress?: (loaded: number, total: number) => void;
      },
    ) => Promise<DatasourceFileEntry<FakeType>>
  >();
  readonly doDeleteFile = vi.fn<(target: Target) => Promise<void>>();
  readonly doRename = vi.fn<
    (
      target: Target,
      newName: string,
      conflictPolicy: "fail" | "overwrite" | "keep-both",
    ) => Promise<DatasourceFileEntry<FakeType>>
  >();
  readonly doDownloadFile = vi.fn<
    (target: Target, options: DownloadOptions) => Promise<DownloadResult>
  >();
  readonly doGetQuotaSpy = vi.fn<() => Promise<Quota>>();
  readonly refreshTokenSpy = vi.fn<() => Promise<AuthResult>>();
  readonly normalizeErrorSpy = vi.fn<(raw: unknown) => DatasourceError<FakeType>>();

  constructor(
    init: { datasourceId: string; ctx: BaseClientContext },
    cfg: FakeConfig = {},
  ) {
    super(init);

    if (cfg.doStatus) this.doStatus.mockImplementation(cfg.doStatus);
    else this.doStatus.mockResolvedValue("connected");

    if (cfg.doTestConnection)
      this.doTestConnection.mockImplementation(cfg.doTestConnection);
    else this.doTestConnection.mockResolvedValue(undefined);

    if (cfg.doAuthenticate)
      this.doAuthenticate.mockImplementation(cfg.doAuthenticate);

    if (cfg.doListDirectory)
      this.doListDirectory.mockImplementation(cfg.doListDirectory);
    else this.doListDirectory.mockResolvedValue({ entries: [], nextCursor: null });

    if (cfg.doSearch) this.doSearch.mockImplementation(cfg.doSearch);
    else this.doSearch.mockResolvedValue([]);

    if (cfg.doGetMetadata)
      this.doGetMetadata.mockImplementation(cfg.doGetMetadata);
    else this.doGetMetadata.mockResolvedValue(makeEntry());

    if (cfg.doUploadFile)
      this.doUploadFile.mockImplementation(cfg.doUploadFile);
    else this.doUploadFile.mockResolvedValue(makeEntry());

    if (cfg.doDeleteFile)
      this.doDeleteFile.mockImplementation(cfg.doDeleteFile);
    else this.doDeleteFile.mockResolvedValue(undefined);

    if (cfg.doRename) this.doRename.mockImplementation(cfg.doRename);
    else this.doRename.mockResolvedValue(makeEntry());

    if (cfg.doDownloadFile)
      this.doDownloadFile.mockImplementation(cfg.doDownloadFile);
    else
      this.doDownloadFile.mockResolvedValue({
        stream: Readable.from([]),
        contentLength: 0,
      });

    if (cfg.doGetQuota)
      this.doGetQuotaSpy.mockImplementation(cfg.doGetQuota);
    else this.doGetQuotaSpy.mockResolvedValue({ used: 0, quota: 0 });

    if (cfg.refreshToken)
      this.refreshTokenSpy.mockImplementation(cfg.refreshToken);
    else
      this.refreshTokenSpy.mockResolvedValue({ accessToken: "refreshed" });

    if (cfg.normalizeError)
      this.normalizeErrorSpy.mockImplementation(cfg.normalizeError);
    else this.normalizeErrorSpy.mockImplementation(defaultNormalize(this));
  }

  // Expose the abstract-method hooks to the base via the configured spies.
  protected doStatusImpl(): Promise<DatasourceStatus> {
    return this.doStatus();
  }
  protected doTestConnectionImpl(): Promise<void> {
    return this.doTestConnection();
  }
  protected doAuthenticateImpl(): Promise<AuthIntent> {
    return this.doAuthenticate();
  }
  protected doListDirectoryImpl(
    target: Target,
    options: { cursor?: string; pageSize?: number },
  ): Promise<{ entries: DatasourceFileEntry<FakeType>[]; nextCursor: string | null }> {
    return this.doListDirectory(target, options);
  }
  protected doSearchImpl(
    query: string,
    scope?: Target,
  ): Promise<DatasourceFileEntry<FakeType>[]> {
    return this.doSearch(query, scope);
  }
  protected doGetMetadataImpl(target: Target): Promise<FileMetadata<FakeType>> {
    return this.doGetMetadata(target);
  }
  protected doUploadFileImpl(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    options: {
      signal?: AbortSignal;
      onProgress?: (loaded: number, total: number) => void;
    },
  ): Promise<DatasourceFileEntry<FakeType>> {
    return this.doUploadFile(parent, file, options);
  }
  protected doDeleteFileImpl(target: Target): Promise<void> {
    return this.doDeleteFile(target);
  }
  protected doRenameImpl(
    target: Target,
    newName: string,
    conflictPolicy: "fail" | "overwrite" | "keep-both",
  ): Promise<DatasourceFileEntry<FakeType>> {
    return this.doRename(target, newName, conflictPolicy);
  }
  protected doDownloadFileImpl(
    target: Target,
    options: DownloadOptions,
  ): Promise<DownloadResult> {
    return this.doDownloadFile(target, options);
  }
  protected doGetQuotaImpl(): Promise<Quota> {
    return this.doGetQuotaSpy();
  }
  protected refreshTokenImpl(): Promise<AuthResult> {
    return this.refreshTokenSpy();
  }
  protected normalizeErrorImpl(raw: unknown): DatasourceError<FakeType> {
    return this.normalizeErrorSpy(raw);
  }
}

function defaultNormalize(
  client: FakeDatasourceClient,
): (raw: unknown) => DatasourceError<FakeType> {
  return (raw) => {
    if (raw instanceof DatasourceError) return raw as DatasourceError<FakeType>;
    const tagged = raw as { __tag?: string; __retryAfterMs?: number } | null;
    const tag = tagged?.__tag ?? "provider-error";
    return new DatasourceError<FakeType>({
      tag: tag as DatasourceError<FakeType>["tag"],
      datasourceType: client.type,
      datasourceId: client.datasourceId,
      retryable: tag === DatasourceErrorTag.RateLimited || tag === DatasourceErrorTag.NetworkError,
      raw,
    });
  };
}

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function makeProviderDescriptor(quota = true): ProviderDescriptor {
  return {
    id: "amazon-s3",
    displayName: "Amazon S3",
    icon: "database",
    capabilities: { quota, oauth: false, directUpload: true },
    credentialsSchema: "aws-access-key",
  };
}

function makeStore(): CredentialStore & {
  putMock: ReturnType<typeof vi.fn>;
  getMock: ReturnType<typeof vi.fn>;
  deleteMock: ReturnType<typeof vi.fn>;
} {
  const putMock = vi.fn<(id: string, c: StoredCredentials) => Promise<void>>();
  putMock.mockResolvedValue(undefined);
  const getMock = vi.fn<(id: string) => Promise<StoredCredentials | null>>();
  getMock.mockResolvedValue(null);
  const deleteMock = vi.fn<(id: string) => Promise<void>>();
  deleteMock.mockResolvedValue(undefined);
  return {
    get: (id) => getMock(id),
    put: (id, creds) => putMock(id, creds),
    delete: (id) => deleteMock(id),
    putMock,
    getMock,
    deleteMock,
  };
}

interface Harness {
  store: ReturnType<typeof makeStore>;
  descriptor: ProviderDescriptor;
  client: FakeDatasourceClient;
}

function makeHarness(cfg: FakeConfig = {}, quotaCap = true): Harness {
  const store = makeStore();
  const descriptor = makeProviderDescriptor(quotaCap);
  const client = new FakeDatasourceClient(
    {
      datasourceId: "ds-1",
      ctx: { credentialStore: store, providerDescriptor: descriptor },
    },
    cfg,
  );
  return { store, descriptor, client };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Successful op: returns the typed result; no bus side effects
// (the engine event bus was removed in migrate-engine-events-to-consumer).
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — success path", () => {
  it("uploadFile resolves with the entry and drives the consumer's onProgress", async () => {
    const onProgress = vi.fn<(loaded: number, total: number) => void>();
    const { client } = makeHarness({
      doUploadFile: async (_parent, _file, options) => {
        // Strategies invoke the consumer's onProgress callback as bytes
        // flow. Simulate two ticks plus a final at total.
        options.onProgress?.(0, 1000);
        options.onProgress?.(500, 1000);
        options.onProgress?.(1000, 1000);
        return makeEntry("/demo.txt");
      },
    });

    const result = await client.uploadFile(
      { kind: "path", path: "/parent" },
      { path: "C:/tmp/demo.txt", name: "demo.txt" },
      { onProgress },
    );

    expect(result.path).toBe("/demo.txt");
    // Consumer's onProgress callback DID fire with monotonic non-decreasing
    // loaded values (the strategy's contract). This is the only progress
    // channel — the engine emits nothing.
    expect(onProgress).toHaveBeenCalledTimes(3);
    const calls = onProgress.mock.calls;
    expect(calls[0]).toEqual([0, 1000]);
    expect(calls[1]).toEqual([500, 1000]);
    expect(calls[2]).toEqual([1000, 1000]);
  });
});

// ---------------------------------------------------------------------------
// uploadFile forwards options.onProgress directly to doUploadFileImpl.
// Strategies invoke it (loaded, total) as bytes flow. The base does NOT
// emit any event (per migrate-upload-orchestration-out-of-engine and
// migrate-engine-events-to-consumer) — the consumer (fs-sync handler) owns
// throttle + event emission.
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — uploadFile options forwarding", () => {
  it("options.onProgress is forwarded to doUploadFileImpl", async () => {
    let captured: ((loaded: number, total: number) => void) | undefined;

    const { client } = makeHarness({
      doUploadFile: async (_parent, _file, options) => {
        captured = options.onProgress;
        // Simulate mid-upload progress ticks.
        options.onProgress?.(500, 1000);
        options.onProgress?.(1000, 1000);
        return makeEntry("/demo.txt");
      },
    });

    const onProgress = vi.fn<(loaded: number, total: number) => void>();
    await client.uploadFile(
      { kind: "path", path: "/parent" },
      { path: "C:/tmp/demo.txt", name: "demo.txt" },
      { onProgress },
    );

    // The base forwarded the consumer's callback down to the strategy.
    expect(typeof captured).toBe("function");
    expect(captured).toBe(onProgress);
    // The strategy's two ticks reached the consumer's callback.
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0]).toEqual([500, 1000]);
    expect(onProgress.mock.calls[1]).toEqual([1000, 1000]);
  });

  it("options.signal is forwarded to doUploadFileImpl; abort propagates as DatasourceError(cancelled)", async () => {
    // The consumer constructs an AbortController, passes its signal to
    // uploadFile, aborts mid-upload. The strategy detects the abort and
    // rejects with DatasourceError { tag: "cancelled" }. The wrapper
    // propagates the rejection.
    const { client } = makeHarness({
      doUploadFile: (_parent, _file, options) =>
        new Promise<DatasourceFileEntry<FakeType>>((_res, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(
              new DatasourceError<FakeType>({
                tag: DatasourceErrorTag.Cancelled,
                datasourceType: "amazon-s3",
                datasourceId: "ds-1",
                retryable: false,
                message: "upload cancelled",
              }),
            );
          });
        }),
    });

    const controller = new AbortController();
    const promise = client.uploadFile(
      { kind: "path", path: "/parent" },
      { path: "C:/tmp/big.bin" },
      { signal: controller.signal },
    );
    // Abort on the next microtask so the strategy's signal listener has
    // been registered.
    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DatasourceError &&
        e.tag === DatasourceErrorTag.Cancelled &&
        e.retryable === false,
    );
  });

  // The former "withRefresh still applies to uploadFile — auth-expired
  // refreshes once and retries" case was retired by
  // migrate-engine-retry-policy-to-consumer (Decision 1): the engine no longer
  // auto-refreshes on `auth-expired`. uploadFile now surfaces a normalized
  // `auth-expired` raw (see the inversion guard below), and the
  // refresh-once-then-retry behaviour is owned by the consumer via the
  // exported `withAuthRefresh` helper — exercised in `with-auth-refresh.test.ts`.
});

// Note: the legacy "transactionId / progress percentage" assertions and
// the "total=0 defensive" test are obsolete post-migrate-upload-
// orchestration-out-of-engine — the base no longer translates onProgress
// into a transactionId-keyed event with percentage. The consumer
// (fs-sync handler) owns that translation.


// ---------------------------------------------------------------------------
// Failing op: throws normalized error (no bus side effects)
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — failure path normalization", () => {
  it("uploadFile rejects with a normalized DatasourceError carrying the strategy's tag", async () => {
    const { client } = makeHarness({
      doUploadFile: async () => {
        throw { __tag: "network-error" };
      },
    });

    let caught: unknown;
    try {
      await client.uploadFile(
        { kind: "path", path: "/parent" },
        { path: "C:/tmp/demo.txt" },
      );
    } catch (e) {
      caught = e;
    }

    // The wrapper still applies normalizeError — the rejection surfaces
    // as a DatasourceError carrying the strategy's tag.
    expect(caught).toBeInstanceOf(DatasourceError);
    expect((caught as DatasourceError).tag).toBe("network-error");
  });

  it("delete (file) failure throws a normalized DatasourceError", async () => {
    const { client } = makeHarness({
      doDeleteFile: async () => {
        throw { __tag: "not-found" };
      },
    });

    await expect(
      client.delete({ kind: "path", path: "/gone.txt" }, "file"),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DatasourceError && e.tag === DatasourceErrorTag.NotFound,
    );
  });

});

// ---------------------------------------------------------------------------
// The "BaseDatasourceClient — cancelUpload" describe block was removed by
// migrate-upload-orchestration-out-of-engine. The base no longer exposes
// `cancelUpload`; cancellation is consumer-driven via `options.signal`
// on `uploadFile`. The signal-driven semantics are exercised by the
// "options.signal is forwarded …" scenario in the
// "BaseDatasourceClient — uploadFile options forwarding" describe above
// and by per-strategy cancel tests in each strategy's own *.test.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Unsupported error does NOT emit a failed event
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — Unsupported errors throw without side effects", () => {
  it("getMetadata with Unsupported throws the normalized `unsupported` error", async () => {
    const { client } = makeHarness({
      doGetMetadata: async () => {
        throw { __tag: "unsupported" };
      },
    });

    await expect(
      client.getMetadata({ kind: "path", path: "/x" }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DatasourceError && e.tag === DatasourceErrorTag.Unsupported,
    );
  });
});

// ---------------------------------------------------------------------------
// Public refreshCredentials() — single-flight credential refresh
// ---------------------------------------------------------------------------
//
// migrate-engine-retry-policy-to-consumer Decisions 2 + 7: the base no longer
// auto-refreshes around operations (see the inversion guard below). Instead it
// exposes a PUBLIC single-flight `refreshCredentials()` that callers invoke
// explicitly (typically via the exported `withAuthRefresh` helper) after
// observing an `auth-expired` error. These cases were transformed from the
// former engine-owned `withRefresh` single-flight / persist / failure-events
// tests — their intent now belongs to the public method, exercised directly
// here rather than through an op that throws `auth-expired`. The one-shot
// refresh-then-retry behaviour those op-driven tests used to cover now lives
// in `with-auth-refresh.test.ts`.

describe("BaseDatasourceClient — public refreshCredentials() single-flight", () => {
  it("5 concurrent refreshCredentials() calls trigger exactly one refreshTokenImpl + one put; all resolve with the same AuthResult", async () => {
    const refreshed: AuthResult = { accessToken: "new-token" };
    const { client, store } = makeHarness({
      refreshToken: async () => refreshed,
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.refreshCredentials()),
    );

    // refreshTokenImpl was called exactly once across the 5 concurrent callers.
    expect(client.refreshTokenSpy).toHaveBeenCalledTimes(1);
    // credentialStore.put was called exactly once. (The engine no longer
    // emits token-refreshed — single-flight is proven via the spy + put +
    // shared AuthResult, per migrate-engine-events-to-consumer.)
    expect(store.putMock).toHaveBeenCalledTimes(1);
    // all 5 callers resolved with the same refreshed AuthResult.
    for (const r of results) {
      expect(r).toEqual(refreshed);
    }
  });

  it("5 concurrent refreshCredentials() calls that ALL fail share ONE refresh cycle; all reject with auth-expired; put NOT called", async () => {
    // Regression guard (engine code-review Minor #1). The single-flight cycle
    // holds on the failure path: N concurrent failing callers observe exactly
    // one refreshTokenImpl call and all share the same rejection — NOT N
    // independent cycles. (The engine no longer emits token-expired /
    // authentication-failed — that emission moved to the consumer in
    // migrate-engine-events-to-consumer; single-flight is now proven via the
    // refreshTokenImpl spy + the shared rejection.)
    const { client, store } = makeHarness({
      refreshToken: async () => {
        throw new Error("refresh exploded");
      },
    });

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => client.refreshCredentials()),
    );

    // Single-flight holds on the failure path too: exactly one refresh attempt.
    expect(client.refreshTokenSpy).toHaveBeenCalledTimes(1);
    // No persistence on failure.
    expect(store.putMock).not.toHaveBeenCalled();
    // All 5 callers reject with the shared auth-expired error.
    expect(settled).toHaveLength(5);
    for (const s of settled) {
      expect(s.status).toBe("rejected");
      if (s.status === "rejected") {
        expect(s.reason).toBeInstanceOf(DatasourceError);
        expect((s.reason as DatasourceError).tag).toBe("auth-expired");
      }
    }
  });

  it("persists refreshed credentials to the store BEFORE the promise resolves", async () => {
    const callOrder: string[] = [];

    const store = makeStore();
    store.putMock.mockImplementation(async () => {
      callOrder.push("put");
    });

    const descriptor = makeProviderDescriptor();
    const client = new FakeDatasourceClient(
      {
        datasourceId: "ds-1",
        ctx: { credentialStore: store, providerDescriptor: descriptor },
      },
      {
        refreshToken: async () => {
          callOrder.push("refreshToken");
          return { accessToken: "new-token" };
        },
      },
    );

    await client.refreshCredentials();
    // `put` is recorded only after it is awaited; the resolve below sees it.
    callOrder.push("resolved");

    // Expected ordering:
    //   refreshToken (the strategy primitive)
    //   put (persisted BEFORE the promise resolves)
    //   resolved (the awaited refreshCredentials() returned)
    expect(callOrder).toEqual(["refreshToken", "put", "resolved"]);
  });

  it("refresh failure (refreshTokenImpl throws) rejects with AuthExpired; put NOT called", async () => {
    const { client, store } = makeHarness({
      refreshToken: async () => {
        throw new Error("refresh exploded");
      },
    });

    let caught: unknown;
    try {
      await client.refreshCredentials();
    } catch (e) {
      caught = e;
    }

    // The refresh-failure path wraps the raw refresh exception into a
    // `DatasourceError` tagged `auth-expired` carrying the raw cause. The
    // engine no longer emits token-expired / authentication-failed events —
    // the rejection IS the contract (migrate-engine-events-to-consumer).
    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError;
    expect(err.tag).toBe("auth-expired");
    expect(err.retryable).toBe(false);
    // `raw` preserves the original refresh exception for diagnostics.
    expect((err as unknown as { raw?: unknown }).raw).toBeDefined();

    // Store was NOT updated with new credentials.
    expect(store.putMock).not.toHaveBeenCalled();
  });

  it("refresh succeeds but credentialStore.put rejects → routed through the refresh-failed path", async () => {
    // Documented behaviour: a storage failure inside the refresh cycle
    // reframes as auth-expired. Host implementations must surface storage
    // failures via their own logging. See class docstring.
    const putError = new Error("disk full");
    const store = makeStore();
    store.putMock.mockRejectedValue(putError);

    const descriptor = makeProviderDescriptor();
    const client = new FakeDatasourceClient(
      {
        datasourceId: "ds-1",
        ctx: { credentialStore: store, providerDescriptor: descriptor },
      },
      {
        // refreshTokenImpl resolves with a valid AuthResult — the failure
        // is entirely in the credential-store `put`.
        refreshToken: async () => ({ accessToken: "freshly-minted" }),
      },
    );

    let caught: unknown;
    try {
      await client.refreshCredentials();
    } catch (e) {
      caught = e;
    }

    // The put rejection reframes as a synthesized `auth-expired`
    // DatasourceError carrying the credential-store exception as `raw`.
    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError;
    expect(err.tag).toBe("auth-expired");
    expect((err as unknown as { raw?: unknown }).raw).toBeDefined();

    // put was attempted exactly once; its error is NOT re-surfaced as a
    // distinct error to the caller.
    expect(store.putMock).toHaveBeenCalledTimes(1);
  });

  it("reuses a typed DatasourceError when refreshTokenImpl throws one (does not re-synthesize)", async () => {
    // When refreshTokenImpl rejects with a typed DatasourceError, the failure
    // path surfaces THAT error unchanged rather than wrapping it in a fresh
    // synthesized `auth-expired` (per the spec: synthesis happens only when the
    // underlying refresh did not itself produce a typed DatasourceError).
    const typed = new DatasourceError<FakeType>({
      tag: DatasourceErrorTag.AuthRevoked,
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
      message: "refresh token revoked by provider",
    });
    const { client } = makeHarness({
      refreshToken: async () => {
        throw typed;
      },
    });

    let caught: unknown;
    try {
      await client.refreshCredentials();
    } catch (e) {
      caught = e;
    }

    // The exact typed instance propagates unchanged.
    expect(caught).toBe(typed);
  });
});

// ---------------------------------------------------------------------------
// Inversion guard — operations surface auth-expired RAW (no engine refresh)
// ---------------------------------------------------------------------------
//
// migrate-engine-retry-policy-to-consumer Decision 1: the base no longer
// wraps operations in `withRefresh`. An operation whose `doXImpl` throws an
// `auth-expired`-tagged error surfaces it to the caller UNCHANGED —
// `refreshTokenImpl` is NOT called and the operation is NOT retried. The
// caller decides whether to call `refreshCredentials()` and retry (typically
// via `withAuthRefresh`). This guard PROVES the old auto-refresh is gone.

describe("BaseDatasourceClient — operations surface auth-expired without auto-retry", () => {
  it("listDirectory: a doListDirectoryImpl auth-expired surfaces raw — refreshTokenImpl NOT called, NO retry", async () => {
    const doListDirectory = vi.fn(
      async (
        target: Target,
        options: { cursor?: string; pageSize?: number },
      ) => {
        void target;
        void options;
        throw new DatasourceError<FakeType>({
          tag: DatasourceErrorTag.AuthExpired,
          datasourceType: "amazon-s3",
          datasourceId: "ds-1",
          retryable: false,
          message: "token expired",
        });
      },
    );

    const { client } = makeHarness({
      doListDirectory: doListDirectory as unknown as (
        target: Target,
        options: { cursor?: string; pageSize?: number },
      ) => Promise<{
        entries: DatasourceFileEntry<FakeType>[];
        nextCursor: string | null;
      }>,
    });

    let caught: unknown;
    try {
      await client.listDirectory({ kind: "path", path: "/root" });
    } catch (e) {
      caught = e;
    }

    // The auth-expired DatasourceError propagated unchanged.
    expect(caught).toBeInstanceOf(DatasourceError);
    expect((caught as DatasourceError).tag).toBe("auth-expired");
    // The engine did NOT refresh.
    expect(client.refreshTokenSpy).not.toHaveBeenCalled();
    // The op was invoked exactly once — no retry.
    expect(doListDirectory).toHaveBeenCalledTimes(1);
  });

  it("uploadFile: a doUploadFileImpl auth-expired surfaces a normalized DatasourceError — refreshTokenImpl NOT called, NO retry", async () => {
    let attempts = 0;
    const { client } = makeHarness({
      doUploadFile: async () => {
        attempts += 1;
        // Throw a RAW (un-normalized) auth-expired marker — the wrapper's
        // normalize-only catch must still turn it into a DatasourceError.
        throw { __tag: "auth-expired" };
      },
    });

    let caught: unknown;
    try {
      await client.uploadFile(
        { kind: "path", path: "/parent" },
        { path: "C:/tmp/x.txt" },
      );
    } catch (e) {
      caught = e;
    }

    // uploadFile is bus-exempt but still normalizes — the caller (and the
    // downstream withAuthRefresh) sees a DatasourceError tagged auth-expired.
    expect(caught).toBeInstanceOf(DatasourceError);
    expect((caught as DatasourceError).tag).toBe("auth-expired");
    // The engine did NOT refresh.
    expect(client.refreshTokenSpy).not.toHaveBeenCalled();
    // The op was invoked exactly once — no retry.
    expect(attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// listDirectory pagination wrapper (add-engine-listdirectory-pagination §1.4)
// ---------------------------------------------------------------------------
//
// The base `listDirectory(target, options?)` wrapper threads the opaque
// pagination options into `doListDirectoryImpl` and surfaces the strategy's
// `{ entries, nextCursor }` shape unchanged. Decision 2: the base treats the
// cursor as opaque — it neither inspects nor normalizes it, and it does NOT
// inject a default pageSize (defaulting is strategy-side). When `options` is
// omitted the base hands the primitive an empty `{}`.

describe("BaseDatasourceClient — listDirectory pagination wrapper", () => {
  it("forwards cursor + pageSize to doListDirectoryImpl unchanged", async () => {
    const doListDirectory = vi.fn(
      async (
        target: Target,
        options: { cursor?: string; pageSize?: number },
      ) => {
        void target;
        void options;
        return { entries: [], nextCursor: null as string | null };
      },
    );
    const { client } = makeHarness({ doListDirectory });

    await client.listDirectory(
      { kind: "path", path: "/photos" },
      { cursor: "opaque-token-abc", pageSize: 250 },
    );

    expect(doListDirectory).toHaveBeenCalledTimes(1);
    expect(doListDirectory).toHaveBeenCalledWith(
      { kind: "path", path: "/photos" },
      { cursor: "opaque-token-abc", pageSize: 250 },
    );
  });

  it("hands the primitive an empty options object when options is omitted (no injected default pageSize)", async () => {
    const doListDirectory = vi.fn(
      async (
        target: Target,
        options: { cursor?: string; pageSize?: number },
      ) => {
        void target;
        void options;
        return { entries: [], nextCursor: null as string | null };
      },
    );
    const { client } = makeHarness({ doListDirectory });

    await client.listDirectory({ kind: "path", path: "/" });

    expect(doListDirectory).toHaveBeenCalledTimes(1);
    const [, passedOptions] = doListDirectory.mock.calls[0]!;
    // The base does NOT inspect or default the cursor/pageSize — Decision 2.
    expect(passedOptions).toEqual({});
  });

  it("surfaces the strategy's { entries, nextCursor } shape unchanged", async () => {
    const entry = makeEntry("/photos/a.txt");
    const doListDirectory = vi.fn(
      async (
        target: Target,
        options: { cursor?: string; pageSize?: number },
      ) => {
        void target;
        void options;
        return {
          entries: [entry],
          nextCursor: "next-page-token-xyz" as string | null,
        };
      },
    );
    const { client } = makeHarness({ doListDirectory });

    const result = await client.listDirectory({ kind: "path", path: "/photos" });

    expect(result.entries).toEqual([entry]);
    expect(result.nextCursor).toBe("next-page-token-xyz");
  });

  it("leaves the error envelope unchanged on rejection (normalized DatasourceError rethrown)", async () => {
    const doListDirectory = vi.fn(
      async (
        target: Target,
        options: { cursor?: string; pageSize?: number },
      ) => {
        void target;
        void options;
        // Raw (un-normalized) provider marker — runReadOp normalizes it.
        throw { __tag: "provider-error" };
      },
    );
    const { client } = makeHarness({
      doListDirectory: doListDirectory as unknown as (
        target: Target,
        options: { cursor?: string; pageSize?: number },
      ) => Promise<{
        entries: DatasourceFileEntry<FakeType>[];
        nextCursor: string | null;
      }>,
    });

    let caught: unknown;
    try {
      await client.listDirectory(
        { kind: "path", path: "/photos" },
        { cursor: "stale", pageSize: 100 },
      );
    } catch (e) {
      caught = e;
    }

    // runReadOp normalizes the raw provider marker and rethrows — the engine
    // no longer emits a status-changed event (migrate-engine-events-to-consumer);
    // the normalized thrown error IS the contract.
    expect(caught).toBeInstanceOf(DatasourceError);
    expect((caught as DatasourceError).tag).toBe("provider-error");
  });
});

// ---------------------------------------------------------------------------
// Unified delete(target, entryKind) — unify-engine-delete-method
// File deletes dispatch to doDeleteFileImpl; directory deletes are refused
// with Unsupported in the BASE (global product policy, Decision 10 relocated
// from the removed deleteDirectory) — identical tag/raw, no strategy call.
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — unified delete(target, entryKind)", () => {
  it("entryKind 'file' dispatches to doDeleteFileImpl and resolves void", async () => {
    const doDeleteFile = vi.fn(async () => undefined);
    const { client } = makeHarness({ doDeleteFile });

    await expect(
      client.delete({ kind: "path", path: "/x.txt" }, "file"),
    ).resolves.toBeUndefined();
    expect(doDeleteFile).toHaveBeenCalledOnce();
  });

  it("entryKind 'directory' throws Unsupported (raw='disabled-for-product-stability') without calling doDeleteFileImpl", async () => {
    const doDeleteFile = vi.fn(async () => undefined);
    const { client } = makeHarness({ doDeleteFile });

    let caught: unknown;
    try {
      await client.delete({ kind: "path", path: "/any" }, "directory");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<FakeType>;
    expect(err.tag).toBe("unsupported");
    expect(err.raw).toBe("disabled-for-product-stability");
    expect(err.retryable).toBe(false);
    expect(doDeleteFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getQuota capability gating
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — getQuota capability gating", () => {
  it("throws Unsupported when provider capability quota=false, without invoking doGetQuota", async () => {
    const harness = makeHarness({}, /* quotaCap */ false);
    const { client } = harness;

    let caught: unknown;
    try {
      await client.getQuota();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<FakeType>;
    expect(err.tag).toBe("unsupported");
    expect(err.raw).toBe("not-supported-by-provider");
    expect(client.doGetQuotaSpy).not.toHaveBeenCalled();
  });

  it("delegates to doGetQuota when provider capability quota=true", async () => {
    const { client } = makeHarness(
      { doGetQuota: async () => ({ used: 42, quota: 100 }) },
      /* quotaCap */ true,
    );

    const q = await client.getQuota();
    expect(q).toEqual({ used: 42, quota: 100 });
    expect(client.doGetQuotaSpy).toHaveBeenCalledTimes(1);
  });

  it("getQuota surfaces a normalized rate-limited error (routed through runReadOp)", async () => {
    const { client } = makeHarness(
      {
        doGetQuota: async () => {
          throw { __tag: "rate-limited", __retryAfterMs: 1500 };
        },
      },
      /* quotaCap */ true,
    );

    let caught: unknown;
    try {
      await client.getQuota();
    } catch (e) {
      caught = e;
    }

    // runReadOp normalizes and rethrows — the engine no longer emits a
    // rate-limited event (migrate-engine-events-to-consumer); the thrown
    // `rate-limited` tag IS the contract.
    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<FakeType>;
    expect(err.tag).toBe("rate-limited");
  });
});

// ---------------------------------------------------------------------------
// authenticate: intent wrapping + event semantics
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — authenticate", () => {
  it("returns the intent synchronously; completion persists credentials BEFORE resolving (no put until completion)", async () => {
    const callOrder: string[] = [];
    const { client, store } = makeHarness({
      doAuthenticate: async () => {
        const intent: CredentialsFormIntent = {
          kind: "credentials-form",
          schema: "aws-access-key",
          submit: async (values) => {
            void values;
            callOrder.push("intent.submit");
            return { accessToken: "fresh-token" };
          },
        };
        return intent;
      },
    });

    store.putMock.mockImplementation(async () => {
      callOrder.push("put");
    });

    const intent = await client.authenticate();
    // The intent is returned but completion is host-driven — no persistence
    // has happened yet. (The engine no longer emits an `authenticated` event;
    // completion is observed via the resolved AuthResult + the put call.)
    expect(intent.kind).toBe("credentials-form");
    expect(store.putMock).not.toHaveBeenCalled();

    // Host completes the intent.
    const credsIntent = intent as CredentialsFormIntent;
    const result = await credsIntent.submit({
      accessKeyId: "AK",
      secretAccessKey: "SK",
    });

    expect(result.accessToken).toBe("fresh-token");
    // After completion: submit ran then put persisted (before resolve).
    expect(callOrder).toEqual(["intent.submit", "put"]);
    expect(store.putMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows a normalized DatasourceError when the intent completion rejects; does NOT persist", async () => {
    const { client, store } = makeHarness({
      doAuthenticate: async () => ({
        kind: "credentials-form",
        schema: "aws-access-key",
        submit: async () => {
          throw new Error("bad creds");
        },
      }),
    });

    const intent = (await client.authenticate()) as CredentialsFormIntent;
    // The intent-completion reject path normalizes the raw submit() exception
    // and rethrows it. The engine emits nothing
    // (migrate-engine-events-to-consumer); the thrown error IS the contract.
    await expect(intent.submit({})).rejects.toBeInstanceOf(DatasourceError);

    expect(store.putMock).not.toHaveBeenCalled();
  });

  it("rethrows the normalized DatasourceError when `authenticate()` itself throws (pre-intent); does NOT persist", async () => {
    // The general catch path in `authenticate()` — where `doAuthenticateImpl()`
    // throws BEFORE returning an intent — normalizes and rethrows.
    const { client, store } = makeHarness({
      doAuthenticate: async () => {
        throw new DatasourceError<FakeType>({
          tag: DatasourceErrorTag.ProviderError,
          datasourceType: "amazon-s3",
          datasourceId: "ds-1",
          retryable: false,
          raw: { providerCode: "IntentBuildFailed" },
          message: "cannot build auth intent",
        });
      },
    });

    let caught: unknown;
    try {
      await client.authenticate();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<FakeType>;
    expect(err.tag).toBe("provider-error");
    expect(err.message).toBe("cannot build auth intent");

    expect(store.putMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// dispose() — lifecycle hook
// ---------------------------------------------------------------------------
//
// The base exposes `dispose(): void` as a no-op by default; subclasses that
// hold resources (timers, external handles) override it. No strategy
// subscribes to any bus (the engine event bus was removed in
// migrate-engine-events-to-consumer; path-cache invalidation is inline). The
// base contract is only that `dispose()` exists and may be called
// idempotently.

describe("BaseDatasourceClient — dispose()", () => {
  it("exposes a public `dispose()` method as a no-op on the base", () => {
    const { client } = makeHarness();
    expect(typeof (client as unknown as { dispose: unknown }).dispose).toBe(
      "function",
    );
    // No-op: calling it on a subclass that didn't override MUST NOT throw.
    expect(() =>
      (client as unknown as { dispose: () => void }).dispose(),
    ).not.toThrow();
  });

  it("dispose() is idempotent — calling twice does not throw", () => {
    const { client } = makeHarness();
    const d = (client as unknown as { dispose: () => void }).dispose.bind(
      client,
    );
    d();
    expect(() => d()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// rename — base-class primitive (add-engine-rename-download §4)
// ---------------------------------------------------------------------------
//
// The base class calls the strategy's `doRenameImpl` directly (per
// migrate-engine-retry-policy-to-consumer Decision 1 — no auto-refresh) and
// emits exactly one `entry-renamed` event on success or one
// `delete-failed { via: "rename" }` event on failure.
// Per design.md Decision 1 + spec.md "Directory rename with conflictPolicy
// 'overwrite' is refused", per-policy orchestration (sibling-detection,
// suffix-retry, kind-based refusal) lives in each strategy — Section 4
// only lands the base wrapper + a programmable mock subclass that
// proves the wrapper's contract behaviour for each policy branch.

describe("BaseDatasourceClient — rename success path", () => {
  it("resolves with the strategy's renamed entry (no bus side effects)", async () => {
    const renamed = makeEntry("/welcome-v2.pdf");
    const { client } = makeHarness({
      doRename: async () => renamed,
    });

    const from: Target = { kind: "path", path: "/welcome.pdf" };
    const result = await client.rename(from, "welcome-v2.pdf", "fail");

    // The base returns the strategy's renamed entry unchanged. The engine
    // emits no event (migrate-engine-events-to-consumer).
    expect(result).toEqual(renamed);
  });
});

describe("BaseDatasourceClient — rename `fail` policy surfaces conflict tag", () => {
  it("strategy throws conflict-tagged DatasourceError → base re-throws unchanged", async () => {
    const conflictErr = new DatasourceError<FakeType>({
      tag: DatasourceErrorTag.Conflict,
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
      raw: { existingPath: "/parent/bar.pdf" },
      message: "name already exists at /parent/bar.pdf",
    });
    const { client } = makeHarness({
      doRename: async () => {
        throw conflictErr;
      },
    });

    let caught: unknown;
    try {
      await client.rename(
        { kind: "path", path: "/parent/foo.pdf" },
        "bar.pdf",
        "fail",
      );
    } catch (e) {
      caught = e;
    }

    // The base normalizes and re-throws — the thrown `conflict` error IS the
    // contract (the engine emits no `delete-failed` event post
    // migrate-engine-events-to-consumer).
    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<FakeType>;
    expect(err.tag).toBe("conflict");
    expect(err.retryable).toBe(false);
    // `raw` carries the colliding sibling path so the renderer's
    // ConflictResolutionDialog can prompt with the exact path.
    expect(err.raw).toEqual({ existingPath: "/parent/bar.pdf" });
  });
});

describe("BaseDatasourceClient — rename `overwrite` policy on a file delegates to the strategy", () => {
  it("base passes `overwrite` through to doRenameImpl; strategy's internal `doDeleteFileImpl` cleanup is invisible to the caller (single-step rename)", async () => {
    // Per design.md Decision 1 + tasks.md §4.6 ("lives in each strategy
    // since the sibling-detection is provider-specific"), the base does
    // NOT itself drive the overwrite-then-rename. It delegates by passing
    // `conflictPolicy` through to `doRenameImpl`. The base-side contract is:
    //   1. `doRenameImpl` is invoked with conflictPolicy === "overwrite"
    //   2. Whatever the strategy did internally — including a sibling
    //      delete via the protected `doDeleteFileImpl` primitive — is
    //      invisible to the caller (the engine emits no events at all post
    //      migrate-engine-events-to-consumer; single-step rename UX holds).
    //   3. On the strategy resolving the renamed entry, the base returns it.
    //
    // The mock simulates the strategy's overwrite path by invoking
    // `doDeleteFileImpl` (via the public `doDeleteFile` spy that the test
    // fixture wires it to) before returning the renamed entry — exercising
    // the actual property under test rather than just the policy passthrough.
    const renamed = makeEntry("/parent/bar.pdf");
    const { client } = makeHarness();
    // Override doRename post-construction so the mock can close over
    // `client` and exercise the protected primitive via the public spy.
    client.doRename.mockImplementation(
      async (_target, _newName, conflictPolicy) => {
        // Sanity: the base MUST forward the policy unchanged.
        expect(conflictPolicy).toBe("overwrite");
        // Strategy's internal sibling-cleanup. doDeleteFileImpl resolves to
        // doDeleteFile (the test spy), which is a no-op vi.fn. This mirrors a
        // real strategy's overwrite path: call the protected primitive, then
        // perform the rename.
        await client["doDeleteFileImpl"]({
          kind: "path",
          path: "/parent/bar.pdf",
        });
        return renamed;
      },
    );

    const from: Target = { kind: "path", path: "/parent/foo.pdf" };
    const result = await client.rename(from, "bar.pdf", "overwrite");

    expect(result).toEqual(renamed);
    // The strategy's overwrite path actually invoked the cleanup primitive.
    expect(client.doDeleteFile).toHaveBeenCalledTimes(1);
    expect(client.doDeleteFile).toHaveBeenCalledWith({
      kind: "path",
      path: "/parent/bar.pdf",
    });
  });
});

describe("BaseDatasourceClient — rename `overwrite` on a directory is refused", () => {
  it("strategy throws `unsupported`; base re-throws unchanged", async () => {
    // Per design.md Decision 1 ("Directory-rename conflict-policy guard"),
    // the strategy detects kind === "folder" + policy === "overwrite" and
    // throws `DatasourceError { tag: "unsupported" }`. The base passes the
    // policy through and re-throws the strategy-thrown error. The engine
    // emits no events (migrate-engine-events-to-consumer); the thrown
    // `unsupported` error IS the contract.
    const refusal = new DatasourceError<FakeType>({
      tag: DatasourceErrorTag.Unsupported,
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
      raw: "directory-overwrite-refused",
      message:
        "directory rename with conflictPolicy 'overwrite' is not supported (would require recursive replacement)",
    });
    const { client } = makeHarness({
      doRename: async () => {
        throw refusal;
      },
    });

    let caught: unknown;
    try {
      await client.rename(
        { kind: "path", path: "/parent/some-folder" },
        "renamed-folder",
        "overwrite",
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<FakeType>;
    expect(err.tag).toBe("unsupported");
    expect(err.message).toContain(
      "directory rename with conflictPolicy 'overwrite' is not supported",
    );
  });
});

describe("BaseDatasourceClient — rename `keep-both` policy delegates to the strategy", () => {
  it("base passes `keep-both` through to doRenameImpl unchanged; strategy returns the auto-suffixed entry", async () => {
    // Per design.md Decision 1 + tasks.md §4.10 ("lives in each strategy
    // alongside its rename API call"), the keep-both retry loop is
    // strategy-side (provider-specific sibling-detection happens during
    // the loop). The base's job is to delegate — `doRenameImpl` receives
    // `keep-both`, the strategy retries internally with `bar-2.pdf` /
    // `bar-3.pdf` / … until success or 99 attempts (terminal `tag: other`),
    // and resolves with the final renamed entry. Whatever number of
    // internal retries occurred, the base returns that single entry (the
    // engine emits no events post migrate-engine-events-to-consumer).
    const renamed = makeEntry("/parent/bar-3.pdf");
    const { client } = makeHarness({
      doRename: async (_target, _newName, conflictPolicy) => {
        expect(conflictPolicy).toBe("keep-both");
        return renamed;
      },
    });

    const from: Target = { kind: "path", path: "/parent/foo.pdf" };
    const result = await client.rename(from, "bar.pdf", "keep-both");

    expect(result).toEqual(renamed);
  });

  it("strategy exhausts keep-both attempts → base re-throws strategy's `tag: other` error", async () => {
    // Strategy's exhausted-retry path lives in the strategy (§4.10); the base
    // normalizes and re-throws the resulting error so the renderer can
    // surface it (the engine emits no `delete-failed` event post
    // migrate-engine-events-to-consumer).
    const exhausted = new DatasourceError<FakeType>({
      tag: "other",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
      message: "exhausted keep-both attempts",
    });
    const { client } = makeHarness({
      doRename: async () => {
        throw exhausted;
      },
    });

    let caught: unknown;
    try {
      await client.rename(
        { kind: "path", path: "/parent/foo.pdf" },
        "bar.pdf",
        "keep-both",
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<FakeType>;
    expect(err.tag).toBe("other");
    expect(err.message).toBe("exhausted keep-both attempts");
  });
});

// ---------------------------------------------------------------------------
// downloadFile — base-class primitive (add-engine-rename-download §5)
// ---------------------------------------------------------------------------
//
// The base calls the strategy's `doDownloadFileImpl` directly (per
// migrate-engine-retry-policy-to-consumer Decision 1 — no auto-refresh on
// `auth-expired`) and returns the strategy's `{ stream, contentLength,
// contentRange }` UNCHANGED. The engine emits NO download events and attaches
// NO stream listeners (the event bus was removed in
// migrate-engine-events-to-consumer): progress flows solely via the strategy's
// `options.onProgress(loaded, total)` callback, and fs-sync's download handler
// owns terminal handling (`file-downloaded` / `download-failed` /
// `download-cancelled`) off its own synchronous pipe-to-disk path. Per
// design.md Decision 3, the engine does NOT mint a transaction ID, does NOT
// carry per-download state across calls, and does NOT splice/retry mid-stream.

describe("BaseDatasourceClient — downloadFile success path", () => {
  it("returns the strategy's shape unchanged; drives the consumer's onProgress as bytes flow", async () => {
    const target: Target = { kind: "path", path: "/folder/big.bin" };
    const stream = new Readable({ read() {} });
    const { client } = makeHarness({
      doDownloadFile: async (_t, options) => {
        // Simulate the strategy's byte-counting hook firing onProgress as
        // bytes flow, then deliver the stream's data + end events.
        options.onProgress?.(2048, 4096);
        options.onProgress?.(4096, 4096);
        // Defer chunk-push to after the consumer wires up listeners.
        setImmediate(() => {
          stream.push(Buffer.alloc(2048));
          stream.push(Buffer.alloc(2048));
          stream.push(null);
        });
        return {
          stream,
          contentLength: 4096,
        };
      },
    });

    const progressTicks: Array<{ loaded: number; total: number | null }> = [];
    const result = await client.downloadFile(target, {
      onProgress: (loaded, total) => progressTicks.push({ loaded, total }),
    });
    // Shape echoes what the strategy returned, unchanged.
    expect(result.contentLength).toBe(4096);
    expect(result.stream).toBe(stream);
    // Drain the stream.
    await new Promise<void>((resolve, reject) => {
      result.stream.on("data", () => {});
      result.stream.on("end", () => resolve());
      result.stream.on("error", reject);
    });

    // onProgress fired with the strategy's byte counts; the final tick is the
    // full content length. This is the only progress channel (the engine
    // emits nothing).
    expect(progressTicks).toEqual([
      { loaded: 2048, total: 4096 },
      { loaded: 4096, total: 4096 },
    ]);
  });
});

describe("BaseDatasourceClient — downloadFile rangeStart propagation", () => {
  it("forwards rangeStart unchanged into doDownloadFileImpl and returns the strategy's contentRange unchanged", async () => {
    const target: Target = { kind: "path", path: "/large.bin" };
    let receivedOptions: DownloadOptions | undefined;
    const stream = new Readable({ read() {} });
    const { client } = makeHarness({
      doDownloadFile: async (_t, options) => {
        receivedOptions = options;
        setImmediate(() => stream.push(null));
        return {
          stream,
          contentLength: 1_000_000 - 1024,
          contentRange: { start: 1024, end: 999_999, total: 1_000_000 },
        };
      },
    });

    const result = await client.downloadFile(target, { rangeStart: 1024 });

    expect(receivedOptions?.rangeStart).toBe(1024);
    expect(result.contentRange).toEqual({
      start: 1024,
      end: 999_999,
      total: 1_000_000,
    });
  });
});

describe("BaseDatasourceClient — downloadFile signal propagation", () => {
  it("aborting the consumer-supplied AbortSignal causes the strategy's underlying call to reject with AbortError; the rejection propagates to the consumer", async () => {
    const target: Target = { kind: "path", path: "/abortable.bin" };
    const controller = new AbortController();
    const { client } = makeHarness({
      doDownloadFile: async (_t, options) => {
        // Mirror a real SDK call: hang waiting for the signal, reject on abort.
        return new Promise<DownloadResult>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(
              Object.assign(new Error("aborted"), { name: "AbortError" }),
            );
          });
        });
      },
    });

    const promise = client.downloadFile(target, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(DatasourceError);
  });
});

describe("BaseDatasourceClient — downloadFile onProgress propagation", () => {
  it("invokes the consumer's `onProgress(loaded, total)` synchronously as the strategy reports progress", async () => {
    const target: Target = { kind: "path", path: "/p.bin" };
    const onProgress = vi.fn<
      (loaded: number, total: number | null) => void
    >();
    const stream = new Readable({ read() {} });
    const { client } = makeHarness({
      doDownloadFile: async (_t, options) => {
        // Strategy invokes the consumer's callback synchronously per byte tick.
        options.onProgress?.(2048, 4096);
        options.onProgress?.(4096, 4096);
        setImmediate(() => stream.push(null));
        return { stream, contentLength: 4096 };
      },
    });

    await client.downloadFile(target, { onProgress });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 2048, 4096);
    expect(onProgress).toHaveBeenNthCalledWith(2, 4096, 4096);
  });
});
