// Renderer-facing IPC channel constants — contract tests.
//
// Follows the established pattern from `DATASOURCES_CHANNELS`: a single
// `as const` object whose values are stable string literals so both the
// main-process handler registration and the preload's `ipcRenderer.invoke`
// calls reference identical, typo-proof names.

import { describe, expect, expectTypeOf, it } from "vitest";

import { SYNC_CHANNELS } from "./channels.js";

describe("sync-service-desktop SYNC_CHANNELS constants", () => {
  it("exposes exactly the 12 expected keys", () => {
    expect(Object.keys(SYNC_CHANNELS).sort()).toEqual(
      [
        "authenticate",
        "authenticateStart",
        "authenticateComplete",
        "cancelJob",
        "enqueueMirror",
        "enqueueUpload",
        "event",
        "getJob",
        "getRetryPolicy",
        "getStatus",
        "listJobs",
        "setRetryPolicy",
      ].sort(),
    );
  });

  it("each channel resolves to its stable string literal", () => {
    expect(SYNC_CHANNELS.listJobs).toBe("sync:list-jobs");
    expect(SYNC_CHANNELS.getJob).toBe("sync:get-job");
    expect(SYNC_CHANNELS.enqueueUpload).toBe("sync:enqueue-upload");
    expect(SYNC_CHANNELS.enqueueMirror).toBe("sync:enqueue-mirror");
    expect(SYNC_CHANNELS.cancelJob).toBe("sync:cancel-job");
    expect(SYNC_CHANNELS.authenticate).toBe("sync:authenticate");
    expect(SYNC_CHANNELS.getStatus).toBe("sync:get-status");
    expect(SYNC_CHANNELS.getRetryPolicy).toBe("sync:get-retry-policy");
    expect(SYNC_CHANNELS.setRetryPolicy).toBe("sync:set-retry-policy");
    expect(SYNC_CHANNELS.event).toBe("sync:event");
  });

  it("each value is a stable string literal at the TYPE level", () => {
    expectTypeOf<typeof SYNC_CHANNELS.listJobs>().toEqualTypeOf<
      "sync:list-jobs"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.getJob>().toEqualTypeOf<"sync:get-job">();
    expectTypeOf<typeof SYNC_CHANNELS.enqueueUpload>().toEqualTypeOf<
      "sync:enqueue-upload"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.enqueueMirror>().toEqualTypeOf<
      "sync:enqueue-mirror"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.cancelJob>().toEqualTypeOf<
      "sync:cancel-job"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.authenticate>().toEqualTypeOf<
      "sync:authenticate"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.getStatus>().toEqualTypeOf<
      "sync:get-status"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.getRetryPolicy>().toEqualTypeOf<
      "sync:get-retry-policy"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.setRetryPolicy>().toEqualTypeOf<
      "sync:set-retry-policy"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.event>().toEqualTypeOf<"sync:event">();
  });

  it("is reachable from the top-level @ft5/ipc-contracts index re-export", async () => {
    const root = await import("../index.js");
    expect(root.SYNC_CHANNELS).toBe(SYNC_CHANNELS);
  });
});
