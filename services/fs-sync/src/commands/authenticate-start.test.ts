// Tests for the real `sync:authenticate-start` handler — replaces the
// stub from wire-fs-sync-service per implement-datasource-onboarding §9.
//
// The handler is the canonical credential-flow entry point. It mints one
// correlationId at the top, emits `auth-initiated` on the service bus,
// and dispatches:
//   - OAuth-class providers → OAuthLoopbackBroker.start(...) (broker
//     emits `oauth-open-url` and owns the live OAuthIntent in its own
//     pending-session map);
//   - credentials-form providers → AuthCorrelationStore.createWith(
//     correlationId, intent) (the live intent waits there for the
//     paired §10 sync:authenticate-complete request).
//
// Per spec ADDED Requirement "sync:authenticate-start / complete /
// cancel are the canonical credential-writing entry point" + design.md
// Decisions 4, 5, 7, 9.

import { describe, expect, it, vi } from "vitest";

import type {
  AuthResult,
  CredentialsSchema,
  ProviderId,
} from "@ft5/ipc-contracts";
import type {
  ClientFactory,
  CredentialStore,
  EngineContext,
  OAuthAppConfig,
  AuthIntent,
  CredentialsFormIntent,
  OAuthIntent,
} from "@ft5/fs-datasource-engine";
import { DatasourceError, DatasourceErrorTag } from "@ft5/ipc-contracts";

import { createEventBus, type EventBus } from "../events/event-bus.js";
import type { EventName, EventPayloadMap } from "@ft5/ipc-contracts/sync-service";
import {
  createAuthCorrelationStore,
  type AuthCorrelationStore,
} from "../state/auth-correlation-store.js";
import {
  ServiceConfigMissingError,
} from "../config/service-config-store.js";
import type { OAuthLoopbackBroker } from "../oauth/loopback-broker.js";
import type { Connection } from "../ipc/server.js";

import { makeAuthenticateStartHandler } from "./authenticate-start.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ctx = (): { readonly connection: Connection } => ({
  connection: {
    id: 1,
    closed: false,
    sendEvent: () => void 0,
  },
});

function makeBusSpy(bus: EventBus): {
  events: Array<{ name: EventName; payload: EventPayloadMap[EventName] }>;
} {
  const events: Array<{ name: EventName; payload: EventPayloadMap[EventName] }> = [];
  bus.subscribe((name, payload) => {
    events.push({ name, payload: payload as EventPayloadMap[EventName] });
  });
  return { events };
}

function fakeCredentialStore(): CredentialStore {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  } as unknown as CredentialStore;
}

interface SetupResult {
  bus: EventBus;
  events: Array<{ name: EventName; payload: EventPayloadMap[EventName] }>;
  correlationStore: AuthCorrelationStore;
  broker: {
    start: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  } & Partial<OAuthLoopbackBroker>;
  factory: ClientFactory;
  configStore: { getOAuthAppConfig: ReturnType<typeof vi.fn> };
  engineContext: EngineContext;
  formSchema: CredentialsSchema;
  authResult: AuthResult;
  oauthIntent: OAuthIntent;
  formIntent: CredentialsFormIntent;
}

/**
 * Build a fully wired set of fakes for the handler.
 *
 * The factory's `createForAuth` returns a client whose `authenticate()`
 * returns either an OAuthIntent or a CredentialsFormIntent depending on
 * the requested providerId (mirrors the production strategy dispatch).
 */
function setup(opts: {
  /** Make broker.start throw — simulates service-config-missing or
   *  any other broker-internal failure (since the broker is the one
   *  that resolves config + builds the engine client in approach b). */
  brokerStartThrows?: ServiceConfigMissingError | Error;
  /** Make factory.createForAuth throw — used for the credentials-form
   *  branch (the OAuth branch goes through the broker which is
   *  separately stubbed). */
  factoryThrows?: DatasourceError<"google-drive"> | Error;
} = {}): SetupResult {
  const bus = createEventBus();
  const { events } = makeBusSpy(bus);
  const correlationStore = createAuthCorrelationStore();
  const credentialStore = fakeCredentialStore();
  const engineContext: EngineContext = {
    bus: {} as never, // engine bus stub — handler doesn't read it
    credentialStore,
  };

  const formSchema: CredentialsSchema = "aws-access-key";
  const authResult: AuthResult = { accessToken: "tok" };
  const oauthIntent: OAuthIntent = {
    kind: "oauth",
    authorizeUrl: "https://accounts.google.com/o/oauth2/auth?client_id=X",
    completeWith: vi.fn(async () => authResult),
  };
  const formIntent: CredentialsFormIntent = {
    kind: "credentials-form",
    schema: formSchema,
    submit: vi.fn(async () => authResult),
  };

  const createForAuth = vi.fn((providerId: ProviderId): {
    authenticate: () => Promise<AuthIntent>;
  } => {
    if (opts.factoryThrows) throw opts.factoryThrows;
    if (providerId === "amazon-s3") {
      return { authenticate: async () => formIntent };
    }
    return { authenticate: async () => oauthIntent };
  });

  const factory = {
    create: vi.fn(),
    createForAuth: createForAuth as unknown as ClientFactory["createForAuth"],
  } as unknown as ClientFactory;

  const broker = {
    start: vi.fn(async (args: { correlationId: string }) => {
      if (opts.brokerStartThrows) throw opts.brokerStartThrows;
      return { correlationId: args.correlationId };
    }),
    cancel: vi.fn(async () => undefined),
  };

  const configStore = {
    // configStore is injected into the BROKER at construction (in
    // production wiring) — the handler does NOT call it directly. We
    // keep a stub here for type alignment with HandlersDeps but it
    // should remain uncalled from the handler unit tests.
    getOAuthAppConfig: vi.fn(
      async (_providerId: ProviderId, redirectUri: string): Promise<OAuthAppConfig> => {
        return {
          clientId: "client-X",
          clientSecret: "secret-X",
          redirectUri,
        };
      },
    ),
  };

  return {
    bus,
    events,
    correlationStore,
    broker,
    factory,
    configStore,
    engineContext,
    formSchema,
    authResult,
    oauthIntent,
    formIntent,
  };
}

function buildHandler(s: SetupResult) {
  return makeAuthenticateStartHandler({
    bus: s.bus,
    correlationStore: s.correlationStore,
    factory: s.factory,
    configStore: s.configStore as never,
    loopbackBroker: s.broker as unknown as OAuthLoopbackBroker,
    engineContext: s.engineContext,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync:authenticate-start handler — implement-datasource-onboarding §9", () => {
  it("OAuth-class happy path returns kind=oauth, dispatches to broker, handler emits no events", async () => {
    const s = setup();
    const handler = buildHandler(s);

    // ACT
    const res = await handler({ providerId: "google-drive" }, ctx());

    // ASSERT 1: response shape.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.kind).toBe("oauth");
    if (res.result.kind !== "oauth") return;
    expect(typeof res.result.correlationId).toBe("string");
    expect(res.result.correlationId.length).toBeGreaterThan(0);
    const correlationId = res.result.correlationId;

    // ASSERT 2: broker.start was called with the same correlationId.
    expect(s.broker.start).toHaveBeenCalledTimes(1);
    expect(s.broker.start.mock.calls[0]![0]).toMatchObject({
      providerId: "google-drive",
      correlationId,
    });

    // ASSERT 3: Handler delegates the WHOLE OAuth flow to the broker —
    // factory.createForAuth is invoked INSIDE the broker, not by the
    // handler. The §14 integration test exercises that path with a real
    // broker.
    expect(s.factory.createForAuth).not.toHaveBeenCalled();

    // ASSERT 4: For OAuth, the broker emits BOTH `auth-initiated` and
    // `oauth-open-url` (broker-side spec — see loopback-broker.ts and
    // design.md Decision 7 addendum). Since the broker is stubbed in
    // this unit test, the handler itself emits nothing on the OAuth
    // branch. The full event-ordering invariant is asserted in
    // loopback-broker.test.ts and the §14 integration test.
    expect(s.events).toHaveLength(0);

    // ASSERT 5: correlation store does NOT hold the OAuth intent — that
    // lives inside the broker's pending-session map.
    expect(s.correlationStore.peek(correlationId)).toBeUndefined();
  });

  it("OAuth-class with reconnect datasourceId threads it through to broker.start", async () => {
    const s = setup();
    const handler = buildHandler(s);

    const res = await handler(
      { providerId: "google-drive", datasourceId: "ds-existing-1" },
      ctx(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(s.broker.start.mock.calls[0]![0]).toMatchObject({
      providerId: "google-drive",
      datasourceId: "ds-existing-1",
      correlationId: res.result.correlationId,
    });
  });

  it("Credentials-form happy path returns kind=credentials-form with schema, stashes intent in correlation store, emits auth-initiated, broker NOT called", async () => {
    const s = setup();
    const handler = buildHandler(s);

    const res = await handler({ providerId: "amazon-s3" }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.kind).toBe("credentials-form");
    if (res.result.kind !== "credentials-form") return;
    const correlationId = res.result.correlationId;
    expect(typeof correlationId).toBe("string");
    expect(correlationId.length).toBeGreaterThan(0);
    expect(res.result.formSchema).toEqual(s.formSchema);

    // ASSERT: correlation store has the form intent under our id.
    expect(s.correlationStore.peek(correlationId)).toBe(s.formIntent);

    // ASSERT: broker NOT called for credentials-form.
    expect(s.broker.start).not.toHaveBeenCalled();

    // ASSERT: configStore.getOAuthAppConfig NOT called for credentials-form
    // (S3 does not consult OAuth app config).
    expect(s.configStore.getOAuthAppConfig).not.toHaveBeenCalled();

    // ASSERT: auth-initiated emitted.
    const initiated = s.events.filter((e) => e.name === "auth-initiated");
    expect(initiated).toHaveLength(1);
    expect(
      (initiated[0]!.payload as EventPayloadMap["auth-initiated"]).providerId,
    ).toBe("amazon-s3");
  });

  it("propagates ServiceConfigMissingError as wire error service-config-missing; no auth-initiated emitted", async () => {
    // Production wiring: configStore.getOAuthAppConfig is injected INTO
    // the broker at construction (Decision 4). When the file is absent
    // the broker resolves the closure, gets a ServiceConfigMissingError,
    // closes the bound listener, and re-throws. The handler catches and
    // surfaces the typed wire error.
    const err = new ServiceConfigMissingError(
      "/abs/path/config.json",
      "google-drive",
      "config file does not exist",
    );
    const s = setup({ brokerStartThrows: err });
    const handler = buildHandler(s);

    const res = await handler({ providerId: "google-drive" }, ctx());

    // ASSERT 1: typed wire error.
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.tag).toBe("service-config-missing");
    if (res.error.tag !== "service-config-missing") return;
    expect(res.error.path).toBe("/abs/path/config.json");
    expect(res.error.providerId).toBe("google-drive");

    // ASSERT 2: handler did not directly call factory.createForAuth.
    expect(s.factory.createForAuth).not.toHaveBeenCalled();

    // ASSERT 3: NO auth-initiated event — handler short-circuits BEFORE
    // emitting per the spec scenario "no event is emitted, no loopback
    // server is bound".
    expect(s.events.filter((e) => e.name === "auth-initiated")).toHaveLength(0);
  });

  it("maps DatasourceError(invalid-datasource) from factory.createForAuth to unknown-provider wire error (credentials-form branch)", async () => {
    const err = new DatasourceError({
      tag: DatasourceErrorTag.InvalidDatasource,
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
      raw: "unknown-provider",
      message: "No strategy registered for provider 'amazon-s3'",
    });
    const s = setup({ factoryThrows: err });
    const handler = buildHandler(s);

    const res = await handler({ providerId: "amazon-s3" }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.tag).toBe("unknown-provider");
    if (res.error.tag !== "unknown-provider") return;
    expect(res.error.providerId).toBe("amazon-s3");

    // No correlation entry — handler bailed before stashing intent.
    expect(s.correlationStore.size()).toBe(0);
  });

  it("maps DatasourceError(invalid-datasource) raised inside the broker (OAuth branch) to unknown-provider wire error", async () => {
    const err = new DatasourceError({
      tag: DatasourceErrorTag.InvalidDatasource,
      datasourceType: "google-drive",
      datasourceId: "ds-1",
      retryable: false,
      raw: "unknown-provider",
      message: "No strategy registered for provider 'google-drive'",
    });
    const s = setup({ brokerStartThrows: err });
    const handler = buildHandler(s);

    const res = await handler({ providerId: "google-drive" }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.tag).toBe("unknown-provider");
    if (res.error.tag !== "unknown-provider") return;
    expect(res.error.providerId).toBe("google-drive");
  });

  it("maps generic engine throws to engine-error wire error (credentials-form branch)", async () => {
    const err = new Error("transient engine boom");
    const s = setup({ factoryThrows: err });
    const handler = buildHandler(s);

    const res = await handler({ providerId: "amazon-s3" }, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.tag).toBe("engine-error");
    if (res.error.tag !== "engine-error") return;
    expect(res.error.message).toMatch(/transient engine boom/);
  });
});
