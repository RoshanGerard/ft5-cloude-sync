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
//   broker._getPendingSessionForTests(sid)   → PendingSession | undefined
//
// Constructor options use dependency injection so tests can stub
// openExternal and supply a fake engine factory without touching globals.

import type { StoredCredentials, AuthIntent } from "@ft5/ipc-contracts";
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
 * Task 4.7: replaces this stub with the real implementation.
 */
export function createOAuthConsentBroker(
  _options: OAuthConsentBrokerOptions,
): OAuthConsentBroker {
  // The Map is referenced by _getPendingSessionForTests so the real impl
  // can populate it once task 4.7 lands, without changing the interface.
  const pending = new Map<string, PendingSession>();

  return {
    async start(_opts: BrokerStartOptions): Promise<BrokerStartResult> {
      throw new Error("Not implemented");
    },

    async cancel(_opts: { sessionId: string }): Promise<void> {
      throw new Error("Not implemented");
    },

    dispose(): void {
      // No-op in stub — no real servers to close.
    },

    _getPendingSessionForTests(
      sessionId: string,
    ): PendingSession | undefined {
      return pending.get(sessionId);
    },
  };
}