import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type {
  AuthIntent,
  AuthResult,
  CredentialsFormIntent,
  DatasourceEvent,
  DatasourceStatus,
  DatasourceType,
  FileEntry,
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
  doListDirectory?: (target: Target) => Promise<FileEntry<FakeType>[]>;
  doSearch?: (query: string, scope?: Target) => Promise<FileEntry<FakeType>[]>;
  doGetMetadata?: (target: Target) => Promise<FileMetadata<FakeType>>;
  doCreateFile?: (
    parent: Target,
    name: string,
    content: { path: string },
  ) => Promise<FileEntry<FakeType>>;
  doUploadFile?: (
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    onProgress?: (loaded: number, total: number) => void,
  ) => Promise<FileEntry<FakeType>>;
  doDeleteFile?: (target: Target) => Promise<void>;
  doGetQuota?: () => Promise<Quota>;
  refreshToken?: () => Promise<AuthResult>;
  normalizeError?: (raw: unknown) => DatasourceError<FakeType>;
}

function makeEntry(path = "/demo.txt"): FileEntry<FakeType> {
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
    (target: Target) => Promise<FileEntry<FakeType>[]>
  >();
  readonly doSearch = vi.fn<
    (query: string, scope?: Target) => Promise<FileEntry<FakeType>[]>
  >();
  readonly doGetMetadata = vi.fn<
    (target: Target) => Promise<FileMetadata<FakeType>>
  >();
  readonly doCreateFile = vi.fn<
    (
      parent: Target,
      name: string,
      content: { path: string },
    ) => Promise<FileEntry<FakeType>>
  >();
  readonly doUploadFile = vi.fn<
    (
      parent: Target,
      file: { path: string; name?: string; mimeType?: string },
      onProgress?: (loaded: number, total: number) => void,
    ) => Promise<FileEntry<FakeType>>
  >();
  readonly doDeleteFile = vi.fn<(target: Target) => Promise<void>>();
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

    if (cfg.doCreateFile)
      this.doCreateFile.mockImplementation(cfg.doCreateFile);
    else this.doCreateFile.mockResolvedValue(makeEntry());

    if (cfg.doUploadFile)
      this.doUploadFile.mockImplementation(cfg.doUploadFile);
    else this.doUploadFile.mockResolvedValue(makeEntry());

    if (cfg.doDeleteFile)
      this.doDeleteFile.mockImplementation(cfg.doDeleteFile);
    else this.doDeleteFile.mockResolvedValue(undefined);

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
  protected doListDirectoryImpl(target: Target): Promise<FileEntry<FakeType>[]> {
    return this.doListDirectory(target);
  }
  protected doSearchImpl(
    query: string,
    scope?: Target,
  ): Promise<FileEntry<FakeType>[]> {
    return this.doSearch(query, scope);
  }
  protected doGetMetadataImpl(target: Target): Promise<FileMetadata<FakeType>> {
    return this.doGetMetadata(target);
  }
  protected doCreateFileImpl(
    parent: Target,
    name: string,
    content: { path: string },
  ): Promise<FileEntry<FakeType>> {
    return this.doCreateFile(parent, name, content);
  }
  protected doUploadFileImpl(
    parent: Target,
    file: { path: string; name?: string; mimeType?: string },
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<FileEntry<FakeType>> {
    return this.doUploadFile(parent, file, onProgress);
  }
  protected doDeleteFileImpl(target: Target): Promise<void> {
    return this.doDeleteFile(target);
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
  it("uploadFile emits uploading then file-created in order", async () => {
    const { client, events } = makeHarness({
      doUploadFile: async () => makeEntry("/demo.txt"),
    });

    const result = await client.uploadFile(
      { kind: "path", path: "/parent" },
      { path: "C:/tmp/demo.txt", name: "demo.txt" },
    );

    expect(result.path).toBe("/demo.txt");
    // Extract the ordered event names, filtering to the two we expect.
    const names = events.map((e) => e.event);
    const uploadingIdx = names.indexOf("uploading");
    const createdIdx = names.indexOf("file-created");
    expect(uploadingIdx).toBeGreaterThanOrEqual(0);
    expect(createdIdx).toBeGreaterThanOrEqual(0);
    expect(uploadingIdx).toBeLessThan(createdIdx);
    // Envelope fields must carry the provider + datasource ids
    const uploading = events[uploadingIdx]!;
    expect(uploading.datasourceType).toBe("amazon-s3");
    expect(uploading.datasourceId).toBe("ds-1");
    expect(uploading.streaming).toBe(true);
    const created = events[createdIdx]!;
    expect(created.datasourceType).toBe("amazon-s3");
    expect(created.datasourceId).toBe("ds-1");
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
// uploadFile passes an onProgress callback to doUploadFileImpl that re-emits
// `uploading` with streaming: true for mid-upload progress ticks. The ticks
// share the initial `uploading` event's transactionId so the bus coalesces
// them per-transaction. (Added for Phase 6 — S3Client's Upload helper fires
// httpUploadProgress events which the strategy pipes through this callback.)
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — uploadFile onProgress streaming ticks", () => {
  it("doUploadFileImpl receives onProgress; invoking it emits streaming uploading ticks sharing the initial transactionId", async () => {
    let captured: ((loaded: number, total: number) => void) | undefined;

    const { client, events } = makeHarness({
      doUploadFile: async (_parent, _file, onProgress) => {
        captured = onProgress;
        // Simulate mid-upload progress ticks.
        onProgress?.(500, 1000);
        onProgress?.(1000, 1000);
        return makeEntry("/demo.txt");
      },
    });

    await client.uploadFile(
      { kind: "path", path: "/parent" },
      { path: "C:/tmp/demo.txt", name: "demo.txt" },
    );

    // The base must have handed a real callback down.
    expect(typeof captured).toBe("function");

    // Collect every `uploading` event.
    const uploadings = events.filter((e) => e.event === "uploading");
    // Initial (progress:0) + at least one mid-upload tick must be visible.
    // The bus throttles on 1s/10%, but the first streaming emission for a new
    // key delivers immediately AND a progress jump of 0→50 crosses the 10%
    // delta threshold, so the tick at loaded=500/total=1000 must emit.
    expect(uploadings.length).toBeGreaterThanOrEqual(2);

    // All uploading events must be streaming-flagged.
    for (const u of uploadings) {
      expect(u.streaming).toBe(true);
    }

    // The mid-upload tick must carry a numeric `progress` representing the
    // loaded/total ratio as percentage points, and must reuse the initial
    // emission's transactionId so the bus coalesces the stream.
    const initial = uploadings[0]!;
    const initialPayload = initial.payload as { transactionId?: string };
    const tick = uploadings[1]!;
    const tickPayload = tick.payload as {
      transactionId?: string;
      progress?: number;
    };
    expect(tickPayload.transactionId).toBe(initialPayload.transactionId);
    expect(tickPayload.progress).toBe(50);
  });

  it("onProgress handles total=0 defensively (no NaN, no crash)", async () => {
    const { client } = makeHarness({
      doUploadFile: async (_parent, _file, onProgress) => {
        // Edge: an SDK emits progress before the total is known.
        onProgress?.(0, 0);
        return makeEntry("/demo.txt");
      },
    });

    // Must not reject — the base's onProgress wrapper must guard against
    // division-by-zero when computing percentage.
    await expect(
      client.uploadFile(
        { kind: "path", path: "/parent" },
        { path: "C:/tmp/demo.txt" },
      ),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Failing op: pre + failed, throws normalized error
// ---------------------------------------------------------------------------

describe("BaseDatasourceClient — failure path emission", () => {
  it("uploadFile failure emits uploading then upload-failed and throws DatasourceError", async () => {
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

    expect(caught).toBeInstanceOf(DatasourceError);
    expect((caught as DatasourceError).tag).toBe("network-error");
    const names = events.map((e) => e.event);
    expect(names).toContain("uploading");
    expect(names).toContain("upload-failed");
    const uploadingIdx = names.indexOf("uploading");
    const failedIdx = names.indexOf("upload-failed");
    expect(uploadingIdx).toBeLessThan(failedIdx);
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

  it("createFile failure routes through upload-failed (with meta.via=createFile)", async () => {
    const { client, events } = makeHarness({
      doCreateFile: async () => {
        throw { __tag: "conflict" };
      },
    });

    await expect(
      client.createFile({ kind: "path", path: "/p" }, "x.txt", {
        path: "C:/tmp/x.txt",
      }),
    ).rejects.toBeInstanceOf(DatasourceError);
    const failed = events.find((e) => e.event === "upload-failed");
    expect(failed).toBeDefined();
    // Flag: this is deliberate routing until `create-failed` is added.
    const payload = failed?.payload as { via?: string } | undefined;
    expect(payload?.via).toBe("createFile");
  });
});

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
      ) => Promise<FileEntry<FakeType>[]>,
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
        ) => Promise<FileEntry<FakeType>[]>,
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
      ) => Promise<FileEntry<FakeType>[]>,
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
