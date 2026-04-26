// Real implementation of the `sync:authenticate-start` wire command.
// Replaces the wire-fs-sync-service stub per
// implement-datasource-onboarding §9 / design.md Decisions 4 + 5 + 7 + 9.
//
// The handler is the canonical credential-flow entry point. Per spec
// requirement "sync:authenticate-start / complete / cancel are the
// canonical credential-writing entry point" the handler:
//
//   1. Mints ONE correlationId at the top so every event in this
//      authenticate session shares the same identifier — `auth-initiated`
//      (handler), `oauth-open-url` (broker), `auth-completed` (broker or
//      §10 handler).
//   2. Resolves an effective datasourceId — caller-supplied (reconnect)
//      or freshly minted (`ds-${randomUUID()}`). The same id is threaded
//      through `factory.createForAuth(...)` so the engine's
//      `decorateIntent` writes credentials at this id. Both branches
//      use the same minting rule so the §10 response and the OAuth
//      loopback completion produce the same shape.
//   3. For OAuth providers: looks up `OAuthAppConfig` via
//      `ServiceConfigStore.getOAuthAppConfig(providerId, redirectUri)`.
//      A miss surfaces as the typed wire error
//      `{ tag: "service-config-missing", path, providerId }` — handler
//      short-circuits BEFORE emitting any event.
//   4. Hands off to the broker for OAuth (`OAuthLoopbackBroker.start`
//      binds the loopback, computes the redirectUri, calls
//      `factory.createForAuth(...)`, runs `client.authenticate()`,
//      stashes the OAuthIntent in its own pending-session map, and
//      emits `oauth-open-url`); for credentials-form, runs the
//      authenticate flow inline and stashes the live intent in the
//      `AuthCorrelationStore` for the paired §10 complete request.
//
// Concern split (per §8 agent's report):
//   - OAuth intents live in `broker.pending` (the broker holds the
//     live closure for the loopback callback — completing in-process,
//     never via the renderer).
//   - Credentials-form intents live in `correlationStore` (the §10
//     handler consumes them when the renderer posts the values).
//
// Note on broker ↔ handler split for OAuth config resolution: design.md
// §9 enumerated two approaches (a) handler resolves config, threads it
// through; (b) broker owns the whole OAuth lifecycle. (b) is simpler
// because the broker already binds the loopback and computes the
// redirectUri — having it also call `getOAuthAppConfig(providerId,
// redirectUri)` keeps responsibility cohesive. Wired as (b): the
// handler passes the configStore-wrapping closure into the broker at
// construction time (see `bootstrap.ts`), so on the handler's
// `broker.start(...)` call the broker resolves config + factory.

import { randomUUID } from "node:crypto";

import {
  DatasourceError,
  DatasourceErrorTag,
  type ProviderId,
} from "@ft5/ipc-contracts";
import type {
  ClientFactory,
  EngineContext,
} from "@ft5/fs-datasource-engine";

import type { CommandHandler } from "../ipc/server.js";
import type { EventBus } from "../events/event-bus.js";
import type { AuthCorrelationStore } from "../state/auth-correlation-store.js";
import {
  ServiceConfigMissingError,
  type ServiceConfigStore,
} from "../config/service-config-store.js";
import type { OAuthLoopbackBroker } from "../oauth/loopback-broker.js";

/**
 * Returns the registered authKind for a providerId without re-walking the
 * full registry. The strategy registry is the source of truth; we
 * re-derive here so the handler does not need to import the registry
 * directly. The list mirrors `createDefaultProviderRegistry` in
 * `packages/fs-datasource-engine/src/factory.ts` — keep these in sync
 * when adding a provider.
 *
 * Hard-coded vs registry-import is intentional: the handler runs at IPC
 * boundary and a shared, type-checked union is a stronger contract than
 * a lookup that could silently widen if the registry shape changed.
 */
function authKindOf(providerId: ProviderId): "oauth" | "credentials-form" {
  switch (providerId) {
    case "google-drive":
    case "onedrive":
      return "oauth";
    case "amazon-s3":
      return "credentials-form";
  }
}

export interface AuthenticateStartHandlerDeps {
  readonly bus: EventBus;
  readonly correlationStore: AuthCorrelationStore;
  readonly factory: ClientFactory;
  readonly configStore: Pick<ServiceConfigStore, "getOAuthAppConfig">;
  readonly loopbackBroker: OAuthLoopbackBroker;
  readonly engineContext: EngineContext;
}

export function makeAuthenticateStartHandler(
  deps: AuthenticateStartHandlerDeps,
): CommandHandler<"sync:authenticate-start"> {
  return async (params) => {
    const { providerId } = params;
    // Mint a single correlation id for this authenticate session.
    const correlationId = randomUUID();
    const datasourceId = params.datasourceId ?? `ds-${randomUUID()}`;
    const kind = authKindOf(providerId);

    if (kind === "oauth") {
      // Hand off to the broker. The broker owns the WHOLE OAuth lifecycle:
      // bind loopback → resolve OAuthAppConfig (via the `getOAuthAppConfig`
      // closure injected at broker construction) → emit `auth-initiated`
      // (post-config, pre-bind-of-intent) → factory.createForAuth(...) →
      // client.authenticate() → stash live intent → emit `oauth-open-url`.
      //
      // Why the broker emits both events (deviation from task brief):
      // The §9 spec scenario "Service-config-missing on OAuth start"
      // requires "no event is emitted; no loopback server is bound" on
      // failure, AND "auth-initiated PRECEDES oauth-open-url" on success.
      // If the handler emitted `auth-initiated` before broker.start, the
      // config-missing branch would violate the no-event invariant. If
      // the handler emitted AFTER broker.start, ordering vs the broker's
      // oauth-open-url would be wrong. Solution: broker emits both
      // post-config-validation. (See loopback-broker.ts comment block
      // and design.md Decision 7 addendum.)
      //
      // ServiceConfigMissingError, DatasourceError, and any other
      // broker-internal failure surface through the catch below; handler
      // maps to the typed wire error.
      try {
        await deps.loopbackBroker.start({
          providerId,
          correlationId,
          datasourceId,
        });
      } catch (err) {
        if (err instanceof ServiceConfigMissingError) {
          return {
            ok: false,
            error: {
              tag: "service-config-missing",
              path: err.path,
              providerId: err.providerId,
              message: err.message,
            },
          };
        }
        if (
          err instanceof DatasourceError &&
          err.tag === DatasourceErrorTag.InvalidDatasource
        ) {
          return {
            ok: false,
            error: {
              tag: "unknown-provider",
              providerId: String(providerId),
              message: err.message,
            },
          };
        }
        return {
          ok: false,
          error: {
            tag: "engine-error",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }

      return {
        ok: true,
        result: { correlationId, kind: "oauth" },
      };
    }

    // ---- Credentials-form branch -------------------------------------------
    // No broker — the renderer collects values and posts a
    // sync:authenticate-complete with `kind: "credentials-form"`.
    let intent;
    try {
      const client = deps.factory.createForAuth(
        providerId,
        null,
        deps.engineContext,
        datasourceId,
      );
      intent = await client.authenticate();
    } catch (err) {
      if (
        err instanceof DatasourceError &&
        err.tag === DatasourceErrorTag.InvalidDatasource
      ) {
        return {
          ok: false,
          error: {
            tag: "unknown-provider",
            providerId: String(providerId),
            message: err.message,
          },
        };
      }
      return {
        ok: false,
        error: {
          tag: "engine-error",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    if (intent.kind !== "credentials-form") {
      // Defensive: the registry's authKind contract guarantees this
      // doesn't happen, but a malformed strategy could surface here.
      return {
        ok: false,
        error: {
          tag: "engine-error",
          message: `Expected credentials-form intent for provider '${String(providerId)}' but got '${intent.kind}'`,
        },
      };
    }

    // Stash the live intent under our pre-minted correlationId. The §10
    // handler will consume it when the renderer submits the form values.
    deps.correlationStore.createWith(correlationId, intent);

    // Emit auth-initiated — the renderer hook starts watching here.
    deps.bus.emit("auth-initiated", {
      correlationId,
      providerId,
      ...(params.datasourceId !== undefined
        ? { datasourceId: params.datasourceId }
        : {}),
    });

    return {
      ok: true,
      result: {
        correlationId,
        kind: "credentials-form",
        formSchema: intent.schema,
      },
    };
  };
}
