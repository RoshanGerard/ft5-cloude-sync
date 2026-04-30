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
    // The auth-* event family + bridge-only `oauth-open-url` /
    // `credential-persisted` events were added by the
    // `implement-datasource-onboarding` change per design.md Decision 7.
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
      | "credential-store-permission-violation"
      | "auth-initiated"
      | "auth-completed"
      | "auth-cancelled"
      | "auth-failed"
      | "auth-timeout"
      | "oauth-open-url"
      | "credential-persisted"
      | "downloading"
      | "download-retrying"
      | "file-downloaded"
      | "download-failed"
      | "download-cancelled";
    expectTypeOf<EventName>().toEqualTypeOf<Expected>();
  });

  it("download-retrying payload carries attempt/limit/waitMs/engineCause (add-download-resilience)", () => {
    // The handler emits this event at the start of each environmental-retry
    // sleep — NOT for the auth-expired Layer 2 branch. `engineCause` is a
    // diagnostic-only engine-taxonomy leak; the renderer SHALL NOT branch
    // behavior on its value.
    type Payload = EventPayloadMap["download-retrying"];
    expectTypeOf<Payload>().toMatchTypeOf<{
      readonly downloadJobId: string;
      readonly datasourceId: string;
      readonly attempt: number;
      readonly limit: number;
      readonly waitMs: number;
      readonly engineCause: string;
    }>();
  });

  it("download-failed payload tag union includes exhausted-retries (add-download-resilience)", () => {
    type Tag = EventPayloadMap["download-failed"]["tag"];
    expectTypeOf<"exhausted-retries">().toMatchTypeOf<Tag>();
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
