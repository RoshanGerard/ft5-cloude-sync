import * as http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

import type {
  StoredCredentials,
  AuthIntent,
  ConsentEvent,
  DatasourceSummary,
  OAuthIntent,
  ProviderId,
} from "@ft5/ipc-contracts";
import { providers } from "@ft5/ipc-contracts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BrokerStartOptions {
  providerId: string;
  datasourceId?: string;
}

export interface BrokerStartResult {
  sessionId: string;
}

/**
 * In-memory record for an active consent session. Exposed via
 * _getPendingSessionForTests so the 4.x tests can reach into the broker
 * without implementing the full IPC surface. The leading underscore signals
 * test-only access — never call this from production code.
 */
export interface PendingSession {
  sessionId: string;
  providerId: string;
  datasourceId?: string;
  /** OS-assigned port the loopback HTTP server bound to. */
  port: number;
  /** CSRF state (32 random bytes base64url). */
  state: string;
  /** The OAuthIntent returned by the engine — carries authorizeUrl and completeWith. */
  intent: OAuthIntent;
  /** The authorizeUrl after the broker appended &state=<state>. */
  authorizeUrl: string;
  /** The http.Server listening on 127.0.0.1:<port>. */
  server: http.Server;
  /** 5-minute timeout handle. */
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface OAuthConsentBrokerOptions {
  /**
   * Injected shell.openExternal. The broker never imports electron directly
   * so tests can stub this without vi.mock("electron").
   * Production wires in shell.openExternal.
   */
  openExternal: (url: string) => Promise<void>;

  /**
   * Build-time OAuth client credentials.
   * Tests pass fake values; production wires build-time constants.
   */
  clientId: string;
  clientSecret: string;

  /**
   * Engine factory: given a StoredCredentials blob, create a client whose
   * authenticate() returns an AuthIntent. Tests supply a lightweight fake;
   * production wires the engine factory.
   */
  createClient: (
    datasourceId: string,
    credentials: StoredCredentials,
  ) => { authenticate(): Promise<AuthIntent> };

  /**
   * Registry write hook. Called by the broker AFTER intent.completeWith(code)
   * resolves successfully, with a fully-constructed DatasourceSummary.
   * Tests supply a vi.fn() spy; production wires engine.registry.add.
   *
   * Narrow DI: the broker constructs the summary and passes it here,
   * rather than holding a reference to the whole registry (D7: no row before
   * completeWith success; tests assert addToRegistry is NOT called at start()).
   *
   * Optional to preserve backward-compatibility with existing 4.1/4.2 tests
   * that do not supply this option.
   */
  addToRegistry?: (summary: DatasourceSummary) => DatasourceSummary;

  /**
   * Datasource id minter. Called once per successful consent to produce the
   * new datasourceId stored in both the registry row and the
   * consent-completed event. Tests supply vi.fn returning a fixed string
   * so they can assert the exact id; production wires a real id minter.
   *
   * Optional to preserve backward-compatibility with existing 4.1/4.2 tests.
   */
  mintDatasourceId?: () => string;

  /**
   * Dev-override credentials reader. When present and returns non-null, the
   * broker short-circuits the browser OAuth flow: no HTTP server is bound,
   * `openExternal` is never called, and `consent-completed` is emitted
   * immediately using the returned credentials.
   *
   * Production code MUST leave this undefined. Only the main-process bootstrap
   * wires it when `FT5_DEV_CREDENTIALS=1` is set at runtime.
   */
  readDevCredentials?: () => StoredCredentials | null;

  /**
   * One-shot warning callback. Called by the broker exactly once (per broker
   * instance) the first time `start()` enters the dev-override path. Tests
   * supply a vi.fn() spy; production wires a `console.warn` call.
   *
   * Optional — callers that do not care about the warning may omit it.
   */
  warnOnce?: () => void;
}

// ---------------------------------------------------------------------------
// OAuthConsentBroker interface
// ---------------------------------------------------------------------------

export interface OAuthConsentBroker {
  /** Start a new OAuth consent session. */
  start(opts: BrokerStartOptions): Promise<BrokerStartResult>;

  /**
   * Cancel an active consent session. Idempotent.
   */
  cancel(opts: { sessionId: string }): Promise<void>;

  /**
   * Tear down all active sessions and release all resources.
   * Call in afterEach to prevent listener leaks across tests.
   */
  dispose(): void;

  /**
   * Subscribe to consent lifecycle events emitted by the broker.
   * Returns an unsubscribe function.
   */
  subscribe(handler: (event: ConsentEvent) => void): () => void;

  /**
   * TEST-ONLY: return the pending-session record for the given sessionId,
   * or undefined if not found. Never call from production code.
   */
  _getPendingSessionForTests(sessionId: string): PendingSession | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOAuthConsentBroker(
  options: OAuthConsentBrokerOptions,
): OAuthConsentBroker {
  const pending = new Map<string, PendingSession>();
  const consentSubscribers = new Set<(event: ConsentEvent) => void>();
  let hasWarned = false;

  function _emitConsent(event: ConsentEvent): void {
    for (const handler of consentSubscribers) {
      try {
        handler(event);
      } catch {
        // Subscriber errors must not abort delivery to other subscribers.
      }
    }
  }

  function cleanup(sessionId: string): void {
    const session = pending.get(sessionId);
    if (!session) return;
    clearTimeout(session.timer);
    session.server.close();
    pending.delete(sessionId);
  }

  return {
    async start(opts: BrokerStartOptions): Promise<BrokerStartResult> {
      // Dev override: bypass browser, HTTP binding, and clientId/clientSecret.
      if (options.readDevCredentials) {
        const devCreds = options.readDevCredentials();
        if (devCreds !== null) {
          if (!hasWarned) {
            hasWarned = true;
            options.warnOnce?.();
          }
          const sessionId = randomBytes(32).toString("base64url");
          const datasourceId =
            opts.datasourceId ??
            (options.mintDatasourceId?.() ?? randomBytes(16).toString("base64url"));
          const provider = providers[opts.providerId as keyof typeof providers];
          const summary: DatasourceSummary = {
            id: datasourceId,
            displayName: provider?.displayName ?? opts.providerId,
            providerId: opts.providerId,
            status: "connected",
            lastSyncAt: null,
            itemCount: 0,
            errorKind: null,
          };
          options.addToRegistry?.(summary);
          _emitConsent({ event: "consent-completed", sessionId, datasourceId });
          return { sessionId };
        }
      }

      if (!options.clientId) {
        throw new Error(
          "OAuth client ID is not configured — set FT5_GOOGLE_OAUTH_CLIENT_ID at build time",
        );
      }
      if (!options.clientSecret) {
        throw new Error(
          "OAuth client secret is not configured — set FT5_GOOGLE_OAUTH_CLIENT_SECRET at build time",
        );
      }

      const sessionId = randomBytes(32).toString("base64url");
      const state = randomBytes(32).toString("base64url");

      // Create HTTP server — per-session handler captures sessionId in closure.
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (url.pathname !== "/callback") {
          // Health probe or other paths — acknowledge and return.
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("Waiting for OAuth consent...");
          return;
        }

        const session = pending.get(sessionId);
        if (!session) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Session not found");
          return;
        }

        const receivedState = url.searchParams.get("state");
        const code = url.searchParams.get("code") ?? "";

        if (receivedState !== state) {
          // CSRF state mismatch — possible replay or cross-site attack.
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("State mismatch — consent rejected");
          cleanup(sessionId);
          _emitConsent({ event: "consent-failed", sessionId, tag: "auth-revoked" });
          return;
        }

        // Valid callback — respond immediately so the browser can display the
        // success page, then complete the token exchange asynchronously.
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<!DOCTYPE html><html><body>" +
            "<p>You can close this tab and return to the app.</p>" +
            "</body></html>",
        );

        Promise.resolve().then(async () => {
          cleanup(sessionId);
          try {
            await session.intent.completeWith(code);
            const datasourceId =
              session.datasourceId ??
              (options.mintDatasourceId?.() ??
                randomBytes(16).toString("base64url"));
            const provider =
              providers[session.providerId as keyof typeof providers];
            const summary: DatasourceSummary = {
              id: datasourceId,
              displayName: provider?.displayName ?? session.providerId,
              providerId: session.providerId,
              status: "connected",
              lastSyncAt: null,
              itemCount: 0,
              errorKind: null,
            };
            options.addToRegistry?.(summary);
            _emitConsent({ event: "consent-completed", sessionId, datasourceId });
          } catch (err) {
            _emitConsent({
              event: "consent-failed",
              sessionId,
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

      // Pre-auth StoredCredentials blob — engine reads OAuth config from meta.
      const preAuthCredentials: StoredCredentials = {
        providerId: opts.providerId as ProviderId,
        authResult: {
          accessToken: "",
          meta: {
            clientId: options.clientId,
            clientSecret: options.clientSecret,
            redirectUri,
          },
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const client = options.createClient(
        opts.datasourceId ?? sessionId,
        preAuthCredentials,
      );
      const intent = await client.authenticate();

      if (intent.kind !== "oauth") {
        server.close();
        throw new Error(`Expected oauth intent but got: ${intent.kind}`);
      }

      // Append CSRF state to the authorize URL.
      const urlWithState = new URL(intent.authorizeUrl);
      urlWithState.searchParams.set("state", state);
      const finalAuthorizeUrl = urlWithState.toString();

      // 5-minute consent timeout.
      const timer = setTimeout(() => {
        cleanup(sessionId);
        _emitConsent({ event: "consent-timeout", sessionId });
      }, 300_000);

      // Store the pending session before opening the browser.
      pending.set(sessionId, {
        sessionId,
        providerId: opts.providerId,
        ...(opts.datasourceId !== undefined ? { datasourceId: opts.datasourceId } : {}),
        port,
        state,
        intent: intent as OAuthIntent,
        authorizeUrl: finalAuthorizeUrl,
        server,
        timer,
      });

      await options.openExternal(finalAuthorizeUrl);

      return { sessionId };
    },

    async cancel(opts: { sessionId: string }): Promise<void> {
      const session = pending.get(opts.sessionId);
      if (!session) return; // Idempotent no-op.
      cleanup(opts.sessionId);
      _emitConsent({ event: "consent-cancelled", sessionId: opts.sessionId });
    },

    dispose(): void {
      for (const session of pending.values()) {
        clearTimeout(session.timer);
        session.server.close();
      }
      pending.clear();
      consentSubscribers.clear();
    },

    subscribe(handler: (event: ConsentEvent) => void): () => void {
      consentSubscribers.add(handler);
      return () => {
        consentSubscribers.delete(handler);
      };
    },

    _getPendingSessionForTests(sessionId: string): PendingSession | undefined {
      return pending.get(sessionId);
    },
  };
}
