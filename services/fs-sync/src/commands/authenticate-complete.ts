// Real implementation of the `sync:authenticate-complete` wire command.
// Replaces the wire-fs-sync-service stub per
// implement-datasource-onboarding §10 / spec scenario "credentials-form
// completion writes credentials via the request/response handler".
//
// Wire constraints:
//   - Only `kind: "credentials-form"` completions cross the wire (per §4
//     contract). OAuth completions land via the broker's loopback HTTP
//     callback inside the service — they never reach this handler.
//   - The §9 handler stashes the live `CredentialsFormIntent` plus
//     `(datasourceId, providerId)` metadata under the correlationId; we
//     consume both via `correlationStore.consumeEntry`.
//
// Engine flow:
//   - The intent's `submit(values)` is the engine's `decorateIntent`
//     wrapper around the strategy's raw submit. On resolution the engine
//     calls `credentialStore.put(this.datasourceId, AuthResult)` for us
//     — the handler does NOT touch the credential store directly.
//   - On rejection we still emit `auth-failed { tag: "engine-error" }` so
//     the renderer's `useAuthSession` can surface the failure UI symmetric
//     with the OAuth failure path (broker emits the same shape on
//     `completeWith` rejection).
//
// Spec ref: openspec/changes/implement-datasource-onboarding/specs/
//   fs-sync-service/spec.md MODIFIED Requirement
//   "sync:authenticate-start / complete / cancel are the canonical
//   credential-writing entry point" — the `sync:authenticate-complete`
//   handler steps 1-4.

import type {
  DatasourceSummary,
  ProviderId,
} from "@ft5/ipc-contracts";
import { providers } from "@ft5/ipc-contracts";

import type { CommandHandler } from "../ipc/server.js";
import type { EventBus } from "../events/event-bus.js";
import type { AuthCorrelationStore } from "../state/auth-correlation-store.js";

export interface AuthenticateCompleteHandlerDeps {
  readonly bus: EventBus;
  readonly correlationStore: AuthCorrelationStore;
}

function buildSummary(
  providerId: ProviderId,
  datasourceId: string,
): DatasourceSummary {
  const provider = providers[providerId];
  return {
    id: datasourceId,
    displayName: provider?.displayName ?? providerId,
    providerId,
    status: "connected",
    lastSyncAt: null,
    itemCount: 0,
    errorKind: null,
  };
}

export function makeAuthenticateCompleteHandler(
  deps: AuthenticateCompleteHandlerDeps,
): CommandHandler<"sync:authenticate-complete"> {
  return async (params) => {
    const { correlationId, completion } = params;
    const entry = deps.correlationStore.consumeEntry(correlationId);

    // Miss → correlation-expired. The store's TTL eviction silently
    // removes stale entries; from the caller's POV "expired" and "never
    // existed" are the same.
    if (entry === undefined) {
      return {
        ok: false,
        error: { tag: "correlation-expired", correlationId },
      };
    }

    const { intent, metadata } = entry;

    // Kind mismatch — the wire only carries credentials-form completions
    // per §4. An OAuth-kind intent in the store with a credentials-form
    // completion is the realistic mismatch case (the renderer mistakenly
    // posted complete for an OAuth session whose tokens land in the
    // broker, not via this handler).
    if (intent.kind !== completion.kind) {
      return {
        ok: false,
        error: {
          tag: "intent-kind-mismatch",
          expected: intent.kind,
          actual: completion.kind,
        },
      };
    }

    // Defensive: every credentials-form intent stashed by §9 carries
    // metadata. A missing metadata at this point would mean a misuse of
    // `correlationStore.create` (legacy path) — surface as engine-error.
    if (metadata === undefined) {
      return {
        ok: false,
        error: {
          tag: "engine-error",
          message:
            "AuthCorrelationStore entry missing metadata; cannot construct response summary — likely a service-side wiring bug",
        },
      };
    }

    // Run the engine's decorated submit. Engine persists creds via the
    // injected credentialStore on resolution.
    try {
      await intent.submit(completion.values);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Mirror the OAuth loopback's `auth-failed` taxonomy so the
      // renderer's failure UI works for both branches uniformly.
      deps.bus.emit("auth-failed", {
        correlationId,
        tag: "engine-error",
        message,
      });
      return {
        ok: false,
        error: { tag: "engine-error", message },
      };
    }

    const summary = buildSummary(metadata.providerId, metadata.datasourceId);
    // credential-persisted + auth-completed pair (Decision 7) — same
    // shape as the OAuth loopback's terminal events so the desktop event
    // bridge treats both paths uniformly.
    deps.bus.emit("credential-persisted", {
      correlationId,
      datasourceId: metadata.datasourceId,
      summary,
    });
    deps.bus.emit("auth-completed", {
      correlationId,
      datasourceId: metadata.datasourceId,
      summary,
    });

    return {
      ok: true,
      result: { datasourceId: metadata.datasourceId, summary },
    };
  };
}
