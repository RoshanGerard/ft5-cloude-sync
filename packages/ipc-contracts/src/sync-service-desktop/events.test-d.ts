// Renderer-observable SyncEvent union — contract tests.
//
// The renderer sees a SUPERSET of the service's lifecycle events: the 10
// service events proper, the synthetic `sync-state-seed` emitted by the
// desktop supervisor during the app-open reconciliation handshake, and the
// two synthetic connection-lifecycle events the supervisor raises when its
// underlying socket closes / re-establishes.
//
// This file does NOT duplicate payload shapes from the wire contract — they
// are re-exported in `events.ts` via `export type { ... } from
// "../sync-service/events.js"`.

import { describe, expectTypeOf, it } from "vitest";

import type {
  JobSummary,
} from "../sync-service/commands.js";
import type {
  AuthCancelledPayload,
  AuthCompletedPayload,
  AuthFailedPayload,
  AuthInitiatedPayload,
  AuthTimeoutPayload,
  JobCancelledPayload,
  JobCompletedPayload,
  JobEnqueuedPayload,
  JobFailedPayload,
  JobProgressPayload,
  JobRecoveredPayload,
  JobStartedPayload,
  NetworkAvailablePayload,
  SourceUnavailablePayload,
  SyncCompletedPayload,
} from "../sync-service/events.js";
import type {
  ServiceDisconnectedPayload,
  ServiceReconnectedPayload,
  SyncEvent,
  SyncEventKind,
  SyncEventPayloadMap,
  SyncStateSeedPayload,
} from "./events.js";

describe("sync-service-desktop SyncEventKind enumeration", () => {
  it("enumerates all 18 kinds the renderer must handle", () => {
    type Expected =
      | "sync-state-seed"
      | "job-enqueued"
      | "job-started"
      | "job-progress"
      | "job-completed"
      | "job-failed"
      | "job-cancelled"
      | "job-recovered"
      | "sync-completed"
      | "source-unavailable"
      | "network-available"
      | "service-disconnected"
      | "service-reconnected"
      // Authenticate lifecycle (implement-datasource-onboarding §Prereq B).
      // The two bridge-only events (`oauth-open-url`, `credential-persisted`)
      // are filtered out before the renderer-bound forward and SHALL NOT
      // appear in this union.
      | "auth-initiated"
      | "auth-completed"
      | "auth-cancelled"
      | "auth-failed"
      | "auth-timeout";
    expectTypeOf<SyncEventKind>().toEqualTypeOf<Expected>();
  });
});

describe("sync-service-desktop SyncEventPayloadMap", () => {
  it("sync-state-seed payload carries in-progress jobs", () => {
    expectTypeOf<SyncEventPayloadMap["sync-state-seed"]>().toEqualTypeOf<
      SyncStateSeedPayload
    >();
    expectTypeOf<SyncStateSeedPayload>().toEqualTypeOf<{
      readonly jobs: ReadonlyArray<JobSummary>;
    }>();
  });

  it("service-disconnected + service-reconnected payloads are declared", () => {
    expectTypeOf<
      SyncEventPayloadMap["service-disconnected"]
    >().toEqualTypeOf<ServiceDisconnectedPayload>();
    expectTypeOf<
      SyncEventPayloadMap["service-reconnected"]
    >().toEqualTypeOf<ServiceReconnectedPayload>();
  });

  it("service lifecycle payloads re-use the wire-contract shapes", () => {
    expectTypeOf<SyncEventPayloadMap["job-enqueued"]>().toEqualTypeOf<
      JobEnqueuedPayload
    >();
    expectTypeOf<SyncEventPayloadMap["job-started"]>().toEqualTypeOf<
      JobStartedPayload
    >();
    expectTypeOf<SyncEventPayloadMap["job-progress"]>().toEqualTypeOf<
      JobProgressPayload
    >();
    expectTypeOf<SyncEventPayloadMap["job-completed"]>().toEqualTypeOf<
      JobCompletedPayload
    >();
    expectTypeOf<SyncEventPayloadMap["job-failed"]>().toEqualTypeOf<
      JobFailedPayload
    >();
    expectTypeOf<SyncEventPayloadMap["job-cancelled"]>().toEqualTypeOf<
      JobCancelledPayload
    >();
    expectTypeOf<SyncEventPayloadMap["job-recovered"]>().toEqualTypeOf<
      JobRecoveredPayload
    >();
    expectTypeOf<SyncEventPayloadMap["sync-completed"]>().toEqualTypeOf<
      SyncCompletedPayload
    >();
    expectTypeOf<SyncEventPayloadMap["source-unavailable"]>().toEqualTypeOf<
      SourceUnavailablePayload
    >();
    expectTypeOf<SyncEventPayloadMap["network-available"]>().toEqualTypeOf<
      NetworkAvailablePayload
    >();
  });

  it("authenticate lifecycle payloads re-use the wire-contract shapes", () => {
    expectTypeOf<SyncEventPayloadMap["auth-initiated"]>().toEqualTypeOf<
      AuthInitiatedPayload
    >();
    expectTypeOf<SyncEventPayloadMap["auth-completed"]>().toEqualTypeOf<
      AuthCompletedPayload
    >();
    expectTypeOf<SyncEventPayloadMap["auth-cancelled"]>().toEqualTypeOf<
      AuthCancelledPayload
    >();
    expectTypeOf<SyncEventPayloadMap["auth-failed"]>().toEqualTypeOf<
      AuthFailedPayload
    >();
    expectTypeOf<SyncEventPayloadMap["auth-timeout"]>().toEqualTypeOf<
      AuthTimeoutPayload
    >();
  });
});

describe("sync-service-desktop SyncEvent discriminated union", () => {
  it("SyncEvent is keyed on `kind` with matching `payload`", () => {
    type SeedVariant = Extract<SyncEvent, { kind: "sync-state-seed" }>;
    expectTypeOf<SeedVariant>().toEqualTypeOf<{
      readonly kind: "sync-state-seed";
      readonly payload: SyncStateSeedPayload;
    }>();

    type DisconnectedVariant = Extract<
      SyncEvent,
      { kind: "service-disconnected" }
    >;
    expectTypeOf<DisconnectedVariant>().toEqualTypeOf<{
      readonly kind: "service-disconnected";
      readonly payload: ServiceDisconnectedPayload;
    }>();

    type ProgressVariant = Extract<SyncEvent, { kind: "job-progress" }>;
    expectTypeOf<ProgressVariant>().toEqualTypeOf<{
      readonly kind: "job-progress";
      readonly payload: JobProgressPayload;
    }>();
  });

  it("SyncEvent['kind'] equals SyncEventKind", () => {
    expectTypeOf<SyncEvent["kind"]>().toEqualTypeOf<SyncEventKind>();
  });
});
