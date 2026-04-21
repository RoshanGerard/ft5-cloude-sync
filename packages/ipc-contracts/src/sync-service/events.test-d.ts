import { describe, expectTypeOf, it } from "vitest";

import type {
  EVENT_NAMES,
  EventName,
  EventPayloadMap,
  ServiceEvent,
  SyncCompletedPayload,
} from "./events.js";

describe("sync-service event contract", () => {
  it("enumerates every event the spec requires", () => {
    type Expected =
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
      | "credential-store-permission-violation";
    expectTypeOf<EventName>().toEqualTypeOf<Expected>();
  });

  it("EVENT_NAMES tuple contains every EventName", () => {
    expectTypeOf<(typeof EVENT_NAMES)[number]>().toEqualTypeOf<EventName>();
  });

  it("ServiceEvent is a discriminated union keyed on `name`", () => {
    type SampleCompleted = Extract<ServiceEvent, { name: "sync-completed" }>;
    expectTypeOf<SampleCompleted>().toEqualTypeOf<{
      readonly name: "sync-completed";
      readonly payload: SyncCompletedPayload;
    }>();
  });

  it("sync-completed payload carries summary counts", () => {
    expectTypeOf<EventPayloadMap["sync-completed"]>().toEqualTypeOf<{
      readonly jobId: string;
      readonly uploaded: number;
      readonly updated: number;
      readonly deleted: number;
      readonly skipped: number;
      readonly completedAt: number;
    }>();
  });

  it("credential-store-permission-violation payload carries observed mode", () => {
    expectTypeOf<
      EventPayloadMap["credential-store-permission-violation"]
    >().toEqualTypeOf<{
      readonly path: string;
      readonly mode: string;
      readonly observedAt: number;
    }>();
  });
});
