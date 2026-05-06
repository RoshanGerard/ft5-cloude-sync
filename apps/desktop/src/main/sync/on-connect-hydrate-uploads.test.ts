// migrate-upload-orchestration-out-of-engine §13.3 — RED tests for the
// on-launch `uploads:list-active` hydrate.
//
// Mirror of `on-connect-hydrate-downloads.test.ts`. Behavior contract
// (per design.md Decision 4 + spec.md "App-launch hydrates active
// uploads from the service registry"):
//
//   - On the supervisor's FIRST connect of an app session, the desktop
//     main process MUST issue exactly one
//     `sync.request("uploads:list-active")`.
//   - The response MUST be forwarded to the renderer via the
//     `files:hydrate-active-uploads` channel — preload exposes this as
//     `window.api.files.onActiveUploadsHydrate(callback)`.
//   - Reconnects mid-session MUST NOT re-fire. Fire-once-per-session is
//     a STRUCTURAL invariant: the bootstrap call site invokes the
//     hydrate function exactly once and does NOT register it on
//     `syncHandle.on("reconnect", ...)`. The function itself contains
//     no `alreadyFired` flag — its semantics are "do one query + one
//     send, every time you're called."
//
// The function takes a SyncClient-shaped object (only `request` is
// touched) and a `sendToRenderer(channel, payload)` callback so the
// caller can pass `(channel, payload) => window.webContents.send(...)`.
// Decoupling the BrowserWindow from this module keeps the test under
// plain Node and lets bootstrap pick the window at the call site.

import { describe, expect, it, vi } from "vitest";

import type { UploadJob } from "@ft5/ipc-contracts/sync-service";

import { hydrateActiveUploadsOnce } from "./on-connect-hydrate-uploads.js";

describe("hydrateActiveUploadsOnce — fire-once on-supervisor-connect", () => {
  it("issues exactly one `uploads:list-active` request and forwards the jobs to the renderer on the dedicated channel", async () => {
    const sampleJobs: readonly UploadJob[] = [
      {
        uploadJobId: "u-1",
        datasourceId: "ds-1",
        sourcePath: "C:/local/welcome.pdf",
        targetPath: "/projects/2026/welcome.pdf",
        bytesUploaded: 12_345,
        contentLength: 100_000,
        startedAt: 1_700_000_000_000,
      },
    ];
    const request = vi.fn().mockResolvedValue({ jobs: sampleJobs });
    const sendToRenderer = vi.fn();

    await hydrateActiveUploadsOnce({ request }, sendToRenderer);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("uploads:list-active", {});

    expect(sendToRenderer).toHaveBeenCalledTimes(1);
    expect(sendToRenderer).toHaveBeenCalledWith(
      "files:hydrate-active-uploads",
      sampleJobs,
    );
  });

  it("forwards an empty array when the registry has no active jobs (still fires exactly once)", async () => {
    const request = vi.fn().mockResolvedValue({ jobs: [] });
    const sendToRenderer = vi.fn();

    await hydrateActiveUploadsOnce({ request }, sendToRenderer);

    expect(request).toHaveBeenCalledTimes(1);
    expect(sendToRenderer).toHaveBeenCalledTimes(1);
    expect(sendToRenderer).toHaveBeenCalledWith(
      "files:hydrate-active-uploads",
      [],
    );
  });

  it("does NOT throw when the request rejects — logs and skips the renderer send", async () => {
    // The hydrate is best-effort: if the service responds with an error
    // (e.g. service crashed mid-startup, or a transient pipe blip), the
    // renderer MUST NOT be told about a malformed snapshot. The renderer's
    // live event feed (sync-service event bridge) continues to drive
    // in-flight upload toasters; missing the seed only loses the
    // historical snapshot, not the live event feed.
    const request = vi.fn().mockRejectedValue(new Error("service unreachable"));
    const sendToRenderer = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      hydrateActiveUploadsOnce({ request }, sendToRenderer),
    ).resolves.toBeUndefined();

    expect(sendToRenderer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("calling the function a second time (e.g. on a renderer reload) issues a fresh query — fire-once is a CALL-SITE invariant, not a function-level one", async () => {
    // The structural fire-once-per-session guarantee lives at the
    // bootstrap call site (which invokes this once and does NOT
    // register it on supervisor reconnect). The function itself has
    // no internal latch — calling it twice is well-defined and useful
    // for renderer-reload scenarios. Locking that here so refactors
    // toward an internal latch must explicitly break this contract.
    const sampleJobs: readonly UploadJob[] = [];
    const request = vi.fn().mockResolvedValue({ jobs: sampleJobs });
    const sendToRenderer = vi.fn();

    await hydrateActiveUploadsOnce({ request }, sendToRenderer);
    await hydrateActiveUploadsOnce({ request }, sendToRenderer);

    expect(request).toHaveBeenCalledTimes(2);
    expect(sendToRenderer).toHaveBeenCalledTimes(2);
  });
});
