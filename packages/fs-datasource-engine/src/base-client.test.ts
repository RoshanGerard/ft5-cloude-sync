import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

import type {
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  DatasourceEvent,
  DatasourceStatus,
  DatasourceType,
  DatasourceFileEntry,
  FileMetadata,
  PayloadMap,
  ProviderDescriptor,
  Quota,
  StoredCredentials,
  Target,
} from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

import { createEventBus, type EventBus } from "./event-bus.js";
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
  doListDirectory?: (target: Target) => Promise<DatasourceFileEntry<FakeType>[]>;
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
  emitDownloading?: (loaded: number, total: number | null) => void;
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
    (target: Target) => Promise<DatasourceFileEntry<FakeType>[]>
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
    else this.doListDirectory.mockResolvedValue([]);

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
  protected doListDirectoryImpl(target: Target): Promise<DatasourceFileEntry<FakeType>[]> {
    return this.doListDirectory(target);
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
      retryable: tag === "rate-limited" || tag === "network-error",
      raw,
    });
  };
}

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

type AnyEvent = DatasourceEvent<DatasourceType, keyof PayloadMap[DatasourceType]>;

function collect(bus: EventBus): AnyEvent[] {
  const out: AnyEvent[] = [];
  bus.subscribe((e) => {
    out.push(e);
  });
  return out;
}

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
  bus: EventBus;
  events: AnyEvent[];
  store: ReturnType<typeof makeStore>;
  descriptor: ProviderDescriptor;
  client: FakeDatasourceClient;
}

function makeHarness(cfg: FakeConfig = {}, quotaCap = true): Harness {
  const bus = createEventBus();
  const events = collect(bus);
  const store = makeStore();
  const descriptor = makeProviderDescriptor(quotaCap);
  const client = new FakeDatasourceClient(
    {
      datasourceId: "ds-1",
      ctx: { bus, credentialStore: store, providerDescriptor: descriptor },
    },
    cfg,
  );
  return { bus, events, store, descriptor, client };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Successful op: pre + post events in order
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — success path emission", () => {
  it("uploadFile resolves with the entry and emits NO upload events on the engine bus (post-migrate-upload-orchestration-out-of-engine)", async () => {
    const onProgress = vi.fn<(loaded: number, total: number) => void>();
    const { client, events } = makeHarness({
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
    // Engine bus is silent for upload (Decision 1):
    const names = events.map((e) => e.event);
    expect(names).not.toContain("uploading");
    expect(names).not.toContain("file-created");
    expect(names).not.toContain("upload-failed");
    expect(names).not.toContain("upload-cancelled");
    // Consumer's onProgress callback DID fire with monotonic non-decreasing
    // loaded values (the strategy's contract).
    expect(onProgress).toHaveBeenCalledTimes(3);
    const calls = onProgress.mock.calls;
    expect(calls[0]).toEqual([0, 1000]);
    expect(calls[1]).toEqual([500, 1000]);
    expect(calls[2]).toEqual([1000, 1000]);
  });

  it("deleteFile emits `deleted` on success and no `delete-failed`", async () => {
    const { client, events } = makeHarness({
      doDeleteFile: async () => undefined,
    });

    await client.deleteFile({ kind: "path", path: "/x.txt" });

    const names = events.map((e) => e.event);
    expect(names).toContain("deleted");
    expect(names).not.toContain("delete-failed");
  });
});

// ---------------------------------------------------------------------------
// uploadFile forwards options.onProgress directly to doUploadFileImpl.
// Strategies invoke it (loaded, total) as bytes flow. The base does NOT
// translate those calls into bus events any more (per migrate-upload-
// orchestration-out-of-engine) — the consumer (fs-sync handler) owns
// throttle + bus emission.
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — uploadFile options forwarding", () => {
  it("options.onProgress is forwarded to doUploadFileImpl; invoking it does NOT emit bus events", async () => {
    let captured: ((loaded: number, total: number) => void) | undefined;

    const { client, events } = makeHarness({
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
    // No upload-related bus events fire from the base.
    const names = events.map((e) => e.event);
    expect(names).not.toContain("uploading");
    expect(names).not.toContain("file-created");
    expect(names).not.toContain("upload-failed");
    expect(names).not.toContain("upload-cancelled");
  });

  it("options.signal is forwarded to doUploadFileImpl; abort propagates as DatasourceError(cancelled) WITHOUT bus emission", async () => {
    // The consumer constructs an AbortController, passes its signal to
    // uploadFile, aborts mid-upload. The strategy detects the abort and
    // rejects with DatasourceError { tag: "cancelled" }. The wrapper
    // propagates the rejection. NO bus emission for upload events.
    const { client, events } = makeHarness({
      doUploadFile: (_parent, _file, options) =>
        new Promise<DatasourceFileEntry<FakeType>>((_res, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(
              new DatasourceError<FakeType>({
                tag: "cancelled",
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
        e.tag === "cancelled" &&
        e.retryable === false,
    );

    // Engine bus stays silent for the entire upload lifecycle.
    const names = events.map((e) => e.event);
    expect(names).not.toContain("uploading");
    expect(names).not.toContain("file-created");
    expect(names).not.toContain("upload-failed");
    expect(names).not.toContain("upload-cancelled");
  });

  it("withRefresh still applies to uploadFile — auth-expired refreshes once and retries", async () => {
    let attempt = 0;
    const onProgress = vi.fn<(loaded: number, total: number) => void>();
    const { client, events } = makeHarness({
      doUploadFile: async (_parent, _file, options) => {
        attempt += 1;
        if (attempt === 1) {
          throw { __tag: "auth-expired" };
        }
        // Second attempt fires the consumer's onProgress as normal.
        options.onProgress?.(0, 100);
        options.onProgress?.(100, 100);
        return makeEntry("/post-refresh.txt");
      },
      refreshToken: async () => ({ accessToken: "fresh" }),
    });

    const result = await client.uploadFile(
      { kind: "path", path: "/" },
      { path: "C:/tmp/x.txt" },
      { onProgress },
    );
    expect(result.path).toBe("/post-refresh.txt");
    // Single retry; onProgress fires only on the successful attempt.
    expect(attempt).toBe(2);
    expect(onProgress).toHaveBeenCalledTimes(2);
    // Bus carries the refresh event only — no upload events.
    const names = events.map((e) => e.event);
    expect(names).toContain("token-refreshed");
    expect(names).not.toContain("uploading");
    expect(names).not.toContain("file-created");
  });
});

// Note: the legacy "transactionId / progress percentage" assertions and
// the "total=0 defensive" test are obsolete post-migrate-upload-
// orchestration-out-of-engine — the base no longer translates onProgress
// into a transactionId-keyed bus event with percentage. The consumer
// (fs-sync handler) owns that translation.


// ---------------------------------------------------------------------------
// Failing op: pre + failed, throws normalized error
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — failure path emission", () => {
  it("uploadFile rejects with normalized DatasourceError and emits NO upload events on the engine bus", async () => {
    const { client, events } = makeHarness({
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
    // But the engine bus is silent for upload events
    // (per migrate-upload-orchestration-out-of-engine).
    const names = events.map((e) => e.event);
    expect(names).not.toContain("uploading");
    expect(names).not.toContain("upload-failed");
    expect(names).not.toContain("file-created");
    expect(names).not.toContain("upload-cancelled");
  });

  it("deleteFile failure emits delete-failed and throws", async () => {
    const { client, events } = makeHarness({
      doDeleteFile: async () => {
        throw { __tag: "not-found" };
      },
    });

    await expect(
      client.deleteFile({ kind: "path", path: "/gone.txt" }),
    ).rejects.toBeInstanceOf(DatasourceError);
    const names = events.map((e) => e.event);
    expect(names).toContain("delete-failed");
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

describe("BaseDatasourceClient — Unsupported errors are silent on the bus", () => {
  it("getMetadata with Unsupported throws and emits no *-failed event", async () => {
    const { client, events } = makeHarness({
      doGetMetadata: async () => {
        throw { __tag: "unsupported" };
      },
    });

    await expect(
      client.getMetadata({ kind: "path", path: "/x" }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DatasourceError && e.tag === "unsupported",
    );
    const names = events.map((e) => e.event);
    expect(names).not.toContain("status-changed");
    expect(names.filter((n) => String(n).endsWith("-failed"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Single-flight refresh on 5 concurrent auth-expired
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — single-flight token refresh", () => {
  it("5 concurrent auth-expired failures trigger exactly one refreshToken call", async () => {
    const retryReturn = [makeEntry("/a.txt")];

    // First 5 calls reject with auth-expired (one per concurrent op); calls
    // 6..10 (the retries) resolve. This mirrors "each op fails once, retries
    // succeed" since the base only retries once per op.
    let callCount = 0;
    const doListDirectory = vi.fn(async (target: Target) => {
      void target;
      callCount++;
      if (callCount <= 5) throw { __tag: "auth-expired" };
      return retryReturn;
    });

    const { client, events, store } = makeHarness({
      doListDirectory: doListDirectory as unknown as (
        target: Target,
      ) => Promise<DatasourceFileEntry<FakeType>[]>,
      refreshToken: async () => ({ accessToken: "new-token" }),
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        client.listDirectory({ kind: "path", path: "/root" }),
      ),
    );

    // refreshToken was called exactly once
    expect(client.refreshTokenSpy).toHaveBeenCalledTimes(1);
    // credentialStore.put was called exactly once
    expect(store.putMock).toHaveBeenCalledTimes(1);
    // exactly one token-refreshed event
    const refreshed = events.filter((e) => e.event === "token-refreshed");
    expect(refreshed).toHaveLength(1);
    // all 5 calls resolved with the retry's result
    for (const r of results) {
      expect(r).toEqual(retryReturn);
    }
    // every call's `doListDirectory` was invoked twice (fail + retry), so total 10
    expect(doListDirectory).toHaveBeenCalledTimes(10);
  });

  it("persists refreshed credentials to the store BEFORE retry runs", async () => {
    const callOrder: string[] = [];

    const doListDirectory = vi.fn(async (target: Target) => {
      void target;
      callOrder.push("doListDirectory");
      if (callOrder.filter((s) => s === "doListDirectory").length === 1) {
        throw { __tag: "auth-expired" };
      }
      return [makeEntry("/a.txt")];
    });

    const store = makeStore();
    store.putMock.mockImplementation(async () => {
      callOrder.push("put");
    });

    const bus = createEventBus();
    const descriptor = makeProviderDescriptor();
    const client = new FakeDatasourceClient(
      {
        datasourceId: "ds-1",
        ctx: { bus, credentialStore: store, providerDescriptor: descriptor },
      },
      {
        doListDirectory: doListDirectory as unknown as (
          target: Target,
        ) => Promise<DatasourceFileEntry<FakeType>[]>,
        refreshToken: async () => {
          callOrder.push("refreshToken");
          return { accessToken: "new-token" };
        },
      },
    );

    await client.listDirectory({ kind: "path", path: "/root" });

    // Expected ordering:
    //   doListDirectory (fails auth-expired)
    //   refreshToken
    //   put
    //   doListDirectory (retry)
    expect(callOrder).toEqual([
      "doListDirectory",
      "refreshToken",
      "put",
      "doListDirectory",
    ]);
  });

  it("refresh failure emits token-expired + authentication-failed and throws AuthExpired", async () => {
    const { client, events, store } = makeHarness({
      doListDirectory: async () => {
        throw { __tag: "auth-expired" };
      },
      refreshToken: async () => {
        throw new Error("refresh exploded");
      },
    });

    let caught: unknown;
    try {
      await client.listDirectory({ kind: "path", path: "/root" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DatasourceError);
    expect((caught as DatasourceError).tag).toBe("auth-expired");

    const names = events.map((e) => e.event);
    expect(names).toContain("token-expired");
    expect(names).toContain("authentication-failed");

    // Decision 12.4: `authentication-failed` payload is the full
    // SerializedDatasourceError shape (not a reason string). The single-
    // flight refresh-failure path wraps the raw refresh exception into a
    // `DatasourceError` with tag `auth-expired` before serializing —
    // consumers receive retry affordances plus the raw cause.
    const authFailed = events.find((e) => e.event === "authentication-failed");
    expect(authFailed?.payload).toMatchObject({
      tag: "auth-expired",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
      message: expect.any(String),
    });
    // `raw` preserves the original refresh exception for diagnostics.
    expect((authFailed?.payload as { raw?: unknown }).raw).toBeDefined();

    // Store was NOT updated with new credentials
    expect(store.putMock).not.toHaveBeenCalled();
  });

  it("refresh succeeds but credentialStore.put rejects → routed through refresh-failed path", async () => {
    // Documented behaviour: a storage failure inside the refresh cycle
    // reframes as auth-expired. Host implementations must surface storage
    // failures via their own logging. See class docstring.
    const putError = new Error("disk full");
    const store = makeStore();
    store.putMock.mockRejectedValue(putError);

    const bus = createEventBus();
    const events = collect(bus);
    const descriptor = makeProviderDescriptor();
    const client = new FakeDatasourceClient(
      {
        datasourceId: "ds-1",
        ctx: { bus, credentialStore: store, providerDescriptor: descriptor },
      },
      {
        doUploadFile: async () => {
          throw { __tag: "auth-expired" };
        },
        // refreshTokenImpl resolves with a valid AuthResult — the failure
        // is entirely in the credential-store `put`.
        refreshToken: async () => ({ accessToken: "freshly-minted" }),
      },
    );

    let caught: unknown;
    try {
      await client.uploadFile(
        { kind: "path", path: "/parent" },
        { path: "C:/tmp/demo.txt" },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DatasourceError);
    expect((caught as DatasourceError).tag).toBe("auth-expired");

    const names = events.map((e) => e.event);
    expect(names).toContain("token-expired");
    expect(names).toContain("authentication-failed");
    expect(names).not.toContain("token-refreshed");

    // Decision 12.4: `authentication-failed` payload is the full
    // SerializedDatasourceError shape — the refresh-failure path
    // serializes a synthesized `auth-expired` DatasourceError carrying
    // the credential-store exception as `raw`.
    const authFailed = events.find((e) => e.event === "authentication-failed");
    expect(authFailed?.payload).toMatchObject({
      tag: "auth-expired",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
      message: expect.any(String),
    });
    expect((authFailed?.payload as { raw?: unknown }).raw).toBeDefined();

    // The store.put error is only visible via the spy's rejection — it is
    // NOT re-surfaced to the caller as a distinct error.
    expect(store.putMock).toHaveBeenCalledTimes(1);
  });

  it("retry auth-expired is NOT re-refreshed (one refresh max per auth-expired burst)", async () => {
    const doListDirectory = vi.fn(async (target: Target) => {
      // Always fail with auth-expired, both first call and retry.
      void target;
      throw { __tag: "auth-expired" };
    });

    const { client } = makeHarness({
      doListDirectory: doListDirectory as unknown as (
        target: Target,
      ) => Promise<DatasourceFileEntry<FakeType>[]>,
      refreshToken: async () => ({ accessToken: "new-token" }),
    });

    let caught: unknown;
    try {
      await client.listDirectory({ kind: "path", path: "/root" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DatasourceError);
    expect((caught as DatasourceError).tag).toBe("auth-expired");
    // refreshToken called ONCE — the retry's auth-expired does NOT trigger a 2nd refresh.
    expect(client.refreshTokenSpy).toHaveBeenCalledTimes(1);
    // doListDirectory called TWICE (initial + single retry).
    expect(doListDirectory).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// deleteDirectory always throws Unsupported
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — deleteDirectory unsupported", () => {
  it("throws Unsupported with raw='disabled-for-product-stability' and emits no event", async () => {
    const { client, events } = makeHarness();

    let caught: unknown;
    try {
      await client.deleteDirectory({ kind: "path", path: "/any" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<FakeType>;
    expect(err.tag).toBe("unsupported");
    expect(err.raw).toBe("disabled-for-product-stability");
    // No events emitted at all for the deleteDirectory attempt
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getQuota capability gating
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — getQuota capability gating", () => {
  it("throws Unsupported when provider capability quota=false, without invoking doGetQuota", async () => {
    const harness = makeHarness({}, /* quotaCap */ false);
    const { client, events } = harness;

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
    expect(events).toHaveLength(0);
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

  it("getQuota emits rate-limited on rate-limit error (routed through runReadOp)", async () => {
    const { client, events } = makeHarness(
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

    expect(caught).toBeInstanceOf(DatasourceError);
    expect((caught as DatasourceError).tag).toBe("rate-limited");

    const rateLimited = events.filter((e) => e.event === "rate-limited");
    expect(rateLimited).toHaveLength(1);
    expect(rateLimited[0]?.datasourceType).toBe("amazon-s3");
    // status-changed must NOT have been emitted for the rate-limit path —
    // runReadOp branches on `rate-limited` first.
    expect(events.some((e) => e.event === "status-changed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// authenticate: intent wrapping + event semantics
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — authenticate", () => {
  it("returns the intent synchronously, emits `authenticated` only after completion (and after put)", async () => {
    const callOrder: string[] = [];
    const { client, events, store } = makeHarness({
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
    // At this point, the intent has been returned but no `authenticated` event
    // must have been emitted yet — completion is host-driven.
    expect(intent.kind).toBe("credentials-form");
    expect(events.map((e) => e.event)).not.toContain("authenticated");

    // Host completes the intent.
    const credsIntent = intent as CredentialsFormIntent;
    const result = await credsIntent.submit({
      accessKeyId: "AK",
      secretAccessKey: "SK",
    });

    expect(result.accessToken).toBe("fresh-token");
    // After completion: put was called, then authenticated event emitted.
    expect(callOrder).toEqual(["intent.submit", "put"]);
    expect(store.putMock).toHaveBeenCalledTimes(1);
    const names = events.map((e) => e.event);
    expect(names).toContain("authenticated");
  });

  it("emits `authentication-failed` and rethrows when the intent completion rejects", async () => {
    const { client, events, store } = makeHarness({
      doAuthenticate: async () => ({
        kind: "credentials-form",
        schema: "aws-access-key",
        submit: async () => {
          throw new Error("bad creds");
        },
      }),
    });

    const intent = (await client.authenticate()) as CredentialsFormIntent;
    await expect(intent.submit({})).rejects.toBeInstanceOf(DatasourceError);

    const names = events.map((e) => e.event);
    expect(names).toContain("authentication-failed");
    expect(names).not.toContain("authenticated");

    // Decision 12.4: `authentication-failed` payload is the full
    // SerializedDatasourceError shape — the intent-completion reject
    // path normalizes the raw submit() exception and emits the full
    // serialized error so consumers can reconstruct recovery UX.
    const authFailed = events.find((e) => e.event === "authentication-failed");
    expect(authFailed?.payload).toMatchObject({
      tag: expect.any(String),
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: expect.any(Boolean),
      message: expect.any(String),
    });

    expect(store.putMock).not.toHaveBeenCalled();
  });

  it("emits `authentication-failed` with the full SerializedDatasourceError when `authenticate()` itself throws (pre-intent)", async () => {
    // Decision 12.4: the general catch path in `authenticate()` — where
    // `doAuthenticateImpl()` throws BEFORE returning an intent — also
    // emits the full serialized error, not a reason string.
    const { client, events, store } = makeHarness({
      doAuthenticate: async () => {
        throw new DatasourceError<FakeType>({
          tag: "provider-error",
          datasourceType: "amazon-s3",
          datasourceId: "ds-1",
          retryable: false,
          raw: { providerCode: "IntentBuildFailed" },
          message: "cannot build auth intent",
        });
      },
    });

    await expect(client.authenticate()).rejects.toBeInstanceOf(DatasourceError);

    const authFailed = events.find((e) => e.event === "authentication-failed");
    expect(authFailed).toBeDefined();
    expect(authFailed?.payload).toMatchObject({
      tag: "provider-error",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
      message: "cannot build auth intent",
      raw: { providerCode: "IntentBuildFailed" },
    });

    expect(store.putMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// dispose() — lifecycle hook
// ---------------------------------------------------------------------------
//
// Phase 7 code-review finding: strategies that subscribe to the bus (e.g.,
// OneDriveClient's path↔handle cache invalidation) leak the subscription if
// the client is discarded. The base exposes `dispose(): void` as a no-op by
// default; subclasses that hold resources (bus subscriptions, timers)
// override it. The base contract is only that `dispose()` exists and may
// be called idempotently.

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
// The base class wraps the strategy's `doRenameImpl` with the existing
// `withRefresh` machinery and emits exactly one `entry-renamed` event on
// success or one `delete-failed { via: "rename" }` event on failure.
// Per design.md Decision 1 + spec.md "Directory rename with conflictPolicy
// 'overwrite' is refused", per-policy orchestration (sibling-detection,
// suffix-retry, kind-based refusal) lives in each strategy — Section 4
// only lands the base wrapper + a programmable mock subclass that
// proves the wrapper's contract behaviour for each policy branch.

describe("BaseDatasourceClient — rename success path", () => {
  it("emits exactly one `entry-renamed { from, to }` event and resolves with the strategy's renamed entry", async () => {
    const renamed = makeEntry("/welcome-v2.pdf");
    const { client, events } = makeHarness({
      doRename: async () => renamed,
    });

    const from: Target = { kind: "path", path: "/welcome.pdf" };
    const result = await client.rename(from, "welcome-v2.pdf", "fail");

    expect(result).toEqual(renamed);
    const renames = events.filter((e) => e.event === "entry-renamed");
    expect(renames).toHaveLength(1);
    expect(renames[0]?.payload).toEqual({ from, to: renamed });
    // No `delete-failed` (failure path) and no `deleted` (overwrite-cleanup
    // pseudo-emission) MUST appear on the success path.
    expect(events.some((e) => e.event === "delete-failed")).toBe(false);
    expect(events.some((e) => e.event === "deleted")).toBe(false);
  });
});

describe("BaseDatasourceClient — rename `fail` policy surfaces conflict tag", () => {
  it("strategy throws conflict-tagged DatasourceError → base re-throws unchanged and emits one `delete-failed { via: rename, tag: conflict }`", async () => {
    const conflictErr = new DatasourceError<FakeType>({
      tag: "conflict",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
      raw: { existingPath: "/parent/bar.pdf" },
      message: "name already exists at /parent/bar.pdf",
    });
    const { client, events } = makeHarness({
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

    expect(caught).toBeInstanceOf(DatasourceError);
    const err = caught as DatasourceError<FakeType>;
    expect(err.tag).toBe("conflict");
    expect(err.retryable).toBe(false);
    // `raw` carries the colliding sibling path so the renderer's
    // ConflictResolutionDialog can prompt with the exact path.
    expect(err.raw).toEqual({ existingPath: "/parent/bar.pdf" });

    // The base routes rename failures through the existing `delete-failed`
    // taxonomy (per spec.md "Rename failure emits delete-failed with via:
    // rename") with the `via: "rename"` discriminator.
    const failures = events.filter((e) => e.event === "delete-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.payload).toMatchObject({
      tag: "conflict",
      via: "rename",
    });
    // No `entry-renamed` on the failure path.
    expect(events.some((e) => e.event === "entry-renamed")).toBe(false);
  });
});

describe("BaseDatasourceClient — rename `overwrite` policy on a file delegates to the strategy", () => {
  it("base passes `overwrite` through to doRenameImpl; strategy's internal `doDeleteFileImpl` cleanup does NOT leak a `deleted` event; bus observes one `entry-renamed` only", async () => {
    // Per design.md Decision 1 + tasks.md §4.6 ("lives in each strategy
    // since the sibling-detection is provider-specific"), the base does
    // NOT itself drive the overwrite-then-rename. It delegates by passing
    // `conflictPolicy` through to `doRenameImpl`. The base-side contract is:
    //   1. `doRenameImpl` is invoked with conflictPolicy === "overwrite"
    //   2. Whatever the strategy did internally — including a sibling
    //      delete via the protected `doDeleteFileImpl` primitive — does
    //      NOT cause the base to emit a `deleted` event for that internal
    //      cleanup (the public `deleteFile` is the only path that emits;
    //      strategies bypass it via the protected primitive precisely so
    //      single-step rename UX holds, per spec.md "the deletion event
    //      SHALL NOT be emitted to the bus")
    //   3. On the strategy resolving the renamed entry, the base emits
    //      exactly one `entry-renamed`
    //
    // The mock simulates the strategy's overwrite path by invoking
    // `doDeleteFileImpl` (via the public `doDeleteFile` spy that the test
    // fixture wires it to) before returning the renamed entry — exercising
    // the actual property under test rather than just the policy passthrough.
    const renamed = makeEntry("/parent/bar.pdf");
    const { client, events } = makeHarness();
    // Override doRename post-construction so the mock can close over
    // `client` and exercise the protected primitive via the public spy.
    client.doRename.mockImplementation(
      async (_target, _newName, conflictPolicy) => {
        // Sanity: the base MUST forward the policy unchanged.
        expect(conflictPolicy).toBe("overwrite");
        // Strategy's internal sibling-cleanup. doDeleteFileImpl resolves to
        // doDeleteFile (the test spy), which is a no-op vi.fn — no provider
        // call, no event emission. This mirrors a real strategy's overwrite
        // path: call the protected primitive, then perform the rename.
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
    const renames = events.filter((e) => e.event === "entry-renamed");
    expect(renames).toHaveLength(1);
    expect(renames[0]?.payload).toEqual({ from, to: renamed });
    // CRITICAL: no `deleted` event despite the actual `doDeleteFileImpl`
    // call inside the strategy. The user-visible UX is single-step.
    expect(events.some((e) => e.event === "deleted")).toBe(false);
  });
});

describe("BaseDatasourceClient — rename `overwrite` on a directory is refused", () => {
  it("strategy throws `unsupported`; base re-throws; no `delete-failed` event (unsupported is silent on the bus per the existing convention)", async () => {
    // Per design.md Decision 1 ("Directory-rename conflict-policy guard"),
    // the strategy detects kind === "folder" + policy === "overwrite" and
    // throws `DatasourceError { tag: "unsupported" }`. The base passes the
    // policy through and re-throws the strategy-thrown error. Per the
    // existing codebase convention (deleteFile, uploadFile), `*-failed`
    // events are NOT emitted
    // when `tag === "unsupported"` — the unsupported case stays silent on
    // the bus. spec.md's "Directory rename with conflictPolicy 'overwrite'
    // is refused" scenario confirms only "the call rejects ... no rename
    // API call is issued" — no event-emission requirement.
    const refusal = new DatasourceError<FakeType>({
      tag: "unsupported",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
      raw: "directory-overwrite-refused",
      message:
        "directory rename with conflictPolicy 'overwrite' is not supported (would require recursive replacement)",
    });
    const { client, events } = makeHarness({
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
    // No event of any kind for the unsupported-refusal path.
    expect(events.some((e) => e.event === "delete-failed")).toBe(false);
    expect(events.some((e) => e.event === "entry-renamed")).toBe(false);
  });
});

describe("BaseDatasourceClient — rename `keep-both` policy delegates to the strategy", () => {
  it("base passes `keep-both` through to doRenameImpl unchanged; strategy returns the auto-suffixed entry; bus observes one `entry-renamed`", async () => {
    // Per design.md Decision 1 + tasks.md §4.10 ("lives in each strategy
    // alongside its rename API call"), the keep-both retry loop is
    // strategy-side (provider-specific sibling-detection happens during
    // the loop). The base's job is to delegate — `doRenameImpl` receives
    // `keep-both`, the strategy retries internally with `bar-2.pdf` /
    // `bar-3.pdf` / … until success or 99 attempts (terminal `tag: other`),
    // and resolves with the final renamed entry. Whatever number of
    // internal retries occurred, the bus observes ONE `entry-renamed`
    // (the terminal success).
    const renamed = makeEntry("/parent/bar-3.pdf");
    const { client, events } = makeHarness({
      doRename: async (_target, _newName, conflictPolicy) => {
        expect(conflictPolicy).toBe("keep-both");
        return renamed;
      },
    });

    const from: Target = { kind: "path", path: "/parent/foo.pdf" };
    const result = await client.rename(from, "bar.pdf", "keep-both");

    expect(result).toEqual(renamed);
    const renames = events.filter((e) => e.event === "entry-renamed");
    expect(renames).toHaveLength(1);
    expect(renames[0]?.payload).toEqual({ from, to: renamed });
    expect(events.some((e) => e.event === "delete-failed")).toBe(false);
  });

  it("strategy exhausts keep-both attempts → base re-throws strategy's `tag: other` error and emits one `delete-failed { via: rename }`", async () => {
    // Strategy's exhausted-retry path lives in the strategy (§4.10), but
    // the base must still route the resulting error through the standard
    // failure-emission path so the renderer can surface it.
    const exhausted = new DatasourceError<FakeType>({
      tag: "other",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
      message: "exhausted keep-both attempts",
    });
    const { client, events } = makeHarness({
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
    expect((caught as DatasourceError).tag).toBe("other");

    const failures = events.filter((e) => e.event === "delete-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.payload).toMatchObject({
      tag: "other",
      message: "exhausted keep-both attempts",
      via: "rename",
    });
  });
});

// ---------------------------------------------------------------------------
// downloadFile — base-class primitive (add-engine-rename-download §5)
// ---------------------------------------------------------------------------
//
// The base wraps the strategy's `doDownloadFileImpl` with `withRefresh`
// (one-shot auth-expired retry on the initial HTTP call) and emits the
// engine bus's four download lifecycle events: `downloading` (per chunk),
// `file-downloaded` (on stream end), `download-failed` (on stream error),
// `download-cancelled` (on AbortSignal). Per design.md Decision 3, the
// engine does NOT mint a transaction ID, does NOT carry per-download
// state across calls, and does NOT splice/retry mid-stream — those
// orchestration responsibilities live in fs-sync.
//
// Per the user's task description: ONE byte-counting hook in the strategy
// fires both the consumer's `onProgress` callback AND the bus emission.
// The base provides a `protected emitDownloading(path, loaded, total)`
// helper that strategies invoke from their progress hook; the helper
// emits the bus event AND captures the latest counts so the
// cancel-path event can populate `bytesDownloaded` / `bytesTotal`.

describe("BaseDatasourceClient — downloadFile success path", () => {
  it("returns the strategy's shape unchanged via withRefresh; emits one or more `downloading` then exactly one `file-downloaded` on clean stream end; no `download-failed` or `download-cancelled`", async () => {
    const target: Target = { kind: "path", path: "/folder/big.bin" };
    const stream = new Readable({ read() {} });
    const { client, events } = makeHarness({
      doDownloadFile: async (_t, options) => {
        // Simulate the strategy's byte-counting hook: emit two ticks via
        // the base helper (which fires both bus emission + closure tracking)
        // then deliver the stream's data + end events.
        const callBaseHelper = (
          loaded: number,
          total: number | null,
        ): void => {
          (
            client as unknown as {
              emitDownloading: (
                path: string,
                loaded: number,
                total: number | null,
              ) => void;
            }
          ).emitDownloading("/folder/big.bin", loaded, total);
        };
        callBaseHelper(2048, 4096);
        callBaseHelper(4096, 4096);
        // Defer chunk-push to after the consumer wires up listeners.
        setImmediate(() => {
          stream.push(Buffer.alloc(2048));
          stream.push(Buffer.alloc(2048));
          stream.push(null);
        });
        void options;
        return {
          stream,
          contentLength: 4096,
        };
      },
    });

    const result = await client.downloadFile(target);
    // Shape echoes what the strategy returned, unchanged.
    expect(result.contentLength).toBe(4096);
    expect(result.stream).toBe(stream);
    // Drain the stream so the base's `end`-listener fires `file-downloaded`.
    await new Promise<void>((resolve, reject) => {
      const sink = new Readable({ read() {} });
      void sink;
      result.stream.on("data", () => {});
      result.stream.on("end", () => resolve());
      result.stream.on("error", reject);
    });

    const downloadings = events.filter((e) => e.event === "downloading");
    const downloaded = events.filter((e) => e.event === "file-downloaded");
    expect(downloadings.length).toBeGreaterThanOrEqual(1);
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]?.payload).toEqual({
      path: "/folder/big.bin",
      bytes: 4096,
    });
    expect(events.some((e) => e.event === "download-failed")).toBe(false);
    expect(events.some((e) => e.event === "download-cancelled")).toBe(false);
    // Envelope fields on the terminal event.
    expect(downloaded[0]?.datasourceId).toBe("ds-1");
    expect(downloaded[0]?.datasourceType).toBe("amazon-s3");
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

describe("BaseDatasourceClient — downloadFile bus emission of `downloading` events", () => {
  it("for each (loaded, total) the strategy reports, the bus observes a `downloading { path, loaded, total }` event with envelope-level datasourceType/datasourceId/ts; the consumer's onProgress fires from the same byte-flow source", async () => {
    // The bus's streaming-event coalescer (event-bus.ts) suppresses rapid-
    // succession emissions for the same `(datasourceId, transactionId)` key
    // unless either (a) >= throttleMs have elapsed or (b) the progress-delta
    // crosses progressDeltaPct. The `downloading` payload carries
    // `(loaded, total)` rather than `progress`, so the progress-delta rule
    // doesn't help — the test drives a controllable clock so each tick is
    // time-eligible and delivers immediately, proving the contract that
    // every `emitDownloading` call from the strategy reaches the bus.
    const target: Target = { kind: "path", path: "/dual.bin" };
    const onProgress = vi.fn<
      (loaded: number, total: number | null) => void
    >();
    const stream = new Readable({ read() {} });

    // Custom harness: identical to makeHarness() except the bus uses a
    // controllable clock so the test can advance time between ticks.
    let nowMs = 0;
    const bus = createEventBus({
      clock: {
        now: () => nowMs,
        setTimeout: (fn, ms) =>
          globalThis.setTimeout(fn, ms) as unknown as ReturnType<
            typeof globalThis.setTimeout
          >,
        clearTimeout: (timer) =>
          globalThis.clearTimeout(
            timer as unknown as ReturnType<typeof globalThis.setTimeout>,
          ),
      },
    });
    const events = collect(bus);
    const store = makeStore();
    const descriptor = makeProviderDescriptor();
    const client = new FakeDatasourceClient(
      {
        datasourceId: "ds-1",
        ctx: { bus, credentialStore: store, providerDescriptor: descriptor },
      },
      {
        doDownloadFile: async (_t, options) => {
          // ONE byte-counting hook in the strategy fires BOTH the consumer's
          // onProgress AND the bus emission via the base's helper. Real
          // strategies (§7-§9) attach this hook to their SDK stream's `data`
          // events; the test fixture invokes it directly to assert the dual
          // emission contract.
          const tick = (loaded: number, total: number | null): void => {
            options.onProgress?.(loaded, total);
            (
              client as unknown as {
                emitDownloading: (
                  path: string,
                  loaded: number,
                  total: number | null,
                ) => void;
              }
            ).emitDownloading("/dual.bin", loaded, total);
          };
          tick(1024, 8192);
          // Advance past the throttle window so the next tick is time-eligible.
          nowMs += 1100;
          tick(4096, 8192);
          nowMs += 1100;
          tick(8192, 8192);
          setImmediate(() => stream.push(null));
          return { stream, contentLength: 8192 };
        },
      },
    );

    await client.downloadFile(target, { onProgress });

    // Three onProgress callbacks fired (synchronous from the same hook).
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, 1024, 8192);
    expect(onProgress).toHaveBeenNthCalledWith(2, 4096, 8192);
    expect(onProgress).toHaveBeenNthCalledWith(3, 8192, 8192);

    // Three matching `downloading` bus events, in order, with matching counts.
    const downloadings = events.filter((e) => e.event === "downloading");
    expect(downloadings).toHaveLength(3);
    const payloads = downloadings.map((e) => e.payload as {
      path: string;
      loaded: number;
      total: number | null;
    });
    expect(payloads).toEqual([
      { path: "/dual.bin", loaded: 1024, total: 8192 },
      { path: "/dual.bin", loaded: 4096, total: 8192 },
      { path: "/dual.bin", loaded: 8192, total: 8192 },
    ]);
    // Envelope-level fields set by the base for every emission.
    for (const e of downloadings) {
      expect(e.datasourceId).toBe("ds-1");
      expect(e.datasourceType).toBe("amazon-s3");
      expect(typeof e.ts).toBe("number");
      // streaming flag set on every `downloading` emission so the bus's
      // coalescer can do its job downstream.
      expect(e.streaming).toBe(true);
    }
  });
});

describe("BaseDatasourceClient — downloadFile mid-stream error → `download-failed`", () => {
  it("strategy resolves a stream that errors mid-flight; bus observes `downloading` events then exactly one `download-failed { ...SerializedDatasourceError<T> }`; no `file-downloaded` or `download-cancelled`", async () => {
    const target: Target = { kind: "path", path: "/midflight.bin" };
    const stream = new Readable({ read() {} });
    const { client, events } = makeHarness({
      doDownloadFile: async (_t, _options) => {
        // Tick once, then schedule a stream error.
        (
          client as unknown as {
            emitDownloading: (
              path: string,
              loaded: number,
              total: number | null,
            ) => void;
          }
        ).emitDownloading("/midflight.bin", 1024, 4096);
        setImmediate(() => {
          stream.destroy(
            new DatasourceError<FakeType>({
              tag: "network-error",
              datasourceType: "amazon-s3",
              datasourceId: "ds-1",
              retryable: true,
              message: "stream interrupted",
            }),
          );
        });
        return { stream, contentLength: 4096 };
      },
    });

    const result = await client.downloadFile(target);
    // Drive the stream — base attaches its error/end listeners. The error
    // surfaces synchronously to the consumer's pipe via an `error` event.
    let caught: unknown;
    await new Promise<void>((resolve) => {
      result.stream.on("data", () => {});
      result.stream.on("end", () => resolve());
      result.stream.on("error", (err) => {
        caught = err;
        resolve();
      });
    });

    expect(caught).toBeInstanceOf(DatasourceError);
    expect((caught as DatasourceError).tag).toBe("network-error");

    const downloadings = events.filter((e) => e.event === "downloading");
    const failed = events.filter((e) => e.event === "download-failed");
    expect(downloadings.length).toBeGreaterThanOrEqual(1);
    expect(failed).toHaveLength(1);
    // Per contracts (`download-failed: SerializedDatasourceError<T>`), the
    // payload IS the serialized error — no `error:` wrapper. `path` is NOT
    // in the payload; subscribers correlate via the envelope's `datasourceId`.
    expect(failed[0]?.payload).toMatchObject({
      tag: "network-error",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: true,
      message: "stream interrupted",
    });
    expect(events.some((e) => e.event === "file-downloaded")).toBe(false);
    expect(events.some((e) => e.event === "download-cancelled")).toBe(false);
  });
});

describe("BaseDatasourceClient — downloadFile cancel via AbortSignal → `download-cancelled`", () => {
  it("strategy stream aborts via options.signal; bus observes `downloading` then exactly one `download-cancelled { path, bytesDownloaded, bytesTotal }`; no `download-failed`", async () => {
    const target: Target = { kind: "path", path: "/cancellable.bin" };
    const controller = new AbortController();
    const stream = new Readable({ read() {} });
    const { client, events } = makeHarness({
      doDownloadFile: async (_t, options) => {
        // Tick a couple of times so the cancel event reflects real byte counts.
        (
          client as unknown as {
            emitDownloading: (
              path: string,
              loaded: number,
              total: number | null,
            ) => void;
          }
        ).emitDownloading("/cancellable.bin", 1024, 16_384);
        (
          client as unknown as {
            emitDownloading: (
              path: string,
              loaded: number,
              total: number | null,
            ) => void;
          }
        ).emitDownloading("/cancellable.bin", 4096, 16_384);
        // Wire the abort listener so a `controller.abort()` after the call
        // resolves causes the stream to error with AbortError.
        options.signal?.addEventListener("abort", () => {
          stream.destroy(
            Object.assign(new Error("aborted"), { name: "AbortError" }),
          );
        });
        return { stream, contentLength: 16_384 };
      },
    });

    const result = await client.downloadFile(target, {
      signal: controller.signal,
    });
    // Drive the stream and abort mid-flow.
    const drained = new Promise<void>((resolve) => {
      result.stream.on("data", () => {});
      result.stream.on("end", () => resolve());
      result.stream.on("error", () => resolve());
    });
    controller.abort();
    await drained;

    const downloadings = events.filter((e) => e.event === "downloading");
    const cancelled = events.filter((e) => e.event === "download-cancelled");
    expect(downloadings.length).toBeGreaterThanOrEqual(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.payload).toEqual({
      path: "/cancellable.bin",
      bytesDownloaded: 4096,
      bytesTotal: 16_384,
    });
    expect(events.some((e) => e.event === "download-failed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Concurrent downloads on the SAME client (different paths) must not
// cross-contaminate per-call progress tracking. Regression for the
// original single-slot `currentDownloadProgressHook` design: starting
// a second concurrent call clobbered the first call's hook (the field
// was a single instance slot, not keyed by path), so progress ticks
// emitted via the strategy's `emitDownloading(path, …)` helper for
// path A AFTER path B had set the slot would silently route to B's
// closure — freezing A's `lastLoaded` at zero AND polluting B's.
// On cancel of A, `download-cancelled.bytesDownloaded` would read 0
// instead of A's actual progress. Refactor moved per-call tracking
// into closure-local state with a `Map<path, recordProgress>` lookup
// inside the protected `emitDownloading` helper so each tick routes
// to the correct call's closure.
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — concurrent downloadFile calls on same client emit per-call byte counts on cancel", () => {
  it("two concurrent calls on different paths each carry their own bytesDownloaded in `download-cancelled`; emitDownloading after both calls are in flight routes to the correct call's closure", async () => {
    const targetA: Target = { kind: "path", path: "/concurrent/a.bin" };
    const targetB: Target = { kind: "path", path: "/concurrent/b.bin" };
    const streamA = new Readable({ read() {} });
    const streamB = new Readable({ read() {} });
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    // Strategy mock returns the streams without ticking — the test
    // ticks `emitDownloading` from the test body AFTER both calls are
    // in flight, so under the buggy single-slot design the second
    // call's hook-set has already overwritten the first's by the time
    // a tick for path A arrives, and A's tick silently routes to B's
    // closure. This is the regression-discriminator the per-instance
    // slot design fails on.
    const { client, events } = makeHarness({
      doDownloadFile: async (t, options) => {
        const path = t.kind === "path" ? t.path : t.handle;
        const stream = path === targetA.path ? streamA : streamB;
        options.signal?.addEventListener("abort", () => {
          stream.destroy(
            Object.assign(new Error("aborted"), { name: "AbortError" }),
          );
        });
        return { stream, contentLength: 16_384 };
      },
    });

    // Start both calls concurrently on the SAME client instance.
    const [resultA, resultB] = await Promise.all([
      client.downloadFile(targetA, { signal: controllerA.signal }),
      client.downloadFile(targetB, { signal: controllerB.signal }),
    ]);

    // Both downloads are now in flight. Tick `emitDownloading` for
    // each path — the helper MUST route each tick to the matching
    // call's closure. Under the buggy single-slot design, the second
    // `downloadFile` call had overwritten the instance hook with B's
    // closure, so a tick for path A would update B's `lastLoaded`
    // (not A's), leaving A's closure-captured `lastLoaded` at 0.
    const helper = client as unknown as {
      emitDownloading: (p: string, loaded: number, total: number | null) => void;
    };
    helper.emitDownloading(targetA.path, 1024, 16_384);
    helper.emitDownloading(targetB.path, 4096, 16_384);

    // Drain both streams so the base's listeners fire on cancel.
    const drainedA = new Promise<void>((resolve) => {
      resultA.stream.on("data", () => {});
      resultA.stream.on("end", () => resolve());
      resultA.stream.on("error", () => resolve());
    });
    const drainedB = new Promise<void>((resolve) => {
      resultB.stream.on("data", () => {});
      resultB.stream.on("end", () => resolve());
      resultB.stream.on("error", () => resolve());
    });

    // Abort A first; assert A's cancel event carries A's own byte
    // count (1024). Under the buggy single-slot design, A's
    // closure-captured `lastLoaded` would be 0 (the tick for A had
    // routed to B's closure), so A's cancel would emit
    // `bytesDownloaded: 0`.
    controllerA.abort();
    await drainedA;

    const cancelledA = events.filter(
      (e) =>
        e.event === "download-cancelled" &&
        (e.payload as { path: string }).path === targetA.path,
    );
    expect(cancelledA).toHaveLength(1);
    expect(cancelledA[0]?.payload).toEqual({
      path: targetA.path,
      bytesDownloaded: 1024,
      bytesTotal: 16_384,
    });

    // Now abort B; B's cancel event must carry B's own byte count
    // (4096). Under the buggy single-slot design, B's closure would
    // have ALSO captured A's tick (since A's tick routed to B's
    // closure), so B's `lastLoaded` would be 4096 — but A's tick
    // would have first set it to 1024 then B's tick overwrote to
    // 4096, so B happens to land on the correct value here. The
    // distinguishing assertion is A's, above; B's is included for
    // completeness so the test exercises both cancel paths.
    controllerB.abort();
    await drainedB;

    const cancelledB = events.filter(
      (e) =>
        e.event === "download-cancelled" &&
        (e.payload as { path: string }).path === targetB.path,
    );
    expect(cancelledB).toHaveLength(1);
    expect(cancelledB[0]?.payload).toEqual({
      path: targetB.path,
      bytesDownloaded: 4096,
      bytesTotal: 16_384,
    });

    // Sanity: no cross-contamination produces a stray `download-failed`.
    expect(events.some((e) => e.event === "download-failed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Strategies cannot emit events directly
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — no direct bus.emit in strategies", () => {
  it("only base-client.ts references bus.emit in packages/fs-datasource-engine/src/", () => {
    const root = join(__dirname);
    const files = walkTs(root);
    const offenders: string[] = [];
    for (const file of files) {
      const base = file.split(/[\\/]/).pop() ?? "";
      if (base === "base-client.ts") continue;
      if (base === "event-bus.ts") continue; // the bus itself
      if (base.endsWith(".test.ts")) continue;
      const content = readFileSync(file, "utf8");
      if (/\.emit\s*\(/.test(content) || /bus\.emit/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTs(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}
