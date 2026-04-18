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

import { DATASOURCES_CHANNELS } from "@ft5/ipc-contracts";
import type { DatasourcesUploadProgressEvent } from "@ft5/ipc-contracts";

type ExposedApi = {
  ping: () => Promise<unknown>;
  datasources: {
    list: () => Promise<unknown>;
    add: (req: unknown) => Promise<unknown>;
    remove: (req: unknown) => Promise<unknown>;
    action: (req: unknown) => Promise<unknown>;
    upload: (req: unknown) => Promise<unknown>;
    onUploadProgress: (
      transactionId: string,
      callback: (event: DatasourcesUploadProgressEvent) => void,
    ) => () => void;
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
    expect(Object.keys(exposed).sort()).toEqual(["datasources", "ping"]);
    expect(typeof exposed.ping).toBe("function");
    expect(typeof exposed.datasources).toBe("object");
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
    it("exposes list/add/remove/action/upload as functions and onUploadProgress as a function", async () => {
      const exposed = await loadExposed();

      expect(typeof exposed.datasources.list).toBe("function");
      expect(typeof exposed.datasources.add).toBe("function");
      expect(typeof exposed.datasources.remove).toBe("function");
      expect(typeof exposed.datasources.action).toBe("function");
      expect(typeof exposed.datasources.upload).toBe("function");
      expect(typeof exposed.datasources.onUploadProgress).toBe("function");
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

    it("upload(req) delegates to ipcRenderer.invoke('datasources:upload', req) and returns the resolved value", async () => {
      const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
      const response = { transactionId: "tx-1" };
      invokeMock.mockResolvedValue(response);

      const exposed = await loadExposed();
      const req = { datasourceId: "ds-1" };
      const result = await exposed.datasources.upload(req);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]).toEqual([
        DATASOURCES_CHANNELS.upload,
        req,
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
  });
});
