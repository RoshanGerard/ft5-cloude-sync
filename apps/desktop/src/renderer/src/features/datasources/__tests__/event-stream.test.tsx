/** @vitest-environment jsdom */
//
// Phase 10 (tasks 10.6 + 10.7) — renderer `useDatasourceEvents` hook.
//
// This file is the RED side of the TDD cycle: it exercises the hook's
// contract against a mocked `window.api.datasources.onEvent`, including the
// type-level narrowing guarantee (`switch (e.datasourceType)` narrows the
// union to the provider's specific `DatasourceEvent<T, K>` shape). The hook
// itself is implemented in `../event-stream.ts`.
//
// Behaviour covered:
//   (a) subscribes on mount via `window.api.datasources.onEvent`
//   (b) delivers events to the caller's callback unfiltered
//   (c) calls the dispose function on unmount (cleanup contract)
//   (d) captures the latest callback via a ref — the component can re-render
//       with a different `cb` prop without re-registering the IPC listener,
//       and the most recent `cb` receives subsequent events
//   (e) type-level: inside `switch (event.datasourceType)`, the `"amazon-s3"`
//       branch narrows to `DatasourceEvent<"amazon-s3", …>` and its payload
//       is the S3-specific shape

import { afterEach, beforeEach, describe, expect, it, vi, expectTypeOf } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import type {
  AnyDatasourceEvent,
  DatasourceEvent,
  SerializedDatasourceError,
} from "@ft5/ipc-contracts";

import { useDatasourceEvents } from "../event-stream";

// -----------------------------------------------------------------------------
// `window.api.datasources.onEvent` mock harness.
//
// `onEvent` captures the listener it was handed, exposes a `trigger(ev)` to
// synthesise a delivery, and returns a `dispose` spy the hook must invoke on
// unmount. Every test gets a fresh harness.
// -----------------------------------------------------------------------------

type Listener = (event: AnyDatasourceEvent) => void;

interface Harness {
  onEvent: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  listeners: Listener[];
  trigger: (event: AnyDatasourceEvent, listenerIndex?: number) => void;
}

function installApiMock(): Harness {
  const listeners: Listener[] = [];
  const dispose = vi.fn();
  const onEvent = vi.fn((cb: Listener) => {
    listeners.push(cb);
    return dispose;
  });
  (window as unknown as { api: unknown }).api = {
    ping: vi.fn(),
    datasources: {
      list: vi.fn(),
      add: vi.fn(),
      remove: vi.fn(),
      action: vi.fn(),
      upload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent,
    },
  };
  return {
    onEvent,
    dispose,
    listeners,
    trigger: (event, listenerIndex = 0) => {
      const listener = listeners[listenerIndex];
      if (!listener) {
        throw new Error(
          `no listener registered at index ${listenerIndex} — only ${listeners.length} listener(s) captured`,
        );
      }
      act(() => {
        listener(event);
      });
    },
  };
}

// A representative S3 `file-created` event. The payload shape is kept loose
// (`as unknown`) because per-provider `file-created` payload types may tighten
// in later phases; the narrowing test below cares only about the *event*
// discriminators, not the payload fields.
const s3FileCreated: DatasourceEvent<"amazon-s3", "file-created"> = {
  event: "file-created",
  datasourceType: "amazon-s3",
  datasourceId: "ds-s3-1",
  ts: 1_700_000_000_000,
  payload: { bucket: "b", key: "k" } as unknown,
};

const gdUploading: DatasourceEvent<"google-drive", "uploading"> = {
  event: "uploading",
  datasourceType: "google-drive",
  datasourceId: "ds-gd-1",
  ts: 1_700_000_000_001,
  streaming: true,
  payload: { progress: 0.5 } as unknown,
};

// -----------------------------------------------------------------------------
// Test components.
// -----------------------------------------------------------------------------

function Subscriber({
  onEvent,
}: {
  onEvent: (event: AnyDatasourceEvent) => void;
}) {
  useDatasourceEvents(onEvent);
  return <div data-testid="subscriber">subscribed</div>;
}

// A component whose `cb` prop can swap at runtime. We use it to verify the
// ref-captured-latest-cb behaviour: the IPC listener should stay registered
// exactly once, but the *current* cb should receive the next event.
function SubscriberWithSwap({
  cb,
}: {
  cb: (event: AnyDatasourceEvent) => void;
}) {
  const [current] = useState(() => cb);
  // Always use the LATEST cb from props, not the memoised `current`, so the
  // ref capture inside the hook is the only thing keeping it up-to-date.
  useDatasourceEvents(cb);
  void current; // suppress unused warning; retained for diff-vs-closure parity
  return <div data-testid="swap">swap</div>;
}

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

describe("useDatasourceEvents", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = installApiMock();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("subscribes on mount and delivers events to the callback", () => {
    const cb = vi.fn();
    render(<Subscriber onEvent={cb} />);

    expect(harness.onEvent).toHaveBeenCalledTimes(1);

    harness.trigger(s3FileCreated);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(s3FileCreated);

    harness.trigger(gdUploading);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith(gdUploading);
  });

  it("disposes the subscription on unmount", () => {
    const cb = vi.fn();
    const { unmount } = render(<Subscriber onEvent={cb} />);

    expect(harness.dispose).not.toHaveBeenCalled();

    unmount();
    expect(harness.dispose).toHaveBeenCalledTimes(1);
  });

  it("captures the latest callback via a ref — does NOT re-register on cb change", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    const { rerender } = render(<SubscriberWithSwap cb={cb1} />);
    expect(harness.onEvent).toHaveBeenCalledTimes(1);
    const initialDisposeCount = harness.dispose.mock.calls.length;

    // First event — cb1 should receive it.
    harness.trigger(s3FileCreated);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb1).toHaveBeenCalledWith(s3FileCreated);
    expect(cb2).not.toHaveBeenCalled();

    // Swap the callback.
    rerender(<SubscriberWithSwap cb={cb2} />);

    // Listener count unchanged — the hook should NOT have re-registered.
    expect(harness.onEvent).toHaveBeenCalledTimes(1);
    // And dispose should NOT have been called (the old subscription is still
    // the live one — it's the cb target that changed, not the listener).
    expect(harness.dispose.mock.calls.length).toBe(initialDisposeCount);

    // Next event goes to cb2, not cb1.
    harness.trigger(gdUploading);
    expect(cb1).toHaveBeenCalledTimes(1); // unchanged
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledWith(gdUploading);
  });

  it("each mounted hook instance creates its own subscription", () => {
    const cbA = vi.fn();
    const cbB = vi.fn();

    const { unmount: unmountA } = render(<Subscriber onEvent={cbA} />);
    const { unmount: unmountB } = render(<Subscriber onEvent={cbB} />);

    expect(harness.onEvent).toHaveBeenCalledTimes(2);
    expect(harness.listeners.length).toBe(2);

    // Event to the first listener only — only cbA sees it.
    harness.trigger(s3FileCreated, 0);
    expect(cbA).toHaveBeenCalledTimes(1);
    expect(cbB).not.toHaveBeenCalled();

    // Event to the second listener only — only cbB sees it.
    harness.trigger(gdUploading, 1);
    expect(cbA).toHaveBeenCalledTimes(1);
    expect(cbB).toHaveBeenCalledTimes(1);

    unmountA();
    expect(harness.dispose).toHaveBeenCalledTimes(1);
    unmountB();
    expect(harness.dispose).toHaveBeenCalledTimes(2);
  });

  it("narrows payload types under `switch (event.datasourceType)` (compile-time check)", () => {
    // Type-level assertion: the callback parameter is `AnyDatasourceEvent`,
    // and a `switch (event.datasourceType)` narrows to the per-provider
    // `DatasourceEvent<T, K>` union. This exercises the spec's
    // "asserting narrowed payload types" clause.
    const narrowingCb = vi.fn((event: AnyDatasourceEvent) => {
      switch (event.datasourceType) {
        case "amazon-s3": {
          // Narrowed union: only S3 events remain.
          expectTypeOf(event).toMatchTypeOf<
            DatasourceEvent<"amazon-s3", keyof import("@ft5/ipc-contracts").PayloadMap["amazon-s3"]>
          >();
          // Further narrowing on the event name yields the specific payload.
          if (event.event === "authentication-failed") {
            expectTypeOf(event.payload).toEqualTypeOf<
              SerializedDatasourceError<"amazon-s3">
            >();
          }
          break;
        }
        case "google-drive": {
          expectTypeOf(event).toMatchTypeOf<
            DatasourceEvent<"google-drive", keyof import("@ft5/ipc-contracts").PayloadMap["google-drive"]>
          >();
          if (event.event === "authentication-failed") {
            expectTypeOf(event.payload).toEqualTypeOf<
              SerializedDatasourceError<"google-drive">
            >();
          }
          break;
        }
        case "onedrive": {
          expectTypeOf(event).toMatchTypeOf<
            DatasourceEvent<"onedrive", keyof import("@ft5/ipc-contracts").PayloadMap["onedrive"]>
          >();
          if (event.event === "authentication-failed") {
            expectTypeOf(event.payload).toEqualTypeOf<
              SerializedDatasourceError<"onedrive">
            >();
          }
          break;
        }
        default: {
          // Exhaustiveness: every provider in `PayloadMap` is handled above.
          const _exhaustive: never = event;
          void _exhaustive;
        }
      }
    });

    render(<Subscriber onEvent={narrowingCb} />);
    harness.trigger(s3FileCreated);
    expect(narrowingCb).toHaveBeenCalledTimes(1);
  });
});
