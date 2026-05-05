import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock `electron` BEFORE the preload module is imported. The preload script
// calls `contextBridge.exposeInMainWorld` at module load as a side effect,
// so we use dynamic `import(...)` inside each test after `vi.resetModules()`
// to get a fresh, observable invocation.
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import { contextBridge, ipcRenderer } from "electron";

import {
  SYNC_CHANNELS,
} from "@ft5/ipc-contracts/sync-service-desktop";
import type {
  SyncEvent,
  SyncListJobsRequest,
  SyncListJobsResponse,
  SyncGetJobRequest,
  SyncGetJobResponse,
  SyncEnqueueUploadRequest,
  SyncEnqueueUploadResponse,
  SyncEnqueueMirrorRequest,
  SyncEnqueueMirrorResponse,
  SyncCancelDownloadRequest,
  SyncCancelDownloadResponse,
  SyncCancelJobRequest,
  SyncCancelJobResponse,
  SyncAuthenticateCancelRequest,
  SyncAuthenticateCancelResponse,
  SyncAuthenticateStartRequest,
  SyncAuthenticateStartResponse,
  SyncAuthenticateCompleteRequest,
  SyncAuthenticateCompleteResponse,
  SyncGetStatusResponse,
  SyncGetRetryPolicyRequest,
  SyncGetRetryPolicyResponse,
  SyncSetRetryPolicyRequest,
  SyncSetRetryPolicyResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

type ExposedSync = {
  listJobs: (req: SyncListJobsRequest) => Promise<SyncListJobsResponse>;
  getJob: (req: SyncGetJobRequest) => Promise<SyncGetJobResponse>;
  enqueueUpload: (req: SyncEnqueueUploadRequest) => Promise<SyncEnqueueUploadResponse>;
  enqueueMirror: (req: SyncEnqueueMirrorRequest) => Promise<SyncEnqueueMirrorResponse>;
  cancelJob: (req: SyncCancelJobRequest) => Promise<SyncCancelJobResponse>;
  cancelDownload: (
    req: SyncCancelDownloadRequest,
  ) => Promise<SyncCancelDownloadResponse>;
  authenticateStart: (req: SyncAuthenticateStartRequest) => Promise<SyncAuthenticateStartResponse>;
  authenticateComplete: (req: SyncAuthenticateCompleteRequest) => Promise<SyncAuthenticateCompleteResponse>;
  authenticateCancel: (req: SyncAuthenticateCancelRequest) => Promise<SyncAuthenticateCancelResponse>;
  getStatus: () => Promise<SyncGetStatusResponse>;
  getRetryPolicy: (req: SyncGetRetryPolicyRequest) => Promise<SyncGetRetryPolicyResponse>;
  setRetryPolicy: (req: SyncSetRetryPolicyRequest) => Promise<SyncSetRetryPolicyResponse>;
  onEvent: (callback: (event: SyncEvent) => void) => () => void;
};

type ExposedApi = {
  sync: ExposedSync;
  [key: string]: unknown;
};

async function loadExposed(): Promise<ExposedApi> {
  await import("../index");
  const exposeMock = contextBridge.exposeInMainWorld as unknown as ReturnType<
    typeof vi.fn
  >;
  return exposeMock.mock.calls[0]![1] as ExposedApi;
}

describe("preload sync surface", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("exposes a sync object with exactly 14 members (13 commands + onEvent), no legacy `authenticate`", async () => {
    const exposed = await loadExposed();

    expect(typeof exposed.sync).toBe("object");
    expect(Object.keys(exposed.sync).sort()).toEqual(
      [
        "authenticateCancel",
        "authenticateComplete",
        "authenticateStart",
        "cancelDownload",
        "cancelJob",
        // migrate-upload-orchestration-out-of-engine §7.3 / §7.9 —
        // dedicated cancel surface for the new `files:upload` direct
        // RPC, keyed by service-minted `uploadJobId`.
        "cancelUpload",
        "enqueueMirror",
        "enqueueUpload",
        "getJob",
        "getRetryPolicy",
        "getStatus",
        "listJobs",
        "onEvent",
        "setRetryPolicy",
      ].sort(),
    );
    // legacy single-shot `authenticate` must NOT be exposed
    expect("authenticate" in exposed.sync).toBe(false);
  });

  describe("request/response commands", () => {
    it("listJobs(req) invokes SYNC_CHANNELS.listJobs with req and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response: SyncListJobsResponse = {
        jobs: [],
        derivedSyncingDatasourceIds: [],
      };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req: SyncListJobsRequest = {};
      const result = await exposed.sync.listJobs(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([SYNC_CHANNELS.listJobs, req]);
      expect(result).toBe(response);
    });

    it("getJob(req) invokes SYNC_CHANNELS.getJob with req and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response: SyncGetJobResponse = { job: null };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req: SyncGetJobRequest = { jobId: "j-1" };
      const result = await exposed.sync.getJob(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([SYNC_CHANNELS.getJob, req]);
      expect(result).toBe(response);
    });

    it("enqueueUpload(req) invokes SYNC_CHANNELS.enqueueUpload with req and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response: SyncEnqueueUploadResponse = { jobId: "j-2" };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req: SyncEnqueueUploadRequest = {
        datasourceId: "ds-1",
        sourcePath: "/tmp/file.txt",
        targetPath: "/remote/file.txt",
        conflictPolicy: "overwrite",
      };
      const result = await exposed.sync.enqueueUpload(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([SYNC_CHANNELS.enqueueUpload, req]);
      expect(result).toBe(response);
    });

    it("enqueueMirror(req) invokes SYNC_CHANNELS.enqueueMirror with req and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response: SyncEnqueueMirrorResponse = { jobId: "j-3" };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req: SyncEnqueueMirrorRequest = {
        datasourceId: "ds-1",
        sourcePath: "/tmp/dir",
      };
      const result = await exposed.sync.enqueueMirror(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([SYNC_CHANNELS.enqueueMirror, req]);
      expect(result).toBe(response);
    });

    it("cancelJob(req) invokes SYNC_CHANNELS.cancelJob with req and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response: SyncCancelJobResponse = { cancelled: true };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req: SyncCancelJobRequest = { jobId: "j-1" };
      const result = await exposed.sync.cancelJob(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([SYNC_CHANNELS.cancelJob, req]);
      expect(result).toBe(response);
    });

    // add-download-resilience §12.6.6 (iter-5, Decision 16) — cancelDownload
    // routes through its OWN channel (sync:cancel-download), distinct from
    // cancelJob (sync:cancel-job). Pre-iter-5, the renderer toaster's
    // Cancel button collision-routed via cancelJob; this test pins the
    // separate channel mapping so the regression cannot recur.
    it("cancelDownload(req) invokes SYNC_CHANNELS.cancelDownload with req and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response: SyncCancelDownloadResponse = { cancelled: true };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req: SyncCancelDownloadRequest = { downloadJobId: "d-1" };
      const result = await exposed.sync.cancelDownload(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([
        SYNC_CHANNELS.cancelDownload,
        req,
      ]);
      // Crucially the call did NOT route to SYNC_CHANNELS.cancelJob —
      // pin the separation so a future refactor cannot collapse the two.
      expect(invokeMock.mock.calls[0]?.[0]).not.toBe(SYNC_CHANNELS.cancelJob);
      expect(result).toBe(response);
    });

    it("authenticateStart(req) invokes SYNC_CHANNELS.authenticateStart with req and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response: SyncAuthenticateStartResponse = {
        ok: true,
        result: { correlationId: "corr-1", kind: "oauth" },
      };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req: SyncAuthenticateStartRequest = {
        providerId: "google-drive",
      };
      const result = await exposed.sync.authenticateStart(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([SYNC_CHANNELS.authenticateStart, req]);
      expect(result).toBe(response);
    });

    it("authenticateComplete(req) invokes SYNC_CHANNELS.authenticateComplete with req and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response: SyncAuthenticateCompleteResponse = {
        ok: true,
        result: {
          datasourceId: "ds-1",
          summary: {
            id: "ds-1",
            providerId: "amazon-s3",
            displayName: "S3",
            status: "connected",
            errorReason: null,
            errorKind: null,
            paused: false,
            lastSyncAt: null,
            itemCount: 0,
          },
        },
      };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req: SyncAuthenticateCompleteRequest = {
        correlationId: "corr-1",
        completion: {
          kind: "credentials-form",
          values: { accessKeyId: "x", secretAccessKey: "y" },
        },
      };
      const result = await exposed.sync.authenticateComplete(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([SYNC_CHANNELS.authenticateComplete, req]);
      expect(result).toBe(response);
    });

    it("authenticateCancel(req) invokes SYNC_CHANNELS.authenticateCancel with req and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response: SyncAuthenticateCancelResponse = {
        ok: true,
        result: { cancelled: true },
      };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req: SyncAuthenticateCancelRequest = { correlationId: "corr-1" };
      const result = await exposed.sync.authenticateCancel(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([
        SYNC_CHANNELS.authenticateCancel,
        req,
      ]);
      expect(result).toBe(response);
    });

    it("getStatus() invokes SYNC_CHANNELS.getStatus with no args (void request) and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response: SyncGetStatusResponse = {
        version: "1.0.0",
        serviceUuid: "uuid-1",
        runningJobs: 0,
        queuedJobs: 0,
        waitingNetworkJobs: 0,
      };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const result = await exposed.sync.getStatus();

      expect(invokeMock).toHaveBeenCalledTimes(1);
      // Single-arg call (no second arg) — mirrors the ping() pattern
      expect(invokeMock.mock.calls[0]).toEqual([SYNC_CHANNELS.getStatus]);
      expect(result).toBe(response);
    });

    it("getRetryPolicy(req) invokes SYNC_CHANNELS.getRetryPolicy with req and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response: SyncGetRetryPolicyResponse = {
        policy: {
          maxAttempts: 3,
          backoffMs: 1000,
          backoffStrategy: "exponential",
        },
      };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req: SyncGetRetryPolicyRequest = { scope: "global" };
      const result = await exposed.sync.getRetryPolicy(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([SYNC_CHANNELS.getRetryPolicy, req]);
      expect(result).toBe(response);
    });

    it("setRetryPolicy(req) invokes SYNC_CHANNELS.setRetryPolicy with req and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response: SyncSetRetryPolicyResponse = {
        policy: {
          maxAttempts: 5,
          backoffMs: 2000,
          backoffStrategy: "linear",
        },
      };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req: SyncSetRetryPolicyRequest = {
        scope: "global",
        maxAttempts: 5,
        backoffMs: 2000,
        backoffStrategy: "linear",
      };
      const result = await exposed.sync.setRetryPolicy(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([SYNC_CHANNELS.setRetryPolicy, req]);
      expect(result).toBe(response);
    });
  });

  describe("onEvent subscription", () => {
    it("onEvent registers a listener on SYNC_CHANNELS.event and delivers the payload to the callback", async () => {
      const onMock = ipcRenderer.on as unknown as ReturnType<typeof vi.fn>;
      const removeListenerMock =
        ipcRenderer.removeListener as unknown as ReturnType<typeof vi.fn>;

      const exposed = await loadExposed();
      const callback = vi.fn();

      const unsubscribe = exposed.sync.onEvent(callback);

      // Registered exactly one listener on the event channel.
      expect(onMock).toHaveBeenCalledTimes(1);
      const [channel, listener] = onMock.mock.calls[0]!;
      expect(channel).toBe(SYNC_CHANNELS.event);
      expect(typeof listener).toBe("function");

      // Simulate delivery of a SyncEvent — the preload listener strips the
      // IpcRendererEvent and passes only the payload through to the caller's
      // callback.
      const sampleEvent: SyncEvent = {
        kind: "job-enqueued",
        payload: {
          jobId: "j-1",
          datasourceId: "ds-1",
          kind: "upload",
          enqueuedAt: 1_700_000_000_000,
        },
      };
      (listener as (ev: unknown, payload: SyncEvent) => void)({}, sampleEvent);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(sampleEvent);

      // The returned unsubscribe must be a function that removes THAT listener
      // from THAT channel.
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
      expect(removeListenerMock).toHaveBeenCalledTimes(1);
      expect(removeListenerMock.mock.calls[0]).toEqual([
        SYNC_CHANNELS.event,
        listener,
      ]);
    });

    it("onEvent supports multiple independent subscribers, each with its own listener registration", async () => {
      const onMock = ipcRenderer.on as unknown as ReturnType<typeof vi.fn>;
      const removeListenerMock =
        ipcRenderer.removeListener as unknown as ReturnType<typeof vi.fn>;

      const exposed = await loadExposed();
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      const unsub1 = exposed.sync.onEvent(cb1);
      const unsub2 = exposed.sync.onEvent(cb2);

      expect(onMock).toHaveBeenCalledTimes(2);
      const listener1 = onMock.mock.calls[0]![1] as (
        ev: unknown,
        payload: SyncEvent,
      ) => void;
      const listener2 = onMock.mock.calls[1]![1] as (
        ev: unknown,
        payload: SyncEvent,
      ) => void;
      expect(listener1).not.toBe(listener2);

      unsub1();
      expect(removeListenerMock).toHaveBeenCalledWith(
        SYNC_CHANNELS.event,
        listener1,
      );
      unsub2();
      expect(removeListenerMock).toHaveBeenCalledWith(
        SYNC_CHANNELS.event,
        listener2,
      );
    });
  });
});
