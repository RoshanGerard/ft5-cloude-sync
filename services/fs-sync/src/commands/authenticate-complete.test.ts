// Tests for the real `sync:authenticate-complete` handler — replaces
// the wire-fs-sync-service stub per implement-datasource-onboarding §10.
//
// Only credentials-form completions cross the wire (OAuth completions
// land via the loopback callback inside the broker, not through this
// handler).
//
// Per spec ADDED Requirement "sync:authenticate-start / complete /
// cancel are the canonical credential-writing entry point" §
// "credentials-form completion writes credentials via the
// request/response handler".

import { describe, expect, it, vi } from "vitest";

import type {
  AuthResult,
  CredentialsSchema,
  DatasourceSummary,
} from "@ft5/ipc-contracts";
import type {
  CredentialsFormIntent,
  OAuthIntent,
} from "@ft5/fs-datasource-engine";

import { createEventBus, type EventBus } from "../events/event-bus.js";
import type { EventName, EventPayloadMap } from "@ft5/ipc-contracts/sync-service";
import {
  createAuthCorrelationStore,
  type AuthCorrelationStore,
} from "../state/auth-correlation-store.js";
import { providers } from "@ft5/ipc-contracts";
import type { Connection } from "../ipc/server.js";

import { makeAuthenticateCompleteHandler } from "./authenticate-complete.js";

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

/**
 * Build a credentials-form intent whose `submit` resolves to the supplied
 * AuthResult.
 */
function makeFormIntent(opts: {
  authResult: AuthResult;
  schema?: CredentialsSchema;
}): {
  intent: CredentialsFormIntent;
  submit: ReturnType<typeof vi.fn>;
} {
  const submit = vi.fn(async (_v: Record<string, unknown>) => opts.authResult);
  const intent: CredentialsFormIntent = {
    kind: "credentials-form",
    schema: opts.schema ?? "aws-access-key",
    submit,
  };
  return { intent, submit };
}

interface DepsBundle {
  bus: EventBus;
  events: Array<{ name: EventName; payload: EventPayloadMap[EventName] }>;
  correlationStore: AuthCorrelationStore;
}

function buildDeps(): DepsBundle {
  const bus = createEventBus();
  const { events } = makeBusSpy(bus);
  const correlationStore = createAuthCorrelationStore();
  return { bus, events, correlationStore };
}

function buildHandler(d: DepsBundle) {
  return makeAuthenticateCompleteHandler({
    bus: d.bus,
    correlationStore: d.correlationStore,
  });
}

describe("sync:authenticate-complete handler — implement-datasource-onboarding §10", () => {
  it("credentials-form happy path: consumes correlation, runs submit, emits credential-persisted + auth-completed, returns datasourceId + summary", async () => {
    const d = buildDeps();
    const handler = buildHandler(d);

    const { intent, submit } = makeFormIntent({
      authResult: { accessToken: "tok" },
    });
    d.correlationStore.createWith("corr-1", intent, {
      datasourceId: "ds-42",
      providerId: "amazon-s3",
    });

    const values = {
      accessKeyId: "AKIA",
      secretAccessKey: "sec",
      region: "us-east-1",
      bucket: "b",
    };

    // ACT
    const res = await handler(
      { correlationId: "corr-1", completion: { kind: "credentials-form", values } },
      ctx(),
    );

    // ASSERT 1: response shape.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.datasourceId).toBe("ds-42");
    const summary: DatasourceSummary = res.result.summary;
    expect(summary.id).toBe("ds-42");
    expect(summary.providerId).toBe("amazon-s3");
    expect(summary.status).toBe("connected");
    expect(summary.errorKind).toBeNull();
    expect(summary.displayName).toBe(providers["amazon-s3"]?.displayName);

    // ASSERT 2: submit was called with the typed values.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(values);

    // ASSERT 3: correlation consumed.
    expect(d.correlationStore.peek("corr-1")).toBeUndefined();

    // ASSERT 4: BOTH credential-persisted AND auth-completed emitted
    // exactly once each, carrying the same correlation/datasource/summary.
    const persisted = d.events.filter((e) => e.name === "credential-persisted");
    const completed = d.events.filter((e) => e.name === "auth-completed");
    expect(persisted).toHaveLength(1);
    expect(completed).toHaveLength(1);
    const persistedPayload = persisted[0]!.payload as
      EventPayloadMap["credential-persisted"];
    const completedPayload = completed[0]!.payload as
      EventPayloadMap["auth-completed"];
    expect(persistedPayload.correlationId).toBe("corr-1");
    expect(completedPayload.correlationId).toBe("corr-1");
    expect(persistedPayload.datasourceId).toBe("ds-42");
    expect(completedPayload.datasourceId).toBe("ds-42");
    expect(persistedPayload.summary).toEqual(completedPayload.summary);
  });

  it("returns correlation-expired when the correlationId is unknown", async () => {
    const d = buildDeps();
    const handler = buildHandler(d);

    const res = await handler(
      {
        correlationId: "no-such-id",
        completion: { kind: "credentials-form", values: {} },
      },
      ctx(),
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.tag).toBe("correlation-expired");
    if (res.error.tag !== "correlation-expired") return;
    expect(res.error.correlationId).toBe("no-such-id");

    // No events emitted on miss.
    expect(d.events).toHaveLength(0);
  });

  it("returns intent-kind-mismatch when stored intent is OAuth and completion is credentials-form", async () => {
    const d = buildDeps();
    const handler = buildHandler(d);

    const oauthIntent: OAuthIntent = {
      kind: "oauth",
      authorizeUrl: "https://example.com",
      completeWith: vi.fn(async () => ({ accessToken: "x" })),
    };
    d.correlationStore.createWith("corr-mismatch", oauthIntent, {
      datasourceId: "ds-mm",
      providerId: "google-drive",
    });

    const res = await handler(
      {
        correlationId: "corr-mismatch",
        completion: { kind: "credentials-form", values: {} },
      },
      ctx(),
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.tag).toBe("intent-kind-mismatch");
    if (res.error.tag !== "intent-kind-mismatch") return;
    expect(res.error.expected).toBe("oauth");
    expect(res.error.actual).toBe("credentials-form");

    // No completeWith invocation.
    expect(oauthIntent.completeWith).not.toHaveBeenCalled();

    // No credential-persisted / auth-completed.
    expect(
      d.events.filter((e) => e.name === "credential-persisted"),
    ).toHaveLength(0);
    expect(
      d.events.filter((e) => e.name === "auth-completed"),
    ).toHaveLength(0);
  });

  it("on submit rejection returns engine-error AND emits auth-failed; correlation consumed; no credential-persisted", async () => {
    const d = buildDeps();
    const handler = buildHandler(d);

    const submit = vi.fn(async () => {
      throw new Error("bucket not found");
    });
    const intent: CredentialsFormIntent = {
      kind: "credentials-form",
      schema: "aws-access-key",
      submit,
    };
    d.correlationStore.createWith("corr-boom", intent, {
      datasourceId: "ds-boom",
      providerId: "amazon-s3",
    });

    const res = await handler(
      {
        correlationId: "corr-boom",
        completion: { kind: "credentials-form", values: {} },
      },
      ctx(),
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.tag).toBe("engine-error");
    if (res.error.tag !== "engine-error") return;
    expect(res.error.message).toMatch(/bucket not found/);

    // Correlation consumed (not retryable on the same id).
    expect(d.correlationStore.peek("corr-boom")).toBeUndefined();

    // auth-failed emitted, credential-persisted NOT emitted.
    const failed = d.events.filter((e) => e.name === "auth-failed");
    expect(failed).toHaveLength(1);
    const failedPayload = failed[0]!.payload as
      EventPayloadMap["auth-failed"];
    expect(failedPayload.correlationId).toBe("corr-boom");
    expect(failedPayload.tag).toBe("engine-error");
    expect(failedPayload.message).toMatch(/bucket not found/);

    expect(
      d.events.filter((e) => e.name === "credential-persisted"),
    ).toHaveLength(0);
    expect(
      d.events.filter((e) => e.name === "auth-completed"),
    ).toHaveLength(0);
  });
});
