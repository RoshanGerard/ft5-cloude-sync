import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatasourceEvent, DatasourceType, PayloadMap } from "@ft5/ipc-contracts";

import type { Clock, ClockTimer, EventBus } from "./event-bus.js";
import { createEventBus } from "./event-bus.js";

// ---------------------------------------------------------------------------
// FakeClock — deterministic time for tests. Drives `setTimeout` manually via
// `advance(ms)`; no real timers involved. The clock-injection pattern is part
// of the engine's portability, so tests exercise the injection path rather
// than Vitest's fake-timer helpers.
// ---------------------------------------------------------------------------
interface PendingTimer extends ClockTimer {
  readonly id: number;
  readonly fireAt: number;
  readonly fn: () => void;
  cancelled: boolean;
}

function createFakeClock(startMs = 0): Clock & { advance: (ms: number) => void; current: () => number } {
  let currentMs = startMs;
  let nextId = 0;
  const timers: PendingTimer[] = [];

  const clock: Clock & { advance: (ms: number) => void; current: () => number } = {
    now: () => currentMs,
    setTimeout(fn: () => void, ms: number): ClockTimer {
      const timer: PendingTimer = {
        id: nextId++,
        fireAt: currentMs + ms,
        fn,
        cancelled: false,
      };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer: ClockTimer): void {
      (timer as PendingTimer).cancelled = true;
    },
    advance(ms: number): void {
      const target = currentMs + ms;
      // Drain timers in fire-time order, advancing `currentMs` to each timer's
      // fireAt before invoking it (so `now()` inside the callback reflects the
      // scheduled time, not the final advanced time).
      //
      // We use strict `<` comparison for firing; this is a test-only choice
      // and does NOT match Node's `setTimeout(fn, N)` semantics. Node fires at
      // the first event-loop tick where `Date.now() - scheduledAt >= N`
      // (equality allowed). Tests here explicitly advance past the boundary
      // (e.g. `advance(1001)` to cross the 1s line) so the strict-vs-nonstrict
      // choice does not affect any assertion. A future test that tried to hit
      // the boundary exactly would need to change this — and its real-Node
      // counterpart would be nondeterministic on Windows anyway.
      for (;;) {
        const due = timers
          .filter((t) => !t.cancelled && t.fireAt < target)
          .sort((a, b) => a.fireAt - b.fireAt)[0];
        if (!due) break;
        // Remove from the live list.
        const idx = timers.indexOf(due);
        if (idx >= 0) timers.splice(idx, 1);
        currentMs = due.fireAt;
        due.fn();
      }
      currentMs = target;
    },
    current: () => currentMs,
  };
  return clock;
}

// ---------------------------------------------------------------------------
// Event constructors — keep the 11 canonical event names in view and minimise
// per-test boilerplate.
// ---------------------------------------------------------------------------
function mkStreamingUpload(
  datasourceId: string,
  transactionId: string,
  progress: number,
  ts: number,
): DatasourceEvent<"amazon-s3", "uploading"> {
  return {
    event: "uploading",
    datasourceType: "amazon-s3",
    datasourceId,
    ts,
    streaming: true,
    payload: { progress, transactionId } as PayloadMap["amazon-s3"]["uploading"],
  };
}

function mkTerminal<K extends keyof PayloadMap["amazon-s3"]>(
  event: K,
  datasourceId: string,
  ts: number,
  transactionId?: string,
): DatasourceEvent<"amazon-s3", K> {
  return {
    event,
    datasourceType: "amazon-s3",
    datasourceId,
    ts,
    payload: (transactionId ? { transactionId } : {}) as PayloadMap["amazon-s3"][K],
  };
}

function mkStatusChanged(
  datasourceId: string,
  ts: number,
): DatasourceEvent<"amazon-s3", "status-changed"> {
  return {
    event: "status-changed",
    datasourceType: "amazon-s3",
    datasourceId,
    ts,
    payload: {} as PayloadMap["amazon-s3"]["status-changed"],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type AnyEvent = DatasourceEvent<DatasourceType, keyof PayloadMap[DatasourceType]>;

function collect(bus: EventBus): AnyEvent[] {
  const received: AnyEvent[] = [];
  bus.subscribe((e) => {
    received.push(e);
  });
  return received;
}

describe("EventBus — non-streaming + first-event delivery", () => {
  it("delivers a non-streaming event immediately (synchronously)", () => {
    const clock = createFakeClock(0);
    const bus = createEventBus({ clock });
    const received = collect(bus);

    bus.emit(mkStatusChanged("ds-1", 0));

    expect(received).toHaveLength(1);
    expect(received[0]?.event).toBe("status-changed");
  });

  it("delivers the first streaming event for a key immediately", () => {
    const clock = createFakeClock(0);
    const bus = createEventBus({ clock });
    const received = collect(bus);

    bus.emit(mkStreamingUpload("ds-1", "tx-1", 0, 0));

    expect(received).toHaveLength(1);
    expect(received[0]?.event).toBe("uploading");
  });
});

describe("EventBus — streaming throttle (1 second)", () => {
  it("coalesces streaming events under the 1s window and delivers the last one when the window elapses", () => {
    const clock = createFakeClock(0);
    const bus = createEventBus({ clock });
    const received = collect(bus);

    // Emit 20 events at 0, 50, 100, ..., 950ms. Progress 0%..19% — each
    // incremental delta is 1%, and the cumulative delta from the first
    // emission stays under 10% for the first 10 emissions. Eventually the
    // cumulative delta crosses 10% (delta from 0% to 10% at emission #10),
    // which the spec says MUST trigger an immediate delivery even inside the
    // 1s window. So after crossing 10%, we expect a second delivery mid-window.
    //
    // To keep this test focused strictly on the *time*-based rule, stay below
    // the 10% progress threshold the entire loop.
    for (let i = 0; i < 20; i += 1) {
      const ts = i * 50;
      // progress 0, 0.4, 0.8, ..., 7.6 — max 7.6% < 10%
      const progress = i * 0.4;
      // Jump clock to `ts` before emit (first iteration is t=0, matches clock).
      if (ts > clock.current()) {
        clock.advance(ts - clock.current());
      }
      bus.emit(mkStreamingUpload("ds-1", "tx-1", progress, ts));
    }

    // Only the first event should have been delivered so far.
    expect(received).toHaveLength(1);
    expect(received[0]?.ts).toBe(0);

    // Advance past the 1s boundary — the held "latest" event fires.
    clock.advance(1000 - clock.current() + 1);

    expect(received).toHaveLength(2);
    // The last held event was the 20th emission (i=19, ts=950, progress=7.6).
    expect(received[1]?.ts).toBe(950);
    const payload = received[1]?.payload as { progress?: number } | undefined;
    expect(payload?.progress).toBeCloseTo(7.6, 5);
  });
});

describe("EventBus — streaming throttle (>=10% progress delta)", () => {
  it("delivers immediately when progress delta >= 10 percentage points, even inside the 1s window", () => {
    const clock = createFakeClock(0);
    const bus = createEventBus({ clock });
    const received = collect(bus);

    // t=0, progress=0 — first emit, delivered.
    bus.emit(mkStreamingUpload("ds-1", "tx-1", 0, 0));
    expect(received).toHaveLength(1);

    // t=100, progress=10 — delta >=10, delivered immediately.
    clock.advance(100);
    bus.emit(mkStreamingUpload("ds-1", "tx-1", 10, 100));
    expect(received).toHaveLength(2);
    expect(received[1]?.ts).toBe(100);

    // t=150, progress=12 — delta from last delivered (10) is 2, <10%. Also
    // still within 1s of the last delivery (100ms ago). Held.
    clock.advance(50);
    bus.emit(mkStreamingUpload("ds-1", "tx-1", 12, 150));
    expect(received).toHaveLength(2);

    // t=1100 — 1000ms since last delivery at t=100. Emit progress=12 (same),
    // the time rule fires and the held (or fresh) event is delivered.
    clock.advance(950);
    bus.emit(mkStreamingUpload("ds-1", "tx-1", 12, 1100));
    expect(received).toHaveLength(3);
    expect(received[2]?.ts).toBe(1100);
  });
});

describe("EventBus — terminal events bypass throttle synchronously", () => {
  it("flushes a pending streaming event then delivers the terminal, both synchronously", () => {
    const clock = createFakeClock(0);
    const bus = createEventBus({ clock });
    const received = collect(bus);

    // t=0, streaming 5% — delivered.
    bus.emit(mkStreamingUpload("ds-1", "tx-1", 5, 0));
    expect(received).toHaveLength(1);

    // t=100, streaming 7% — held (delta 2 < 10, within 1s).
    clock.advance(100);
    bus.emit(mkStreamingUpload("ds-1", "tx-1", 7, 100));
    expect(received).toHaveLength(1);

    // t=110, terminal file-created — pending 7% flushes, then terminal. All
    // synchronous within this emit call.
    clock.advance(10);
    bus.emit(mkTerminal("file-created", "ds-1", 110, "tx-1"));

    expect(received).toHaveLength(3);
    expect(received[1]?.event).toBe("uploading");
    const heldPayload = received[1]?.payload as { progress?: number } | undefined;
    expect(heldPayload?.progress).toBe(7);
    expect(received[2]?.event).toBe("file-created");
  });

  it("treats every terminal trigger as terminal: -created, -failed, token-refreshed, token-expired, deleted", () => {
    const clock = createFakeClock(0);
    const bus = createEventBus({ clock });
    const received = collect(bus);

    // Seed: one streaming per key so a pending-held event is possible.
    const triggers: Array<keyof PayloadMap["amazon-s3"]> = [
      "file-created",
      "upload-failed",
      "token-refreshed",
      "token-expired",
      "deleted",
    ];

    for (let i = 0; i < triggers.length; i += 1) {
      const txId = `tx-term-${i}`;
      // t=0 for this tx — delivered.
      bus.emit(mkStreamingUpload("ds-T", txId, 0, clock.now()));
      // t+50 — held.
      clock.advance(50);
      bus.emit(mkStreamingUpload("ds-T", txId, 1, clock.now()));
      // Terminal — flushes held + delivers terminal synchronously.
      const triggerName = triggers[i];
      if (!triggerName) throw new Error("triggers array invariant");
      const before = received.length;
      bus.emit(mkTerminal(triggerName, "ds-T", clock.now(), txId));
      const after = received.length;
      expect(after - before).toBe(2);
      expect(received[after - 1]?.event).toBe(triggerName);
    }
  });
});

describe("EventBus — per-(datasourceId, transactionId) keying", () => {
  it("coalesces transactions independently — A's holds do not suppress B's deliveries", () => {
    const clock = createFakeClock(0);
    const bus = createEventBus({ clock });
    const received = collect(bus);

    // t=0: both A and B emit progress=0 — both delivered (first emit for key).
    bus.emit(mkStreamingUpload("ds-1", "tx-A", 0, 0));
    bus.emit(mkStreamingUpload("ds-1", "tx-B", 0, 0));
    expect(received).toHaveLength(2);

    // t=200: both emit progress=1 (<10% delta, <1s). Both held.
    clock.advance(200);
    bus.emit(mkStreamingUpload("ds-1", "tx-A", 1, 200));
    bus.emit(mkStreamingUpload("ds-1", "tx-B", 1, 200));
    expect(received).toHaveLength(2);

    // t=400: both emit progress=2. Still held in their own buckets.
    clock.advance(200);
    bus.emit(mkStreamingUpload("ds-1", "tx-A", 2, 400));
    bus.emit(mkStreamingUpload("ds-1", "tx-B", 2, 400));
    expect(received).toHaveLength(2);

    // Advance past 1s from t=0 — both buckets flush their latest held event.
    clock.advance(601); // now 1001ms
    expect(received).toHaveLength(4);
    const txs = received.slice(2).map((e) => {
      const p = e.payload as { transactionId?: string } | undefined;
      return p?.transactionId;
    });
    // Both tx-A and tx-B should each appear once.
    expect(new Set(txs)).toEqual(new Set(["tx-A", "tx-B"]));
  });
});

describe("EventBus — subscribers", () => {
  it("delivers each event to every subscriber in subscription order", () => {
    const clock = createFakeClock(0);
    const bus = createEventBus({ clock });
    const a: AnyEvent[] = [];
    const b: AnyEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.emit(mkStatusChanged("ds-1", 0));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("returns an unsubscribe function that stops further delivery", () => {
    const clock = createFakeClock(0);
    const bus = createEventBus({ clock });
    const received: AnyEvent[] = [];
    const unsubscribe = bus.subscribe((e) => received.push(e));

    bus.emit(mkStatusChanged("ds-1", 0));
    expect(received).toHaveLength(1);

    unsubscribe();
    bus.emit(mkStatusChanged("ds-1", 1));
    expect(received).toHaveLength(1);
  });

  it("isolates a throwing subscriber: other subscribers still receive and emit does not throw", () => {
    const clock = createFakeClock(0);
    const bus = createEventBus({ clock });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const good: AnyEvent[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => good.push(e));

    expect(() => bus.emit(mkStatusChanged("ds-1", 0))).not.toThrow();
    expect(good).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe("EventBus — flush()", () => {
  it("flush(datasourceId, transactionId) delivers pending streaming event and cancels the timer", () => {
    const clock = createFakeClock(0);
    const bus = createEventBus({ clock });
    const received = collect(bus);

    bus.emit(mkStreamingUpload("ds-1", "tx-1", 0, 0));
    clock.advance(100);
    bus.emit(mkStreamingUpload("ds-1", "tx-1", 1, 100));
    expect(received).toHaveLength(1); // first delivered, second held

    bus.flush("ds-1", "tx-1");
    expect(received).toHaveLength(2);
    expect(received[1]?.ts).toBe(100);

    // Advancing past the original window must not deliver a duplicate — the
    // timer should have been cancelled.
    clock.advance(2000);
    expect(received).toHaveLength(2);
  });

  it("flush(datasourceId) flushes every pending transaction under that datasource", () => {
    const clock = createFakeClock(0);
    const bus = createEventBus({ clock });
    const received = collect(bus);

    bus.emit(mkStreamingUpload("ds-1", "tx-A", 0, 0));
    bus.emit(mkStreamingUpload("ds-1", "tx-B", 0, 0));
    clock.advance(100);
    bus.emit(mkStreamingUpload("ds-1", "tx-A", 1, 100));
    bus.emit(mkStreamingUpload("ds-1", "tx-B", 1, 100));
    expect(received).toHaveLength(2);

    bus.flush("ds-1");
    expect(received).toHaveLength(4);
    const flushed = received.slice(2).map((e) => {
      const p = e.payload as { transactionId?: string } | undefined;
      return p?.transactionId;
    });
    expect(new Set(flushed)).toEqual(new Set(["tx-A", "tx-B"]));
  });
});

describe("EventBus — factory options", () => {
  let clock: ReturnType<typeof createFakeClock>;

  beforeEach(() => {
    clock = createFakeClock(0);
  });

  it("respects a custom throttleMs", () => {
    const bus = createEventBus({ clock, throttleMs: 500 });
    const received = collect(bus);

    bus.emit(mkStreamingUpload("ds-1", "tx-1", 0, 0));
    clock.advance(100);
    bus.emit(mkStreamingUpload("ds-1", "tx-1", 1, 100));
    expect(received).toHaveLength(1);

    // 500ms from first delivery passes — held event flushes.
    clock.advance(401);
    expect(received).toHaveLength(2);
  });

  it("respects a custom progressDeltaPct", () => {
    const bus = createEventBus({ clock, progressDeltaPct: 5 });
    const received = collect(bus);

    bus.emit(mkStreamingUpload("ds-1", "tx-1", 0, 0));
    // Delta = 5, threshold = 5, delivered.
    clock.advance(10);
    bus.emit(mkStreamingUpload("ds-1", "tx-1", 5, 10));
    expect(received).toHaveLength(2);
  });
});

describe("EventBus — re-entrancy", () => {
  it("does not orphan state when a subscriber re-emits during terminal delivery", () => {
    // Contract: when a terminal event is emitted, the coalescer state for that
    // (datasourceId, transactionId) is cleared BEFORE any subscriber callback
    // runs for the flushed-pending and terminal deliveries. So if subscriber A
    // re-emits a streaming event for the same key from inside its terminal
    // handler, subscriber B should observe that re-emit as the FIRST event of
    // a fresh coalescer window (delivered immediately, not held).
    const clock = createFakeClock(0);
    const bus = createEventBus({ clock });

    let reemitted = false;
    const reEmitEvent = mkStreamingUpload("ds-1", "tx-1", 50, 200);

    // Subscriber B: collects everything in delivery order. Subscribed FIRST so
    // B records each outer delivery before subscriber A's re-entrant emit can
    // push an extra event into B's list (subscribers iterate in insertion order).
    const b: AnyEvent[] = [];
    bus.subscribe((e) => b.push(e));

    // Subscriber A: on the first file-created it sees, re-emits a streaming
    // event for the same (datasourceId, transactionId). Subscribed SECOND so
    // B has already seen the terminal by the time A's re-emit runs.
    bus.subscribe((event) => {
      if (!reemitted && event.event === "file-created") {
        reemitted = true;
        bus.emit(reEmitEvent);
      }
    });

    // t=0 — initial streaming (first emit for the key, delivered immediately).
    bus.emit(mkStreamingUpload("ds-1", "tx-1", 0, 0));

    // t=100 — held (delta 5 < 10, within 1s).
    clock.advance(100);
    bus.emit(mkStreamingUpload("ds-1", "tx-1", 5, 100));

    // t=200 — terminal file-created. Should flush the held t=100 event, then
    // deliver the terminal. Subscriber A runs on the terminal, re-emits the
    // streaming event, which — because state was deleted before subscriber
    // callbacks ran — is treated as the first event of a fresh window and
    // delivered synchronously.
    clock.advance(100);
    bus.emit(mkTerminal("file-created", "ds-1", 200, "tx-1"));

    // Expected order in B:
    //   1. initial uploading (t=0, progress 0)
    //   2. held uploading    (t=100, progress 5) — flushed before terminal
    //   3. file-created terminal
    //   4. re-emitted uploading from inside A's handler (t=200, progress 50)
    expect(b).toHaveLength(4);

    expect(b[0]?.event).toBe("uploading");
    expect(b[0]?.ts).toBe(0);
    expect((b[0]?.payload as { progress?: number }).progress).toBe(0);

    expect(b[1]?.event).toBe("uploading");
    expect(b[1]?.ts).toBe(100);
    expect((b[1]?.payload as { progress?: number }).progress).toBe(5);

    expect(b[2]?.event).toBe("file-created");

    expect(b[3]?.event).toBe("uploading");
    expect(b[3]?.ts).toBe(200);
    expect((b[3]?.payload as { progress?: number }).progress).toBe(50);

    // The re-emit should have been delivered synchronously (state was cleared
    // before the terminal delivery, so it started a fresh window). No advance
    // needed. Advancing past the throttle window must not produce any further
    // delivery — i.e. the re-emit is not still held as pending.
    clock.advance(2000);
    expect(b).toHaveLength(4);
  });
});
