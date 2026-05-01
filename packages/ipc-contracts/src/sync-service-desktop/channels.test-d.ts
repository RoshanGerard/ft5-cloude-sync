// Renderer-facing IPC channel constants — contract tests.
//
// Follows the established pattern from `DATASOURCES_CHANNELS`: a single
// `as const` object whose values are stable string literals so both the
// main-process handler registration and the preload's `ipcRenderer.invoke`
// calls reference identical, typo-proof names.
//
// `implement-datasource-onboarding` retired the single-shot
// `authenticate` channel and added the three-command split + config
// round-trip + delete-credentials channels.

import { describe, expect, expectTypeOf, it } from "vitest";

import { SYNC_CHANNELS } from "./channels.js";

describe("sync-service-desktop SYNC_CHANNELS constants", () => {
  it("exposes exactly the expected keys (post-onboarding + iter-5 cancelDownload)", () => {
    expect(Object.keys(SYNC_CHANNELS).sort()).toEqual(
      [
        "authenticateStart",
        "authenticateComplete",
        "authenticateCancel",
        "cancelDownload",
        "cancelJob",
        "deleteCredentials",
        "enqueueMirror",
        "enqueueUpload",
        "event",
        "getConfig",
        "getJob",
        "getRetryPolicy",
        "getStatus",
        "listJobs",
        "setConfig",
        "setRetryPolicy",
      ].sort(),
    );
  });

  it("retired single-shot `authenticate` channel is absent", () => {
    type Channels = typeof SYNC_CHANNELS;
    type HasAuthenticate = "authenticate" extends keyof Channels
      ? true
      : false;
    expectTypeOf<HasAuthenticate>().toEqualTypeOf<false>();
    expect(
      Object.prototype.hasOwnProperty.call(SYNC_CHANNELS, "authenticate"),
    ).toBe(false);
  });

  it("each channel resolves to its stable string literal", () => {
    expect(SYNC_CHANNELS.listJobs).toBe("sync:list-jobs");
    expect(SYNC_CHANNELS.getJob).toBe("sync:get-job");
    expect(SYNC_CHANNELS.enqueueUpload).toBe("sync:enqueue-upload");
    expect(SYNC_CHANNELS.enqueueMirror).toBe("sync:enqueue-mirror");
    expect(SYNC_CHANNELS.cancelJob).toBe("sync:cancel-job");
    expect(SYNC_CHANNELS.cancelDownload).toBe("sync:cancel-download");
    expect(SYNC_CHANNELS.authenticateStart).toBe("sync:authenticate-start");
    expect(SYNC_CHANNELS.authenticateComplete).toBe(
      "sync:authenticate-complete",
    );
    expect(SYNC_CHANNELS.authenticateCancel).toBe("sync:authenticate-cancel");
    expect(SYNC_CHANNELS.getConfig).toBe("sync:get-config");
    expect(SYNC_CHANNELS.setConfig).toBe("sync:set-config");
    expect(SYNC_CHANNELS.deleteCredentials).toBe("sync:delete-credentials");
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
    expectTypeOf<typeof SYNC_CHANNELS.cancelDownload>().toEqualTypeOf<
      "sync:cancel-download"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.authenticateStart>().toEqualTypeOf<
      "sync:authenticate-start"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.authenticateComplete>().toEqualTypeOf<
      "sync:authenticate-complete"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.authenticateCancel>().toEqualTypeOf<
      "sync:authenticate-cancel"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.getConfig>().toEqualTypeOf<
      "sync:get-config"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.setConfig>().toEqualTypeOf<
      "sync:set-config"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.deleteCredentials>().toEqualTypeOf<
      "sync:delete-credentials"
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
