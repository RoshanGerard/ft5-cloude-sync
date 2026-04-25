// OAuthConsentBroker — stub for task 4.1.
//
// Minimum surface needed for the failing test to compile.
// No real implementation — start() throws "Not implemented".
// The real implementation lands in task 4.7.
//
// API surface (satisfies all §4 test scenarios 4.1-4.6):
//
//   createOAuthConsentBroker(options) → OAuthConsentBroker
//
//   broker.start({providerId, datasourceId?}) → Promise<{sessionId}>
//   broker.cancel({sessionId})               → Promise<void>
//   broker.dispose()                         → void
//   broker.subscribe(handler)                → () => void  (consent events)
//   broker._getPendingSessionForTests(sid)   → PendingSession | undefined
//
// Constructor options use dependency injection so tests can stub
// openExternal and supply a fake engine factory without touching globals.

import type { StoredCredentials, AuthIntent, ConsentEvent, DatasourceSummary } from "@ft5/ipc-contracts";
import type { OAuthIntent } from "@ft5/ipc-contracts";

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
  server: import("node:http").Server;
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

}

// ---------------------------------------------------------------------------
// OAuthConsentBroker interface
// ---------------------------------------------------------------------------

export interface OAuthConsentBroker {
  /** Start a new OAuth consent session. Throws "Not implemented" until 4.7. */
  start(opts: BrokerStartOptions): Promise<BrokerStartResult>;

  /**
   * Cancel an active consent session. Idempotent.
   * Throws "Not implemented" until 4.7.
   */
  cancel(opts: { sessionId: string }): Promise<void>;

  /**
   * Tear down all active sessions and release all resources.
   * Call in afterEach to prevent listener leaks across tests.
   */
  dispose(): void;

  /**
   * Subscribe to consent lifecycle events emitted by the broker.
   * Mirrors the EventBus subscribe shape from @ft5/fs-datasource-engine:
   *   subscribe(handler: (e: ConsentEvent) => void): () => void
   * Returns an unsubscribe function. Handlers registered before task 4.7
   * lands will receive no events (stub emits nothing), but the surface is
   * wired so tasks 4.3-4.6 can subscribe without interface changes.
   */
  subscribe(handler: (event: ConsentEvent) => void): () => void;

  /**
   * TEST-ONLY: return the pending-session record for the given sessionId,
   * or undefined if not found. Never call from production code.
   */
  _getPendingSessionForTests(sessionId: string): PendingSession | undefined;
}

// ---------------------------------------------------------------------------
// Factory (stub — throws "Not implemented")
// ---------------------------------------------------------------------------

/**
 * Create an OAuthConsentBroker instance.
 *
 * Task 4.1: start() and cancel() always throw "Not implemented".
 * Task 4.2: subscribe() / unsubscribe() surface added (noop stub).
 * Task 4.3: OAuthConsentBrokerOptions extended with addToRegistry and
 *           mintDatasourceId (both optional, for backward-compatibility).
 * Task 4.7: replaces this stub with the real implementation.
 */
export function createOAuthConsentBroker(
  _options: OAuthConsentBrokerOptions,
): OAuthConsentBroker {
  // The Map is referenced by _getPendingSessionForTests so the real impl
  // can populate it once task 4.7 lands, without changing the interface.
  const pending = new Map<string, PendingSession>();

  // Consent-event subscribers. The real implementation (task 4.7) populates
  // this set and calls _emitConsent. The stub keeps the set but never calls
  // _emitConsent, so no events reach subscribers until 4.7 lands.
  const consentSubscribers = new Set<(event: ConsentEvent) => void>();

  return {
    async start(_opts: BrokerStartOptions): Promise<BrokerStartResult> {
      throw new Error("Not implemented");
    },

    async cancel(_opts: { sessionId: string }): Promise<void> {
      throw new Error("Not implemented");
    },

    dispose(): void {
      // No-op in stub — no real servers to close.
      consentSubscribers.clear();
    },

    subscribe(handler: (event: ConsentEvent) => void): () => void {
      consentSubscribers.add(handler);
      return () => {
        consentSubscribers.delete(handler);
      };
    },

    _getPendingSessionForTests(
      sessionId: string,
    ): PendingSession | undefined {
      return pending.get(sessionId);
    },
  };
}
