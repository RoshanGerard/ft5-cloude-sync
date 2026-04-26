// OAuthLoopbackBroker — service-side port of the desktop's
// `apps/desktop/src/main/oauth/consent-broker.ts`.
//
// Per implement-datasource-onboarding design.md Decision 2 (loopback
// HTTP listener relocates to service) and Decision 7 (event taxonomy:
// `auth-*`, `oauth-open-url`, `credential-persisted` on the service
// event bus).
//
// Lifecycle (broker-driven; the §9 handler is slim):
//   start({providerId, datasourceId?})
//     1. Bind a fresh `http.createServer()` to 127.0.0.1:0 (OS picks port).
//     2. Compute redirectUri = `http://127.0.0.1:<port>/callback`.
//     3. Resolve OAuthAppConfig via the injected `getOAuthAppConfig`
//        closure (wraps ServiceConfigStore.getOAuthAppConfig).
//     4. Call `factory.createForAuth(providerId, oauthAppConfig, ctx,
//        datasourceId?)` -> client.
//     5. Call `client.authenticate()` -> OAuthIntent. The strategy's
//        decorateIntent (engine-side) writes credentials through
//        `ctx.credentialStore.put` when `intent.completeWith(code)`
//        resolves -- the broker NEVER writes credentials directly.
//     6. Generate CSRF state (32 random bytes base64url), append
//        &state=... to the authorize URL.
//     7. Start the 5-minute timeout timer.
//     8. Emit `oauth-open-url { correlationId, authorizeUrl }` on the
//        bus so the desktop bridge can call `shell.openExternal`.
//     9. Stash a pending-session record keyed by correlationId.
//
//   On a valid /callback hit:
//     - 200 OK with a "you can close this tab" page.
//     - clean up (close server + clear timer + delete record) BEFORE
//       awaiting completeWith so a re-entrant emit cannot see stale
//       state.
//     - intent.completeWith(code) -> AuthResult (engine writes creds).
//     - Build DatasourceSummary and emit BOTH `credential-persisted`
//       and `auth-completed` (paired terminal events, distinct
//       audiences per Decision 7).
//
//   On state mismatch: 400, emit `auth-failed { tag: "auth-revoked" }`.
//   On completeWith reject: emit `auth-failed { tag: "provider-error" }`.
//   On 5-minute timer expiry: emit `auth-timeout`.
//   On cancel: emit `auth-cancelled` (idempotent — second cancel is a
//     no-op, no event, no throw).
//   On dispose: close every active server, clear every timer, drain
//     the pending-session map. Used by SIGINT graceful shutdown.
//
// Dev override (FT5_DEV_CREDENTIALS=1):
//   When `isDevOverride: true` AND `<dataDir>/dev-credentials.json`
//   parses successfully, the broker short-circuits the browser flow
//   entirely. No HTTP server bound, no factory.createForAuth call, no
//   `oauth-open-url` event. The broker mints a synthetic
//   correlationId, emits `credential-persisted` + `auth-completed`
//   synchronously, and returns. `warnOnce()` fires on the first dev
//   override start.

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import type {
  DatasourceSummary,
  ProviderId,
  StoredCredentials,
} from "@ft5/ipc-contracts";
import { providers } from "@ft5/ipc-contracts";
import type {
  ClientFactory,
  EngineContext,
  OAuthAppConfig,
  OAuthIntent,
} from "@ft5/fs-datasource-engine";

import type { EventBus } from "../events/event-bus.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BrokerStartOptions {
  /** OAuth-class providerId. The factory must resolve to an OAuth
   *  strategy; credentials-form providers (S3) are not handled here. */
  providerId: ProviderId;
  /** Optional existing datasourceId — used on the reconnect / re-auth
   *  path when the desktop already has a row in the registry. When
   *  omitted, the broker mints a new id via `mintDatasourceId` (or a
   *  fallback). */
  datasourceId?: string;
  /** Optional pre-minted correlation id. Used by the §9
   *  `sync:authenticate-start` handler so a single id flows through the
   *  whole authenticate session — `auth-initiated` (emitted by handler)
   *  → `oauth-open-url` (emitted by broker) → `auth-completed`. When
   *  omitted (e.g. legacy / direct-broker tests) the broker mints
   *  internally via `randomUUID()`. */
  correlationId?: string;
}

export interface BrokerStartResult {
  correlationId: string;
}

/**
 * Per-correlation pending session record. Exposed via
 * `_getPendingSessionForTests` so unit tests can reach into the broker
 * to read the bound port + CSRF state without needing the full IPC
 * surface. The leading underscore signals test-only access.
 */
export interface PendingSession {
  correlationId: string;
  providerId: ProviderId;
  datasourceId?: string;
  /** OS-assigned port the loopback HTTP server bound to. */
  port: number;
  /** CSRF state (32 random bytes base64url). */
  state: string;
  /** OAuthIntent returned by client.authenticate(). */
  intent: OAuthIntent;
  /** authorizeUrl after the broker appended &state=. */
  authorizeUrl: string;
  /** http.Server listening on 127.0.0.1:<port>. */
  server: http.Server;
  /** 5-minute timeout handle. */
  timer: ReturnType<typeof setTimeout>;
}

export interface OAuthLoopbackBrokerOptions {
  /** Service-side event bus — emits auth-*, oauth-open-url,
   *  credential-persisted. */
  bus: EventBus;

  /** EngineContext (engine bus + credentialStore) passed verbatim
   *  into `factory.createForAuth(...)`. The engine's decorateIntent
   *  uses `ctx.credentialStore` to persist on completeWith resolution. */
  engineContext: EngineContext;

  /** Engine factory used to construct the per-auth client. The broker
   *  calls `factory.createForAuth(providerId, oauthAppConfig, ctx,
   *  datasourceId?)`. */
  factory: ClientFactory;

  /** Closure wrapping ServiceConfigStore.getOAuthAppConfig — given a
   *  providerId and the broker-computed redirectUri, returns the
   *  OAuthAppConfig (clientId / clientSecret / redirectUri).
   *
   *  Production wires `(providerId, redirectUri) => {
   *    const raw = await configStore.getOAuthAppConfig(providerId);
   *    return { ...raw, redirectUri };
   *  }`. Tests stub a synchronous async closure. */
  getOAuthAppConfig: (
    providerId: ProviderId,
    redirectUri: string,
  ) => Promise<OAuthAppConfig>;

  /** Datasource id minter. Called once per successful authenticate
   *  completion when `start()`'s `datasourceId` was undefined.
   *  Production wires a real id minter (e.g. `ds-${randomUUID()}`).
   *  Tests supply vi.fn() so they can assert the deterministic id. */
  mintDatasourceId?: () => string;

  /** Service data dir. Used to locate the dev-override file at
   *  `<dataDir>/dev-credentials.json`. Bootstrap wires
   *  `paths.dataDir`. */
  dataDir: string;

  /** When true AND `<dataDir>/dev-credentials.json` parses, every
   *  start() short-circuits to the dev path (no browser, no HTTP
   *  bind). Production wires
   *  `process.env.FT5_DEV_CREDENTIALS === "1"` at bootstrap; the
   *  broker module stays env-agnostic so it remains pure / unit
   *  testable. */
  isDevOverride?: boolean;

  /** One-shot warning callback. Fired exactly once on the first dev
   *  override `start()` per broker instance. Production wires
   *  `() => console.warn(...)`. Tests supply vi.fn(). */
  warnOnce?: () => void;
}

export interface OAuthLoopbackBroker {
  /** Start a new authenticate flow. Returns the correlationId so the
   *  caller (sync:authenticate-start handler) can stash the live
   *  intent in the AuthCorrelationStore. */
  start(opts: BrokerStartOptions): Promise<BrokerStartResult>;

  /** Cancel an active session. Idempotent — a second cancel for the
   *  same correlationId is a silent no-op (no event, no throw). */
  cancel(opts: { correlationId: string }): Promise<void>;

  /** Tear down every active session — close every HTTP server,
   *  clear every timer, drain the pending-session map. Called by
   *  SIGINT graceful shutdown (per spec scenario "SIGINT cancels
   *  active OAuth sessions before exit"). */
  dispose(): void;

  /** TEST-ONLY accessor for the pending-session record keyed by
   *  correlationId. Returns undefined when no session exists. */
  _getPendingSessionForTests(
    correlationId: string,
  ): PendingSession | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Factory function for building an OAuthLoopbackBroker. */
export function createOAuthLoopbackBroker(
  options: OAuthLoopbackBrokerOptions,
): OAuthLoopbackBroker {
  const pending = new Map<string, PendingSession>();
  let hasWarned = false;

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

  function cleanup(correlationId: string): void {
    const session = pending.get(correlationId);
    if (!session) return;
    clearTimeout(session.timer);
    session.server.close();
    pending.delete(correlationId);
  }

  /**
   * Attempt to read `<dataDir>/dev-credentials.json` synchronously.
   * Returns the parsed StoredCredentials when the file exists and
   * parses, or null when the file is absent or unreadable.
   *
   * Sync read is intentional — the dev path runs at start-time and
   * we want short-circuit semantics before any I/O on the loopback
   * socket. The desktop original used `readFileSync` for the same
   * reason.
   */
  function readDevCredentials(): StoredCredentials | null {
    const filePath = path.join(options.dataDir, "dev-credentials.json");
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw) as StoredCredentials;
    } catch {
      return null;
    }
  }

  return {
    async start(opts: BrokerStartOptions): Promise<BrokerStartResult> {
      // Dev override: bypass browser, HTTP binding, and OAuth app config.
      if (options.isDevOverride) {
        const devCreds = readDevCredentials();
        if (devCreds !== null) {
          if (!hasWarned) {
            hasWarned = true;
            options.warnOnce?.();
          }
          // Use the supplied correlationId when given (handler-driven path);
          // otherwise synthesize one for direct-broker callers.
          const correlationId = opts.correlationId ?? randomUUID();
          const datasourceId =
            opts.datasourceId ??
            options.mintDatasourceId?.() ??
            `ds-${randomUUID()}`;
          const summary = buildSummary(opts.providerId, datasourceId);
          // credential-persisted + auth-completed pair (Decision 7).
          options.bus.emit("credential-persisted", {
            correlationId,
            datasourceId,
            summary,
          });
          options.bus.emit("auth-completed", {
            correlationId,
            datasourceId,
            summary,
          });
          return { correlationId };
        }
        // dev-credentials.json absent / unreadable — fall through to
        // the normal browser flow.
      }

      // ---- Normal browser flow -------------------------------------------
      // Use the supplied correlationId when given (so the handler's
      // `auth-initiated` and the broker's `oauth-open-url` carry the same
      // id); otherwise mint internally for direct-broker callers.
      const correlationId = opts.correlationId ?? randomUUID();
      const state = randomBytes(32).toString("base64url");

      // Bind the loopback FIRST so we know the port (the strategy needs
      // it threaded through `redirect_uri` in the authorize URL).
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (url.pathname !== "/callback") {
          // Health probe or other paths.
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("Waiting for OAuth consent...");
          return;
        }

        const session = pending.get(correlationId);
        if (!session) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Session not found");
          return;
        }

        const receivedState = url.searchParams.get("state");
        const code = url.searchParams.get("code") ?? "";

        if (receivedState !== state) {
          // CSRF state mismatch — 400 + auth-failed { auth-revoked }.
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("State mismatch — consent rejected");
          cleanup(correlationId);
          options.bus.emit("auth-failed", {
            correlationId,
            tag: "auth-revoked",
          });
          return;
        }

        // Valid state — respond immediately so the browser renders the
        // success page, then exchange the code asynchronously. Cleanup
        // BEFORE awaiting completeWith so a re-entrant emit cannot
        // observe stale state.
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<!DOCTYPE html><html><body>" +
            "<p>You can close this tab and return to the app.</p>" +
            "</body></html>",
        );

        Promise.resolve().then(async () => {
          cleanup(correlationId);
          try {
            await session.intent.completeWith(code);
            const datasourceId =
              session.datasourceId ??
              options.mintDatasourceId?.() ??
              `ds-${randomUUID()}`;
            const summary = buildSummary(session.providerId, datasourceId);
            // credential-persisted + auth-completed pair (Decision 7).
            options.bus.emit("credential-persisted", {
              correlationId,
              datasourceId,
              summary,
            });
            options.bus.emit("auth-completed", {
              correlationId,
              datasourceId,
              summary,
            });
          } catch (err) {
            options.bus.emit("auth-failed", {
              correlationId,
              tag: "provider-error",
              message: String(err),
            });
          }
        });
      });

      // Bind to 127.0.0.1:0 — OS picks the port.
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });

      const port = (server.address() as AddressInfo).port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      // From here through `intent` resolution, any throw must close the
      // bound server before propagating — otherwise the §9 spec scenario
      // "Service-config-missing on OAuth start: no loopback server is
      // bound" is violated (server leaks into the post-throw state).
      let intent: OAuthIntent;
      try {
        // Resolve the OAuth app config (clientId / clientSecret /
        // redirectUri). The closure wraps ServiceConfigStore.
        const oauthAppConfig = await options.getOAuthAppConfig(
          opts.providerId,
          redirectUri,
        );

        // Construct the engine client + acquire the AuthIntent.
        const client = options.factory.createForAuth(
          opts.providerId,
          oauthAppConfig,
          options.engineContext,
          opts.datasourceId,
        );
        const acquired = await client.authenticate();

        if (acquired.kind !== "oauth") {
          // Defensive — credentials-form intents should never reach the
          // loopback broker (the §9 handler dispatches them via the
          // request/response complete path instead).
          throw new Error(
            `OAuthLoopbackBroker.start: expected oauth intent but got '${acquired.kind}'`,
          );
        }
        intent = acquired;
      } catch (err) {
        // Close the bound server before propagating so the post-throw
        // state observable to the §9 handler is "no listener bound for
        // this attempt".
        server.close();
        throw err;
      }

      // Append CSRF state to the authorize URL.
      const urlWithState = new URL(intent.authorizeUrl);
      urlWithState.searchParams.set("state", state);
      const finalAuthorizeUrl = urlWithState.toString();

      // 5-minute consent timeout.
      const timer = setTimeout(() => {
        cleanup(correlationId);
        options.bus.emit("auth-timeout", { correlationId });
      }, 300_000);
      // Don't keep the service process alive on a lingering session.
      (timer as { unref?: () => void }).unref?.();

      pending.set(correlationId, {
        correlationId,
        providerId: opts.providerId,
        ...(opts.datasourceId !== undefined
          ? { datasourceId: opts.datasourceId }
          : {}),
        port,
        state,
        intent,
        authorizeUrl: finalAuthorizeUrl,
        server,
        timer,
      });

      // Emit oauth-open-url so the desktop bridge can call
      // `shell.openExternal(authorizeUrl)`.
      options.bus.emit("oauth-open-url", {
        correlationId,
        authorizeUrl: finalAuthorizeUrl,
      });

      return { correlationId };
    },

    async cancel(opts: { correlationId: string }): Promise<void> {
      const session = pending.get(opts.correlationId);
      if (!session) return; // Idempotent no-op.
      cleanup(opts.correlationId);
      options.bus.emit("auth-cancelled", {
        correlationId: opts.correlationId,
      });
    },

    dispose(): void {
      for (const session of pending.values()) {
        clearTimeout(session.timer);
        session.server.close();
      }
      pending.clear();
    },

    _getPendingSessionForTests(
      correlationId: string,
    ): PendingSession | undefined {
      return pending.get(correlationId);
    },
  };
}
