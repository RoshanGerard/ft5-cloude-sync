import { describe, expect, it, vi } from "vitest";

import { NoopMonitorEventSource } from "./noop-monitor.js";

describe("NoopMonitorEventSource", () => {
  it("start() resolves and stop() resolves without side effects", async () => {
    const m = new NoopMonitorEventSource();
    await expect(m.start()).resolves.toBeUndefined();
    await expect(m.stop()).resolves.toBeUndefined();
  });

  it("registered onChange listener is never invoked", async () => {
    const m = new NoopMonitorEventSource();
    const listener = vi.fn();
    const unsub = m.onChange(listener);
    await m.start();
    await new Promise((r) => setTimeout(r, 50));
    await m.stop();
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it("registered onSnapshot listener is never invoked", async () => {
    const m = new NoopMonitorEventSource();
    const listener = vi.fn();
    const unsub = m.onSnapshot(listener);
    await m.start();
    await new Promise((r) => setTimeout(r, 50));
    await m.stop();
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });
});
