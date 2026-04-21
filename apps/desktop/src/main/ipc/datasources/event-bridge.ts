// Phase 10.3 — main-process event bridge.
//
// Subscribes to the FS Datasource Engine's `EventBus` once and fans each
// delivered `DatasourceEvent<T, K>` out to every registered `BrowserWindow`
// over the one-way channel `DATASOURCES_CHANNELS.event`. The renderer's
// preload (Phase 10.5) exposes the other side of this pipe as
// `window.api.datasources.onEvent(cb)`.
//
// Two design choices worth calling out:
//
// 1. **Clone before broadcast, not after.** `webContents.send(...)` already
//    structured-clones its args before crossing the IPC boundary, so in
//    principle we could pass the raw event through. We clone inside the
//    bridge anyway because (a) every registered window then receives the
//    same frozen-shape value — a subscriber can't mutate the payload and
//    affect sibling windows, and (b) tests can observe the exact cloned
//    shape that renderers will see (Electron's internal clone is opaque
//    to Vitest). The incidental cost of one extra clone per emit is
//    negligible at the bus's throttled rate.
//
// 2. **Lazy pruning of destroyed windows.** Electron fires `closed` events
//    asynchronously, and a `BrowserWindow` whose `webContents` is destroyed
//    throws on `send`. Rather than plumb window lifecycle listeners here,
//    we check `isDestroyed()` at broadcast time and drop the window from
//    the set. This keeps the bridge's surface small — callers pass a
//    window in via `registerWindow` and we quietly forget it when it
//    dies — and matches how other main-process broadcasters in this
//    codebase handle the same problem.
//
// Multi-window note: today `main/index.ts` creates exactly one window, so
// the bridge's window set will contain a single entry for the life of the
// app. The `registerWindow` hook exists so future multi-window work (e.g.
// a separate settings window) can register without touching the bridge.
//
// Refs: openspec/changes/add-fs-datasource-engine/design.md Decision 4
// (Observer pattern); tasks.md 10.2 + 10.3.

import type { BrowserWindow } from "electron";

import type { EventBus } from "@ft5/fs-datasource-engine";
import { DATASOURCES_CHANNELS } from "@ft5/ipc-contracts";

/**
 * Recursively copy `value` into a plain structure, dropping any field whose
 * value is a function. Mirrors Electron's IPC structured-clone semantics
 * (functions are silently stripped, not thrown on) — Node's native
 * `structuredClone` throws `DataCloneError` on callables, which is too
 * strict for our use: a provider SDK error may legitimately hang closures
 * off its `raw` context, and we'd rather drop them than crash the bridge.
 *
 * `Map`/`Set`/Dates/typed arrays are not expected to appear in engine
 * payloads (the event shape is `DatasourceEvent<T, K>` whose payloads are
 * JSON-ish records), so the recursion covers plain objects, arrays, and
 * primitives. Anything else that slips through is passed by reference — a
 * trade-off against the added complexity of a full structured-clone
 * polyfill for types we don't actually emit.
 */
function sanitizeForIpc(value: unknown): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === "function") return undefined;
  if (type === "object") {
    if (Array.isArray(value)) {
      // Preserve array length; functions inside arrays become `null` so we
      // don't change the indexing of sibling entries. Engine payloads
      // don't currently put functions in arrays, but the branch exists
      // for robustness.
      return value.map((v) => {
        const cleaned = sanitizeForIpc(v);
        return typeof v === "function" ? null : cleaned;
      });
    }
    const out: Record<string, unknown> = {};
    for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = sanitizeForIpc(sub);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  // Primitives (string/number/boolean/bigint/symbol/undefined) — return
  // as-is; Electron's IPC clone strips Symbols too, but the engine's
  // payload types don't carry any, so passing through is safe.
  if (type === "symbol") return undefined;
  return value;
}

export interface EventBridgeHandle {
  /**
   * Register a `BrowserWindow` to receive datasource events from the bus.
   * The bridge holds the window by reference and checks `isDestroyed()` on
   * every emit — when it reports destroyed, the window is dropped from the
   * set and never sent to again (even if a caller mutates it back).
   */
  registerWindow(win: BrowserWindow): void;
  /**
   * Detach the bus subscription and forget every registered window. Call
   * on app quit (or in a test's `afterEach`) to prevent further
   * broadcasts. Idempotent: a second `dispose()` is a no-op.
   */
  dispose(): void;
}

export function createEventBridge(bus: EventBus): EventBridgeHandle {
  const windows = new Set<BrowserWindow>();
  let disposed = false;

  const unsubscribe = bus.subscribe((event) => {
    if (disposed) return;
    // Clone once per emit, share the cloned value across every recipient.
    // We sanitize rather than use Node's `structuredClone` because that
    // throws `DataCloneError` on functions — provider errors can hang
    // closures off `raw`, and we'd rather strip them than crash the bridge
    // (Electron's own IPC clone silently strips functions; we match its
    // semantics here so `webContents.send` sees a clean plain-object
    // envelope).
    const serialized = sanitizeForIpc(event);
    for (const win of windows) {
      if (win.isDestroyed()) {
        windows.delete(win);
        continue;
      }
      win.webContents.send(DATASOURCES_CHANNELS.event, serialized);
    }
  });

  return {
    registerWindow(win) {
      if (disposed) return;
      windows.add(win);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      windows.clear();
    },
  };
}
