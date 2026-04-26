// `sync:authenticate-cancel` handler — implement-datasource-onboarding
// §11. Symmetric cancel for the OAuth (broker) and credentials-form
// (correlation store) branches.
//
// The handler is branch-agnostic: it tries both paths and asks "did
// either of them have something to cancel?" Mutual exclusion is real
// in practice (an OAuth correlation never lives in the correlation
// store; a credentials-form correlation never lives in broker.pending)
// but the handler does not need to know which is active.
//
// Idempotency:
//   - Second cancel for the same id returns `{ok: true, result:
//     {cancelled: false}}` and emits no event.
//   - Unknown id (never started, or already torn down) returns the
//     same `cancelled: false` shape — absence is not an error.
//
// Event semantics:
//   - OAuth path: the broker emits `auth-cancelled` itself (existing
//     §8 behaviour). The handler does NOT double-emit.
//   - Credentials-form path: the broker.cancel is a no-op, so the
//     handler is responsible for emitting `auth-cancelled` once.
//
// Spec ref: openspec/changes/implement-datasource-onboarding/specs/
//   fs-sync-service/spec.md MODIFIED Requirement
//   "sync:authenticate-start / complete / cancel are the canonical
//   credential-writing entry point" — `sync:authenticate-cancel`
//   sub-bullets 1-3.

import type { CommandHandler } from "../ipc/server.js";
import type { EventBus } from "../events/event-bus.js";
import type { AuthCorrelationStore } from "../state/auth-correlation-store.js";
import type { OAuthLoopbackBroker } from "../oauth/loopback-broker.js";

export interface AuthenticateCancelHandlerDeps {
  readonly bus: EventBus;
  readonly correlationStore: AuthCorrelationStore;
  readonly loopbackBroker: OAuthLoopbackBroker;
}

export function makeAuthenticateCancelHandler(
  deps: AuthenticateCancelHandlerDeps,
): CommandHandler<"sync:authenticate-cancel"> {
  return async (params) => {
    const { correlationId } = params;

    // Subscribe BEFORE calling broker.cancel so we know whether the
    // broker emitted auth-cancelled (OAuth path was active) or did
    // nothing (id unknown to broker — handler must emit instead for
    // the credentials-form path).
    let brokerEmittedCancelled = false;
    const unsubscribe = deps.bus.subscribe((name, payload) => {
      if (
        name === "auth-cancelled" &&
        (payload as { correlationId?: string }).correlationId === correlationId
      ) {
        brokerEmittedCancelled = true;
      }
    });

    let brokerHadIt = false;
    try {
      await deps.loopbackBroker.cancel({ correlationId });
      // The broker is idempotent — `cancel` resolves either way. We
      // detect "active" via the auth-cancelled side-effect captured
      // above.
      brokerHadIt = brokerEmittedCancelled;
    } finally {
      unsubscribe();
    }

    // Try the credentials-form path. consume returns the live intent
    // (or undefined if absent).
    const formIntent = deps.correlationStore.consume(correlationId);
    const formHadIt = formIntent !== undefined;

    if (!brokerHadIt && !formHadIt) {
      // Idempotent / unknown: no-op response, no event.
      return { ok: true, result: { cancelled: false } };
    }

    // Credentials-form path: broker did not emit, so we do.
    if (!brokerHadIt && formHadIt) {
      deps.bus.emit("auth-cancelled", { correlationId });
    }

    return { ok: true, result: { cancelled: true } };
  };
}
