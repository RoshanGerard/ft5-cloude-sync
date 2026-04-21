// Phase 10.2 — tests for the main-process event forwarder that bridges the
// engine's `EventBus` to renderer windows over `DATASOURCES_CHANNELS.event`.
//
// Electron is mocked as a tiny stub here because the bridge only needs
// `BrowserWindow`'s shape — a `webContents.send` sink and an `isDestroyed`
// probe. We also don't need `safeStorage` in these tests because the bridge
// doesn't touch credentials.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATASOURCES_CHANNELS } from "@ft5/ipc-contracts";
import { createEventBus, type EventBus } from "@ft5/fs-datasource-engine";

import { createEventBridge } from "../event-bridge.js";

// Minimal BrowserWindow stub: `webContents.send` and `isDestroyed` are the
// only surface the bridge touches. `vi.fn()` gives us the usual call-count
// and argument assertions.
interface FakeWindow {
  isDestroyed: ReturnType<typeof vi.fn>;
  webContents: {
    send: ReturnType<typeof vi.fn>;
  };
}

function makeWindow(): FakeWindow {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
    },
  };
}

describe("createEventBridge", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = createEventBus();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subscribes to the bus on construction", () => {
    const subscribeSpy = vi.spyOn(bus, "subscribe");
    const handle = createEventBridge(bus);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it("broadcasts one emit to every registered window exactly once", () => {
    const handle = createEventBridge(bus);
    const winA = makeWindow();
    const winB = makeWindow();
    handle.registerWindow(winA as unknown as Electron.BrowserWindow);
    handle.registerWindow(winB as unknown as Electron.BrowserWindow);

    bus.emit({
      event: "token-refreshed",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      ts: 1_700_000_000_000,
      payload: { expiresAt: 1_700_003_600_000 },
    });

    expect(winA.webContents.send).toHaveBeenCalledTimes(1);
    expect(winB.webContents.send).toHaveBeenCalledTimes(1);

    const [channelA, payloadA] = winA.webContents.send.mock.calls[0]!;
    expect(channelA).toBe(DATASOURCES_CHANNELS.event);
    expect(payloadA).toMatchObject({
      event: "token-refreshed",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
    });

    const [channelB, payloadB] = winB.webContents.send.mock.calls[0]!;
    expect(channelB).toBe(DATASOURCES_CHANNELS.event);
    expect(payloadB).toMatchObject({
      event: "token-refreshed",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
    });

    handle.dispose();
  });

  it("skips destroyed windows and removes them from its internal set", () => {
    const handle = createEventBridge(bus);
    const alive = makeWindow();
    const dead = makeWindow();
    // `dead` reports itself as destroyed from the first emit onward.
    dead.isDestroyed.mockReturnValue(true);

    handle.registerWindow(alive as unknown as Electron.BrowserWindow);
    handle.registerWindow(dead as unknown as Electron.BrowserWindow);

    bus.emit({
      event: "token-refreshed",
      datasourceType: "onedrive",
      datasourceId: "ds-2",
      ts: 1_700_000_000_000,
      payload: { expiresAt: 1_700_003_600_000 },
    });

    expect(alive.webContents.send).toHaveBeenCalledTimes(1);
    expect(dead.webContents.send).not.toHaveBeenCalled();

    // Second emit — bridge must have pruned `dead` on the first pass, so
    // even if `isDestroyed` changes back to false (simulating a bogus
    // external resurrection), we still shouldn't send to it. The bridge
    // treats "destroyed once" as permanently removed.
    dead.isDestroyed.mockReturnValue(false);

    bus.emit({
      event: "token-expired",
      datasourceType: "onedrive",
      datasourceId: "ds-2",
      ts: 1_700_000_000_001,
      payload: {},
    });

    expect(alive.webContents.send).toHaveBeenCalledTimes(2);
    expect(dead.webContents.send).not.toHaveBeenCalled();

    handle.dispose();
  });

  it("structured-clones the event so function fields in `raw` are stripped", () => {
    const handle = createEventBridge(bus);
    const win = makeWindow();
    handle.registerWindow(win as unknown as Electron.BrowserWindow);

    // Simulate an authentication-failed event whose DatasourceError.raw
    // carries a callable — the kind of thing a provider SDK might hang off
    // an error object (e.g. a retry closure). structured-clone must strip
    // the function before the payload crosses the IPC boundary; Electron's
    // send would also strip it, but we clone inside the bridge so tests
    // (and future subscribers on the main side) see the same shape.
    const callable = (): number => 1;
    const errorPayload = {
      code: "token-invalid" as const,
      message: "stale refresh token",
      providerId: "google-drive",
      retriable: false,
      raw: { fn: callable, keep: "this-stays" },
    };
    bus.emit({
      event: "authentication-failed",
      datasourceType: "google-drive",
      datasourceId: "ds-3",
      ts: 1_700_000_000_000,
      payload: errorPayload,
    });

    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    const [, delivered] = win.webContents.send.mock.calls[0]!;
    // The structurally cloned envelope must keep the non-function fields…
    expect(delivered.payload.message).toBe("stale refresh token");
    expect(delivered.payload.raw.keep).toBe("this-stays");
    // …and must NOT carry the callable across the clone.
    expect(delivered.payload.raw.fn).toBeUndefined();
    // Sanity: the cloned value is a fresh object, not a reference to the
    // original `errorPayload` — mutating the clone must not touch the
    // source.
    expect(delivered.payload).not.toBe(errorPayload);

    handle.dispose();
  });

  it("dispose() unsubscribes from the bus so later emits are ignored", () => {
    const handle = createEventBridge(bus);
    const win = makeWindow();
    handle.registerWindow(win as unknown as Electron.BrowserWindow);

    handle.dispose();

    bus.emit({
      event: "token-refreshed",
      datasourceType: "amazon-s3",
      datasourceId: "ds-4",
      ts: 1_700_000_000_000,
      payload: { expiresAt: 1_700_003_600_000 },
    });

    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
