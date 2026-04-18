import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock `electron` BEFORE the preload module is imported. The preload script
// calls `contextBridge.exposeInMainWorld` at module load as a side effect,
// so we use dynamic `import(...)` inside each test after `vi.resetModules()`
// to get a fresh, observable invocation.
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
}));

import { contextBridge, ipcRenderer } from "electron";

describe("preload exposed api", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("exposes exactly { ping } on window.api via contextBridge", async () => {
    await import("../index");

    const exposeMock = contextBridge.exposeInMainWorld as unknown as ReturnType<typeof vi.fn>;
    expect(exposeMock).toHaveBeenCalledTimes(1);

    const callArgs = exposeMock.mock.calls[0]!;
    expect(callArgs[0]).toBe("api");

    const exposed = callArgs[1] as Record<string, unknown>;
    expect(Object.keys(exposed)).toEqual(["ping"]);
    expect(typeof exposed.ping).toBe("function");
  });

  it("ping() invokes ipcRenderer.invoke('ping') with no other args and returns its resolved value", async () => {
    const invokeMock = ipcRenderer.invoke as unknown as ReturnType<typeof vi.fn>;
    invokeMock.mockResolvedValue({ ok: true, ts: 123 });

    await import("../index");

    const exposeMock = contextBridge.exposeInMainWorld as unknown as ReturnType<typeof vi.fn>;
    const exposed = exposeMock.mock.calls[0]![1] as {
      ping: () => Promise<unknown>;
    };

    const result = await exposed.ping();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]).toEqual(["ping"]);
    expect(result).toEqual({ ok: true, ts: 123 });
  });
});
