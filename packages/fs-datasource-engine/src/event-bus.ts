// EventBus for the FS Datasource Engine.
//
// Emits `DatasourceEvent<T, K>` values to subscribers. Streaming events are
// coalesced per (datasourceId, transactionId) with the "1 second OR 10
// percentage points" rule (design.md Decision 5): the first streaming event
// per key delivers immediately, subsequent streaming events inside the 1s
// window are held unless the progress delta crosses the threshold, and the
// held event flushes when the window elapses (or sooner if a larger-delta
// event arrives). Terminal events bypass the coalescer entirely and flush
// any pending streaming event for the same key synchronously before their
// own delivery, so subscribers always see the last progress tick before
// the completion signal.
//
// The package is framework-agnostic: no Electron, no provider SDKs. The
// default `Clock` wraps `Date.now` and `globalThis.setTimeout`; tests (and
// non-Electron hosts) may inject a custom clock.

import type {
  DatasourceEvent,
  DatasourceType,
  PayloadMap,
} from "@ft5/ipc-contracts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Opaque timer handle returned by `Clock.setTimeout`. Deliberately empty —
 * the bus never inspects its contents; it only passes the handle back to
 * `Clock.clearTimeout`. Implementations (real or fake) stash whatever state
 * they need on the concrete returned object.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ClockTimer {}

/** Clock abstraction. Production uses `Date.now` + `globalThis.setTimeout`;
 * tests inject a deterministic fake.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ClockTimer;
  clearTimeout(timer: ClockTimer): void;
}

export interface EventBusOptions {
  /** Defaults to a real-time clock over `Date.now` + `globalThis.setTimeout`. */
  clock?: Clock;
  /** Streaming throttle window, in ms. Default: 1000. */
  throttleMs?: number;
  /** Minimum progress delta (percentage points) that forces an early flush
   * inside the throttle window. Default: 10. */
  progressDeltaPct?: number;
}

// Any concrete event in the engine, widened across providers and event names.
// Keeps the bus fully typed at its boundaries while letting internal state use
// a single event shape.
type AnyDatasourceEvent = {
  [T in DatasourceType]: {
    [K in keyof PayloadMap[T]]: DatasourceEvent<T, K>;
  }[keyof PayloadMap[T]];
}[DatasourceType];

export interface EventBus {
  /** Subscribe to every delivered event. Returns an unsubscribe function. */
  subscribe(handler: (event: AnyDatasourceEvent) => void): () => void;

  /** Emit an event. Streaming events coalesce; terminal events flush
   * synchronously.
   */
  emit<T extends DatasourceType, K extends keyof PayloadMap[T]>(
    event: DatasourceEvent<T, K>,
  ): void;

  /** Force-flush pending coalesced events. With `transactionId`, flushes just
   * that key; without, flushes every pending key for the datasource. Cancels
   * any scheduled timers and clears state.
   */
  flush(datasourceId: string, transactionId?: string): void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Defensive read of the known optional streaming payload fields. Payloads are
 * typed `unknown` in Phase 1; stricter typing arrives in later phases when
 * strategies refine their payload maps.
 */
function readStreamingPayload(payload: unknown): {
  progress?: number;
  transactionId?: string;
} {
  if (payload && typeof payload === "object") {
    const p = payload as { progress?: unknown; transactionId?: unknown };
    // Under `exactOptionalPropertyTypes`, `progress?: number` means the
    // property is either a number or absent — explicit `undefined` is
    // rejected. Build the object conditionally.
    const out: { progress?: number; transactionId?: string } = {};
    if (typeof p.progress === "number") out.progress = p.progress;
    if (typeof p.transactionId === "string") out.transactionId = p.transactionId;
    return out;
  }
  return {};
}

/** Terminal events bypass the throttle. The predicate is a pure string check
 * over the 11 canonical event names (see `CanonicalEventPayloads` in
 * `@ft5/ipc-contracts`):
 *   -created | -failed | token-refreshed | token-expired | deleted
 */
function isTerminalEvent(eventName: string): boolean {
  return (
    eventName.endsWith("-created") ||
    eventName.endsWith("-failed") ||
    eventName === "token-refreshed" ||
    eventName === "token-expired" ||
    eventName === "deleted"
  );
}

/** Per-key coalescer state. `lastEmitTs` + `lastProgress` drive the throttle
 * predicate; `pending` holds the latest streaming event when it is suppressed;
 * `timer` is the scheduled flush so we can cancel it on early-flush paths.
 */
interface CoalescerState {
  lastEmitTs: number;
  lastProgress: number;
  pending: AnyDatasourceEvent | null;
  timer: ClockTimer | null;
}

const NO_TX_BUCKET = "__no-tx__";

// ---------------------------------------------------------------------------
// Default real-time clock
// ---------------------------------------------------------------------------

function defaultClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) =>
      globalThis.setTimeout(fn, ms) as unknown as ClockTimer,
    clearTimeout: (timer) =>
      globalThis.clearTimeout(timer as unknown as ReturnType<typeof setTimeout>),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const clock = options.clock ?? defaultClock();
  const throttleMs = options.throttleMs ?? 1000;
  const progressDeltaPct = options.progressDeltaPct ?? 10;

  // Subscribers: iterated in insertion order. Unsubscribe removes the handler
  // from this set; throwing handlers are wrapped in try/catch and logged so
  // a bad subscriber cannot break the bus.
  const subscribers = new Set<(event: AnyDatasourceEvent) => void>();

  // Coalescer state, keyed "${datasourceId}::${transactionId}". Transactions
  // without an id share a per-datasource bucket (`NO_TX_BUCKET`).
  //
  // Entries are retained until a terminal event or explicit flush; unterminated
  // streams leak by design. Phase 6-8 strategies are responsible for always
  // emitting a terminal (-created / -failed / deleted / token-refreshed /
  // token-expired) after any streaming activity.
  const states = new Map<string, CoalescerState>();

  function keyOf(datasourceId: string, transactionId: string | undefined): string {
    return `${datasourceId}::${transactionId ?? NO_TX_BUCKET}`;
  }

  function deliver(event: AnyDatasourceEvent): void {
    for (const handler of subscribers) {
      try {
        handler(event);
      } catch (err) {
        // Never let a subscriber's exception break sibling delivery or crash
        // the emit call. Log and continue.
        console.error("[EventBus] subscriber threw", err);
      }
    }
  }

  function cancelTimer(state: CoalescerState): void {
    if (state.timer !== null) {
      clock.clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function flushState(state: CoalescerState): void {
    cancelTimer(state);
    const pending = state.pending;
    state.pending = null;
    if (pending !== null) {
      const { progress } = readStreamingPayload(pending.payload);
      state.lastEmitTs = clock.now();
      if (progress !== undefined) state.lastProgress = progress;
      deliver(pending);
    }
    // Callers (`flush(...)`) delete the entry from `states` after this returns,
    // so there is no need to write back the mutated state here.
  }

  function scheduleFlush(key: string, state: CoalescerState, delayMs: number): void {
    if (state.timer !== null) return; // one-timer-per-key invariant
    // Clamp: setTimeout with a negative delay is equivalent to 0, but keeping
    // this explicit documents the expected behaviour at window boundaries.
    const delay = delayMs < 0 ? 0 : delayMs;
    state.timer = clock.setTimeout(() => {
      state.timer = null;
      const current = states.get(key);
      if (!current || current !== state) return;
      if (current.pending === null) return;
      const pending = current.pending;
      current.pending = null;
      const { progress } = readStreamingPayload(pending.payload);
      current.lastEmitTs = clock.now();
      if (progress !== undefined) current.lastProgress = progress;
      deliver(pending);
    }, delay);
  }

  function handleStreaming(event: AnyDatasourceEvent): void {
    const { progress, transactionId } = readStreamingPayload(event.payload);
    const key = keyOf(event.datasourceId, transactionId);
    const existing = states.get(key);
    const now = clock.now();
    const currentProgress = progress ?? 0;

    if (!existing) {
      // First emit for this key — deliver immediately and seed state.
      const state: CoalescerState = {
        lastEmitTs: now,
        lastProgress: currentProgress,
        pending: null,
        timer: null,
      };
      states.set(key, state);
      deliver(event);
      return;
    }

    const elapsed = now - existing.lastEmitTs;
    const progressDelta = Math.abs(currentProgress - existing.lastProgress);
    const timeEligible = elapsed >= throttleMs;
    // Progress-delta rule only applies when the event carries a progress
    // number. Without progress, fall back to the time rule alone.
    const progressEligible =
      progress !== undefined && progressDelta >= progressDeltaPct;

    if (timeEligible || progressEligible) {
      // Deliver now; any prior pending event is superseded by this one.
      cancelTimer(existing);
      existing.pending = null;
      existing.lastEmitTs = now;
      existing.lastProgress = currentProgress;
      deliver(event);
      return;
    }

    // Held: stash as pending and schedule a flush for the remaining window.
    existing.pending = event;
    scheduleFlush(key, existing, throttleMs - elapsed);
  }

  function handleTerminal(event: AnyDatasourceEvent): void {
    const { transactionId } = readStreamingPayload(event.payload);
    const key = keyOf(event.datasourceId, transactionId);
    const existing = states.get(key);
    if (existing) {
      // Order matters for re-entrancy: a subscriber invoked by `deliver(pending)`
      // or `deliver(event)` below may synchronously call `bus.emit(...)` for the
      // same (datasourceId, transactionId). By cancelling the timer AND deleting
      // the state entry BEFORE any subscriber callback runs, a re-entrant emit
      // starts from a clean slate (treated as the first event of a fresh
      // coalescer window) — rather than being held against stale state that we
      // would then wipe in a later step.
      cancelTimer(existing);
      const pending = existing.pending;
      existing.pending = null;
      states.delete(key);
      // Flush any prior pending streaming event first so subscribers see the
      // final progress tick before the terminal signal.
      if (pending !== null) {
        deliver(pending);
      }
    }
    deliver(event);
  }

  return {
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    emit(event) {
      const widened = event as AnyDatasourceEvent;
      if (isTerminalEvent(widened.event as string)) {
        handleTerminal(widened);
        return;
      }
      if (widened.streaming === true) {
        handleStreaming(widened);
        return;
      }
      deliver(widened);
    },

    flush(datasourceId, transactionId) {
      if (transactionId !== undefined) {
        const key = keyOf(datasourceId, transactionId);
        const state = states.get(key);
        if (state) {
          flushState(state);
          states.delete(key);
        }
        return;
      }
      // No transactionId — flush every pending key for this datasource.
      const prefix = `${datasourceId}::`;
      const toFlush: Array<[string, CoalescerState]> = [];
      for (const [key, state] of states) {
        if (key.startsWith(prefix)) toFlush.push([key, state]);
      }
      for (const [key, state] of toFlush) {
        flushState(state);
        states.delete(key);
      }
    },
  };
}
