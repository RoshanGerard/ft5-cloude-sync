/** @vitest-environment jsdom */
//
// Shared test harness for renderer-side `window.api.sync.onEvent` tests.
//
// Extracted from `card-sync-state.test.tsx` (task 10.1 RED) so that follow-on
// tests in section 10 (10.3, 10.5, 10.7) can install the same mocked
// `window.api` surface and emit synthesised SyncEvent frames without
// duplicating ~70 lines of setup. Verbatim port — assertion semantics in
// 10.1's test must remain unchanged after the extraction.
//
// Usage:
//
//   let syncHarness: SyncHarness;
//   beforeEach(() => { syncHarness = installApiMock(); });
//   ...
//   syncHarness.emit({ kind: "sync-state-seed", payload: ... });
//
// `emit` wraps delivery in `act` so React state updates triggered by the
// store's reducer dispatch are flushed before the test assertion runs.

import { act } from "@testing-library/react";
import { vi } from "vitest";
import type { SyncEvent } from "@ft5/ipc-contracts/sync-service-desktop";

export type SyncListener = (event: SyncEvent) => void;

export interface SyncHarness {
  readonly onEvent: ReturnType<typeof vi.fn>;
  readonly listeners: SyncListener[];
  /** Synthesise an event delivery to every registered listener. */
  readonly emit: (event: SyncEvent) => void;
}

/**
 * Install a fully-mocked `window.api` surface (datasources stubs + sync
 * harness) and return the harness handle. Match the existing card.test.tsx
 * mock surface exactly so installing this in tests already running other
 * harnesses stays a no-op for non-sync flows.
 */
export function installApiMock(): SyncHarness {
  const listeners: SyncListener[] = [];
  const onEvent = vi.fn((cb: SyncListener) => {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  });
  // Cast through `unknown` because the renderer's `window-api.d.ts` does not
  // (yet) declare `window.api.sync` — the production preload exposes it but
  // the typings are deferred to task 6.2.
  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockReturnValue(new Promise<never>(() => {})),
      add: vi.fn(),
      remove: vi.fn().mockResolvedValue({ ok: true }),
      action: vi.fn(),
      upload: vi.fn().mockResolvedValue({ transactionId: "tx-test" }),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
    sync: {
      // The store under test is expected to call `window.api.sync.onEvent`
      // exactly once on mount. Other sync.* members are present as no-op
      // stubs so an inadvertent call surfaces as a clear test failure rather
      // than a TypeError.
      onEvent,
      listJobs: vi.fn(),
      getJob: vi.fn(),
      enqueueMirror: vi.fn(),
      cancelJob: vi.fn(),
      authenticateStart: vi.fn(),
      authenticateComplete: vi.fn(),
      getStatus: vi.fn(),
      getRetryPolicy: vi.fn(),
      setRetryPolicy: vi.fn(),
    },
  };
  return {
    onEvent,
    listeners,
    emit: (event) => {
      // Wrap delivery in `act` so React state updates triggered by the
      // store's reducer dispatch are flushed before the test assertion runs.
      act(() => {
        // Snapshot to allow listener-triggered unsubscribes during emit.
        for (const l of [...listeners]) {
          l(event);
        }
      });
    },
  };
}

/**
 * Install a JSDOM-side ResizeObserver shim if the environment lacks one.
 * shadcn primitives (Progress, etc.) tolerate its absence, but some
 * dropdown/dialog popovers used by surrounding card UI need it. Idempotent.
 */
export function ensureResizeObserver(): void {
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
}
