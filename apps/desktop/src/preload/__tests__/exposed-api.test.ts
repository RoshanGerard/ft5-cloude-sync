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

import { DATASOURCES_CHANNELS, FILES_CHANNELS } from "@ft5/ipc-contracts";
import type {
  AnyDatasourceEvent,
  DatasourceEvent,
  DatasourcesUploadProgressEvent,
} from "@ft5/ipc-contracts";

type ExposedApi = {
  ping: () => Promise<unknown>;
  datasources: {
    list: () => Promise<unknown>;
    add: (req: unknown) => Promise<unknown>;
    remove: (req: unknown) => Promise<unknown>;
    action: (req: unknown) => Promise<unknown>;
    pickFilesToUpload: () => Promise<unknown>;
    onUploadProgress: (
      transactionId: string,
      callback: (event: DatasourcesUploadProgressEvent) => void,
    ) => () => void;
    onEvent: (
      callback: (event: AnyDatasourceEvent) => void,
    ) => () => void;
  };
  files: {
    list: (req: unknown) => Promise<unknown>;
    stat: (req: unknown) => Promise<unknown>;
    search: (req: unknown) => Promise<unknown>;
    rename: (req: unknown) => Promise<unknown>;
    remove: (req: unknown) => Promise<unknown>;
    download: (req: unknown) => Promise<unknown>;
    upload: (req: unknown) => Promise<unknown>;
  };
  clipboard: {
    writeText: (text: string) => Promise<void>;
  };
};

async function loadExposed(): Promise<ExposedApi> {
  await import("../index");
  const exposeMock = contextBridge.exposeInMainWorld as unknown as ReturnType<
    typeof vi.fn
  >;
  return exposeMock.mock.calls[0]![1] as ExposedApi;
}

describe("preload exposed api", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("exposes both ping and datasources on window.api via contextBridge", async () => {
    await import("../index");

    const exposeMock = contextBridge.exposeInMainWorld as unknown as ReturnType<typeof vi.fn>;
    expect(exposeMock).toHaveBeenCalledTimes(1);

    const callArgs = exposeMock.mock.calls[0]!;
    expect(callArgs[0]).toBe("api");

    const exposed = callArgs[1] as Record<string, unknown>;
    expect(Object.keys(exposed).sort()).toEqual([
      "clipboard",
      "datasources",
      "files",
      "ping",
      "sync",
    ]);
    expect(typeof exposed.ping).toBe("function");
    expect(typeof exposed.datasources).toBe("object");
    expect(typeof exposed.files).toBe("object");
    expect(typeof exposed.clipboard).toBe("object");
    expect(typeof exposed.sync).toBe("object");
  });

  it("ping() invokes ipcRenderer.invoke('ping') with no other args and returns its resolved value", async () => {
    const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockResolvedValue({ ok: true, ts: 123 });

    const exposed = await loadExposed();
    const result = await exposed.ping();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]).toEqual(["ping"]);
    expect(result).toEqual({ ok: true, ts: 123 });
  });

  describe("datasources surface", () => {
    it("exposes list/add/remove/action/pickFilesToUpload as functions and onUploadProgress as a function", async () => {
      const exposed = await loadExposed();

      expect(typeof exposed.datasources.list).toBe("function");
      expect(typeof exposed.datasources.add).toBe("function");
      expect(typeof exposed.datasources.remove).toBe("function");
      expect(typeof exposed.datasources.action).toBe("function");
      expect(typeof exposed.datasources.pickFilesToUpload).toBe("function");
      expect(typeof exposed.datasources.onUploadProgress).toBe("function");
      expect(typeof exposed.datasources.onEvent).toBe("function");
    });

    it("does NOT expose datasources.upload — the legacy channel is retired in favor of files.upload + datasources.pickFilesToUpload", async () => {
      const exposed = await loadExposed();
      const datasources = exposed.datasources as unknown as Record<
        string,
        unknown
      >;
      expect(datasources.upload).toBeUndefined();
      expect(
        Object.prototype.hasOwnProperty.call(datasources, "upload"),
      ).toBe(false);
    });

    it("list() delegates to ipcRenderer.invoke('datasources:list') and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response = { datasources: [] };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const result = await exposed.datasources.list();

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([DATASOURCES_CHANNELS.list]);
      expect(result).toBe(response);
    });

    it("add(req) delegates to ipcRenderer.invoke('datasources:add', req) and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response = { datasource: { id: "x" } };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req = { providerId: "google-drive", credentials: { token: "t" } };
      const result = await exposed.datasources.add(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([DATASOURCES_CHANNELS.add, req]);
      expect(result).toBe(response);
    });

    it("remove(req) delegates to ipcRenderer.invoke('datasources:remove', req) and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response = { ok: true as const };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req = { datasourceId: "ds-1" };
      const result = await exposed.datasources.remove(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([
        DATASOURCES_CHANNELS.remove,
        req,
      ]);
      expect(result).toBe(response);
    });

    it("action(req) delegates to ipcRenderer.invoke('datasources:action', req) and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response = { datasource: { id: "x" } };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req = { datasourceId: "ds-1", action: "pause" as const };
      const result = await exposed.datasources.action(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([
        DATASOURCES_CHANNELS.action,
        req,
      ]);
      expect(result).toBe(response);
    });

    it("pickFilesToUpload() delegates to ipcRenderer.invoke('datasources:pick-files-to-upload') with NO second arg — mirrors the void-request `ping`/`getStatus` pattern — and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response = {
        filePaths: ["/tmp/a.txt", "/tmp/b.txt"] as const,
        canceled: false,
      };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const result = await exposed.datasources.pickFilesToUpload();

      expect(invokeMock).toHaveBeenCalledTimes(1);
      // Bare-channel invocation: the DatasourcesPickFilesRequest contract
      // type is `Record<string, never>`, so the preload takes no args and
      // passes only the channel to ipcRenderer.invoke — no empty object.
      expect(invokeMock.mock.calls[0]).toEqual([
        DATASOURCES_CHANNELS.pickFilesToUpload,
      ]);
      expect(result).toBe(response);
    });

    it("onUploadProgress registers a listener on the progress channel and filters by transactionId", async () => {
      const onMock = ipcRenderer.on as unknown as ReturnType<typeof vi.fn>;
      const removeListenerMock = ipcRenderer.removeListener as unknown as ReturnType<
        typeof vi.fn
      >;

      const exposed = await loadExposed();
      const callback = vi.fn();
      const subscribedTxId = "tx-42";

      const unsubscribe = exposed.datasources.onUploadProgress(
        subscribedTxId,
        callback,
      );

      expect(onMock).toHaveBeenCalledTimes(1);
      const [channel, listener] = onMock.mock.calls[0]!;
      expect(channel).toBe(DATASOURCES_CHANNELS.uploadProgress);
      expect(typeof listener).toBe("function");

      // Simulate an event for a DIFFERENT transaction: callback must NOT fire.
      const otherEvent: DatasourcesUploadProgressEvent = {
        transactionId: "tx-99",
        bytesUploaded: 1,
        bytesTotal: 10,
        status: "uploading",
      };
      (listener as (ev: unknown, payload: DatasourcesUploadProgressEvent) => void)(
        {},
        otherEvent,
      );
      expect(callback).not.toHaveBeenCalled();

      // Simulate an event for the SUBSCRIBED transaction: callback fires with payload.
      const matchingEvent: DatasourcesUploadProgressEvent = {
        transactionId: subscribedTxId,
        bytesUploaded: 5,
        bytesTotal: 10,
        status: "uploading",
      };
      (listener as (ev: unknown, payload: DatasourcesUploadProgressEvent) => void)(
        {},
        matchingEvent,
      );
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(matchingEvent);

      // The returned unsubscribe must be a function that removes THAT listener
      // from THAT channel.
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
      expect(removeListenerMock).toHaveBeenCalledTimes(1);
      expect(removeListenerMock.mock.calls[0]).toEqual([
        DATASOURCES_CHANNELS.uploadProgress,
        listener,
      ]);
    });

    it("onEvent subscribes to DATASOURCES_CHANNELS.event without filtering and returns an unsubscribe that removes the SAME listener", async () => {
      // Unlike `onUploadProgress`, `onEvent` is a broad subscription: every
      // DatasourceEvent crossing the bridge is delivered to the callback
      // unfiltered. Consumers narrow client-side via
      // `switch (e.datasourceType)` / `switch (e.event)`.
      const onMock = ipcRenderer.on as unknown as ReturnType<typeof vi.fn>;
      const removeListenerMock =
        ipcRenderer.removeListener as unknown as ReturnType<typeof vi.fn>;

      const exposed = await loadExposed();
      const callback = vi.fn();

      const unsubscribe = exposed.datasources.onEvent(callback);

      // Registered exactly one listener on the broadcast channel.
      expect(onMock).toHaveBeenCalledTimes(1);
      const [channel, listener] = onMock.mock.calls[0]!;
      expect(channel).toBe(DATASOURCES_CHANNELS.event);
      expect(typeof listener).toBe("function");

      // Simulate delivery of a representative DatasourceEvent. The preload
      // listener must strip the IpcRendererEvent and pass only the payload
      // through to the caller's callback.
      const sampleEvent: DatasourceEvent<"amazon-s3", "file-created"> = {
        event: "file-created",
        datasourceType: "amazon-s3",
        datasourceId: "ds-1",
        ts: 1_700_000_000_000,
        // The payload's static shape is `unknown` in Phase 1; the test only
        // asserts identity-through-delivery, not payload shape.
        payload: { bucket: "b", key: "k" } as unknown,
      };
      (listener as (
        ev: unknown,
        payload: AnyDatasourceEvent,
      ) => void)({}, sampleEvent);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(sampleEvent);

      // A second event — for a different provider — must also pass through
      // without any filtering (contrast with onUploadProgress's tx-id gate).
      const otherEvent: DatasourceEvent<"google-drive", "uploading"> = {
        event: "uploading",
        datasourceType: "google-drive",
        datasourceId: "ds-2",
        ts: 1_700_000_000_001,
        streaming: true,
        payload: { progress: 0.5 } as unknown,
      };
      (listener as (
        ev: unknown,
        payload: AnyDatasourceEvent,
      ) => void)({}, otherEvent);
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenNthCalledWith(2, otherEvent);

      // Unsubscribe must remove the SAME listener instance from the SAME
      // channel (no partial re-registration tricks).
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
      expect(removeListenerMock).toHaveBeenCalledTimes(1);
      expect(removeListenerMock.mock.calls[0]).toEqual([
        DATASOURCES_CHANNELS.event,
        listener,
      ]);
    });

    it("onEvent supports multiple independent subscribers, each with its own listener registration", async () => {
      // Two subscribers must each get their own registration so one's
      // unsubscribe cannot silently knock out the other.
      const onMock = ipcRenderer.on as unknown as ReturnType<typeof vi.fn>;
      const removeListenerMock =
        ipcRenderer.removeListener as unknown as ReturnType<typeof vi.fn>;

      const exposed = await loadExposed();
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      const unsub1 = exposed.datasources.onEvent(cb1);
      const unsub2 = exposed.datasources.onEvent(cb2);

      expect(onMock).toHaveBeenCalledTimes(2);
      const listener1 = onMock.mock.calls[0]![1] as (
        ev: unknown,
        payload: AnyDatasourceEvent,
      ) => void;
      const listener2 = onMock.mock.calls[1]![1] as (
        ev: unknown,
        payload: AnyDatasourceEvent,
      ) => void;
      expect(listener1).not.toBe(listener2);

      unsub1();
      expect(removeListenerMock).toHaveBeenCalledWith(
        DATASOURCES_CHANNELS.event,
        listener1,
      );
      unsub2();
      expect(removeListenerMock).toHaveBeenCalledWith(
        DATASOURCES_CHANNELS.event,
        listener2,
      );
    });
  });

  describe("files surface", () => {
    it("exposes list/stat/search/rename/remove/download/upload as functions", async () => {
      const exposed = await loadExposed();

      expect(typeof exposed.files.list).toBe("function");
      expect(typeof exposed.files.stat).toBe("function");
      expect(typeof exposed.files.search).toBe("function");
      expect(typeof exposed.files.rename).toBe("function");
      expect(typeof exposed.files.remove).toBe("function");
      expect(typeof exposed.files.download).toBe("function");
      expect(typeof exposed.files.upload).toBe("function");
    });

    it("list(req) delegates to ipcRenderer.invoke('files:list', req)", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response = { entries: [], nextCursor: null };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req = { datasourceId: "ds-1", path: "/" };
      const result = await exposed.files.list(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([FILES_CHANNELS.list, req]);
      expect(result).toBe(response);
    });

    it("stat(req) delegates to ipcRenderer.invoke('files:stat', req)", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response = { entry: { id: "e1" } };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req = { datasourceId: "ds-1", path: "/a.txt" };
      const result = await exposed.files.stat(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([FILES_CHANNELS.stat, req]);
      expect(result).toBe(response);
    });

    it("search(req) delegates to ipcRenderer.invoke('files:search', req)", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response = { entries: [], truncated: false };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req = { datasourceId: "ds-1", query: "foo", path: "/" };
      const result = await exposed.files.search(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([FILES_CHANNELS.search, req]);
      expect(result).toBe(response);
    });

    it("rename(req) delegates to ipcRenderer.invoke('files:rename', req)", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response = { entry: { id: "e1" } };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req = { datasourceId: "ds-1", path: "/a.txt", newName: "b.txt" };
      const result = await exposed.files.rename(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([FILES_CHANNELS.rename, req]);
      expect(result).toBe(response);
    });

    it("remove(req) delegates to ipcRenderer.invoke('files:remove', req)", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response = { removed: [], failed: [] };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req = { datasourceId: "ds-1", paths: ["/a.txt", "/b.txt"] };
      const result = await exposed.files.remove(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([FILES_CHANNELS.remove, req]);
      expect(result).toBe(response);
    });

    it("download(req) delegates to ipcRenderer.invoke('files:download', req)", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response = { savedPath: "/tmp/a.txt" };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req = { datasourceId: "ds-1", path: "/a.txt" };
      const result = await exposed.files.download(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([FILES_CHANNELS.download, req]);
      expect(result).toBe(response);
    });

    it("upload(req) delegates to ipcRenderer.invoke('files:upload', req) and returns the resolved envelope", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response = { ok: true as const, value: { jobId: "job-1" } };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req = {
        datasourceId: "ds-1",
        sourcePath: "/tmp/a.txt",
        targetPath: "/projects/2026/a.txt",
        conflictPolicy: "overwrite" as const,
      };
      const result = await exposed.files.upload(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([FILES_CHANNELS.upload, req]);
      expect(result).toBe(response);
    });
  });
});
