// Tests for OAuthLoopbackBroker dev-override (`FT5_DEV_CREDENTIALS=1`)
// path. Service-side port of
// `apps/desktop/src/main/oauth/__tests__/consent-broker-dev-override.test.ts`,
// per implement-datasource-onboarding §8.2.
//
// Surface differences from the desktop original:
//   - dev override reads `<dataDir>/dev-credentials.json` (service path,
//     not the Electron `app.getPath("userData")` location)
//   - tests pass `dataDir` injection + write a fixture file there
//   - `isDevOverride: boolean` injection (production wires from
//     `process.env.FT5_DEV_CREDENTIALS === "1"` at bootstrap; broker
//     stays env-agnostic)
//   - emits `credential-persisted` + `auth-completed` on the bus (no
//     subscribe(handler) injection, no addToRegistry callback)
//
// Spec ref: openspec/changes/implement-datasource-onboarding/specs/
//   fs-sync-service/spec.md ADDED Requirement
//   "Development builds may bypass authenticate via FT5_DEV_CREDENTIALS
//   (service-side)".

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AuthResult,
  ProviderId,
  StoredCredentials,
} from "@ft5/ipc-contracts";
import type {
  ClientFactory,
  CredentialStore,
  EngineContext,
  OAuthAppConfig,
  OAuthIntent,
} from "@ft5/fs-datasource-engine";
import type { EventName, EventPayloadMap } from "@ft5/ipc-contracts/sync-service";

import { createEventBus, type EventBus } from "../../events/event-bus.js";
import {
  createOAuthLoopbackBroker,
  type OAuthLoopbackBroker,
} from "../loopback-broker.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildDevCredentials(): StoredCredentials {
  return {
    providerId: "google-drive",
    authResult: {
      accessToken: "dev-access-token",
      refreshToken: "dev-refresh-token",
    },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function makeBusSpy(bus: EventBus): {
  events: Array<{ name: EventName; payload: EventPayloadMap[EventName] }>;
} {
  const events: Array<{ name: EventName; payload: EventPayloadMap[EventName] }> = [];
  bus.subscribe((name, payload) => {
    events.push({ name, payload: payload as EventPayloadMap[EventName] });
  });
  return { events };
}

function makeFakeCredentialStore(): CredentialStore {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  } as unknown as CredentialStore;
}

/** Fake factory that builds a real OAuthIntent — used to assert the
 *  dev-override path does NOT invoke `factory.createForAuth`. */
function makeFakeFactory(): {
  factory: ClientFactory;
  createForAuthSpy: ReturnType<typeof vi.fn>;
} {
  const createForAuthSpy = vi.fn(
    (
      _providerId: ProviderId,
      oauthAppConfig: OAuthAppConfig | null,
      _ctx: EngineContext,
      _datasourceId?: string,
    ) => {
      const redirectUri =
        oauthAppConfig?.redirectUri ?? "http://127.0.0.1:0/callback";
      const intent: OAuthIntent = {
        kind: "oauth",
        authorizeUrl:
          "https://accounts.google.com/o/oauth2/v2/auth"
          + "?client_id=test-id"
          + "&redirect_uri=" + encodeURIComponent(redirectUri),
        completeWith: async (_code: string): Promise<AuthResult> => ({
          accessToken: "tok",
        }),
      };
      return {
        authenticate: async () => intent,
      } as unknown as ReturnType<ClientFactory["createForAuth"]>;
    },
  );

  const factory: ClientFactory = {
    create: vi.fn(),
    createForAuth: createForAuthSpy as unknown as ClientFactory["createForAuth"],
  } as unknown as ClientFactory;

  return { factory, createForAuthSpy };
}

function makeGetOAuthAppConfig(): (
  providerId: ProviderId,
  redirectUri: string,
) => Promise<OAuthAppConfig> {
  return async (_providerId, redirectUri) => ({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectUri,
  });
}

/** Create a temp data dir, optionally seeding `dev-credentials.json`. */
function mkDataDir(seed?: StoredCredentials | string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft5-broker-dev-"));
  if (seed !== undefined && seed !== null) {
    const target = path.join(dir, "dev-credentials.json");
    const contents = typeof seed === "string" ? seed : JSON.stringify(seed);
    fs.writeFileSync(target, contents, "utf-8");
  }
  return dir;
}

let broker: OAuthLoopbackBroker | null = null;
const dataDirsToCleanup: string[] = [];

afterEach(() => {
  broker?.dispose();
  broker = null;
  for (const dir of dataDirsToCleanup) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  dataDirsToCleanup.length = 0;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Dev override short-circuits the browser flow
// ---------------------------------------------------------------------------

describe("OAuthLoopbackBroker — dev override: short-circuit", () => {
  it("does NOT bind a loopback or call factory.createForAuth when dev override is active", async () => {
    const dataDir = mkDataDir(buildDevCredentials());
    dataDirsToCleanup.push(dataDir);
    const bus = createEventBus();
    const credentialStore = makeFakeCredentialStore();
    const engineContext: EngineContext = { credentialStore };
    const { factory, createForAuthSpy } = makeFakeFactory();
    const mintDatasourceId = vi.fn(() => "ds-dev-42");
    const { events } = makeBusSpy(bus);

    broker = createOAuthLoopbackBroker({
      bus,
      engineContext,
      factory,
      getOAuthAppConfig: makeGetOAuthAppConfig(),
      mintDatasourceId,
      dataDir,
      isDevOverride: true,
    });

    const { correlationId } = await broker.start({ providerId: "google-drive" });

    // factory.createForAuth must NOT have been called — short-circuit path.
    expect(createForAuthSpy).not.toHaveBeenCalled();

    // No HTTP server stored (dev path skips the loopback bind).
    expect(broker._getPendingSessionForTests(correlationId)).toBeUndefined();

    // No `oauth-open-url` event emitted (no browser tab to open).
    expect(events.filter((e) => e.name === "oauth-open-url")).toHaveLength(0);

    // `credential-persisted` AND `auth-completed` were both emitted with
    // the synthetic correlationId and the minted datasourceId.
    const persisted = events.filter((e) => e.name === "credential-persisted");
    const completed = events.filter((e) => e.name === "auth-completed");
    expect(persisted).toHaveLength(1);
    expect(completed).toHaveLength(1);

    const persistedPayload =
      persisted[0]!.payload as EventPayloadMap["credential-persisted"];
    const completedPayload =
      completed[0]!.payload as EventPayloadMap["auth-completed"];
    expect(persistedPayload.correlationId).toBe(correlationId);
    expect(completedPayload.correlationId).toBe(correlationId);
    expect(persistedPayload.datasourceId).toBe("ds-dev-42");
    expect(completedPayload.datasourceId).toBe("ds-dev-42");
    expect(completedPayload.summary.providerId).toBe("google-drive");
    expect(completedPayload.summary.status).toBe("connected");
    expect(completedPayload.summary.errorKind).toBeNull();
  });

  it("uses the supplied datasourceId (reconnect path) instead of minting a new one", async () => {
    const dataDir = mkDataDir(buildDevCredentials());
    dataDirsToCleanup.push(dataDir);
    const bus = createEventBus();
    const credentialStore = makeFakeCredentialStore();
    const engineContext: EngineContext = { credentialStore };
    const { factory } = makeFakeFactory();
    const mintDatasourceId = vi.fn(() => "ds-minted");
    const { events } = makeBusSpy(bus);

    broker = createOAuthLoopbackBroker({
      bus,
      engineContext,
      factory,
      getOAuthAppConfig: makeGetOAuthAppConfig(),
      mintDatasourceId,
      dataDir,
      isDevOverride: true,
    });

    await broker.start({
      providerId: "google-drive",
      datasourceId: "ds-existing-123",
    });

    expect(mintDatasourceId).not.toHaveBeenCalled();
    const completed = events.find((e) => e.name === "auth-completed");
    expect(completed).toBeDefined();
    const summary =
      (completed!.payload as EventPayloadMap["auth-completed"]).summary;
    expect(summary.id).toBe("ds-existing-123");
  });

  it("falls through to the normal browser flow when dev-credentials file is absent", async () => {
    const dataDir = mkDataDir(/* no seed */);
    dataDirsToCleanup.push(dataDir);
    const bus = createEventBus();
    const credentialStore = makeFakeCredentialStore();
    const engineContext: EngineContext = { credentialStore };
    const { factory, createForAuthSpy } = makeFakeFactory();
    const { events } = makeBusSpy(bus);

    broker = createOAuthLoopbackBroker({
      bus,
      engineContext,
      factory,
      getOAuthAppConfig: makeGetOAuthAppConfig(),
      dataDir,
      isDevOverride: true,
    });

    const { correlationId } = await broker.start({ providerId: "google-drive" });

    // Normal flow: factory.createForAuth WAS called, oauth-open-url emitted.
    expect(createForAuthSpy).toHaveBeenCalled();
    expect(events.filter((e) => e.name === "oauth-open-url")).toHaveLength(1);
    expect(broker._getPendingSessionForTests(correlationId)).toBeDefined();
  });

  it("falls through to the normal browser flow when isDevOverride is false", async () => {
    const dataDir = mkDataDir(buildDevCredentials());
    dataDirsToCleanup.push(dataDir);
    const bus = createEventBus();
    const credentialStore = makeFakeCredentialStore();
    const engineContext: EngineContext = { credentialStore };
    const { factory, createForAuthSpy } = makeFakeFactory();
    const { events } = makeBusSpy(bus);

    broker = createOAuthLoopbackBroker({
      bus,
      engineContext,
      factory,
      getOAuthAppConfig: makeGetOAuthAppConfig(),
      dataDir,
      isDevOverride: false,
    });

    const { correlationId } = await broker.start({ providerId: "google-drive" });

    expect(createForAuthSpy).toHaveBeenCalled();
    expect(events.filter((e) => e.name === "oauth-open-url")).toHaveLength(1);
    expect(broker._getPendingSessionForTests(correlationId)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Startup warning fires exactly once across multiple calls
// ---------------------------------------------------------------------------

describe("OAuthLoopbackBroker — dev override: warning", () => {
  it("calls warnOnce exactly once on the first start() with dev override active", async () => {
    const dataDir = mkDataDir(buildDevCredentials());
    dataDirsToCleanup.push(dataDir);
    const bus = createEventBus();
    const credentialStore = makeFakeCredentialStore();
    const engineContext: EngineContext = { credentialStore };
    const { factory } = makeFakeFactory();
    const warnOnce = vi.fn();
    const mintDatasourceId = vi
      .fn()
      .mockReturnValueOnce("ds-dev-w1")
      .mockReturnValue("ds-dev-w2");

    broker = createOAuthLoopbackBroker({
      bus,
      engineContext,
      factory,
      getOAuthAppConfig: makeGetOAuthAppConfig(),
      mintDatasourceId,
      dataDir,
      isDevOverride: true,
      warnOnce,
    });

    await broker.start({ providerId: "google-drive" });
    expect(warnOnce).toHaveBeenCalledTimes(1);

    await broker.start({ providerId: "google-drive" });
    expect(warnOnce).toHaveBeenCalledTimes(1);
  });

  it("does NOT call warnOnce when dev-credentials file is absent (no dev override)", async () => {
    const dataDir = mkDataDir(/* no seed */);
    dataDirsToCleanup.push(dataDir);
    const bus = createEventBus();
    const credentialStore = makeFakeCredentialStore();
    const engineContext: EngineContext = { credentialStore };
    const { factory } = makeFakeFactory();
    const warnOnce = vi.fn();

    broker = createOAuthLoopbackBroker({
      bus,
      engineContext,
      factory,
      getOAuthAppConfig: makeGetOAuthAppConfig(),
      dataDir,
      isDevOverride: true,
      warnOnce,
    });

    await broker.start({ providerId: "google-drive" });
    expect(warnOnce).not.toHaveBeenCalled();
  });

  it("does NOT call warnOnce when isDevOverride is false (production)", async () => {
    const dataDir = mkDataDir(buildDevCredentials());
    dataDirsToCleanup.push(dataDir);
    const bus = createEventBus();
    const credentialStore = makeFakeCredentialStore();
    const engineContext: EngineContext = { credentialStore };
    const { factory } = makeFakeFactory();
    const warnOnce = vi.fn();

    broker = createOAuthLoopbackBroker({
      bus,
      engineContext,
      factory,
      getOAuthAppConfig: makeGetOAuthAppConfig(),
      dataDir,
      isDevOverride: false,
      warnOnce,
    });

    await broker.start({ providerId: "google-drive" });
    expect(warnOnce).not.toHaveBeenCalled();
  });
});
